import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildFlyImage,
  createFlyDeploymentProvider,
  detectFlyCompatibility,
  encodeFlyProviderDeploymentId,
  flyAppName,
  renderFlyDockerfile,
  type FlyBuildSandboxPort,
  type FlyContractPort,
  type FlyUsagePort,
  type FlyVaultPort,
} from '../../src/providers/fly.js';

const PROJECT = 'proj_01J00000000000000000000000';
const ENVIRONMENT = 'env-production';
const COMMIT = 'a'.repeat(40);
const RELEASE = 'rel_01J00000000000000000000000';
const PRODUCTION_ENVIRONMENT = 'env_01J00000000000000000000000';
const SECRET_DATABASE = 'sec_01J00000000000000000000000';
const SECRET_API_KEY = 'sec_01J00000000000000000000001';
const NOW = '2026-08-11T16:00:00.000Z';

const contract = {
  version: 1 as const,
  package_manager: 'pnpm' as const,
  workspace_root: '.',
  install: { command: 'pnpm install --frozen-lockfile', timeout_seconds: 300 },
  develop: { command: 'pnpm dev', port: 3_000 },
  build: { command: 'pnpm build', timeout_seconds: 600 },
  start: { command: 'pnpm start' },
  health: { path: '/health' },
};

function projectContext(files: Readonly<Record<string, string>>) {
  return {
    workspaceRoot: '.',
    detection: { adapterId: 'generic-node', confidence: 0.5, evidence: ['package.json'] },
    listFiles: (glob: string) =>
      Promise.resolve(Object.keys(files).filter((path) => path === glob)),
    readFile: (path: string) => {
      const value = files[path];
      return value === undefined ? Promise.reject(new Error('not found')) : Promise.resolve(value);
    },
  };
}

class RecordingBuildSandbox implements FlyBuildSandboxPort {
  readonly existing = new Set<string>();
  readonly writes: Array<{ readonly path: string; readonly contents: string }> = [];
  readonly deletes: string[] = [];
  readonly executions: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
  }> = [];
  exitCode = 0;
  stderr = '';

  fileExists(path: string): Promise<boolean> {
    return Promise.resolve(this.existing.has(path));
  }

  writeFile(path: string, contents: string): Promise<void> {
    this.writes.push({ path, contents });
    return Promise.resolve();
  }

  deleteFile(path: string): Promise<void> {
    this.deletes.push(path);
    return Promise.resolve();
  }

  exec(input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    this.executions.push(input);
    return Promise.resolve({ exitCode: this.exitCode, stdout: 'build complete', stderr: this.stderr });
  }
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface TestMachine {
  readonly id: string;
  state: string;
  readonly config: Record<string, unknown>;
  checks?: readonly { readonly name: string; readonly status: string }[];
}

const openServers: RecordingFlyServer[] = [];

