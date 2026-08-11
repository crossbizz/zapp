import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { createGitHubProvider } from '../src/integrations/github/app.js';
import {
  createInMemoryGitHubAuthorizationStateStore,
  createRedisGitHubAuthorizationStateStore,
  GITHUB_AUTHORIZATION_STATE_TTL_MS,
  type GitHubAuthorizationStateStore,
} from '../src/integrations/github/store.js';
import type {
  GitHubBranch,
  GitHubProviderPort,
  GitHubRepository,
} from '../src/integrations/github/ports.js';
import { GitHubProviderError } from '../src/integrations/github/ports.js';
import type {
  GitHubCompleteInstallationInput,
  GitHubInstallation,
} from '../src/integrations/github/schemas.js';
import { GitHubBranchSchema } from '../src/integrations/github/schemas.js';
import { IDEMPOTENT_REPLAY_HEADER } from '../src/plugins/idempotency.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import type { RedisCommands } from '../src/redis/client.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const OWNER: AuthIdentity = {
  externalId: 'github-owner',
  email: 'owner@github.test',
  displayName: 'Octavia Owner',
};
const BUILDER: AuthIdentity = {
  externalId: 'github-builder',
  email: 'builder@github.test',
  displayName: 'Basil Builder',
};
const CALLBACK_CODE = 'callback-code-must-not-leak';
const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

class RecordingGitHubProvider implements GitHubProviderPort {
  readonly installations: Array<{ installationId: string; code: string }> = [];
  readonly repositoryCalls: Array<{ installationId: string; cursor?: string }> = [];
  readonly branchCalls: Array<{ installationId: string; repositoryId: string; cursor?: string }> = [];
  repositoryError: Error | undefined;
  installationError: Error | undefined;
  branchHeadCommitSha = 'a'.repeat(40);

  completeInstallation(input: GitHubCompleteInstallationInput): Promise<GitHubInstallation> {
    this.installations.push(input);
    if (this.installationError !== undefined) return Promise.reject(this.installationError);
    return Promise.resolve(input);
  }

  listRepositories(input: { installationId: string; cursor?: string }) {
    this.repositoryCalls.push(input);
    if (this.repositoryError !== undefined) return Promise.reject(this.repositoryError);
    const items: GitHubRepository[] = [
      { id: '501', fullName: 'zapp/example', private: true, defaultBranch: 'main' },
    ];
    return Promise.resolve({ items, nextCursor: input.cursor === undefined ? 'opaque-page-2' : null });
  }

  listBranches(input: { installationId: string; repositoryId: string; cursor?: string }) {
    this.branchCalls.push(input);
    const items: GitHubBranch[] = [{ name: 'main', headCommitSha: this.branchHeadCommitSha }];
    return Promise.resolve({ items, nextCursor: null });
  }
}

async function organization(
  harness: Harness,
  session: TestSession,
  name: string,
): Promise<string> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: session.headers,
    payload: { name },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ organization: { id: string } }>().organization.id;
}

function as(session: TestSession, organizationId: string): Record<string, string> {
  return { ...session.headers, [ORGANIZATION_HEADER]: organizationId };
}

