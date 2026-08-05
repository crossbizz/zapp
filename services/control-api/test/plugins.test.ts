import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiErrorSchema, IdempotencyHeader } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEVICE_GRANT_TTL_MS, DEVICE_POLL_INTERVAL_SECONDS } from '../src/auth/device.js';
import type { AuthIdentity } from '../src/auth/port.js';
import {
  loadRateLimitSettings,
  RATE_LIMITS_PATH,
  trustProxyOption,
} from '../src/config/rate-limits.js';
import { createInMemoryAuditSink, NO_TRANSACTION, type AuditRecord } from '../src/plugins/audit.js';
import {
  createInMemoryIdempotencyStore,
  IDEMPOTENT_REPLAY_HEADER,
  RECORD_TTL_MS,
  type IdempotencyStore,
} from '../src/plugins/idempotency.js';
import {
  classifyRoute,
  createInMemoryRateLimiter,
  type RateLimitDecision,
  type RateLimiter,
} from '../src/plugins/rate-limit.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import type { TenantDbFactory } from '../src/tenant/db.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

/**
 * CP-5's three plugins, through the real HTTP pipeline.
 *
 * Everything here is asserted from the outside — status codes, headers, and
 * whether the mutation behind the request actually happened — because that is
 * what a client experiences and what a regression would change. The parts that
 * need a database (an `audit_events` row surviving or not surviving a rollback)
 * are in `test/integration/audit.test.ts`; the parts that need Redis are in
 * `test/integration/redis.test.ts`.
 */

const harnesses: Harness[] = [];

function harness(options?: Parameters<typeof buildHarness>[0]): Harness {
  const built = buildHarness(options);
  harnesses.push(built);
  return built;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((built) => built.app.close()));
});

const ALICE: AuthIdentity = {
  externalId: 'plugins-test-alice',
  email: 'alice@acme.test',
  displayName: 'Alice Example',
};
const BOB: AuthIdentity = {
  externalId: 'plugins-test-bob',
  email: 'bob@acme.test',
  displayName: 'Bob Example',
};

function errorOf(response: { json: () => unknown }): string {
  return ApiErrorSchema.parse(response.json()).error.code;
}

/**
 * The tenant surface, on the in-memory rows CP-6 built for the project suite —
 * enough that a tenant-scoped route can be registered *and* answered here. What
 * those routes return is `test/projects.test.ts`'s subject; this file only
 * needs a request that reaches one.
 */
function tenantDb(): TenantDbFactory {
  return new InMemoryTenantData().factory;
}

/** One rule, spelled for a test that wants a specific class tightened. */
function rule(
  perMinute: number,
  scope: 'organization' | 'ip',
): {
  perMinute: number;
  burst: number;
  scope: 'organization' | 'ip';
  whenUnavailable: 'allow' | 'deny';
} {
  return { perMinute, burst: perMinute, scope, whenUnavailable: scope === 'ip' ? 'deny' : 'allow' };
}

const UNAVAILABLE: RateLimitDecision = {
  outcome: 'unavailable',
  remaining: 0,
  retryAfterSeconds: 1,
};

/**
 * A limiter that starts healthy and can be taken away — an outage that begins
 * mid-session, which is the only shape a test can sign in through.
 */
function flakyLimiter(): { limiter: RateLimiter; breakIt: () => void } {
  let healthy = true;
  return {
    limiter: {
      take: () =>
        Promise.resolve<RateLimitDecision>(
          healthy ? { outcome: 'allowed', remaining: 1, retryAfterSeconds: 0 } : UNAVAILABLE,
        ),
    },
    breakIt: () => {
      healthy = false;
    },
  };
}

async function createOrganization(
  built: Harness,
  session: TestSession,
  name: string,
  headers: Record<string, string> = {},
): Promise<Awaited<ReturnType<Harness['app']['inject']>>> {
  return await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: { ...session.headers, ...headers },
    payload: { name },
  });
}