class RecordingFlyServer {
  appExists = false;
  unhealthyCandidate = false;
  failMachineReads = false;
  failLogReads = false;
  rejectSecretName: string | undefined;
  readonly requests: RecordedRequest[] = [];
  readonly authorizationHeaders: string[] = [];
  readonly machines: TestMachine[] = [];
  readonly logPages = new Map<string, unknown>();
  private nextMachine = 1;
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    openServers.push(this);
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}/v1`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const bodyText = await new Promise<string>((resolve) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        resolve(body);
      });
    });
    const url = new URL(request.url ?? '/', 'http://fly.test');
    const body: unknown = bodyText === '' ? undefined : JSON.parse(bodyText);
    this.requests.push({ method: request.method ?? 'GET', path: `${url.pathname}${url.search}`, body });
    this.authorizationHeaders.push(request.headers.authorization ?? '');

    const appMatch = /^\/v1\/apps\/([^/]+)$/u.exec(url.pathname);
    if (request.method === 'GET' && appMatch !== null) {
      this.send(response, this.appExists ? 200 : 404, this.appExists ? { name: appMatch[1] } : {});
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/apps') {
      this.appExists = true;
      this.send(response, 201, { name: (body as { app_name: string }).app_name });
      return;
    }

    const secretMatch = /^\/v1\/apps\/([^/]+)\/secrets\/([^/]+)$/u.exec(url.pathname);
    if (request.method === 'POST' && secretMatch !== null) {
      if (decodeURIComponent(secretMatch[2] ?? '') === this.rejectSecretName) {
        this.send(response, 422, body);
        return;
      }
      this.send(response, 200, { ok: true });
      return;
    }

    const machinesMatch = /^\/v1\/apps\/([^/]+)\/machines$/u.exec(url.pathname);
    if (request.method === 'GET' && machinesMatch !== null) {
      this.send(response, 200, this.machines);
      return;
    }
    if (request.method === 'POST' && machinesMatch !== null) {
      const config = (body as { config: Record<string, unknown> }).config;
      const machine: TestMachine = {
        id: `machine-new-${String(this.nextMachine++)}`,
        state: 'created',
        config,
      };
      this.machines.push(machine);
      this.send(response, 201, { ...machine, created_at: NOW });
      return;
    }

    const machineMatch = /^\/v1\/apps\/([^/]+)\/machines\/([^/]+)$/u.exec(url.pathname);
    if (request.method === 'GET' && machineMatch !== null) {
      if (this.failMachineReads) {
        this.send(response, 503, { error: 'provider unavailable' });
        return;
      }
      const machine = this.machines.find(({ id }) => id === machineMatch[2]);
      if (machine === undefined) {
        this.send(response, 404, {});
        return;
      }
      if (machine.id.startsWith('machine-new-')) {
        machine.state = 'started';
        machine.checks = [
          { name: 'zapp-health', status: this.unhealthyCandidate ? 'critical' : 'passing' },
        ];
      }
      this.send(response, 200, { ...machine, created_at: NOW });
      return;
    }

    const logsMatch = /^\/v1\/apps\/([^/]+)\/logs$/u.exec(url.pathname);
    if (request.method === 'GET' && logsMatch !== null) {
      if (this.failLogReads) {
        this.send(response, 503, { error: 'provider unavailable' });
        return;
      }
      this.send(response, 200, this.logPages.get(url.searchParams.get('next_token') ?? '') ?? {
        data: [],
        meta: { next_token: '1779235200000000000' },
      });
      return;
    }

    const actionMatch = /^\/v1\/apps\/([^/]+)\/machines\/([^/]+)\/(uncordon|stop)$/u.exec(
      url.pathname,
    );
    if (request.method === 'POST' && actionMatch !== null) {
      const machine = this.machines.find(({ id }) => id === actionMatch[2]);
      if (machine !== undefined && actionMatch[3] === 'stop') machine.state = 'stopped';
      this.send(response, 200, { ok: true });
      return;
    }

    this.send(response, 404, {});
  }

  private send(response: ServerResponse, status: number, body: unknown): void {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  }
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => server.close()));
});

class RecordingVault implements FlyVaultPort {
  readonly calls: unknown[] = [];
  readonly redactionCalls: unknown[] = [];
  values: Readonly<Record<string, string>> = {
    API_KEY: 'top-secret-api-value',
    DATABASE_URL: 'fake-database-value',
  };

  resolveEnvironment(input: Parameters<FlyVaultPort['resolveEnvironment']>[0]) {
    this.calls.push(input);
    return Promise.resolve(
      Object.fromEntries(
        Object.keys(input.references).map((name) => [name, this.values[name] ?? '']),
      ),
    );
  }

  resolveRedactionValues(input: { readonly providerDeploymentId: string; readonly reason: string }) {
    this.redactionCalls.push(input);
    return Promise.resolve(this.values);
  }
}

class RecordingUsage implements FlyUsagePort {
  readonly calls: unknown[] = [];

  record(input: Parameters<FlyUsagePort['record']>[0]): Promise<void> {
    this.calls.push(input);
    return Promise.resolve();
  }
}

const contracts: FlyContractPort = {
  resolve: () => Promise.resolve(contract),
};

async function flyProvider(server: RecordingFlyServer, apiToken = 'fly-test-token') {
  const vault = new RecordingVault();
  const usage = new RecordingUsage();
  const domainCalls: unknown[] = [];
  const apiBaseUrl = await server.start();
  return {
    provider: createFlyDeploymentProvider({
      apiBaseUrl,
      logsBaseUrl: apiBaseUrl,
      apiToken,
      organizationSlug: 'zapp-staging',
      vault,
      contracts,
      usage,
      domains: {
        configure(input: unknown) {
          domainCalls.push(input);
          return Promise.resolve({
            hostname: 'app.example.com',
            status: 'pending_dns',
            dnsInstructions: [
              { type: 'CNAME', name: 'app.example.com', value: 'target.example.net' },
            ],
          });
        },
      },
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      healthPollAttempts: 1,
    }),
    vault,
    usage,
    domainCalls,
  };
}

function productionInput() {
  return {
    projectId: PROJECT,
    environmentId: PRODUCTION_ENVIRONMENT,
    releaseId: RELEASE,
    commitSha: COMMIT,
    artifact: {
      kind: 'container_image' as const,
      reference: `registry.fly.io/${flyAppName(PROJECT, PRODUCTION_ENVIRONMENT)}:${COMMIT}`,
    },
    env: {
      DATABASE_URL: SECRET_DATABASE,
      API_KEY: SECRET_API_KEY,
    },
  };
}

describe('DEP-4a Fly image build and push', () => {
  it('accepts a Dockerfile without requiring package scripts', async () => {
    await expect(
      detectFlyCompatibility(projectContext({ Dockerfile: 'FROM node:22-slim\n' })),
    ).resolves.toEqual({
      providerId: 'fly',
      compatible: true,
      reasons: ['Dockerfile is present.'],
    });
  });

  it('accepts Node build and start scripts and rejects an incomplete Node project', async () => {
    await expect(
      detectFlyCompatibility(
        projectContext({
          'package.json': JSON.stringify({ scripts: { build: 'vite build', start: 'node server.js' } }),
        }),
      ),
    ).resolves.toEqual({
      providerId: 'fly',
      compatible: true,
      reasons: ['Node build and start scripts are present.'],
    });

    await expect(
      detectFlyCompatibility(
        projectContext({ 'package.json': JSON.stringify({ scripts: { build: 'vite build' } }) }),
      ),
    ).resolves.toEqual({
      providerId: 'fly',
      compatible: false,
      reasons: ['Fly requires a Dockerfile or Node build and start scripts.'],
    });
  });

  it('derives a stable provider-safe app and registry name from project and environment IDs', () => {
    expect(flyAppName(PROJECT, ENVIRONMENT)).toBe(
      'zapp-01j00000000000000000000000-production',
    );
    const longEnvironment = `env_${'B'.repeat(80)}`;
    const first = flyAppName(PROJECT, longEnvironment);
    const second = flyAppName(PROJECT, `${longEnvironment}C`);
    expect(first).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u);
    expect(first.length).toBeLessThanOrEqual(63);
    expect(second).not.toBe(first);
  });

  it('renders the generic Node Dockerfile with contract commands and a non-root runtime', () => {
    expect(renderFlyDockerfile(contract)).toMatchInlineSnapshot(`
      "FROM node:22-slim AS build
      WORKDIR /app
      RUN corepack enable
      COPY . .
      RUN [\"sh\",\"-lc\",\"pnpm install --frozen-lockfile\"]
      RUN [\"sh\",\"-lc\",\"pnpm build\"]

      FROM node:22-slim AS runtime
      ENV NODE_ENV=production
      WORKDIR /app
      RUN groupadd --system zapp && useradd --system --gid zapp --home /app zapp
      COPY --from=build --chown=zapp:zapp /app /app
      USER zapp
      CMD [\"sh\",\"-lc\",\"pnpm start\"]
      "
    `);
  });

  it('uses an existing Dockerfile unchanged and returns the exact-commit image artifact', async () => {
    const sandbox = new RecordingBuildSandbox();
    sandbox.existing.add('Dockerfile');
    const dockerfileContract = { ...contract, build: undefined, start: undefined };

    await expect(
      buildFlyImage(
        {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          commitSha: COMMIT,
          contract: dockerfileContract,
        },
        { sandbox },
      ),
    ).resolves.toEqual({
      kind: 'container_image',
      reference:
        'registry.fly.io/zapp-01j00000000000000000000000-production:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(sandbox.writes).toEqual([]);
    expect(sandbox.deletes).toEqual([]);
    expect(sandbox.executions).toEqual([
      {
        command: 'docker',
        args: [
          'buildx',
          'build',
          '--file',
          'Dockerfile',
          '--tag',
          'registry.fly.io/zapp-01j00000000000000000000000-production:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '--push',
          '.',
        ],
        cwd: '.',
        timeoutMs: 1_200_000,
      },
    ]);
  });

  it('writes and removes a temporary generated Dockerfile around the build', async () => {
    const sandbox = new RecordingBuildSandbox();

    await buildFlyImage(
      { projectId: PROJECT, environmentId: ENVIRONMENT, commitSha: COMMIT, contract },
      { sandbox },
    );

    expect(sandbox.writes).toEqual([
      { path: '.zapp/Dockerfile.fly', contents: renderFlyDockerfile(contract) },
    ]);
    expect(sandbox.executions[0]?.args.slice(0, 4)).toEqual([
      'buildx',
      'build',
      '--file',
      '.zapp/Dockerfile.fly',
    ]);
    expect(sandbox.deletes).toEqual(['.zapp/Dockerfile.fly']);
  });

  it('fails closed on buildx failure and still removes the generated Dockerfile', async () => {
    const sandbox = new RecordingBuildSandbox();
    sandbox.exitCode = 1;
    sandbox.stderr = 'registry push denied';

    await expect(
      buildFlyImage(
        { projectId: PROJECT, environmentId: ENVIRONMENT, commitSha: COMMIT, contract },
        { sandbox },
      ),
    ).rejects.toMatchObject({ code: 'fly_image_build_failed' });
    expect(sandbox.deletes).toEqual(['.zapp/Dockerfile.fly']);
  });
});

describe('DEP-4b Fly Machine deploy and rollback', () => {
  it('idempotently creates the app, resolves vault references, and health-gates blue-green traffic', async () => {
    const server = new RecordingFlyServer();
    const appName = flyAppName(PROJECT, PRODUCTION_ENVIRONMENT);
    server.machines.push({
      id: 'machine-old',
      state: 'started',
      config: { image: `registry.fly.io/${appName}:${'b'.repeat(40)}` },
    });
    const { provider, vault, usage } = await flyProvider(server);

    const handle = await provider.deployProduction(productionInput());

    expect(handle).toEqual({
      providerId: 'fly',
      providerDeploymentId: encodeFlyProviderDeploymentId(appName, 'machine-new-1'),
      url: `https://${appName}.fly.dev/`,
      state: 'ready',
      createdAt: NOW,
    });
    expect(vault.calls).toEqual([
      {
        projectId: PROJECT,
        environmentId: PRODUCTION_ENVIRONMENT,
        references: { DATABASE_URL: SECRET_DATABASE, API_KEY: SECRET_API_KEY },
        reason: `deploy release ${RELEASE} to Fly`,
      },
    ]);
    expect(server.requests.slice(0, 5)).toEqual([
      { method: 'GET', path: `/v1/apps/${appName}`, body: undefined },
      {
        method: 'POST',
        path: '/v1/apps',
        body: { app_name: appName, org_slug: 'zapp-staging' },
      },
      {
        method: 'POST',
        path: `/v1/apps/${appName}/secrets/API_KEY`,
        body: { value: 'top-secret-api-value' },
      },
      {
        method: 'POST',
        path: `/v1/apps/${appName}/secrets/DATABASE_URL`,
        body: { value: 'fake-database-value' },
      },
      { method: 'GET', path: `/v1/apps/${appName}/machines`, body: undefined },
    ]);
    const create = server.requests[5];
    expect(create?.method).toBe('POST');
    expect(create?.path).toBe(`/v1/apps/${appName}/machines?skip_service_registration=true`);
    expect(create?.body).toEqual({
      config: {
        image: productionInput().artifact.reference,
        init: { cmd: ['sh', '-lc', 'pnpm start'] },
        metadata: {
          zapp_release_id: RELEASE,
          zapp_project_id: PROJECT,
          zapp_environment_id: PRODUCTION_ENVIRONMENT,
          zapp_commit_sha: COMMIT,
        },
        restart: { policy: 'on-failure', max_retries: 3 },
        services: [
          {
            protocol: 'tcp',
            internal_port: 3_000,
            ports: [{ port: 80, handlers: ['http'] }, { port: 443, handlers: ['tls', 'http'] }],
            http_checks: [
              {
                path: '/health',
                method: 'GET',
                protocol: 'http',
                interval: '10s',
                timeout: '2s',
                grace_period: '5s',
              },
            ],
          },
        ],
      },
    });
    expect(server.requests.slice(6).map(({ path }) => path)).toEqual([
      `/v1/apps/${appName}/machines/machine-new-1`,
      `/v1/apps/${appName}/machines/machine-new-1/uncordon`,
      `/v1/apps/${appName}/machines/machine-old/stop`,
    ]);
    expect(usage.calls).toEqual([
      {
        category: 'deploy_provider',
        provider: 'fly',
        projectId: PROJECT,
        environmentId: PRODUCTION_ENVIRONMENT,
        releaseId: RELEASE,
        providerDeploymentId: encodeFlyProviderDeploymentId(appName, 'machine-new-1'),
        quantity: '1',
        unit: 'deployment',
      },
    ]);
    expect(JSON.stringify(handle)).not.toContain('top-secret');
    expect(JSON.stringify(usage.calls)).not.toContain('top-secret');
  });

  it('does not recreate an app that already exists', async () => {
    const server = new RecordingFlyServer();
    server.appExists = true;
    const { provider } = await flyProvider(server);

    await provider.deployProduction({ ...productionInput(), env: {} });

    expect(server.requests.filter(({ path }) => path === '/v1/apps')).toEqual([]);
  });

  it('does not expose a vault value when the Fly Secrets API rejects it', async () => {
    const server = new RecordingFlyServer();
    server.appExists = true;
    server.rejectSecretName = 'API_KEY';
    const { provider } = await flyProvider(server);

    const error = await provider.deployProduction(productionInput()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'fly_api_error' });
    expect(String(error)).not.toContain('top-secret-api-value');
  });

  it('stops an unhealthy candidate without uncordoning it or stopping the serving Machine', async () => {
    const server = new RecordingFlyServer();
    server.appExists = true;
    server.unhealthyCandidate = true;
    const appName = flyAppName(PROJECT, PRODUCTION_ENVIRONMENT);
    server.machines.push({ id: 'machine-old', state: 'started', config: { image: 'old' } });
    const { provider } = await flyProvider(server);

    await expect(provider.deployProduction({ ...productionInput(), env: {} })).rejects.toMatchObject({
      code: 'fly_health_check_failed',
    });

    const actionPaths = server.requests
      .map(({ path }) => path)
      .filter((path) => path.endsWith('/stop') || path.endsWith('/uncordon'));
    expect(actionPaths).toEqual([`/v1/apps/${appName}/machines/machine-new-1/stop`]);
  });

  it('rolls back by cloning the explicit retained Machine config through the same health gate', async () => {
    const server = new RecordingFlyServer();
    server.appExists = true;
    const appName = flyAppName(PROJECT, PRODUCTION_ENVIRONMENT);
    const retainedConfig = {
      image: `registry.fly.io/${appName}:${'b'.repeat(40)}`,
      init: { cmd: ['sh', '-lc', 'node old.js'] },
      services: [{ internal_port: 3_000 }],
      restart: { policy: 'on-failure' },
      metadata: { zapp_release_id: 'rel_01J00000000000000000000001' },
    };
    server.machines.push(
      { id: 'machine-retained', state: 'stopped', config: retainedConfig },
      { id: 'machine-current', state: 'started', config: { image: 'current' } },
    );
    const { provider, usage } = await flyProvider(server);

    const handle = await provider.rollback({
      projectId: PROJECT,
      environmentId: PRODUCTION_ENVIRONMENT,
      toProviderDeploymentId: encodeFlyProviderDeploymentId(appName, 'machine-retained'),
      reason: 'Restore the previous healthy release.',
    });

    expect(handle.providerDeploymentId).toBe(
      encodeFlyProviderDeploymentId(appName, 'machine-new-1'),
    );
    const create = server.requests.find(({ path }) => path.endsWith('?skip_service_registration=true'));
    expect(create?.body).toEqual({ config: retainedConfig });
    expect(server.requests.slice(-3).map(({ path }) => path)).toEqual([
      `/v1/apps/${appName}/machines/machine-new-1`,
      `/v1/apps/${appName}/machines/machine-new-1/uncordon`,
      `/v1/apps/${appName}/machines/machine-current/stop`,
    ]);
    expect(JSON.stringify(usage.calls)).not.toContain('Restore the previous healthy release.');
  });

  it('rejects a rollback target from another Fly app before any provider mutation', async () => {
    const server = new RecordingFlyServer();
    server.appExists = true;
    const { provider } = await flyProvider(server);

    await expect(
      provider.rollback({
        projectId: PROJECT,
        environmentId: PRODUCTION_ENVIRONMENT,
        toProviderDeploymentId: encodeFlyProviderDeploymentId('zapp-other-project-production', 'machine-old'),
        reason: 'This target belongs to a different application.',
      }),
    ).rejects.toMatchObject({ code: 'fly_cross_app_rollback' });
    expect(server.requests).toEqual([]);
  });
});

