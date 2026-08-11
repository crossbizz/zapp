import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ProductionDeploymentInput } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createVercelDeploymentProvider,
  decodeVercelProviderDeploymentId,
  detectVercelCompatibility,
  encodeVercelProviderDeploymentId,
  type VercelArtifactPort,
  type VercelConnectionPort,
  type VercelHintsPort,
  type VercelVaultPort,
} from '../../src/providers/vercel.js';

const PROJECT = 'proj_01J00000000000000000000000';
const OTHER_PROJECT = 'proj_01J00000000000000000000001';
const ENVIRONMENT = 'env-production';
const RELEASE = 'rel_01J00000000000000000000000';
const COMMIT = 'a'.repeat(40);
const NOW = '2026-08-11T20:00:00.000Z';
const ACCESS_TOKEN = 'vercel-access-token-value';
const API_SECRET = 'runtime-secret-value';
const CREDENTIAL_REFERENCE = 'vault://integration/vercel';
const API_SECRET_REFERENCE = 'vault://environment/API_SECRET';

function projectContext(adapterId: string) {
  return {
    workspaceRoot: '.',
    detection: { adapterId, confidence: 0.99, evidence: ['package.json'] },
    listFiles: () => Promise.resolve([]),
    readFile: () => Promise.reject(new Error('not used')),
  };
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
}

interface TestDeployment {
  readonly id: string;
  readonly url: string;
  readyState: string;
  readonly createdAt: number;
  readonly errorMessage?: string;
}

const openServers: RecordingVercelServer[] = [];

