import { internalRepoRef, newId } from '@zapp/contracts';
import { describe, expect, it } from 'vitest';

import { createRecordingGitAuditSink } from '../src/audit.js';
import { ForgejoError } from '../src/forgejo/client.js';
import {
  DEFAULT_TOKEN_TTL_SECONDS,
  MAX_TOKEN_TTL_SECONDS,
  createTokenService,
  ephemeralUsername,
  expiryOf,
} from '../src/tokens.js';
import { createFakeForgejo, type Route } from './support/fake-forgejo.js';

/**
 * How a repository-scoped credential is assembled, and what happens when a step
 * of it fails.
 *
 * The *security* property — that the resulting token can reach exactly one
 * repository — is not provable here and is not attempted here: it is a property
 * of Forgejo's permission check, and `test/integration/tokens.test.ts` proves it
 * by cloning. What this file owns is everything around that: the ceiling, the
 * ordering, the compensation, and the fact that the secret never reaches a place
 * it can be read from later.
 */

const ORGANIZATION = newId('org');
const PROJECT = newId('proj');
const REF = internalRepoRef({ organizationId: ORGANIZATION, projectId: PROJECT });
const [OWNER, NAME] = REF.split('/') as [string, string];
const NOW = new Date('2026-03-01T00:00:00.000Z');
const TOKEN = 'forgejo-secret-token';

function service(
  overrides: Record<string, Route> = {},
  options: { readonly cloneBaseUrl?: string } = {},
) {
  const forgejo = createFakeForgejo({
    [`GET /repos/${OWNER}/${NAME}`]: {
      status: 200,
      body: { clone_url: `https://git.test/${REF}.git` },
    },
    'POST /admin/users': { status: 201, body: {} },
    // `*` matches one path segment. The ephemeral username is random by
    // construction, so these two paths cannot be spelled out — and making the
    // username injectable would let a test assert a name production never
    // produces.
    [`PUT /repos/${OWNER}/${NAME}/collaborators/*`]: { status: 204 },
    'POST /users/*/tokens': { status: 201, body: { sha1: TOKEN } },
    ...overrides,
  });
  const audit = createRecordingGitAuditSink();
  return {
    forgejo,
    audit,
    tokens: createTokenService({
      client: forgejo,
      audit,
      now: () => NOW,
      ...(options.cloneBaseUrl === undefined ? {} : { cloneBaseUrl: options.cloneBaseUrl }),
    }),
  };
}

const INPUT = {
  organizationId: ORGANIZATION,
  projectId: PROJECT,
  access: 'write',
  requestingService: 'sandbox-service',
  runId: newId('run'),
} as const;

describe('the ephemeral username', () => {
  it('carries the deadline, which is what makes the sweep restart-safe', () => {
    const expiresAt = new Date('2026-03-01T00:05:00.000Z');
    // The Git host is the record of which grants exist. A table of outstanding
    // grants would be a second source of truth that can disagree with the first
    // — in the direction of a credential nobody knows about.
    expect(expiryOf(ephemeralUsername(expiresAt))?.getTime()).toBe(
      Math.floor(expiresAt.getTime() / 1000) * 1000,
    );
  });

  it('is unique per grant', () => {
    const at = new Date('2026-03-01T00:05:00.000Z');
    const names = new Set(Array.from({ length: 200 }, () => ephemeralUsername(at)));
    // Two concurrent grants for one repository must not collide into one account.
    expect(names.size).toBe(200);
  });

  it('fits Forgejo’s 40-character username limit', () => {
    expect(ephemeralUsername(new Date('2286-11-20T17:46:40.000Z')).length).toBeLessThanOrEqual(40);
  });

  it.each([
    ['the platform admin', 'zapp-admin'],
    ['a customer-shaped name', 'zt-not-a-timestamp'],
    ['a near miss', 'zt-1900000000-nothex123456'],
    ['an empty string', ''],
    ['a prefix match only', 'zt-1900000000'],
  ])('does not claim %s as ours', (_case, login) => {
    // The sweep deletes accounts by this predicate alone. Anything it
    // misidentifies is an account it deletes.
    expect(expiryOf(login)).toBeUndefined();
  });
});