describe('DEP-4c Fly status and log streaming', () => {
  it.each([
    {
      label: 'created Machine',
      state: 'created',
      checks: undefined,
      expectedState: 'queued',
      detail: undefined,
    },
    {
      label: 'started Machine without checks',
      state: 'started',
      checks: undefined,
      expectedState: 'deploying',
      detail: undefined,
    },
    {
      label: 'started Machine with pending checks',
      state: 'started',
      checks: [{ name: 'health', status: 'pending' }],
      expectedState: 'deploying',
      detail: undefined,
    },
    {
      label: 'started Machine with critical checks',
      state: 'started',
      checks: [{ name: 'health', status: 'critical' }],
      expectedState: 'failed',
      detail: 'Fly Machine health checks failed.',
    },
    {
      label: 'healthy started Machine',
      state: 'started',
      checks: [{ name: 'health', status: 'passing' }],
      expectedState: 'ready',
      detail: undefined,
    },
    {
      label: 'stopped Machine',
      state: 'stopped',
      checks: undefined,
      expectedState: 'cancelled',
      detail: undefined,
    },
    {
      label: 'failed Machine',
      state: 'failed',
      checks: undefined,
      expectedState: 'failed',
      detail: 'Fly Machine entered the failed state.',
    },
  ])('maps a $label without a false-ready state', async ({ state, checks, expectedState, detail }) => {
    const server = new RecordingFlyServer();
    const appName = flyAppName(PROJECT, PRODUCTION_ENVIRONMENT);
    server.machines.push({
      id: 'machine-status',
      state,
      config: { image: 'retained-image' },
      ...(checks === undefined ? {} : { checks }),
    });
    const { provider } = await flyProvider(server);

    await expect(
      provider.getStatus(encodeFlyProviderDeploymentId(appName, 'machine-status')),
    ).resolves.toEqual({
      providerDeploymentId: encodeFlyProviderDeploymentId(appName, 'machine-status'),
      state: expectedState,
      url: `https://${appName}.fly.dev/`,
      ...(detail === undefined ? {} : { detail }),
      updatedAt: NOW,
    });
  });

  it('turns a Machines API read failure into an explicit failed status', async () => {
    const server = new RecordingFlyServer();
    server.failMachineReads = true;
    const appName = flyAppName(PROJECT, PRODUCTION_ENVIRONMENT);
    const { provider } = await flyProvider(server);

    await expect(
      provider.getStatus(encodeFlyProviderDeploymentId(appName, 'machine-status')),
    ).resolves.toEqual({
      providerDeploymentId: encodeFlyProviderDeploymentId(appName, 'machine-status'),
      state: 'failed',
      detail: 'Fly status could not be retrieved.',
      updatedAt: NOW,
    });
  });

  it('pages the official Logs API, selects one Machine, maps streams, and redacts all vault values', async () => {
    const server = new RecordingFlyServer();
    const appName = flyAppName(PROJECT, PRODUCTION_ENVIRONMENT);
    const deploymentId = encodeFlyProviderDeploymentId(appName, 'machine-logs');
    server.logPages.set('', {
      data: [
        {
          id: 'log-1',
          attributes: {
            level: 'info',
            instance: 'machine-logs',
            message: 'connected with fake-database-value',
            timestamp: '2026-08-11T16:00:01.000Z',
          },
        },
        {
          id: 'other-machine-log',
          attributes: {
            level: 'error',
            instance: 'machine-other',
            message: 'top-secret-api-value belongs elsewhere',
            timestamp: '2026-08-11T16:00:02.000Z',
          },
        },
      ],
      meta: { next_token: '1779235200000000001' },
    });
    server.logPages.set('1779235200000000001', {
      data: [
        {
          id: 'log-2',
          attributes: {
            level: 'error',
            instance: 'machine-logs',
            message: 'API top-secret-api-value failed',
            timestamp: '2026-08-11T16:00:03.000Z',
          },
        },
      ],
      meta: { next_token: '1779235200000000002' },
    });
    server.logPages.set('1779235200000000002', {
      data: [],
      meta: { next_token: '1779235200000000003' },
    });
    const { provider, vault } = await flyProvider(server);

    const logs = [];
    for await (const entry of provider.streamLogs(deploymentId)) logs.push(entry);

    expect(logs).toEqual([
      {
        at: '2026-08-11T16:00:01.000Z',
        stream: 'stdout',
        message: 'connected with [secret:DATABASE_URL]',
      },
      {
        at: '2026-08-11T16:00:03.000Z',
        stream: 'stderr',
        message: 'API [secret:API_KEY] failed',
      },
    ]);
    expect(server.requests.filter(({ path }) => path.includes('/logs')).map(({ path }) => path)).toEqual([
      `/v1/apps/${appName}/logs?instance=machine-logs`,
      `/v1/apps/${appName}/logs?instance=machine-logs&next_token=1779235200000000001`,
      `/v1/apps/${appName}/logs?instance=machine-logs&next_token=1779235200000000002`,
    ]);
    expect(vault.redactionCalls).toEqual([
      { providerDeploymentId: deploymentId, reason: 'redact Fly runtime logs' },
    ]);
    expect(JSON.stringify(logs)).not.toContain('fake-database-value');
    expect(JSON.stringify(logs)).not.toContain('top-secret-api-value');
  });

  it('rejects malformed log records and provider failures with typed errors', async () => {
    const malformedServer = new RecordingFlyServer();
    const appName = flyAppName(PROJECT, PRODUCTION_ENVIRONMENT);
    const deploymentId = encodeFlyProviderDeploymentId(appName, 'machine-logs');
    malformedServer.logPages.set('', {
      data: [{ id: 'bad-log', attributes: { message: 42 } }],
      meta: { next_token: '1779235200000000001' },
    });
    const { provider: malformedProvider } = await flyProvider(malformedServer);

    await expect(async () => {
      for await (const entry of malformedProvider.streamLogs(deploymentId)) void entry;
    }).rejects.toMatchObject({ code: 'fly_invalid_logs_response' });

    const failedServer = new RecordingFlyServer();
    failedServer.failLogReads = true;
    const { provider: failedProvider } = await flyProvider(failedServer);
    await expect(async () => {
      for await (const entry of failedProvider.streamLogs(deploymentId)) void entry;
    }).rejects.toMatchObject({ code: 'fly_api_error' });
  });

  it('uses FlyV1 authentication for scoped tokens across Machines and Logs APIs', async () => {
    const server = new RecordingFlyServer();
    const appName = flyAppName(PROJECT, PRODUCTION_ENVIRONMENT);
    server.machines.push({
      id: 'machine-scoped-auth',
      state: 'started',
      checks: [{ name: 'health', status: 'passing' }],
      config: { image: 'retained-image' },
    });
    const { provider } = await flyProvider(server, 'fm2_scoped-test-token');
    const deploymentId = encodeFlyProviderDeploymentId(appName, 'machine-scoped-auth');

    await provider.getStatus(deploymentId);
    for await (const entry of provider.streamLogs(deploymentId)) void entry;

    expect(server.authorizationHeaders).toEqual([
      'FlyV1 fm2_scoped-test-token',
      'FlyV1 fm2_scoped-test-token',
    ]);
  });

  it('rejects provider-hosted previews and delegates custom domains to the DEP-10 seam', async () => {
    const server = new RecordingFlyServer();
    const { provider, domainCalls } = await flyProvider(server);

    await expect(
      provider.createPreview({
        projectId: PROJECT,
        commitSha: COMMIT,
        artifact: productionInput().artifact,
        env: {},
      }),
    ).rejects.toMatchObject({ code: 'fly_preview_unsupported' });
    expect(server.requests).toEqual([]);

    const input = {
      projectId: PROJECT,
      environmentId: PRODUCTION_ENVIRONMENT,
      hostname: 'app.example.com',
    };
    await expect(provider.configureDomain(input)).resolves.toEqual({
      hostname: 'app.example.com',
      status: 'pending_dns',
      dnsInstructions: [
        { type: 'CNAME', name: 'app.example.com', value: 'target.example.net' },
      ],
    });
    expect(domainCalls).toEqual([input]);
  });
});