describe('the rate limit configuration file', () => {
  it('is the shipped defaults, read from disk rather than compiled in', () => {
    const { classes } = loadRateLimitSettings();

    // Plan 02 CP-5 verbatim: mutations 60/min/org, reads 600/min/org,
    // auth 10/min/ip.
    expect(classes.mutations).toMatchObject({ perMinute: 60, scope: 'organization' });
    expect(classes.reads).toMatchObject({ perMinute: 600, scope: 'organization' });
    expect(classes.auth).toMatchObject({ perMinute: 10, scope: 'ip' });
    // The documented split: the API stays up, the credential endpoints stay
    // protected.
    expect(classes.reads.whenUnavailable).toBe('allow');
    expect(classes.mutations.whenUnavailable).toBe('allow');
    expect(classes.auth.whenUnavailable).toBe('deny');
    expect(RATE_LIMITS_PATH.endsWith('config/rate-limits.json')).toBe(true);
  });

  it('trusts no forwarded address until somebody says to', () => {
    // The default has to be the safe one: a deployment that says nothing counts
    // socket addresses (wrong behind a proxy, never attacker-chosen) rather
    // than believing a header anyone can set.
    const { proxy } = loadRateLimitSettings();

    expect(proxy).toMatchObject({ trustedHops: 0, trustedProxies: [] });
    expect(trustProxyOption(proxy)).toBe(false);
    expect(trustProxyOption({ trustedHops: 2, trustedProxies: [] })).toBe(2);
    expect(trustProxyOption({ trustedHops: 0, trustedProxies: ['10.0.0.0/8'] })).toEqual([
      '10.0.0.0/8',
    ]);
  });

  it('refuses a file it cannot validate rather than falling back to a default', () => {
    // A service that quietly substituted its own numbers for an unreadable file
    // would be running limits nobody chose.
    expect(() => loadRateLimitSettings('/nonexistent/rate-limits.json')).toThrow();
  });

  it('refuses a proxy stanza that states trust two ways', () => {
    const both = join(mkdtempSync(join(tmpdir(), 'zapp-limits-')), 'rate-limits.json');
    const shipped: unknown = JSON.parse(readFileSync(RATE_LIMITS_PATH, 'utf8'));
    writeFileSync(
      both,
      JSON.stringify({
        ...(shipped as Record<string, unknown>),
        proxy: { trustedHops: 1, trustedProxies: ['10.0.0.1'] },
      }),
    );

    // proxy-addr takes a hop count or an allowlist, not both, and a file that
    // sets both is asking for a resolution nobody chose.
    expect(() => loadRateLimitSettings(both)).toThrow(/trustedHops or trustedProxies/);
  });

  it('keeps the device budget above the poll rate it advertises', () => {
    // The two numbers live in different files and drift silently: the device
    // class is in `config/rate-limits.json`, the poll interval and the grant
    // window are constants in `src/auth/device.ts`. Before this class existed a
    // device polling every five seconds exhausted the ten-a-minute auth bucket
    // five minutes into its own ten-minute grant — and took the browser leg of
    // the same sign-in down with it.
    const { device } = loadRateLimitSettings().classes;
    const pollsPerMinute = 60 / DEVICE_POLL_INTERVAL_SECONDS;
    const grantMinutes = DEVICE_GRANT_TTL_MS / 60_000;
    const pollsPerGrant = Math.ceil(DEVICE_GRANT_TTL_MS / 1_000 / DEVICE_POLL_INTERVAL_SECONDS);

    // Sustained: the bucket refills at least as fast as the client is told to
    // poll, so a poll can never be the thing that empties it.
    expect(device.perMinute).toBeGreaterThanOrEqual(pollsPerMinute);
    // And a whole grant window's worth of polling fits inside the budget.
    expect(device.burst + device.perMinute * grantMinutes).toBeGreaterThanOrEqual(pollsPerGrant);
  });
});

