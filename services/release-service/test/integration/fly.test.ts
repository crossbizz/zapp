import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

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
  rejectSecretName: string | undefined;
  readonly requests: RecordedRequest[] = [];
  readonly machines: TestMachine[] = [];
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

async function flyProvider(server: RecordingFlyServer) {
  const vault = new RecordingVault();
  const usage = new RecordingUsage();
  const apiBaseUrl = await server.start();
  return {
    provider: createFlyDeploymentProvider({
      apiBaseUrl,
      apiToken: 'fly-test-token',
      organizationSlug: 'zapp-staging',
      vault,
      contracts,
      usage,
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      healthPollAttempts: 1,
    }),
    vault,
    usage,
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