const flyStagingRequired = ['FLY_API_TOKEN', 'FLY_ORG_SLUG'] as const;
const flyStagingMissing: string[] = flyStagingRequired.filter(
  (name) => process.env[name] === undefined || process.env[name] === '',
);
if (process.env['ZAPP_FLY_STAGING_ENABLED'] !== '1') {
  flyStagingMissing.push('ZAPP_FLY_STAGING_ENABLED=1');
}
const hasFlyStagingGate = flyStagingMissing.length === 0;
if (!hasFlyStagingGate) {
  process.stderr.write(
    `[@zapp/release-service] Fly staging test SKIPPED — not run, not passed: missing gate ${flyStagingMissing.join(', ')}\n`,
  );
}

function runLiveCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly stdin?: string;
    readonly timeoutMs: number;
  },
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} exceeded its staging timeout.`));
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.end(options.stdin);
  });
}

async function retryUntil<T>(
  operation: () => Promise<T | undefined>,
  attempts = 60,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await operation().catch(() => undefined);
    if (result !== undefined) return result;
    if (attempt + 1 < attempts) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    }
  }
  throw new Error('The Fly staging condition did not become ready.');
}

describe('DEP-4c real Fly staging provider gate', () => {
  it.skipIf(!hasFlyStagingGate)(
    'builds, deploys, observes, rolls back, and cleans up one real staging app',
    async () => {
      const apiToken = (process.env['FLY_API_TOKEN'] ?? '').replace(
        /^(?:Bearer|FlyV1)\s+/u,
        '',
      );
      const apiAuthorization = /^(?:fm1r|fm1a|fm2)_/u.test(apiToken)
        ? `FlyV1 ${apiToken}`
        : `Bearer ${apiToken}`;
      const organizationSlug = process.env['FLY_ORG_SLUG'] ?? '';
      const projectId = newId('proj');
      const environmentId = newId('env');
      const releaseId = newId('rel');
      const secretReference = newId('sec');
      const appName = flyAppName(projectId, environmentId);
      const runtimeProof = randomUUID();
      const fixtureRoot = await mkdtemp(join(tmpdir(), 'zapp-fly-staging-'));
      const dockerConfig = await mkdtemp(join(tmpdir(), 'zapp-fly-docker-'));
      const liveEnvironment = { ...process.env, DOCKER_CONFIG: dockerConfig };
      const liveContract = {
        ...contract,
        install: { command: 'true', timeout_seconds: 30 },
        build: { command: 'true', timeout_seconds: 30 },
        start: { command: 'node server.mjs' },
      };
      const rawFly = async (
        path: string,
        method: 'GET' | 'POST' | 'DELETE',
        body?: unknown,
      ): Promise<Response> =>
        fetch(`https://api.machines.dev/v1${path}`, {
          method,
          headers: {
            accept: 'application/json',
            authorization: apiAuthorization,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
      const cleanupApp = async (): Promise<void> => {
        const response = await rawFly(`/apps/${encodeURIComponent(appName)}`, 'DELETE');
        if (![200, 202, 204, 404].includes(response.status)) {
          throw new Error(`Fly staging cleanup failed with status ${String(response.status)}.`);
        }
      };
      const writeFixture = async (version: string): Promise<void> => {
        await writeFile(
          join(fixtureRoot, 'Dockerfile'),
          [
            'FROM node:22-slim',
            'WORKDIR /app',
            'COPY server.mjs .',
            'USER node',
            'CMD ["node", "server.mjs"]',
            '',
          ].join('\n'),
        );
        await writeFile(
          join(fixtureRoot, 'server.mjs'),
          [
            "import { createServer } from 'node:http';",
            `const version = ${JSON.stringify(version)};`,
            "createServer((request, response) => {",
            "  response.statusCode = 200;",
            "  response.setHeader('content-type', 'text/plain');",
            "  response.end(request.url === '/health' ? 'ok' : `${version}:${process.env.RUNTIME_PROOF ?? 'missing'}`);",
            "}).listen(3000, '0.0.0.0', () => console.log(`runtime-proof ${process.env.RUNTIME_PROOF ?? 'missing'}`));",
            '',
          ].join('\n'),
        );
      };
      const sandbox: FlyBuildSandboxPort = {
        fileExists: (path) =>
          access(resolve(fixtureRoot, path)).then(
            () => true,
            () => false,
          ),
        writeFile: (path, contents) => writeFile(resolve(fixtureRoot, path), contents),
        deleteFile: (path) => rm(resolve(fixtureRoot, path), { force: true }),
        exec: (input) =>
          runLiveCommand(input.command, input.args, {
            cwd: resolve(fixtureRoot, input.cwd),
            env: liveEnvironment,
            timeoutMs: input.timeoutMs,
          }),
      };
      const provider = createFlyDeploymentProvider({
        apiToken,
        organizationSlug,
        vault: {
          resolveEnvironment: () => Promise.resolve({ RUNTIME_PROOF: runtimeProof }),
          resolveRedactionValues: () => Promise.resolve({ RUNTIME_PROOF: runtimeProof }),
        },
        contracts: { resolve: () => Promise.resolve(liveContract) },
        usage: { record: () => Promise.resolve() },
        domains: {
          configure: () => Promise.reject(new Error('DEP-10 is outside this provider gate.')),
        },
        healthPollAttempts: 60,
        healthPollIntervalMs: 2_000,
      });
      const deployVersion = async (commitSha: string, version: string) => {
        await writeFixture(version);
        const artifact = await buildFlyImage(
          { projectId, environmentId, commitSha, contract: liveContract },
          { sandbox },
        );
        return provider.deployProduction({
          projectId,
          environmentId,
          releaseId,
          commitSha,
          artifact,
          env: { RUNTIME_PROOF: secretReference },
        });
      };

      try {
        const login = await runLiveCommand(
          'docker',
          ['login', 'registry.fly.io', '--username', 'x', '--password-stdin'],
          { cwd: fixtureRoot, env: liveEnvironment, stdin: apiToken, timeoutMs: 30_000 },
        );
        expect(login.exitCode, login.stderr).toBe(0);
        const createResponse = await rawFly('/apps', 'POST', {
          app_name: appName,
          org_slug: organizationSlug,
        });
        expect([200, 201]).toContain(createResponse.status);

        const first = await deployVersion('a'.repeat(40), 'v1');
        await expect(provider.getStatus(first.providerDeploymentId)).resolves.toMatchObject({
          state: 'ready',
        });
        await retryUntil(async () => {
          const response = await fetch(first.url ?? '', { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) return undefined;
          return (await response.text()) === `v1:${runtimeProof}` ? true : undefined;
        });
        await retryUntil(async () => {
          const entries = [];
          for await (const entry of provider.streamLogs(first.providerDeploymentId)) entries.push(entry);
          const startup = entries.find(({ message }) => message.includes('runtime-proof'));
          if (startup === undefined) return undefined;
          expect(startup.message).toContain('[secret:RUNTIME_PROOF]');
          expect(startup.message).not.toContain(runtimeProof);
          return true;
        });

        await deployVersion('b'.repeat(40), 'v2');
        await retryUntil(async () => {
          const response = await fetch(first.url ?? '', { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) return undefined;
          return (await response.text()) === `v2:${runtimeProof}` ? true : undefined;
        });
        await provider.rollback({
          projectId,
          environmentId,
          toProviderDeploymentId: first.providerDeploymentId,
          reason: 'DEP-4 staging rollback proof',
        });
        await retryUntil(async () => {
          const response = await fetch(first.url ?? '', { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) return undefined;
          return (await response.text()) === `v1:${runtimeProof}` ? true : undefined;
        });
      } finally {
        try {
          await cleanupApp();
        } finally {
          await Promise.all([
            rm(fixtureRoot, { recursive: true, force: true }),
            rm(dockerConfig, { recursive: true, force: true }),
          ]);
        }
      }
    },
    600_000,
  );
});