describe('route classification', () => {
  it('reads /v1/auth as auth, GETs as reads and everything else as mutations', () => {
    expect(classifyRoute('/v1/auth/login', 'GET')).toBe('auth');
    expect(classifyRoute('/v1/auth/device', 'GET')).toBe('auth');
    expect(classifyRoute('/v1/auth/device/approve', 'POST')).toBe('auth');
    // The poll, and only the poll, has its own budget.
    expect(classifyRoute('/v1/auth/device/token', 'POST')).toBe('device');
    expect(classifyRoute('/v1/organizations', 'GET')).toBe('reads');
    expect(classifyRoute('/v1/organizations', 'POST')).toBe('mutations');
    expect(classifyRoute('/v1/organizations/:orgId/members/:userId', 'DELETE')).toBe('mutations');
    // A route that accepts both takes the stricter of the two.
    expect(classifyRoute('/v1/things', ['GET', 'POST'])).toBe('mutations');
    // Not `/v1/authorizations`: the prefix is a path segment, not a substring.
    expect(classifyRoute('/v1/authorizations', 'GET')).toBe('reads');
  });
});

describe('rate limiting', () => {
  it('refuses the request after the bucket is empty, with retry-after', async () => {
    const built = harness({ rateLimits: { reads: rule(2, 'organization') } });
    const alice = await signIn(built, ALICE);

    for (const attempt of [1, 2]) {
      const response = await built.app.inject({
        method: 'GET',
        url: '/v1/organizations',
        headers: alice.headers,
      });
      expect(response.statusCode, `attempt ${String(attempt)}`).toBe(200);
    }

    const limited = await built.app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: alice.headers,
    });
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited)).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['x-ratelimit-limit']).toBe('2');
    expect(limited.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('refills the bucket as time passes', async () => {
    const built = harness({ rateLimits: { reads: rule(60, 'organization') } });
    const alice = await signIn(built, ALICE);

    for (let taken = 0; taken < 60; taken += 1) {
      await built.app.inject({ method: 'GET', url: '/v1/organizations', headers: alice.headers });
    }
    const emptied = await built.app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: alice.headers,
    });
    expect(emptied.statusCode).toBe(429);

    // 60/min is one token a second, and the clock is the test's.
    built.advance(1_100);
    const refilled = await built.app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: alice.headers,
    });
    expect(refilled.statusCode).toBe(200);
  });

  it('rate-limits POST /v1/organizations — every success mints a provider organization', async () => {
    const built = harness({ rateLimits: { mutations: rule(2, 'organization') } });
    const alice = await signIn(built, ALICE);

    expect((await createOrganization(built, alice, 'One')).statusCode).toBe(201);
    expect((await createOrganization(built, alice, 'Two')).statusCode).toBe(201);

    const third = await createOrganization(built, alice, 'Three');
    expect(third.statusCode).toBe(429);
    // The refusal happened before the handler: no third organization was
    // created here or at the provider.
    expect(built.port.createdOrganizations).toHaveLength(2);
    expect(built.organizations.organizations.size).toBe(2);
  });

  it('gives each caller their own bucket', async () => {
    const built = harness({ rateLimits: { reads: rule(1, 'organization') } });
    const alice = await signIn(built, ALICE);
    const bob = await signIn(built, BOB);

    expect(
      (await built.app.inject({ method: 'GET', url: '/v1/organizations', headers: alice.headers }))
        .statusCode,
    ).toBe(200);
    expect(
      (await built.app.inject({ method: 'GET', url: '/v1/organizations', headers: alice.headers }))
        .statusCode,
    ).toBe(429);
    // Bob is not paying for Alice's traffic.
    expect(
      (await built.app.inject({ method: 'GET', url: '/v1/organizations', headers: bob.headers }))
        .statusCode,
    ).toBe(200);
  });

  it('counts the auth surface by address, not by session', async () => {
    // Sign-in has no session to key on, which is the whole point: this is the
    // brute-force surface.
    const built = harness({ rateLimits: { auth: rule(2, 'ip') } });

    expect((await built.app.inject({ method: 'GET', url: '/v1/auth/login' })).statusCode).toBe(302);
    expect((await built.app.inject({ method: 'GET', url: '/v1/auth/login' })).statusCode).toBe(302);

    const limited = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited)).toBe('rate_limited');
  });

  it('keeps the device poll out of the credential bucket', async () => {
    // The two surfaces share a path prefix and nothing else. A device polling
    // its grant must not be able to lock its owner out of signing in, and a
    // credential search must not be able to hide inside the poll's budget.
    const built = harness({
      rateLimits: { auth: rule(1, 'ip'), device: rule(5, 'ip') },
    });

    expect((await built.app.inject({ method: 'GET', url: '/v1/auth/login' })).statusCode).toBe(302);
    // The auth bucket is now empty…
    expect((await built.app.inject({ method: 'GET', url: '/v1/auth/login' })).statusCode).toBe(429);

    // …and the poll is unaffected by that, because it is not in it.
    const polled = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: 'a'.repeat(64) },
    });
    expect(polled.statusCode, polled.body).toBe(400);
    expect(errorOf(polled)).toBe('invalid_device_code');
  });

  describe('the address an ip-scoped class counts', () => {
    /** What one client at `address` sees, given a harness's proxy trust. */
    async function signInFrom(built: Harness, address: string): Promise<number> {
      const response = await built.app.inject({
        method: 'GET',
        url: '/v1/auth/login',
        headers: { 'x-forwarded-for': address },
      });
      return response.statusCode;
    }

    it('ignores X-Forwarded-For when nothing has vouched for it', async () => {
      // The default. Anything else would let a caller pick their own bucket by
      // setting a header — a complete bypass of every ip-scoped limit, which is
      // why `trustProxy: true` is not the fix for the proxy problem.
      const built = harness({ rateLimits: { auth: rule(1, 'ip') } });

      expect(await signInFrom(built, '203.0.113.1')).toBe(302);
      // A different forwarded address, the same bucket: the header was not
      // believed, so both requests are the one socket they arrived on.
      expect(await signInFrom(built, '203.0.113.2')).toBe(429);
    });

    it('gives two forwarded clients their own buckets once a hop is trusted', async () => {
      // Behind a proxy this is the whole point: without it every /v1/auth
      // request in the world shares one ten-a-minute bucket, so any single
      // caller 429s everybody's sign-in and no attacker is limited at all.
      const built = harness({
        rateLimits: { auth: rule(1, 'ip') },
        proxy: { trustedHops: 1, trustedProxies: [] },
      });

      expect(await signInFrom(built, '203.0.113.1')).toBe(302);
      expect(await signInFrom(built, '203.0.113.2')).toBe(302);
      // Each spent their own token, and only their own.
      expect(await signInFrom(built, '203.0.113.1')).toBe(429);
      expect(await signInFrom(built, '203.0.113.2')).toBe(429);
    });

    it('accepts an address allowlist for a topology with no fixed hop count', async () => {
      const built = harness({
        rateLimits: { auth: rule(1, 'ip') },
        proxy: { trustedHops: 0, trustedProxies: ['127.0.0.1'] },
      });

      expect(await signInFrom(built, '203.0.113.1')).toBe(302);
      expect(await signInFrom(built, '203.0.113.2')).toBe(302);
      expect(await signInFrom(built, '203.0.113.1')).toBe(429);
    });
  });

  it('counts each class against what it is protecting', async () => {
    const keys: string[] = [];
    const recording: RateLimiter = {
      take: (key) => {
        keys.push(key);
        return Promise.resolve<RateLimitDecision>({
          outcome: 'allowed',
          remaining: 1,
          retryAfterSeconds: 0,
        });
      },
    };
    const built = harness({ limiter: recording, tenantDb: tenantDb() });
    const alice = await signIn(built, ALICE);
    const created = await createOrganization(built, alice, 'Acme');
    const organizationId = created.json<{ organization: { id: string } }>().organization.id;

    await built.app.inject({ method: 'GET', url: '/v1/organizations', headers: alice.headers });
    await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
    const scoped = await built.app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { ...alice.headers, [ORGANIZATION_HEADER]: organizationId },
    });
    expect(scoped.statusCode, scoped.body).toBe(200);

    // A sign-in is counted per address, because it has no session to key on;
    // a request that names no organization is counted against the caller; and a
    // tenant-scoped route is counted against the organization, which is the
    // fair-share property the whole class exists for.
    expect(keys).toContain('rl:auth:ip:127.0.0.1');
    expect(keys).toContain(`rl:reads:user:${alice.userId}`);
    expect(keys).toContain(`rl:mutations:user:${alice.userId}`);
    expect(keys).toContain(`rl:reads:org:${organizationId}`);
  });

  it('never limits the liveness probe', async () => {
    const built = harness({ rateLimits: { reads: rule(1, 'organization') } });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await built.app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      // Not merely allowed — never consulted, so a cache outage cannot fail it.
      expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  describe('when the limiter cannot answer', () => {
    it('fails open for reads and for mutations, and closed for auth', async () => {
      const { limiter, breakIt } = flakyLimiter();
      const built = harness({ limiter });
      const alice = await signIn(built, ALICE);
      breakIt();

      const read = await built.app.inject({
        method: 'GET',
        url: '/v1/organizations',
        headers: alice.headers,
      });
      expect(read.statusCode, read.body).toBe(200);

      const mutation = await createOrganization(built, alice, 'Acme');
      expect(mutation.statusCode, mutation.body).toBe(201);

      // …and the credential surface goes the other way: brute-force protection
      // that evaporates when the cache blips is not protection.
      const login = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
      expect(login.statusCode).toBe(503);
      expect(errorOf(login)).toBe('rate_limiter_unavailable');
      expect(login.headers['retry-after']).toBe('1');
    });

    it('honours the configured choice rather than a hard-coded one', async () => {
      // The split is configuration, not code: flip it and the behaviour flips.
      const { limiter, breakIt } = flakyLimiter();
      const built = harness({
        limiter,
        rateLimits: {
          reads: { perMinute: 600, burst: 600, scope: 'organization', whenUnavailable: 'deny' },
        },
      });
      const alice = await signIn(built, ALICE);
      breakIt();

      const response = await built.app.inject({
        method: 'GET',
        url: '/v1/organizations',
        headers: alice.headers,
      });
      expect(response.statusCode).toBe(503);
    });
  });
});