class RecordingVercelServer {
  readonly requests: RecordedRequest[] = [];
  readonly deployments = new Map<string, TestDeployment>();
  events: unknown[] | null = [];
  domainResponse: unknown = {
    name: 'app.example.com',
    apexName: 'example.com',
    projectId: 'prj_external',
    verified: false,
    verification: [
      { type: 'TXT', domain: '_vercel.app.example.com', value: 'verify-value', reason: 'pending' },
    ],
  };
  rejectDuplicateDomain = false;
  private domainPosts = 0;
  failPath: string | undefined;
  private nextDeployment = 1;
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
    openServers.push(this);
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}`;
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
    const bodyBytes = await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });
    const url = new URL(request.url ?? '/', 'http://vercel.test');
    const contentType = request.headers['content-type'] ?? '';
    const body: unknown =
      bodyBytes.length === 0
        ? undefined
        : contentType.includes('application/json')
          ? JSON.parse(bodyBytes.toString('utf8'))
          : new Uint8Array(bodyBytes);
    this.requests.push({
      method: request.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization ?? '',
      headers: request.headers,
      body,
    });

    if (this.failPath !== undefined && url.pathname === this.failPath) {
      this.send(response, 502, { error: { code: 'provider_failed', message: API_SECRET } });
      return;
    }

    if (request.method === 'POST' && /^\/v10\/projects\/[^/]+\/env$/u.test(url.pathname)) {
      this.send(response, 201, []);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v2/files') {
      this.send(response, 200, {});
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v13/deployments') {
      const id = `dpl_new_${String(this.nextDeployment++)}`;
      const deployment: TestDeployment = {
        id,
        url: `${id}.vercel.app`,
        readyState: 'QUEUED',
        createdAt: Date.parse(NOW),
      };
      this.deployments.set(id, deployment);
      this.send(response, 200, deployment);
      return;
    }

    const deploymentMatch = /^\/v13\/deployments\/([^/]+)$/u.exec(url.pathname);
    if (request.method === 'GET' && deploymentMatch !== null) {
      const deployment = this.deployments.get(deploymentMatch[1] ?? '');
      this.send(response, deployment === undefined ? 404 : 200, deployment ?? {});
      return;
    }
    const eventsMatch = /^\/v3\/deployments\/([^/]+)\/events$/u.exec(url.pathname);
    if (request.method === 'GET' && eventsMatch !== null) {
      this.send(response, 200, this.events);
      return;
    }
    if (
      request.method === 'POST' &&
      /^\/v1\/projects\/[^/]+\/rollback\/[^/]+$/u.test(url.pathname)
    ) {
      response.statusCode = 201;
      response.end();
      return;
    }
    if (request.method === 'POST' && /^\/v10\/projects\/[^/]+\/domains$/u.test(url.pathname)) {
      this.domainPosts += 1;
      if (this.rejectDuplicateDomain && this.domainPosts > 1) {
        this.send(response, 400, { error: { code: 'domain_already_in_use' } });
        return;
      }
      this.send(response, 200, this.domainResponse);
      return;
    }
    if (request.method === 'GET' && /^\/v9\/projects\/[^/]+\/domains\/[^/]+$/u.test(url.pathname)) {
      this.send(response, 200, this.domainResponse);
      return;
    }

    this.send(response, 404, { error: 'not found' });
  }

  private send(response: ServerResponse, status: number, value: unknown): void {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(value));
  }
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

class RecordingConnectionPort implements VercelConnectionPort {
  readonly calls: unknown[] = [];

  resolve(input: unknown): Promise<unknown> {
    this.calls.push(input);
    return Promise.resolve({
      provider: 'vercel',
      status: 'connected',
      credentialRef: CREDENTIAL_REFERENCE,
      configuration: {
        projectId: 'prj_external',
        projectName: 'zapp-staging',
        teamId: 'team_test',
      },
    });
  }
}

class RecordingVaultPort implements VercelVaultPort {
  readonly credentialCalls: unknown[] = [];
  readonly environmentCalls: unknown[] = [];
  readonly redactionCalls: unknown[] = [];

  resolveCredential(input: unknown): Promise<unknown> {
    this.credentialCalls.push(input);
    return Promise.resolve({ token: ACCESS_TOKEN });
  }

  resolveEnvironment(input: unknown): Promise<unknown> {
    this.environmentCalls.push(input);
    return Promise.resolve({ API_SECRET });
  }

  resolveRedactionValues(input: unknown): Promise<unknown> {
    this.redactionCalls.push(input);
    return Promise.resolve({ API_SECRET });
  }
}

class RecordingArtifactPort implements VercelArtifactPort {
  readonly calls: unknown[] = [];
  files: readonly { readonly path: string; readonly contents: Uint8Array }[] = [
    { path: '.vercel/output/z-last.txt', contents: new TextEncoder().encode('last') },
    { path: '.vercel/output/index.html', contents: new TextEncoder().encode('first') },
  ];

  listFiles(input: unknown): Promise<unknown> {
    this.calls.push(input);
    return Promise.resolve(this.files);
  }
}

class RecordingHintsPort implements VercelHintsPort {
  readonly calls: unknown[] = [];
  adapterId = 'next';

  resolve(input: unknown): Promise<unknown> {
    this.calls.push(input);
    return Promise.resolve({ adapterId: this.adapterId });
  }
}

async function fixture() {
  const server = new RecordingVercelServer();
  const apiBaseUrl = await server.start();
  const connection = new RecordingConnectionPort();
  const vault = new RecordingVaultPort();
  const artifacts = new RecordingArtifactPort();
  const hints = new RecordingHintsPort();
  const provider = createVercelDeploymentProvider({
    apiBaseUrl,
    connection,
    vault,
    artifacts,
    hints,
    fetch,
    now: () => new Date(NOW),
  });
  return { server, connection, vault, artifacts, hints, provider };
}

function productionInput(
  overrides: Partial<ProductionDeploymentInput> = {},
): ProductionDeploymentInput {
  return {
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    releaseId: RELEASE,
    commitSha: COMMIT,
    artifact: { kind: 'directory', reference: '.vercel/output' },
    env: { API_SECRET: API_SECRET_REFERENCE },
    ...overrides,
  };
}

describe('DEP-5 Vercel compatibility and identity', () => {
  it.each(['next', 'vite', 'astro', 'sveltekit', 'nuxt'])(
    'accepts the %s project-adapter hint',
    async (adapterId) => {
      await expect(detectVercelCompatibility(projectContext(adapterId))).resolves.toEqual({
        providerId: 'vercel',
        compatible: true,
        reasons: [`Project adapter ${adapterId} provides a Vercel deployment hint.`],
      });
    },
  );

  it('rejects a provider hint outside the binding framework set', async () => {
    await expect(detectVercelCompatibility(projectContext('generic-node'))).resolves.toEqual({
      providerId: 'vercel',
      compatible: false,
      reasons: ['Vercel requires a next, vite, astro, sveltekit, or nuxt project-adapter hint.'],
    });
  });

  it('round-trips a provider id without exposing credentials or provider identity in product ids', () => {
    const encoded = encodeVercelProviderDeploymentId(PROJECT, 'dpl_target');
    expect(encoded).not.toContain(ACCESS_TOKEN);
    expect(decodeVercelProviderDeploymentId(encoded)).toEqual({
      projectId: PROJECT,
      deploymentId: 'dpl_target',
    });
  });
});

describe('DEP-5 Vercel production deployment', () => {
  it('uploads deterministic digests, syncs production env from vault, and targets production explicitly', async () => {
    const { server, connection, vault, artifacts, hints, provider } = await fixture();

    const handle = await provider.deployProduction(productionInput());

    const indexSha = createHash('sha1').update('first').digest('hex');
    const lastSha = createHash('sha1').update('last').digest('hex');
    expect(handle).toEqual({
      providerId: 'vercel',
      providerDeploymentId: encodeVercelProviderDeploymentId(PROJECT, 'dpl_new_1'),
      url: 'https://dpl_new_1.vercel.app/',
      state: 'queued',
      createdAt: NOW,
    });
    expect(connection.calls).toEqual([{ projectId: PROJECT, provider: 'vercel' }]);
    expect(vault.credentialCalls).toEqual([
      {
        projectId: PROJECT,
        credentialRef: CREDENTIAL_REFERENCE,
        reason: 'deploy release rel_01J00000000000000000000000 to Vercel',
      },
    ]);
    expect(vault.environmentCalls).toEqual([
      {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        references: { API_SECRET: API_SECRET_REFERENCE },
        reason: 'sync production environment for Vercel release rel_01J00000000000000000000000',
      },
    ]);
    expect(artifacts.calls).toEqual([
      { projectId: PROJECT, commitSha: COMMIT, directory: '.vercel/output' },
    ]);
    expect(hints.calls).toEqual([{ projectId: PROJECT, commitSha: COMMIT }]);

    const mutationRequests = server.requests.filter(({ method }) => method === 'POST');
    expect(mutationRequests.map(({ path }) => path)).toEqual([
      '/v10/projects/prj_external/env?teamId=team_test&upsert=true',
      '/v2/files?teamId=team_test',
      '/v2/files?teamId=team_test',
      '/v13/deployments?teamId=team_test&skipAutoDetectionConfirmation=1&prebuilt=1',
    ]);
    expect(mutationRequests[0]?.body).toEqual([
      { key: 'API_SECRET', value: API_SECRET, type: 'sensitive', target: ['production'] },
    ]);
    expect(mutationRequests[1]?.headers['x-vercel-digest']).toBe(indexSha);
    expect(mutationRequests[1]?.headers['content-length']).toBe('5');
    expect(mutationRequests[2]?.headers['x-vercel-digest']).toBe(lastSha);
    expect(mutationRequests[3]?.body).toEqual({
      name: 'zapp-staging',
      project: 'prj_external',
      files: [
        { file: '.vercel/output/index.html', sha: indexSha, size: 5 },
        { file: '.vercel/output/z-last.txt', sha: lastSha, size: 4 },
      ],
      projectSettings: { framework: 'nextjs' },
      target: 'production',
      meta: {
        zappCommitSha: COMMIT,
        zappEnvironmentId: ENVIRONMENT,
        zappReleaseId: RELEASE,
      },
    });
    expect(
      mutationRequests.every(({ authorization }) => authorization === `Bearer ${ACCESS_TOKEN}`),
    ).toBe(true);
    expect(JSON.stringify(handle)).not.toContain(API_SECRET);
    expect(JSON.stringify(handle)).not.toContain(ACCESS_TOKEN);
  });

  it('sets every supported framework preset explicitly', async () => {
    const expected = new Map([
      ['next', 'nextjs'],
      ['vite', 'vite'],
      ['astro', 'astro'],
      ['sveltekit', 'sveltekit'],
      ['nuxt', 'nuxtjs'],
    ]);
    for (const [adapterId, framework] of expected) {
      const built = await fixture();
      built.hints.adapterId = adapterId;
      await built.provider.deployProduction(productionInput());
      const request = built.server.requests.find(({ path }) => path.startsWith('/v13/deployments'));
      expect(request?.body).toMatchObject({ projectSettings: { framework } });
    }
  });

  it('rejects provider-hosted previews before resolving a user credential', async () => {
    const { provider, connection, vault } = await fixture();
    await expect(
      provider.createPreview({
        projectId: PROJECT,
        commitSha: COMMIT,
        artifact: { kind: 'directory', reference: 'dist' },
        env: {},
      }),
    ).rejects.toMatchObject({ code: 'vercel_preview_unsupported' });
    expect(connection.calls).toEqual([]);
    expect(vault.credentialCalls).toEqual([]);
  });

  it('rejects non-directory, empty, duplicate, and escaping artifacts before provider mutation', async () => {
    const built = await fixture();
    await expect(
      built.provider.deployProduction(
        productionInput({ artifact: { kind: 'container_image', reference: 'registry/image:sha' } }),
      ),
    ).rejects.toMatchObject({ code: 'vercel_invalid_artifact' });

    for (const files of [
      [],
      [
        { path: '.vercel/output/same.txt', contents: new Uint8Array([1]) },
        { path: '.vercel/output/same.txt', contents: new Uint8Array([2]) },
      ],
      [{ path: '../escape.txt', contents: new Uint8Array([1]) }],
    ]) {
      const next = await fixture();
      next.artifacts.files = files;
      await expect(next.provider.deployProduction(productionInput())).rejects.toMatchObject({
        code: 'vercel_invalid_artifact',
      });
      expect(next.server.requests).toEqual([]);
    }
    expect(built.server.requests).toEqual([]);
  });

  it('requires the Build Output API directory so uploaded output cannot be rebuilt', async () => {
    const built = await fixture();
    await expect(
      built.provider.deployProduction(
        productionInput({ artifact: { kind: 'directory', reference: 'dist' } }),
      ),
    ).rejects.toMatchObject({ code: 'vercel_invalid_artifact' });
    expect(built.server.requests).toEqual([]);
  });

  it('fails closed without echoing a rejected secret or token', async () => {
    const { server, provider } = await fixture();
    server.failPath = '/v10/projects/prj_external/env';
    const error = await provider
      .deployProduction(productionInput())
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'vercel_api_error' });
    expect(String(error)).not.toContain(API_SECRET);
    expect(String(error)).not.toContain(ACCESS_TOKEN);
  });
});

describe('DEP-5 Vercel status, logs, rollback, and domains', () => {
  it.each([
    ['QUEUED', 'queued'],
    ['INITIALIZING', 'deploying'],
    ['BUILDING', 'building'],
    ['READY', 'ready'],
    ['ERROR', 'failed'],
    ['CANCELED', 'cancelled'],
  ] as const)('maps Vercel %s to %s', async (readyState, expected) => {
    const { server, provider } = await fixture();
    server.deployments.set('dpl_status', {
      id: 'dpl_status',
      url: 'dpl-status.vercel.app',
      readyState,
      createdAt: Date.parse(NOW),
    });
    await expect(
      provider.getStatus(encodeVercelProviderDeploymentId(PROJECT, 'dpl_status')),
    ).resolves.toMatchObject({ state: expected, url: 'https://dpl-status.vercel.app/' });
  });

  it('reports status retrieval failure as failed instead of success', async () => {
    const { server, provider } = await fixture();
    server.failPath = '/v13/deployments/dpl_missing';
    await expect(
      provider.getStatus(encodeVercelProviderDeploymentId(PROJECT, 'dpl_missing')),
    ).resolves.toMatchObject({
      state: 'failed',
      detail: 'Vercel status could not be retrieved.',
    });
  });

  it('redacts vault values from a provider failure detail', async () => {
    const { server, provider } = await fixture();
    server.deployments.set('dpl_failed', {
      id: 'dpl_failed',
      url: 'failed.vercel.app',
      readyState: 'ERROR',
      createdAt: Date.parse(NOW),
      errorMessage: `build rejected ${API_SECRET}`,
    });
    await expect(
      provider.getStatus(encodeVercelProviderDeploymentId(PROJECT, 'dpl_failed')),
    ).resolves.toMatchObject({
      state: 'failed',
      detail: 'build rejected [secret:API_SECRET]',
    });
  });

  it('validates and redacts deployment event logs', async () => {
    const { server, provider, vault } = await fixture();
    server.events = [
      { type: 'stdout', created: Date.parse(NOW), text: `connected with ${API_SECRET}` },
      {
        type: 'fatal',
        created: Date.parse(NOW) + 1,
        payload: { text: `fatal ${API_SECRET}` },
      },
    ];
    const providerDeploymentId = encodeVercelProviderDeploymentId(PROJECT, 'dpl_logs');
    const logs = [];
    for await (const log of provider.streamLogs(providerDeploymentId)) logs.push(log);
    expect(logs).toEqual([
      { at: NOW, stream: 'stdout', message: 'connected with [secret:API_SECRET]' },
      {
        at: new Date(Date.parse(NOW) + 1).toISOString(),
        stream: 'stderr',
        message: 'fatal [secret:API_SECRET]',
      },
    ]);
    expect(vault.redactionCalls).toEqual([
      { providerDeploymentId, reason: 'redact Vercel deployment logs' },
    ]);
  });

  it('treats a null Vercel events response as an empty log stream', async () => {
    const { server, provider } = await fixture();
    server.events = null;
    const logs = [];
    for await (const log of provider.streamLogs(
      encodeVercelProviderDeploymentId(PROJECT, 'dpl_no_logs'),
    )) {
      logs.push(log);
    }
    expect(logs).toEqual([]);
  });

  it('rolls back to an explicit same-project deployment and rejects a cross-project target before mutation', async () => {
    const { server, provider } = await fixture();
    server.deployments.set('dpl_previous', {
      id: 'dpl_previous',
      url: 'previous.vercel.app',
      readyState: 'READY',
      createdAt: Date.parse(NOW),
    });
    const target = encodeVercelProviderDeploymentId(PROJECT, 'dpl_previous');
    await expect(
      provider.rollback({
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        toProviderDeploymentId: target,
        reason: 'restore known good',
      }),
    ).resolves.toMatchObject({ providerDeploymentId: target, state: 'ready' });
    expect(
      server.requests.some(
        ({ path }) =>
          path ===
          '/v1/projects/prj_external/rollback/dpl_previous?teamId=team_test&description=restore+known+good',
      ),
    ).toBe(true);

    const requestCount = server.requests.length;
    await expect(
      provider.rollback({
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        toProviderDeploymentId: encodeVercelProviderDeploymentId(OTHER_PROJECT, 'dpl_previous'),
        reason: 'invalid target',
      }),
    ).rejects.toMatchObject({ code: 'vercel_cross_project_rollback' });
    expect(server.requests).toHaveLength(requestCount);
  });

  it('maps Vercel domain verification challenges into binding DNS instructions', async () => {
    const { server, provider } = await fixture();
    server.rejectDuplicateDomain = true;
    await expect(
      provider.configureDomain({
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        hostname: 'app.example.com',
      }),
    ).resolves.toEqual({
      hostname: 'app.example.com',
      status: 'pending_dns',
      dnsInstructions: [{ type: 'TXT', name: '_vercel.app.example.com', value: 'verify-value' }],
    });
    expect(server.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/v10/projects/prj_external/domains?teamId=team_test',
      body: { name: 'app.example.com' },
    });

    server.domainResponse = {
      name: 'app.example.com',
      apexName: 'example.com',
      projectId: 'prj_external',
      verified: true,
    };
    await expect(
      provider.configureDomain({
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        hostname: 'app.example.com',
      }),
    ).resolves.toMatchObject({ status: 'active', dnsInstructions: [] });
    expect(server.requests.slice(-2).map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /v10/projects/prj_external/domains?teamId=team_test',
      'GET /v9/projects/prj_external/domains/app.example.com?teamId=team_test',
    ]);
  });
});

const stagingMissing = [
  'VERCEL_ACCESS_TOKEN',
  'VERCEL_PROJECT_ID',
  'VERCEL_PROJECT_NAME',
  'ZAPP_VERCEL_STAGING_ENABLED=1',
].filter((name) =>
  name.endsWith('=1')
    ? process.env[name.slice(0, -2)] !== '1'
    : (process.env[name] ?? '').trim() === '',
);
const stagingEnabled = stagingMissing.length === 0;
if (!stagingEnabled) {
  console.error(
    `[@zapp/release-service] Vercel staging test SKIPPED — not run, not passed: missing gate ${stagingMissing.join(', ')}`,
  );
}

it.skipIf(!stagingEnabled)(
  'DEP-5 real Vercel staging provider gate',
  async () => {
    const token = process.env['VERCEL_ACCESS_TOKEN'] ?? '';
    const externalProjectId = process.env['VERCEL_PROJECT_ID'] ?? '';
    const projectName = process.env['VERCEL_PROJECT_NAME'] ?? '';
    const teamId = (process.env['VERCEL_TEAM_ID'] ?? '').trim() || undefined;
    const marker = `dep5-${Date.now().toString(36)}`;
    const productionUrl = `https://${projectName}.vercel.app/`;
    const providerDeploymentIds: string[] = [];
    let lifecycleError: unknown;

    const projectSchema = z
      .object({
        targets: z
          .record(
            z
              .object({ id: z.string().trim().min(1) })
              .passthrough()
              .nullable(),
          )
          .optional(),
      })
      .passthrough();
    const environmentEntrySchema = z
      .object({
        id: z.string().trim().min(1).optional(),
        key: z.string().trim().min(1),
        value: z.string(),
        type: z.enum(['encrypted', 'plain', 'secret', 'sensitive', 'system']),
        target: z.union([z.string(), z.array(z.string())]).optional(),
        comment: z.string().optional(),
      })
      .passthrough();
    const environmentListResponseSchema = z
      .object({ envs: z.array(environmentEntrySchema) })
      .passthrough();

    const requestVercel = async (
      path: string,
      init: RequestInit,
      expectedStatuses: readonly number[],
      query: readonly [string, string][] = [],
    ): Promise<unknown> => {
      const url = new URL(path, 'https://api.vercel.com');
      if (teamId !== undefined) url.searchParams.set('teamId', teamId);
      for (const [name, value] of query) url.searchParams.set(name, value);
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      const response = await fetch(url, { ...init, headers });
      if (!expectedStatuses.includes(response.status)) {
        throw new Error(`Vercel staging ${init.method ?? 'GET'} request was rejected.`);
      }
      const text = await response.text();
      if (text === '') return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error('Vercel staging API returned invalid JSON.');
      }
    };

    const readEnvironmentEntries = async () => {
      const value = await requestVercel(
        `/v10/projects/${encodeURIComponent(externalProjectId)}/env`,
        { method: 'GET' },
        [200],
        [['decrypt', 'true']],
      );
      const list = environmentListResponseSchema.safeParse(value);
      return list.success ? list.data.envs : [environmentEntrySchema.parse(value)];
    };

    const appliesToProduction = (target: string | readonly string[] | undefined): boolean => {
      if (target === undefined) return true;
      if (typeof target === 'string') return target === 'production';
      return target.includes('production');
    };

    const projectSnapshot = projectSchema.parse(
      await requestVercel(
        `/v9/projects/${encodeURIComponent(externalProjectId)}`,
        { method: 'GET' },
        [200],
      ),
    );
    const baselineDeploymentId = projectSnapshot.targets?.['production']?.id;
    if (baselineDeploymentId === undefined) {
      throw new Error(
        'Vercel staging project has no production deployment to restore after the test.',
      );
    }
    const baselineResponse = await fetch(productionUrl, {
      headers: { 'cache-control': 'no-cache' },
    });
    if (!baselineResponse.ok) {
      throw new Error('Vercel staging production URL was not healthy before the test.');
    }
    const baselineBody = await baselineResponse.text();
    const baselineEnvironmentEntries = (await readEnvironmentEntries()).filter(
      (entry) => entry.key === 'ZAPP_DEP5_RUNTIME_MARKER' && appliesToProduction(entry.target),
    );
    if (baselineEnvironmentEntries.length > 1) {
      throw new Error(
        'Vercel staging project has ambiguous production marker environment entries.',
      );
    }
    const baselineEnvironment = baselineEnvironmentEntries[0];

    const stagingProvider = (version: string) =>
      createVercelDeploymentProvider({
        connection: {
          resolve: () =>
            Promise.resolve({
              provider: 'vercel',
              status: 'connected',
              credentialRef: 'vault://staging/vercel',
              configuration: { projectId: externalProjectId, projectName, teamId },
            }),
        },
        vault: {
          resolveCredential: () => Promise.resolve({ token }),
          resolveEnvironment: () => Promise.resolve({ ZAPP_DEP5_RUNTIME_MARKER: marker }),
          resolveRedactionValues: () => Promise.resolve({ ZAPP_DEP5_RUNTIME_MARKER: marker }),
        },
        hints: { resolve: () => Promise.resolve({ adapterId: 'next' }) },
        artifacts: {
          listFiles: () =>
            Promise.resolve([
              {
                path: '.vercel/output/config.json',
                contents: new TextEncoder().encode(
                  JSON.stringify({
                    version: 3,
                    routes: [{ src: '/', dest: '/index' }],
                    framework: { version: '15.0.0' },
                  }),
                ),
              },
              {
                path: '.vercel/output/functions/index.func/.vc-config.json',
                contents: new TextEncoder().encode(
                  JSON.stringify({
                    runtime: 'nodejs20.x',
                    handler: 'index.js',
                    launcherType: 'Nodejs',
                    shouldAddHelpers: true,
                  }),
                ),
              },
              {
                path: '.vercel/output/functions/index.func/index.js',
                contents: new TextEncoder().encode(
                  `module.exports = (_request, response) => { response.setHeader('content-type', 'text/plain'); response.end(${JSON.stringify(version)} + ':' + (process.env.ZAPP_DEP5_RUNTIME_MARKER ?? 'missing')); };`,
                ),
              },
            ]),
        },
        fetch,
      });

    const waitForReady = async (
      provider: ReturnType<typeof createVercelDeploymentProvider>,
      providerDeploymentId: string,
    ): Promise<void> => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const status = await provider.getStatus(providerDeploymentId);
        if (status.state === 'ready') return;
        if (status.state === 'failed' || status.state === 'cancelled') {
          throw new Error(`Vercel staging deployment ended in ${status.state}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      throw new Error('Vercel staging deployment did not become ready before the timeout.');
    };

    const waitForBody = async (url: string, expected: string): Promise<void> => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
        if (response.ok && (await response.text()).includes(expected)) return;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      throw new Error('Vercel staging URL did not serve the expected immutable release content.');
    };

    const waitForExactBody = async (expected: string): Promise<void> => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await fetch(productionUrl, {
          headers: { 'cache-control': 'no-cache' },
        });
        if (response.ok && (await response.text()) === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      throw new Error('Vercel staging production content was not restored before the timeout.');
    };

    try {
      const firstProvider = stagingProvider('version-one');
      const first = await firstProvider.deployProduction(
        productionInput({
          commitSha: 'a'.repeat(40),
          env: { ZAPP_DEP5_RUNTIME_MARKER: 'vault://staging/runtime-marker' },
        }),
      );
      providerDeploymentIds.push(first.providerDeploymentId);
      await waitForReady(firstProvider, first.providerDeploymentId);
      await waitForBody(first.url ?? '', `version-one:${marker}`);

      const secondProvider = stagingProvider('version-two');
      const second = await secondProvider.deployProduction(
        productionInput({
          commitSha: 'b'.repeat(40),
          env: { ZAPP_DEP5_RUNTIME_MARKER: 'vault://staging/runtime-marker' },
        }),
      );
      providerDeploymentIds.push(second.providerDeploymentId);
      await waitForReady(secondProvider, second.providerDeploymentId);
      await waitForBody(productionUrl, `version-two:${marker}`);

      await secondProvider.rollback({
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        toProviderDeploymentId: first.providerDeploymentId,
        reason: 'DEP-5 staging restore',
      });
      await waitForBody(productionUrl, `version-one:${marker}`);
    } catch (error) {
      lifecycleError = error;
    }

    const restorationErrors: unknown[] = [];
    try {
      const currentEntries = (await readEnvironmentEntries()).filter(
        (entry) => entry.key === 'ZAPP_DEP5_RUNTIME_MARKER' && appliesToProduction(entry.target),
      );
      for (const entry of currentEntries) {
        if (baselineEnvironment?.id !== undefined && entry.id === baselineEnvironment.id) continue;
        if (entry.id === undefined) {
          throw new Error('Vercel staging marker environment entry has no cleanup identifier.');
        }
        await requestVercel(
          `/v9/projects/${encodeURIComponent(externalProjectId)}/env/${encodeURIComponent(entry.id)}`,
          { method: 'DELETE' },
          [200],
        );
      }
      if (baselineEnvironment !== undefined) {
        await requestVercel(
          `/v10/projects/${encodeURIComponent(externalProjectId)}/env`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify([
              {
                key: baselineEnvironment.key,
                value: baselineEnvironment.value,
                type: baselineEnvironment.type,
                target: baselineEnvironment.target ?? ['production'],
                ...(baselineEnvironment.comment === undefined
                  ? {}
                  : { comment: baselineEnvironment.comment }),
              },
            ]),
          },
          [201],
          [['upsert', 'true']],
        );
      }
    } catch (error) {
      restorationErrors.push(error);
    }

    try {
      if (providerDeploymentIds.length > 0) {
        await requestVercel(
          `/v1/projects/${encodeURIComponent(externalProjectId)}/rollback/${encodeURIComponent(baselineDeploymentId)}`,
          { method: 'POST' },
          [201],
          [['description', 'Restore pre-DEP-5 staging production']],
        );
        await waitForExactBody(baselineBody);
      }
    } catch (error) {
      restorationErrors.push(error);
    }

    const cleanupErrors: unknown[] = [];
    if (restorationErrors.length === 0) {
      for (const providerDeploymentId of providerDeploymentIds.reverse()) {
        const { deploymentId } = decodeVercelProviderDeploymentId(providerDeploymentId);
        try {
          await requestVercel(
            `/v13/deployments/${encodeURIComponent(deploymentId)}`,
            { method: 'DELETE' },
            [200, 204],
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (lifecycleError !== undefined || restorationErrors.length > 0 || cleanupErrors.length > 0) {
      throw new AggregateError(
        [lifecycleError, ...restorationErrors, ...cleanupErrors].filter(
          (error) => error !== undefined,
        ),
        'Vercel staging lifecycle, restoration, or cleanup failed.',
      );
    }
  },
  180_000,
);
