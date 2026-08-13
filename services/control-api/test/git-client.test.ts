import { createServiceTokenSigner } from '@zapp/config';
import { internalRepoRef, newId } from '@zapp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGitServiceClient, loadGitServiceUrl, resolveGitService } from '../src/git/client.js';
import {
  GIT_CREATE_DEADLINE_MS,
  GIT_LEASE_DEADLINE_MS,
  GIT_IMPORT_DEADLINE_MS,
  GitServiceImportConflictError,
  GitServiceError,
  createRecordOnlyGitService,
} from '../src/git/port.js';

/**
 * The binding CP-6 left a stand-in for (plan 06 GIT-2).
 *
 * Three things are worth proving here, and none of them needs a git service:
 * that the credential this process presents is the right one for the right
 * audience, that the deadline the port documents is actually enforced, and that
 * a deployment which forgot to say where the git service lives does not quietly
 * fall back to naming repositories nobody creates.
 */

const SERVICE_TOKENS = { secret: 'control-api-test-secret-that-is-long-enough' };
const ORGANIZATION = newId('org');
const PROJECT = newId('proj');

const INPUT = {
  organizationId: ORGANIZATION,
  projectId: PROJECT,
  projectSlug: 'checkout',
  defaultBranch: 'main',
};

const IMPORT_INPUT = {
  organizationId: ORGANIZATION,
  projectId: PROJECT,
  externalRepoRef: 'zapp/example',
  sourceCloneUrl: 'https://github.test/zapp/example.git',
  sourceToken: 'ghs_source-token-must-not-leak',
  sourceBranch: 'feature/import',
};

const TEMPLATE_INPUT = {
  organizationId: ORGANIZATION,
  projectId: PROJECT,
  templateSlug: 'next-starter',
  operationKey: `op_${'b'.repeat(64)}`,
};