describe('idempotency', () => {
  const KEY = 'idem-key-000001';

  it('replays the stored response instead of running the handler again', async () => {
    const built = harness();
    const alice = await signIn(built, ALICE);

    const first = await createOrganization(built, alice, 'Acme', { [IdempotencyHeader]: KEY });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();

    const replay = await createOrganization(built, alice, 'Acme', { [IdempotencyHeader]: KEY });

    expect(replay.statusCode).toBe(201);
    expect(replay.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
    expect(replay.body).toBe(first.body);
    expect(replay.headers['content-type']).toBe(first.headers['content-type']);
    // The point of the whole plugin: one organization, one provider
    // organization, one audit row.
    expect(built.organizations.organizations.size).toBe(1);
    expect(built.port.createdOrganizations).toHaveLength(1);
    expect(built.audit.events).toHaveLength(1);
  });

  it('refuses the same key with a different body', async () => {
    const built = harness();
    const alice = await signIn(built, ALICE);

    await createOrganization(built, alice, 'Acme', { [IdempotencyHeader]: KEY });
    const conflicting = await createOrganization(built, alice, 'Other', {
      [IdempotencyHeader]: KEY,
    });

    expect(conflicting.statusCode).toBe(422);
    expect(errorOf(conflicting)).toBe('idempotency_conflict');
    expect(built.organizations.organizations.size).toBe(1);
  });

  it('reads a reordered body as the same request', async () => {
    const built = harness();
    const alice = await signIn(built, ALICE);

    const first = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { ...alice.headers, [IdempotencyHeader]: KEY },
      payload: { name: 'Acme', slug: 'acme' },
    });
    expect(first.statusCode, first.body).toBe(201);

    const reordered = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { ...alice.headers, [IdempotencyHeader]: KEY },
      payload: { slug: 'acme', name: 'Acme' },
    });

    // Key order is not part of what a client asked for.
    expect(reordered.statusCode, reordered.body).toBe(201);
    expect(reordered.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
  });

  it('answers 409 while the first request is still in flight', async () => {
    const built = harness();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => {};
    // Signalled rather than slept for: "the first request is in flight" has to
    // be a fact this test knows, not a timeout it hopes is long enough.
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // Inside `after`, because `app.requireSession` is a decorator the session
    // plugin adds while it loads — which is exactly how `buildApp` registers
    // every real route.
    built.app.after(() => {
      built.app.post(
        '/v1/slow',
        {
          preHandler: [built.app.requireSession, built.app.requireCsrf],
          schema: { body: z.object({ value: z.string() }) },
        },
        async () => {
          entered();
          await held;
          return { ok: true };
        },
      );
    });
    const alice = await signIn(built, ALICE);

    const send = (): Promise<Awaited<ReturnType<Harness['app']['inject']>>> =>
      built.app.inject({
        method: 'POST',
        url: '/v1/slow',
        headers: { ...alice.headers, [IdempotencyHeader]: KEY },
        payload: { value: 'one' },
      });

    const first = send();
    await inFlight;
    const duplicate = await send();

    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(errorOf(duplicate)).toBe('idempotency_in_progress');
    expect(duplicate.headers['retry-after']).toBe('1');

    release();
    expect((await first).statusCode).toBe(200);
  });

  it('does not store a failure, so the same key can be retried', async () => {
    const built = harness();
    const alice = await signIn(built, ALICE);
    built.port.organizationCreateFails = true;

    const failed = await createOrganization(built, alice, 'Acme', { [IdempotencyHeader]: KEY });
    expect(failed.statusCode).toBe(502);

    built.port.organizationCreateFails = false;
    const retried = await createOrganization(built, alice, 'Acme', { [IdempotencyHeader]: KEY });

    // The handler ran again rather than replaying the 502 for 24 hours.
    expect(retried.statusCode, retried.body).toBe(201);
    expect(retried.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
  });

  it('scopes keys to the caller', async () => {
    const built = harness();
    const alice = await signIn(built, ALICE);
    const bob = await signIn(built, BOB);

    const mine = await createOrganization(built, alice, 'Acme', { [IdempotencyHeader]: KEY });
    const theirs = await createOrganization(built, bob, 'Beta', { [IdempotencyHeader]: KEY });

    expect(mine.statusCode).toBe(201);
    // Neither a collision nor a 422: Bob's key is not Alice's key.
    expect(theirs.statusCode, theirs.body).toBe(201);
    expect(built.organizations.organizations.size).toBe(2);
  });

  it('scopes keys to the caller inside one organization too', async () => {
    // Two members of the same organization both retrying with `retry-1` is not
    // a conflict either of them can act on — and a replay is served from
    // `preHandler`, before `authorize()` runs, so an organization-only scope
    // would hand one member the response another member's permissions earned.
    const built = harness({ tenantDb: tenantDb() });
    const alice = await signIn(built, ALICE);
    const bob = await signIn(built, BOB);
    const created = await createOrganization(built, alice, 'Acme');
    const organizationId = created.json<{ organization: { id: string } }>().organization.id;
    await built.organizations.addMember({
      organizationId,
      userId: bob.userId,
      role: 'builder',
      now: built.now(),
      audit: () => Promise.resolve(),
    });

    const tenant = { [ORGANIZATION_HEADER]: organizationId, [IdempotencyHeader]: KEY };
    const mine = await built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...alice.headers, ...tenant },
      payload: { name: 'Alice Project' },
    });
    const theirs = await built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...bob.headers, ...tenant },
      payload: { name: 'Bob Project' },
    });

    // Same organization, same key, different bodies — and neither a 422 nor a
    // replay of the other's answer.
    expect(mine.statusCode, mine.body).toBe(201);
    expect(theirs.statusCode, theirs.body).toBe(201);
    expect(theirs.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
  });

  it('does not fail a mutation that succeeded when the record cannot be written', async () => {
    // The reservation is taken before the handler runs, where refusing costs
    // nothing; this is after, where refusing costs the whole mutation and
    // protects nothing. An unguarded await here turns a successful create into
    // a 500 whose retry — 409 for a minute, then a second run — produces
    // exactly the duplicate the plugin exists to prevent.
    const store = createInMemoryIdempotencyStore();
    const brittle: IdempotencyStore = {
      reserve: (key, fingerprint, ttl) => store.reserve(key, fingerprint, ttl),
      complete: () => Promise.reject(new Error('redis went away')),
      release: () => Promise.reject(new Error('redis went away')),
    };
    const built = harness({ idempotency: brittle });
    const alice = await signIn(built, ALICE);

    const created = await createOrganization(built, alice, 'Acme', { [IdempotencyHeader]: KEY });

    expect(created.statusCode, created.body).toBe(201);
    expect(built.organizations.organizations.size).toBe(1);
  });

  it('refuses a key that is not one', async () => {
    const built = harness();
    const alice = await signIn(built, ALICE);

    for (const key of ['short', 'has spaces here', 'x'.repeat(256)]) {
      const response = await createOrganization(built, alice, 'Acme', {
        [IdempotencyHeader]: key,
      });
      expect(response.statusCode, key).toBe(400);
      expect(errorOf(response)).toBe('idempotency_key_invalid');
    }
  });

  it('ignores the header on a read', async () => {
    const built = harness();
    const alice = await signIn(built, ALICE);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await built.app.inject({
        method: 'GET',
        url: '/v1/organizations',
        headers: { ...alice.headers, [IdempotencyHeader]: KEY },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
    }
  });

  it('forgets a record once it has expired', async () => {
    const built = harness();
    const alice = await signIn(built, ALICE);

    await createOrganization(built, alice, 'Acme', { [IdempotencyHeader]: KEY });
    built.advance(RECORD_TTL_MS + 1);
    // A day is longer than a session, so the same person signs in again — the
    // user, and therefore the key's scope, is the same one.
    const tomorrow = await signIn(built, ALICE);

    const afterExpiry = await createOrganization(built, tomorrow, 'Acme Two', {
      [IdempotencyHeader]: KEY,
    });
    // A day later the key is nobody's, so this is a new request rather than a
    // conflict with one from yesterday.
    expect(afterExpiry.statusCode, afterExpiry.body).toBe(201);
  });

  it('refuses the request when the store cannot answer, but only if a key was sent', async () => {
    const broken: IdempotencyStore = {
      reserve: () => Promise.reject(new Error('redis is gone')),
      complete: () => Promise.resolve(),
      release: () => Promise.resolve(),
    };
    const built = harness({ idempotency: broken });
    const alice = await signIn(built, ALICE);

    const keyed = await createOrganization(built, alice, 'Acme', { [IdempotencyHeader]: KEY });
    expect(keyed.statusCode).toBe(503);
    expect(errorOf(keyed)).toBe('idempotency_unavailable');

    // A caller who never asked for exactly-once is unaffected.
    const unkeyed = await createOrganization(built, alice, 'Acme Two');
    expect(unkeyed.statusCode, unkeyed.body).toBe(201);
  });

  it('replays a 204 as a 204', async () => {
    const built = harness();
    const alice = await signIn(built, ALICE);
    const bob = await signIn(built, BOB);
    const created = await createOrganization(built, alice, 'Acme');
    const organizationId = created.json<{ organization: { id: string } }>().organization.id;
    await built.organizations.addMember({
      organizationId,
      userId: bob.userId,
      role: 'builder',
      now: built.now(),
      audit: () => Promise.resolve(),
    });

    const remove = (): Promise<Awaited<ReturnType<Harness['app']['inject']>>> =>
      built.app.inject({
        method: 'DELETE',
        url: `/v1/organizations/${organizationId}/members/${bob.userId}`,
        headers: { ...alice.headers, [IdempotencyHeader]: KEY },
      });

    expect((await remove()).statusCode).toBe(204);
    const replay = await remove();

    // Without the record this would be `404 member_not_found`: the member is
    // already gone. That is exactly the retry the header exists to absorb.
    expect(replay.statusCode).toBe(204);
    expect(replay.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
    expect(replay.body).toBe('');
  });
});