async function joinBuilder(
  harness: Harness,
  owner: TestSession,
  organizationId: string,
): Promise<TestSession> {
  const invite = await harness.app.inject({
    method: 'POST',
    url: `/v1/organizations/${organizationId}/invites`,
    headers: owner.headers,
    payload: { email: BUILDER.email, role: 'builder' },
  });
  const builder = await signIn(harness, BUILDER);
  const accepted = await harness.app.inject({
    method: 'POST',
    url: `/v1/invites/${invite.json<{ token: string }>().token}/accept`,
    headers: builder.headers,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return builder;
}

describe('GitHub authorization state', () => {
  it('is opaque, actor/org-bound, expiring, and single-use', async () => {
    let now = new Date('2026-08-10T12:00:00.000Z');
    const store = createInMemoryGitHubAuthorizationStateStore(() => now);
    const binding = { organizationId: newId('org'), actorId: newId('user') };
    const state = await store.issue(binding, GITHUB_AUTHORIZATION_STATE_TTL_MS);

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).not.toContain(binding.organizationId);
    expect(await store.consume(state, { ...binding, actorId: newId('user') })).toBe(false);
    expect(await store.consume(state, { ...binding, organizationId: newId('org') })).toBe(false);
    expect(await store.consume(state, binding)).toBe(true);
    expect(await store.consume(state, binding)).toBe(false);

    const expired = await store.issue(binding, GITHUB_AUTHORIZATION_STATE_TTL_MS);
    now = new Date(now.getTime() + GITHUB_AUTHORIZATION_STATE_TTL_MS);
    expect(await store.consume(expired, binding)).toBe(false);
  });

  it('uses one Redis eval to compare and consume a SHA-256-derived key', async () => {
    const calls: Array<{ script: string; keys: readonly string[]; args: readonly (string | number)[] }> = [];
    let issuedKey = '';
    const redis: RedisCommands = {
      get: () => Promise.reject(new Error('consume must not GET outside Lua')),
      set(key) {
        issuedKey = key;
        return Promise.resolve();
      },
      setIfAbsent: () => Promise.resolve(false),
      exists: () => Promise.resolve(false),
      delete: () => Promise.reject(new Error('consume must not DEL outside Lua')),
      eval(script, keys, args) {
        calls.push({ script, keys, args });
        return Promise.resolve(1);
      },
    };
    const store = createRedisGitHubAuthorizationStateStore(redis);
    const binding = { organizationId: newId('org'), actorId: newId('user') };
    const state = await store.issue(binding, GITHUB_AUTHORIZATION_STATE_TTL_MS);

    expect(issuedKey).toBe(`github:install-state:${createHash('sha256').update(state).digest('hex')}`);
    expect(issuedKey).not.toContain(state);
    expect(await store.consume(state, binding)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.script).toContain("redis.call('GET', KEYS[1])");
    expect(calls[0]?.script).toContain("redis.call('DEL', KEYS[1])");
    expect(calls[0]?.keys).toEqual([issuedKey]);
  });
});

describe('GitHub installation and discovery routes', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', 'short'],
    ['invalid characters', 'invalid key'],
    ['too long', 'x'.repeat(256)],
  ] as const)('rejects a %s authorization idempotency key', async (_label, operationKey) => {
    const data = new InMemoryTenantData();
    const harness = buildHarness({
      tenantDb: data.factory,
      github: {
        appSlug: 'zapp-build-test',
        provider: new RecordingGitHubProvider(),
        stateStore: createInMemoryGitHubAuthorizationStateStore(),
      },
    });
    harnesses.push(harness);
    const owner = await signIn(harness, OWNER);
    const organizationId = await organization(harness, owner, `GitHub key ${_label}`);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/integrations/github/install/authorize',
      headers: {
        ...as(owner, organizationId),
        ...(operationKey === undefined ? {} : { 'idempotency-key': operationKey }),
      },
    });

    expect(response.statusCode, response.body).toBe(400);
  });

  it('replays an exact authorization response and issues one state', async () => {
    const backing = createInMemoryGitHubAuthorizationStateStore();
    let issueCalls = 0;
    const stateStore: GitHubAuthorizationStateStore = {
      issue(binding, ttlMs) {
        issueCalls += 1;
        return backing.issue(binding, ttlMs);
      },
      consume: (state, binding) => backing.consume(state, binding),
    };
    const harness = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      github: { appSlug: 'zapp-build-test', provider: new RecordingGitHubProvider(), stateStore },
    });
    harnesses.push(harness);
    const owner = await signIn(harness, OWNER);
    const organizationId = await organization(harness, owner, 'GitHub authorize replay');
    const headers = {
      ...as(owner, organizationId),
      'idempotency-key': 'github-authorize-operation-0001',
    };

    const first = await harness.app.inject({
      method: 'POST',
      url: '/v1/integrations/github/install/authorize',
      headers,
    });
    const replay = await harness.app.inject({
      method: 'POST',
      url: '/v1/integrations/github/install/authorize',
      headers,
    });

    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(replay.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
    expect(issueCalls).toBe(1);
  });

  it('rejects a concurrent authorization with the same key while the first is pending', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let issueCalls = 0;
    const stateStore: GitHubAuthorizationStateStore = {
      async issue() {
        issueCalls += 1;
        entered();
        await blocked;
        return 'a'.repeat(43);
      },
      consume: () => Promise.resolve(false),
    };
    const harness = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      github: { appSlug: 'zapp-build-test', provider: new RecordingGitHubProvider(), stateStore },
    });
    harnesses.push(harness);
    const owner = await signIn(harness, OWNER);
    const organizationId = await organization(harness, owner, 'GitHub authorize concurrent');
    const headers = {
      ...as(owner, organizationId),
      'idempotency-key': 'github-authorize-operation-0002',
    };

    const first = harness.app.inject({
      method: 'POST',
      url: '/v1/integrations/github/install/authorize',
      headers,
    });
    await started;
    const concurrent = await harness.app.inject({
      method: 'POST',
      url: '/v1/integrations/github/install/authorize',
      headers,
    });

    expect(concurrent.statusCode, concurrent.body).toBe(409);
    expect(concurrent.headers['retry-after']).toBe('1');
    expect(concurrent.json()).toMatchObject({ error: { code: 'idempotency_in_progress' } });
    expect(issueCalls).toBe(1);
    release();
    const completed = await first;
    expect(completed.statusCode, completed.body).toBe(200);
  });

  it('allows an Owner to authorize and denies a Builder', async () => {
    const data = new InMemoryTenantData();
    const provider = new RecordingGitHubProvider();
    const stateStore = createInMemoryGitHubAuthorizationStateStore();
    const harness = buildHarness({
      tenantDb: data.factory,
      github: { appSlug: 'zapp-build-test', provider, stateStore },
    });
    harnesses.push(harness);
    const owner = await signIn(harness, OWNER);
    const organizationId = await organization(harness, owner, 'GitHub Routes');

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/integrations/github/install/authorize',
      headers: { ...as(owner, organizationId), 'idempotency-key': 'github-auth-owner' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const url = new URL(response.json<{ url: string }>().url);
    expect(url.origin + url.pathname).toBe('https://github.com/apps/zapp-build-test/installations/new');
    expect([...url.searchParams.keys()]).toEqual(['state']);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const builder = await joinBuilder(harness, owner, organizationId);
    const denied = await harness.app.inject({
      method: 'POST',
      url: '/v1/integrations/github/install/authorize',
      headers: { ...as(builder, organizationId), 'idempotency-key': 'github-auth-builder' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('consumes matching state, stores only installation metadata, and audits no callback material', async () => {
    const data = new InMemoryTenantData();
    const provider = new RecordingGitHubProvider();
    const stateStore = createInMemoryGitHubAuthorizationStateStore();
    const harness = buildHarness({
      tenantDb: data.factory,
      github: { appSlug: 'zapp-build-test', provider, stateStore },
    });
    harnesses.push(harness);
    const owner = await signIn(harness, OWNER);
    const organizationId = await organization(harness, owner, 'GitHub Install');
    const state = await stateStore.issue(
      { organizationId, actorId: owner.userId },
      GITHUB_AUTHORIZATION_STATE_TTL_MS,
    );
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/integrations/github/install',
      headers: { ...as(owner, organizationId), 'idempotency-key': 'github-install-01' },
      payload: { installationId: '41122', state, code: CALLBACK_CODE },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      connection: {
        organizationId,
        provider: 'github',
        status: 'connected',
        credentialRef: null,
        configuration: { installationId: '41122' },
      },
    });
    expect(response.body).not.toContain(state);
    expect(response.body).not.toContain(CALLBACK_CODE);
    expect(JSON.stringify(harness.audit.events.at(-1))).not.toContain(state);
    expect(JSON.stringify(harness.audit.events.at(-1))).not.toContain(CALLBACK_CODE);
    expect(provider.installations).toEqual([
      { installationId: '41122', code: CALLBACK_CODE },
    ]);
  });

  it('exchanges the callback code and accepts only an installation visible to that user', async () => {
    const requests: Array<{ method: string; url: string; authorization?: string; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          body,
        });
        response.setHeader('content-type', 'application/json');
        if (request.url === '/login/oauth/access_token') {
          response.end(JSON.stringify({
            access_token: 'ghu_ephemeral-test-token',
            token_type: 'bearer',
            scope: '',
            expires_in: 28_800,
            refresh_token: 'ghr_ephemeral-test-refresh',
            refresh_token_expires_in: 15_897_600,
          }));
          return;
        }
        if (request.url === '/api/v3/user/installations?per_page=100&page=1') {
          response.end(JSON.stringify({ total_count: 1, installations: [{ id: 41122 }] }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ message: 'not found' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${String(address.port)}`;
    try {
      const provider = createGitHubProvider({
        appId: '12345',
        clientId: 'Iv1.test-client',
        clientSecret: 'test-client-secret',
        privateKey: 'not-used-for-user-ownership-proof',
        baseUrl: `${origin}/api/v3`,
      });

      await expect(provider.completeInstallation({
        installationId: '41122',
        code: 'one-time-callback-code',
      })).resolves.toEqual({ installationId: '41122' });

      await expect(provider.completeInstallation({
        installationId: 'spoofed-999',
        code: 'second-one-time-callback-code',
      })).rejects.toMatchObject({ failure: 'not_found' });

      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/login/oauth/access_token',
          body: 'client_id=Iv1.test-client&client_secret=test-client-secret&code=one-time-callback-code',
        },
        {
          method: 'GET',
          url: '/api/v3/user/installations?per_page=100&page=1',
          authorization: 'token ghu_ephemeral-test-token',
          body: '',
        },
        {
          method: 'POST',
          url: '/login/oauth/access_token',
          body: 'client_id=Iv1.test-client&client_secret=test-client-secret&code=second-one-time-callback-code',
        },
        {
          method: 'GET',
          url: '/api/v3/user/installations?per_page=100&page=1',
          authorization: 'token ghu_ephemeral-test-token',
          body: '',
        },
      ]);
      expect(requests.some((request) => request.url.includes('/access_tokens'))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
    }
  });

  it('rejects a spoofed installation before persistence or tenant discovery access', async () => {
    const data = new InMemoryTenantData();
    const provider = new RecordingGitHubProvider();
    provider.installationError = new GitHubProviderError('not_found');
    const stateStore = createInMemoryGitHubAuthorizationStateStore();
    const harness = buildHarness({
      tenantDb: data.factory,
      github: { appSlug: 'zapp-build-test', provider, stateStore },
    });
    harnesses.push(harness);
    const owner = await signIn(harness, OWNER);
    const organizationId = await organization(harness, owner, 'Spoof Rejected');
    const state = await stateStore.issue(
      { organizationId, actorId: owner.userId },
      GITHUB_AUTHORIZATION_STATE_TTL_MS,
    );

    const install = await harness.app.inject({
      method: 'POST',
      url: '/v1/integrations/github/install',
      headers: { ...as(owner, organizationId), 'idempotency-key': 'github-spoof-rejected' },
      payload: { installationId: 'spoofed-999', state, code: CALLBACK_CODE },
    });
    expect(install.statusCode).toBe(502);
    expect(data.integrationConnections).toEqual([]);

    const discovery = await harness.app.inject({
      method: 'GET',
      url: '/v1/integrations/github/repositories?installationId=spoofed-999',
      headers: as(owner, organizationId),
    });
    expect(discovery.statusCode).toBe(404);
    expect(provider.repositoryCalls).toEqual([]);
  });

  it('settles racing valid callbacks for one installation as one durable connection', async () => {
    const data = new InMemoryTenantData();
    data.yieldGitHubConnects = true;
    const provider = new RecordingGitHubProvider();
    const stateStore = createInMemoryGitHubAuthorizationStateStore();
    const harness = buildHarness({
      tenantDb: data.factory,
      github: { appSlug: 'zapp-build-test', provider, stateStore },
    });
    harnesses.push(harness);
    const owner = await signIn(harness, OWNER);
    const organizationId = await organization(harness, owner, 'Concurrent Install');
    const binding = { organizationId, actorId: owner.userId };
    const [firstState, secondState] = await Promise.all([
      stateStore.issue(binding, GITHUB_AUTHORIZATION_STATE_TTL_MS),
      stateStore.issue(binding, GITHUB_AUTHORIZATION_STATE_TTL_MS),
    ]);

    const [first, second] = await Promise.all([
      harness.app.inject({
        method: 'POST',
        url: '/v1/integrations/github/install',
        headers: { ...as(owner, organizationId), 'idempotency-key': 'github-race-first' },
        payload: { installationId: '41122', state: firstState, code: 'first-callback-code' },
      }),
      harness.app.inject({
        method: 'POST',
        url: '/v1/integrations/github/install',
        headers: { ...as(owner, organizationId), 'idempotency-key': 'github-race-second' },
        payload: { installationId: '41122', state: secondState, code: 'second-callback-code' },
      }),
    ]);

    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(first.json()).toEqual(second.json());
    expect(data.integrationConnections).toHaveLength(1);
  });

  it('paginates exact repository and branch schemas after same-tenant installation lookup', async () => {
    const data = new InMemoryTenantData();
    const provider = new RecordingGitHubProvider();
    const stateStore = createInMemoryGitHubAuthorizationStateStore();
    const harness = buildHarness({
      tenantDb: data.factory,
      github: { appSlug: 'zapp-build-test', provider, stateStore },
    });
    harnesses.push(harness);
    const owner = await signIn(harness, OWNER);
    const organizationId = await organization(harness, owner, 'GitHub Discovery');
    data.addGitHubConnection(organizationId, '41122');

    const firstPage = await harness.app.inject({
      method: 'GET',
      url: '/v1/integrations/github/repositories?installationId=41122',
      headers: as(owner, organizationId),
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.json()).toEqual({
      items: [{ id: '501', fullName: 'zapp/example', private: true, defaultBranch: 'main' }],
      nextCursor: 'opaque-page-2',
    });

    const repositories = await harness.app.inject({
      method: 'GET',
      url: '/v1/integrations/github/repositories?installationId=41122&cursor=opaque-page-1',
      headers: as(owner, organizationId),
    });
    expect(repositories.statusCode, repositories.body).toBe(200);
    expect(repositories.json()).toEqual({
      items: [{ id: '501', fullName: 'zapp/example', private: true, defaultBranch: 'main' }],
      nextCursor: null,
    });
    expect(provider.repositoryCalls).toEqual([
      { installationId: '41122' },
      { installationId: '41122', cursor: 'opaque-page-1' },
    ]);

    const branches = await harness.app.inject({
      method: 'GET',
      url: '/v1/integrations/github/repositories/501/branches?installationId=41122',
      headers: as(owner, organizationId),
    });
    expect(branches.statusCode, branches.body).toBe(200);
    expect(branches.json()).toEqual({
      items: [{ name: 'main', headCommitSha: 'a'.repeat(40) }],
      nextCursor: null,
    });
    expect(provider.branchCalls).toEqual([
      { installationId: '41122', repositoryId: '501' },
    ]);
  });

  it('rejects a branch ref where GitHub must return a resolved commit SHA', async () => {
    expect(GitHubBranchSchema.safeParse({ name: 'main', headCommitSha: 'main' }).success).toBe(false);

    const data = new InMemoryTenantData();
    const provider = new RecordingGitHubProvider();
    provider.branchHeadCommitSha = 'main';
    const harness = buildHarness({
      tenantDb: data.factory,
      github: {
        appSlug: 'zapp-build-test',
        provider,
        stateStore: createInMemoryGitHubAuthorizationStateStore(),
      },
    });
    harnesses.push(harness);
    const owner = await signIn(harness, OWNER);
    const organizationId = await organization(harness, owner, 'GitHub SHA Boundary');
    data.addGitHubConnection(organizationId, '41122');

    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/integrations/github/repositories/501/branches?installationId=41122',
      headers: as(owner, organizationId),
    });

    expect(response.statusCode, response.body).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'github_unavailable' } });
  });

  it('returns an opaque 404 for a foreign installation before calling GitHub', async () => {
    const data = new InMemoryTenantData();
    const provider = new RecordingGitHubProvider();
    const harness = buildHarness({
      tenantDb: data.factory,
      github: {
        appSlug: 'zapp-build-test',
        provider,
        stateStore: createInMemoryGitHubAuthorizationStateStore(),
      },
    });
    harnesses.push(harness);
    const owner = await signIn(harness, OWNER);
    const first = await organization(harness, owner, 'First GitHub Tenant');
    const second = await organization(harness, owner, 'Second GitHub Tenant');
    data.addGitHubConnection(first, '41122');

    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/integrations/github/repositories?installationId=41122',
      headers: as(owner, second),
    });
    expect(response.statusCode).toBe(404);
    expect(provider.repositoryCalls).toEqual([]);
  });

  it('maps provider 404 and redacts all other provider failures', async () => {
    const data = new InMemoryTenantData();
    const provider = new RecordingGitHubProvider();
    const harness = buildHarness({
      tenantDb: data.factory,
      github: {
        appSlug: 'zapp-build-test',
        provider,
        stateStore: createInMemoryGitHubAuthorizationStateStore(),
      },
    });
    harnesses.push(harness);
    const owner = await signIn(harness, OWNER);
    const organizationId = await organization(harness, owner, 'GitHub Errors');
    data.addGitHubConnection(organizationId, '41122');

    provider.repositoryError = new GitHubProviderError('not_found');
    const missing = await harness.app.inject({
      method: 'GET',
      url: '/v1/integrations/github/repositories?installationId=41122',
      headers: as(owner, organizationId),
    });
    expect(missing.statusCode).toBe(404);

    const providerSecret = 'provider-token-must-not-leak';
    provider.repositoryError = new Error(`GitHub rejected ${providerSecret}`);
    const failed = await harness.app.inject({
      method: 'GET',
      url: '/v1/integrations/github/repositories?installationId=41122',
      headers: as(owner, organizationId),
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain(providerSecret);
  });
});