const imported = (overrides: Record<string, unknown> = {}, status = 200): Response =>
  new Response(
    JSON.stringify({
      externalRepoRef: IMPORT_INPUT.externalRepoRef,
      branch: IMPORT_INPUT.sourceBranch,
      headCommitSha: 'a'.repeat(40),
      ...overrides,
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

function stubFetch(make: () => Response): {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(make());
    },
  };
}

const created = (overrides: Record<string, unknown> = {}): Response =>
  new Response(
    JSON.stringify({
      internalRepoRef: internalRepoRef({ organizationId: ORGANIZATION, projectId: PROJECT }),
      cloneUrl: 'https://git.test/x.git',
      provisionedAt: '2026-03-01T12:00:00.000Z',
      ...overrides,
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadGitServiceUrl', () => {
  it('reads absent and empty as the same thing', () => {
    // `.env.example` ships the key, so pointing a deployment at a git service is
    // a value change rather than a schema change.
    expect(loadGitServiceUrl({})).toBeUndefined();
    expect(loadGitServiceUrl({ GIT_SERVICE_URL: '' })).toBeUndefined();
  });

  it('strips a trailing slash so paths do not double up', () => {
    expect(loadGitServiceUrl({ GIT_SERVICE_URL: 'http://git-service:4500/' })).toBe(
      'http://git-service:4500',
    );
  });

  it.each([
    // `new URL()` parses this as scheme `git-service:`, so `.url()` alone would
    // accept it — and `fetch` would then do something other than an HTTP call.
    ['a scheme that is not http', 'git-service:4500'],
    ['a file URL', 'file:///etc/passwd'],
    ['no scheme at all', 'git-service.internal:4500'],
  ])('names the variable for %s', (_case, value) => {
    expect(() => loadGitServiceUrl({ GIT_SERVICE_URL: value })).toThrow(
      'Invalid environment: GIT_SERVICE_URL',
    );
  });
});

describe('resolveGitService', () => {
  it('falls back to the record-only stand-in in development', () => {
    // Which is what lets `pnpm dev` create projects with no git service running.
    // Vitest sets NODE_ENV=test, which counts.
    const port = resolveGitService({ baseUrl: undefined, serviceTokens: SERVICE_TOKENS });
    expect(port).toBeDefined();
  });

  it('refuses to start outside development when no git service is named', () => {
    vi.stubEnv('NODE_ENV', 'production');
    // A control plane that fell back here would create projects whose
    // `repositories` rows point at repositories that do not exist, and the first
    // symptom would be a clone failure in another service, days later.
    expect(() => resolveGitService({ baseUrl: undefined, serviceTokens: SERVICE_TOKENS })).toThrow(
      /refusing to start: no GIT_SERVICE_URL/,
    );
    vi.unstubAllEnvs();
  });

  it('refuses on an unset NODE_ENV, which is not development', () => {
    vi.stubEnv('NODE_ENV', '');
    expect(() => resolveGitService({ baseUrl: undefined, serviceTokens: SERVICE_TOKENS })).toThrow(
      /refusing to start/,
    );
    vi.unstubAllEnvs();
  });
});

describe('the record-only stand-in', () => {
  it('derives the ref with the same function the git service uses', async () => {
    // Two copies of this expression in two services would be two things a future
    // edit could put out of step — silently, since the symptom is a repository
    // at an address the control plane no longer expects.
    const result = await createRecordOnlyGitService().createRepository(INPUT);
    expect(result.internalRepoRef).toBe(
      internalRepoRef({ organizationId: ORGANIZATION, projectId: PROJECT }),
    );
  });

  it('reports no provisioning time, which is what leaves the column null', async () => {
    const result = await createRecordOnlyGitService().createRepository(INPUT);
    expect(result.provisionedAt).toBeUndefined();
  });
});

describe('the git service client', () => {
  it('mints a bounded attributed write lease through the service-only route', async () => {
    const stub = stubFetch(() =>
      new Response(JSON.stringify({
        token: 'one-time-token', username: 'zt-user',
        cloneUrl: 'https://git.test/org/repo.git', expiresAt: '2026-08-12T12:05:00.000Z',
      }), { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const client = createGitServiceClient({
      baseUrl: 'http://git-service:4500', serviceTokens: SERVICE_TOKENS, fetch: stub.fetch,
    });

    await expect(client.mintRepositoryLease?.({
      organizationId: ORGANIZATION, projectId: PROJECT, requestedBy: newId('user'), ttlSec: 120,
    })).resolves.toMatchObject({ token: 'one-time-token' });
    expect(stub.calls[0]?.url).toBe('http://git-service:4500/internal/git/tokens');
    expect(JSON.parse(stub.calls[0]?.init.body as string)).toMatchObject({ access: 'write', ttlSec: 120 });
    expect(timeout).toHaveBeenCalledWith(GIT_LEASE_DEADLINE_MS);
  });
  it('seeds only a server-approved template slug with a stable operation key', async () => {
    const stub = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            templateSlug: TEMPLATE_INPUT.templateSlug,
            branch: 'main',
            headCommitSha: 'a'.repeat(40),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stub.fetch,
    });

    if (client.seedTemplate === undefined) throw new Error('shipping client omitted template seeding');
    await expect(client.seedTemplate(TEMPLATE_INPUT)).resolves.toMatchObject({
      templateSlug: 'next-starter',
      branch: 'main',
    });
    expect(stub.calls[0]?.url).toBe(
      `http://git-service:4500/internal/git/repositories/${ORGANIZATION}/${PROJECT}/seed-template`,
    );
    expect(stub.calls[0]?.init.headers).toMatchObject({
      'idempotency-key': TEMPLATE_INPUT.operationKey,
    });
    expect(JSON.parse(stub.calls[0]?.init.body as string)).toEqual({
      templateSlug: 'next-starter',
    });
  });

  it('presents a control-api token minted for the git service', async () => {
    const stub = stubFetch(created);

    await createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stub.fetch,
    }).createRepository(INPUT);

    const token = (stub.calls[0]?.init.headers as Record<string, string>)['x-zapp-service-token'];
    expect(token).toBeDefined();

    // Verified with the same signer the git service uses, against the audience
    // it requires: a token minted here is not spendable on the control plane's
    // own internal decrypt route, and vice versa.
    const verdict = await createServiceTokenSigner(SERVICE_TOKENS).verifyServiceToken(
      token as string,
      'git-service',
    );
    expect(verdict).toMatchObject({ ok: true, claims: { service: 'control-api' } });
  });

  it('sends the ids and the slug, and the slug only as a description', async () => {
    const stub = stubFetch(created);

    await createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stub.fetch,
    }).createRepository(INPUT);

    const body = JSON.parse(stub.calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      defaultBranch: 'main',
      // The slug is mutable; a ref derived from it desynchronizes on the first
      // rename. It travels so a human reading the Git host's UI can tell what
      // they are looking at, and for nothing else.
      description: 'checkout',
    });
  });

  it('returns the ref the service created and the time it reports', async () => {
    const stub = stubFetch(created);

    const result = await createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stub.fetch,
    }).createRepository(INPUT);

    expect(result).toEqual({
      internalRepoRef: internalRepoRef({ organizationId: ORGANIZATION, projectId: PROJECT }),
      provisionedAt: new Date('2026-03-01T12:00:00.000Z'),
    });
  });

  it('enforces the deadline the port documents', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const stub = stubFetch(created);

    await createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stub.fetch,
    }).createRepository(INPUT);

    // This call is made with a PostgreSQL transaction open, so an unbounded wait
    // holds a pooled connection until TCP gives up — minutes — and enough
    // concurrent creates then take down every other route in the service.
    expect(timeout).toHaveBeenCalledWith(GIT_CREATE_DEADLINE_MS);
  });

  it('reports an unreachable service as a GitServiceError, naming no URL', async () => {
    const client = createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: () => Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:4500')),
    });

    const error = await client.createRepository(INPUT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitServiceError);
    // A fetch error quotes the URL it was given, and a URL is a place a
    // credential can hide. The cause carries it; the message does not.
    expect((error as Error).message).not.toContain('10.1.2.3');
  });

  it('refuses a non-201, whatever the body says', async () => {
    const client = createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stubFetch(
        () => new Response(JSON.stringify({ error: { code: 'x' } }), { status: 502 }),
      ).fetch,
    });

    await expect(client.createRepository(INPUT)).rejects.toBeInstanceOf(GitServiceError);
  });

  it('refuses a 201 that names no repository rather than writing a guess', async () => {
    const client = createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stubFetch(() => created({ internalRepoRef: undefined })).fetch,
    });

    // Guessing the ref would put a `repositories` row at an address nothing
    // created — and `repositories_org_internal_ref_idx` would then make the
    // *next* project the one that fails.
    await expect(client.createRepository(INPUT)).rejects.toThrow(/no repository ref/);
  });

  it('drops an unparseable provisioning time rather than writing Invalid Date', async () => {
    const client = createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stubFetch(() => created({ provisionedAt: 'the day before yesterday' })).fetch,
    });

    // `provisioned_at` is what distinguishes a row that names a repository from
    // a repository that exists. A NaN date in that column would say
    // "provisioned" while meaning nothing.
    const result = await client.createRepository(INPUT);
    expect(result.provisionedAt).toBeUndefined();
    expect(result.internalRepoRef).toBeDefined();
  });

  it('sends source credentials only to the authenticated import boundary with a fresh token', async () => {
    const stub = stubFetch(imported);
    const client = createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stub.fetch,
    });

    await client.importRepository(IMPORT_INPUT);
    await client.importRepository(IMPORT_INPUT);

    expect(stub.calls.map((call) => call.url)).toEqual([
      `http://git-service:4500/internal/git/repositories/${ORGANIZATION}/${PROJECT}/import`,
      `http://git-service:4500/internal/git/repositories/${ORGANIZATION}/${PROJECT}/import`,
    ]);
    expect(stub.calls.map((call) => JSON.parse(call.init.body as string) as unknown)).toEqual([
      {
        externalRepoRef: IMPORT_INPUT.externalRepoRef,
        sourceCloneUrl: IMPORT_INPUT.sourceCloneUrl,
        sourceToken: IMPORT_INPUT.sourceToken,
        sourceBranch: IMPORT_INPUT.sourceBranch,
      },
      {
        externalRepoRef: IMPORT_INPUT.externalRepoRef,
        sourceCloneUrl: IMPORT_INPUT.sourceCloneUrl,
        sourceToken: IMPORT_INPUT.sourceToken,
        sourceBranch: IMPORT_INPUT.sourceBranch,
      },
    ]);
    const authorizations = stub.calls.map(
      (call) => (call.init.headers as Record<string, string>)['x-zapp-service-token'],
    );
    expect(authorizations[0]).toBeDefined();
    expect(authorizations[1]).toBeDefined();
    expect(authorizations[1]).not.toBe(authorizations[0]);
  });

  it('parses strict mirror metadata and bounds the internal request', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const client = createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stubFetch(imported).fetch,
    });

    await expect(client.importRepository(IMPORT_INPUT)).resolves.toEqual({
      externalRepoRef: IMPORT_INPUT.externalRepoRef,
      branch: IMPORT_INPUT.sourceBranch,
      headCommitSha: 'a'.repeat(40),
    });
    expect(timeout).toHaveBeenCalledWith(GIT_IMPORT_DEADLINE_MS);

    const malformed = createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stubFetch(() => imported({ credential: IMPORT_INPUT.sourceToken })).fetch,
    });
    await expect(malformed.importRepository(IMPORT_INPUT)).rejects.toBeInstanceOf(GitServiceError);
  });

  it('maps only a 409 to a mirror conflict and redacts every remote failure body', async () => {
    const conflict = createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stubFetch(() => imported({ message: IMPORT_INPUT.sourceToken }, 409)).fetch,
    });
    const unavailable = createGitServiceClient({
      baseUrl: 'http://git-service:4500',
      serviceTokens: SERVICE_TOKENS,
      fetch: stubFetch(() => imported({ message: IMPORT_INPUT.sourceToken }, 502)).fetch,
    });

    const conflictError = await conflict.importRepository(IMPORT_INPUT).catch((error: unknown) => error);
    const unavailableError = await unavailable
      .importRepository(IMPORT_INPUT)
      .catch((error: unknown) => error);
    expect(conflictError).toBeInstanceOf(GitServiceImportConflictError);
    expect(unavailableError).toBeInstanceOf(GitServiceError);
    expect((conflictError as Error).message).not.toContain(IMPORT_INPUT.sourceToken);
    expect((unavailableError as Error).message).not.toContain(IMPORT_INPUT.sourceToken);
  });
});