describe('the audit seam', () => {
  it('refuses rows that the audit read boundary cannot serialize', async () => {
    // Break caught: a direct sink caller bypasses request-level metadata checks
    // and writes a row that GET /audit-events later cannot parse.
    const base: AuditRecord = {
      organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      actorType: 'user',
      actorId: 'user_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
      action: 'organization.updated',
      targetType: 'organization',
      targetId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      metadata: {},
      occurredAt: new Date('2026-08-05T12:00:00.000Z'),
    };
    const malformed = [
      { ...base, actorType: 'robot' },
      { ...base, actorId: '' },
      { ...base, action: 'organization.typo' },
      { ...base, targetType: 'credential' },
      { ...base, metadata: { cost: Number.POSITIVE_INFINITY } },
      { ...base, metadata: { nested: { token: 'must-not-persist' } } },
    ];

    for (const row of malformed) {
      const sink = createInMemoryAuditSink();
      await expect(sink.record(NO_TRANSACTION, row as never)).rejects.toThrow();
      expect(sink.events).toEqual([]);
    }
  });

  it('refuses metadata that is not scalar', async () => {
    // The type says scalars; this is the runtime half of the same rule. A
    // nested object is how a token or a whole request body ends up in a table
    // that is read years later.
    const built = harness();
    built.app.after(() => {
      built.app.post(
        '/v1/audit-probe',
        { preHandler: [built.app.requireSession] },
        async (request) => {
          await request.audit(NO_TRANSACTION, {
            organizationId: 'org_probe',
            action: 'organization.updated',
            target: { type: 'organization', id: 'org_probe' },
            // Deliberately wrong: the compiler would refuse this, a value read
            // back from a JSON column would not.
            metadata: { nested: { token: 'sk-live-must-never-be-stored' } } as never,
          });
          return { ok: true };
        },
      );
    });
    const alice = await signIn(built, ALICE);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/audit-probe',
      headers: alice.headers,
    });

    expect(response.statusCode).toBe(500);
    expect(errorOf(response)).toBe('internal_error');
    expect(built.audit.events).toHaveLength(0);
    expect(response.body).not.toContain('sk-live');
  });

  it('takes the actor from the session rather than from the caller', async () => {
    const built = harness();
    const alice = await signIn(built, ALICE);

    await createOrganization(built, alice, 'Acme');

    expect(built.audit.events).toHaveLength(1);
    expect(built.audit.events[0]).toMatchObject({ actorType: 'user', actorId: alice.userId });
  });
});

describe('the in-memory doubles', () => {
  it('reserve is exclusive, and a release only drops a pending record', async () => {
    const store = createInMemoryIdempotencyStore();

    expect(await store.reserve('k', 'fingerprint', 1_000)).toBeUndefined();
    expect(await store.reserve('k', 'fingerprint', 1_000)).toMatchObject({ state: 'pending' });

    await store.complete(
      'k',
      'fingerprint',
      { statusCode: 201, body: '{}', contentType: undefined },
      1_000,
    );
    await store.release('k');
    expect(await store.reserve('k', 'fingerprint', 1_000)).toMatchObject({ state: 'completed' });
  });

  it('the bucket refills at the configured rate and no faster', async () => {
    let at = 0;
    const limiter = createInMemoryRateLimiter(() => new Date(at));
    const oneASecond = rule(60, 'organization');

    expect((await limiter.take('k', oneASecond)).outcome).toBe('allowed');
    at += 60_000;
    // A minute of idling refills the bucket, and no further: capacity is the
    // ceiling.
    for (let taken = 0; taken < 60; taken += 1) {
      expect((await limiter.take('k', oneASecond)).outcome).toBe('allowed');
    }
    expect((await limiter.take('k', oneASecond)).outcome).toBe('limited');
  });
});