describe('mint', () => {
  it('publishes the non-secret restore identity before creating its Forgejo user', async () => {
    const harness = service({
      [`GET /repos/${OWNER}/${NAME}`]: {
        status: 200,
        body: { id: 501, clone_url: `https://git.test/${REF}.git` },
      },
    });
    const allocated: { readonly username: string; readonly expiresAt: Date }[] = [];
    const input = {
      ...INPUT,
      targetRef: REF,
      expectedRepositoryId: 501,
      onIdentityAllocated: (identity: { readonly username: string; readonly expiresAt: Date }) => {
        expect(harness.forgejo.writes).toEqual([]);
        allocated.push(identity);
        return Promise.resolve();
      },
    };

    const minted = await harness.tokens.mintForRepository(input);

    expect(allocated).toEqual([{ username: minted.username, expiresAt: minted.expiresAt }]);
    expect(harness.forgejo.writes[0]?.path).toBe('/admin/users');
  });

  it('refuses to mint a restore credential when the repository is replaced after grant', async () => {
    const harness = service({
      [`GET /repos/${OWNER}/${NAME}`]: {
        status: 200,
        body: { id: 501, clone_url: `https://git.test/${REF}.git` },
        then: {
          status: 200,
          body: { id: 999, clone_url: `https://git.test/${REF}.git` },
        },
      },
    });
    await expect(
      harness.tokens.mintForRepository({
        ...INPUT,
        targetRef: REF,
        expectedRepositoryId: 501,
      }),
    ).rejects.toThrow('repository identity changed during credential grant');
    expect(harness.forgejo.calls.some((call) => call.path.endsWith('/tokens'))).toBe(false);
    expect(
      harness.forgejo.calls.filter(
        (call) => call.method === 'DELETE' && call.path.startsWith('/admin/users/'),
      ),
    ).toHaveLength(1);
  });

  it('creates a restricted user, grants it one repository, and mints its token', async () => {
    const harness = service();

    const minted = await harness.tokens.mint(INPUT);

    expect(minted.token).toBe(TOKEN);
    expect(minted.cloneUrl).toBe(`https://git.test/${REF}.git`);
    expect(minted.expiresAt).toEqual(new Date(NOW.getTime() + DEFAULT_TOKEN_TTL_SECONDS * 1000));

    const create = harness.forgejo.writes.find((call) => call.path === '/admin/users');
    // `restricted` is the word that does the work: without it a token scoped
    // `read:repository` reads every repository the account can see, and an
    // unrestricted account can see every public one.
    expect(create?.body).toMatchObject({ restricted: true, visibility: 'private' });

    const collaborator = harness.forgejo.writes.find((call) =>
      call.path.includes('/collaborators/'),
    );
    expect(collaborator?.path).toContain(`/repos/${OWNER}/${NAME}/collaborators/`);
    expect(collaborator?.body).toMatchObject({ permission: 'write' });

    const token = harness.forgejo.writes.find((call) => call.path.endsWith('/tokens'));
    expect(token?.body).toMatchObject({ scopes: ['write:repository'] });
    // Basic auth, because Forgejo's token endpoint refuses token auth — which is
    // the whole reason the ephemeral account has a password at all.
    expect(token?.auth).toBe('basic');
  });

  it('returns the configured externally reachable clone origin for sandbox grants', async () => {
    const harness = service({}, { cloneBaseUrl: 'https://git-edge.example.test/root/' });

    const minted = await harness.tokens.mint(INPUT);

    expect(minted.cloneUrl).toBe(`https://git-edge.example.test/root/${REF}.git`);
  });

  it('asks for read permission and a read scope when read is asked for', async () => {
    const harness = service();

    await harness.tokens.mint({ ...INPUT, access: 'read' });

    expect(
      harness.forgejo.writes.find((call) => call.path.includes('/collaborators/'))?.body,
    ).toMatchObject({ permission: 'read' });
    expect(
      harness.forgejo.writes.find((call) => call.path.endsWith('/tokens'))?.body,
    ).toMatchObject({ scopes: ['read:repository'] });
  });

  it('refuses a TTL over the ceiling', async () => {
    const harness = service();

    await expect(
      harness.tokens.mint({ ...INPUT, ttlSec: MAX_TOKEN_TTL_SECONDS + 1 }),
    ).rejects.toThrow(/ttlSec/);
    // Refused before anything exists: a caller that wants a long-lived credential
    // fails at its own call rather than quietly receiving one.
    expect(harness.forgejo.writes).toEqual([]);
  });

  it.each([
    ['zero', 0],
    ['negative', -60],
    ['fractional', 1.5],
  ])('refuses a %s TTL', async (_case, ttlSec) => {
    const harness = service();
    await expect(harness.tokens.mint({ ...INPUT, ttlSec })).rejects.toThrow(/ttlSec/);
  });

  it('creates no account for a repository that is not there', async () => {
    const harness = service({ [`GET /repos/${OWNER}/${NAME}`]: { status: 404 } });

    await expect(harness.tokens.mint(INPUT)).rejects.toBeInstanceOf(ForgejoError);
    // The read comes first for exactly this: a mistyped project must not leave a
    // usable identity on the Git host.
    expect(harness.forgejo.writes).toEqual([]);
  });

  it('writes one audit row naming the caller and the run', async () => {
    const harness = service();

    const minted = await harness.tokens.mint(INPUT);

    expect(harness.audit.events).toHaveLength(1);
    expect(harness.audit.events[0]).toMatchObject({
      organizationId: ORGANIZATION,
      action: 'git_token.minted',
      projectId: PROJECT,
      requestingService: 'sandbox-service',
      metadata: {
        internalRepoRef: REF,
        access: 'write',
        ttlSec: DEFAULT_TOKEN_TTL_SECONDS,
        tokenUser: minted.username,
        runId: INPUT.runId,
        taskId: null,
      },
    });
  });

  it('never puts the token in the audit row', async () => {
    const harness = service();

    const minted = await harness.tokens.mint(INPUT);

    // The event type has no field one fits in, which is the only reliable way to
    // keep it out. This asserts the whole serialized row anyway, because the
    // table is read years later.
    expect(JSON.stringify(harness.audit.events)).not.toContain(minted.token);
    expect(JSON.stringify(harness.audit.events)).toContain(minted.username);
  });

  it('destroys the grant when the audit row cannot be written', async () => {
    const harness = service();
    harness.audit.failNext(new Error('audit_events is unreachable'));

    await expect(harness.tokens.mint(INPUT)).rejects.toThrow(/audit_events/);

    // A credential handed out with no record of it is the outcome the trail
    // exists to prevent, so the account — and therefore the token — is deleted
    // and the caller gets an error.
    const deleted = harness.forgejo.calls.filter(
      (call) => call.method === 'DELETE' && call.path.startsWith('/admin/users/'),
    );
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted.at(-1)?.path).toContain('purge=true');
  });

  it('destroys the account when the token itself cannot be minted', async () => {
    const harness = service({ 'POST /users/*/tokens': { status: 500 } });

    await expect(harness.tokens.mint(INPUT)).rejects.toBeInstanceOf(ForgejoError);

    expect(
      harness.forgejo.calls.filter(
        (call) => call.method === 'DELETE' && call.path.startsWith('/admin/users/'),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('revokeForProject', () => {
  it('deletes every ephemeral collaborator and nothing else', async () => {
    const harness = service({
      [`GET /repos/${OWNER}/${NAME}/collaborators?limit=50&page=1`]: {
        status: 200,
        body: [
          { login: 'zt-1900000000-0123456789ab' },
          // A real person with access, and the reason the filter is a pattern
          // rather than "everyone who is not the admin".
          { login: 'a-human-collaborator' },
          { login: 'zt-1900000001-abcdef012345' },
        ],
      },
    });

    const revoked = await harness.tokens.revokeForProject({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      requestingService: 'control-api',
    });

    expect(revoked).toBe(2);
    const deleted = harness.forgejo.calls
      .filter((call) => call.method === 'DELETE')
      .map((call) => call.path);
    expect(deleted).toEqual([
      '/admin/users/zt-1900000000-0123456789ab?purge=true',
      '/admin/users/zt-1900000001-abcdef012345?purge=true',
    ]);
    expect(harness.audit.events[0]).toMatchObject({
      action: 'git_token.revoked',
      metadata: { revoked: 2 },
    });
  });

  it('pages, rather than capping at one request', async () => {
    // The first cut asked for `limit=100` once and stopped, which is a cap and
    // not a page: a project with more outstanding grants than that would have
    // had the surplus survive its own deletion (GIT review). A hundred is not
    // far-fetched for a project minting one token per operation.
    const first = Array.from({ length: 50 }, (_unused, index) =>
      ephemeralUsername(new Date(NOW.getTime() + index * 1_000)),
    );
    const second = [ephemeralUsername(new Date(NOW.getTime() + 99_000))];
    const harness = service({
      [`GET /repos/${OWNER}/${NAME}/collaborators?limit=50&page=1`]: {
        status: 200,
        body: first.map((login) => ({ login })),
      },
      [`GET /repos/${OWNER}/${NAME}/collaborators?limit=50&page=2`]: {
        status: 200,
        body: second.map((login) => ({ login })),
      },
    });

    expect(
      await harness.tokens.revokeForProject({
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        requestingService: 'control-api',
      }),
    ).toBe(51);

    // Read every page before deleting anything: removing a collaborator shifts
    // the rest one place earlier, so a delete-while-paging loop skips whichever
    // entry moved onto a page it had already read.
    const order = harness.forgejo.calls.map((call) => `${call.method} ${call.path}`);
    const lastRead = order.lastIndexOf(`GET /repos/${OWNER}/${NAME}/collaborators?limit=50&page=2`);
    const firstDelete = order.findIndex((entry) => entry.startsWith('DELETE /admin/users/'));
    expect(lastRead).toBeLessThan(firstDelete);
  });

  it('treats a repository that is already gone as nothing to revoke', async () => {
    // Which is exactly when this is called: the project was deleted.
    const harness = service({
      [`GET /repos/${OWNER}/${NAME}/collaborators?limit=50&page=1`]: { status: 404 },
    });

    expect(
      await harness.tokens.revokeForProject({
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        requestingService: 'control-api',
      }),
    ).toBe(0);
    expect(harness.audit.events).toEqual([]);
  });
});

describe('sweepExpired', () => {
  it('deletes ephemeral users past their deadline and leaves everything else alone', async () => {
    const past = ephemeralUsername(new Date(NOW.getTime() - 1_000));
    const future = ephemeralUsername(new Date(NOW.getTime() + 60_000));
    const harness = service({
      'GET /admin/users?limit=50&page=1': {
        status: 200,
        body: [{ login: 'zapp-admin' }, { login: past }, { login: future }],
      },
    });

    expect(await harness.tokens.sweepExpired()).toBe(1);
    expect(
      harness.forgejo.calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
    ).toEqual([`/admin/users/${past}?purge=true`]);
  });

  it('reads every page before deleting anything', async () => {
    // Deleting while paging shifts every later account one place earlier, so the
    // first entry of page 2 moves onto page 1 *after* page 1 was read — and is
    // never looked at. The credential it belongs to would then outlive its
    // deadline, which is the guarantee this function exists to provide.
    const expired = Array.from({ length: 51 }, () =>
      ephemeralUsername(new Date(NOW.getTime() - 1_000)),
    );
    const harness = service({
      'GET /admin/users?limit=50&page=1': {
        status: 200,
        body: expired.slice(0, 50).map((login) => ({ login })),
      },
      'GET /admin/users?limit=50&page=2': {
        status: 200,
        body: expired.slice(50).map((login) => ({ login })),
      },
    });

    expect(await harness.tokens.sweepExpired()).toBe(51);

    const order = harness.forgejo.calls.map((call) => `${call.method} ${call.path}`);
    const lastRead = order.lastIndexOf('GET /admin/users?limit=50&page=2');
    const firstDelete = order.findIndex((entry) => entry.startsWith('DELETE /admin/users/'));
    expect(lastRead).toBeLessThan(firstDelete);
  });

  it('is idempotent — a second sweep finds nothing', async () => {
    const past = ephemeralUsername(new Date(NOW.getTime() - 1_000));
    const harness = service({
      'GET /admin/users?limit=50&page=1': {
        status: 200,
        body: [{ login: past }],
        then: { status: 200, body: [] },
      },
    });

    expect(await harness.tokens.sweepExpired()).toBe(1);
    expect(await harness.tokens.sweepExpired()).toBe(0);
  });

  it('takes an explicit instant, so expiry is asserted rather than waited for', async () => {
    const soon = ephemeralUsername(new Date(NOW.getTime() + 60_000));
    const harness = service({
      'GET /admin/users?limit=50&page=1': { status: 200, body: [{ login: soon }] },
    });

    expect(await harness.tokens.sweepExpired(NOW)).toBe(0);
    expect(await harness.tokens.sweepExpired(new Date(NOW.getTime() + 120_000))).toBe(1);
  });
});
