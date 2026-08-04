import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRedisTokenDenylist, sessionFamilyKey } from '../../src/auth/denylist.js';
import { createRedisDeviceStore, DEVICE_GRANT_TTL_MS } from '../../src/auth/device.js';
import {
  createRedisInviteStore,
  hashInviteToken,
  INVITE_TTL_MS,
  newInviteToken,
} from '../../src/orgs/invites.js';
import { createRedisIdempotencyStore } from '../../src/plugins/idempotency.js';
import { createRedisRateLimiter, type RateLimiter } from '../../src/plugins/rate-limit.js';
import type { RateLimitRule } from '../../src/config/rate-limits.js';
import { createRedisConnection, type RedisConnection } from '../../src/redis/client.js';
import { hasRedis, redisUrl } from './helpers.js';

/**
 * The five stores CP-2, CP-3 and CP-5 put behind ports, against a real Redis.
 *
 * These are the assertions the in-memory doubles cannot make. Every one of them
 * is about a *Lua script* — the atomic check-and-write that stands where a
 * read-then-write would let two callers both succeed — and Lua only runs on a
 * server. The doubles pin the same contracts on one event loop turn
 * (`test/plugins.test.ts`, `test/auth.test.ts`, `test/orgs.test.ts`); this is
 * what says the shipping implementations agree with them.
 *
 * Keys are random per test, so nothing here collides with a running dev stack
 * and nothing has to be flushed. See `./helpers.ts`.
 */

/** A key nobody else in this Redis is using. */
function unique(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

const MINUTE = 60_000;

describe.skipIf(!hasRedis)('the Redis-backed stores', () => {
  let redis: RedisConnection;

  beforeAll(() => {
    redis = createRedisConnection(redisUrl(), { commandTimeoutMs: 2_000 });
  });

  afterAll(async () => {
    await redis.close();
  });

  describe('the token denylist', () => {
    it('lets exactly one caller spend a token', async () => {
      const denylist = createRedisTokenDenylist(redis);
      const jti = unique('jti');
      const expiresAt = new Date(Date.now() + MINUTE);

      // The write is the test: whoever gets `true` spent it, and a second
      // presentation of the same refresh token is reuse rather than a race
      // nobody noticed.
      const [first, second] = await Promise.all([
        denylist.deny(jti, expiresAt),
        denylist.deny(jti, expiresAt),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(await denylist.isDenied(jti)).toBe(true);
    });

    it('answers for a token and its session family in one call', async () => {
      const denylist = createRedisTokenDenylist(redis);
      const sessionId = unique('sess');

      expect(await denylist.isDenied(unique('jti'), sessionFamilyKey(sessionId))).toBe(false);
      await denylist.deny(sessionFamilyKey(sessionId), new Date(Date.now() + MINUTE));
      expect(await denylist.isDenied(unique('jti'), sessionFamilyKey(sessionId))).toBe(true);
    });

    it('refuses to revoke something that has already expired', async () => {
      const denylist = createRedisTokenDenylist(redis);

      // Nothing left to revoke, and a key with a non-positive TTL is an error
      // rather than a no-op.
      expect(await denylist.deny(unique('jti'), new Date(Date.now() - 1))).toBe(false);
    });

    it('forgets an entry when the token it revokes expires', async () => {
      const denylist = createRedisTokenDenylist(redis);
      const jti = unique('jti');

      // A second, not a tenth of one: expiry is Redis' own clock, so the window
      // has to be wide enough that a busy CI runner cannot land the first
      // assertion after it.
      await denylist.deny(jti, new Date(Date.now() + 1_000));
      expect(await denylist.isDenied(jti)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      // Bounded by unexpired sessions rather than growing forever — and there
      // is no sweep of ours to get wrong.
      expect(await denylist.isDenied(jti)).toBe(false);
    });
  });

  describe('the device store', () => {
    it('carries a grant from one instance to another', async () => {
      // Two stores over one Redis: the browser leg and the poll are served by
      // different processes in any real deployment, which is the whole reason
      // this moved out of memory.
      const browser = createRedisDeviceStore(redis);
      const device = createRedisDeviceStore(redis);
      const grant = await browser.start();

      expect(await device.claim(grant.deviceCode)).toEqual({ status: 'pending' });
      expect(await browser.approve(grant.userCode, 'user_alice')).toBe(true);
      expect(await device.claim(grant.deviceCode)).toEqual({
        status: 'approved',
        userId: 'user_alice',
      });
      // Spent: a device code buys exactly one token.
      expect(await device.claim(grant.deviceCode)).toEqual({ status: 'unknown' });
    });

    it('lets one approval through and no more', async () => {
      const store = createRedisDeviceStore(redis);
      const grant = await store.start();

      const results = await Promise.all([
        store.approve(grant.userCode, 'user_alice'),
        store.approve(grant.userCode, 'user_mallory'),
      ]);

      // A second approval would repoint one code at a second identity.
      expect(results.filter(Boolean)).toHaveLength(1);
      const claim = await store.claim(grant.deviceCode);
      expect(claim.status).toBe('approved');
    });

    it('lets a later refusal override an approval', async () => {
      const store = createRedisDeviceStore(redis);
      const grant = await store.start();

      await store.approve(grant.userCode, 'user_alice');
      expect(await store.deny(grant.userCode)).toBe(true);

      // Somebody changed their mind, and the later answer is the one that
      // counts.
      expect(await store.claim(grant.deviceCode)).toEqual({ status: 'denied' });
    });

    it('tells an expired grant from one that never existed', async () => {
      // The clock is the store's argument, so expiry is asserted rather than
      // waited for — and the key outlives the grant so the distinction survives.
      const past = new Date(Date.now() - DEVICE_GRANT_TTL_MS - 1);
      const issuer = createRedisDeviceStore(redis, () => past);
      const grant = await issuer.start();

      const store = createRedisDeviceStore(redis);
      expect(await store.claim(grant.deviceCode)).toEqual({ status: 'expired' });
      expect(await store.approve(grant.userCode, 'user_alice')).toBe(false);
      expect(await store.claim(unique('device'))).toEqual({ status: 'unknown' });
    });
  });

  describe('the invite store', () => {
    const invite = (tokenHash: string, email = 'alice@acme.test') => ({
      tokenHash,
      organizationId: 'org_test',
      email,
      role: 'builder' as const,
      invitedBy: 'user_owner',
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });

    it('is single use, even under two simultaneous accepts', async () => {
      const store = createRedisInviteStore(redis);
      const token = newInviteToken();
      const hash = hashInviteToken(token);
      await store.issue(invite(hash));

      const accept = (): Promise<{ status: string }> =>
        store.claim({
          tokenHash: hash,
          email: 'alice@acme.test',
          complete: () => Promise.resolve('joined'),
        });
      const [first, second] = await Promise.all([accept(), accept()]);

      expect([first.status, second.status].sort()).toEqual(['claimed', 'used']);
    });

    it('gives back the membership the completion produced', async () => {
      const store = createRedisInviteStore(redis);
      const hash = hashInviteToken(newInviteToken());
      await store.issue(invite(hash));

      const claim = await store.claim({
        tokenHash: hash,
        email: 'alice@acme.test',
        complete: (record) => Promise.resolve(`joined ${record.organizationId} as ${record.role}`),
      });

      expect(claim).toMatchObject({ status: 'claimed', result: 'joined org_test as builder' });
    });

    it('puts the invite back when the membership write fails', async () => {
      // The mandatory fold: spending the invite first and writing the
      // membership afterwards strands an invitee whose write failed on
      // `410 invite_used`, holding a link that can never work again.
      const store = createRedisInviteStore(redis);
      const hash = hashInviteToken(newInviteToken());
      await store.issue(invite(hash));
      const boom = new Error('membership write failed');

      await expect(
        store.claim({
          tokenHash: hash,
          email: 'alice@acme.test',
          complete: () => Promise.reject(boom),
        }),
      ).rejects.toBe(boom);

      // Still claimable, by the right person, at the right role.
      const retried = await store.claim({
        tokenHash: hash,
        email: 'alice@acme.test',
        complete: () => Promise.resolve('joined'),
      });
      expect(retried).toMatchObject({ status: 'claimed' });
    });

    it('does not let the wrong person spend it', async () => {
      const store = createRedisInviteStore(redis);
      const hash = hashInviteToken(newInviteToken());
      await store.issue(invite(hash, 'alice@acme.test'));

      const wrong = await store.claim({
        tokenHash: hash,
        email: 'mallory@elsewhere.test',
        complete: () => Promise.reject(new Error('must not run')),
      });
      expect(wrong.status).toBe('email_mismatch');

      // Untouched: the person it was for can still accept it.
      const right = await store.claim({
        tokenHash: hash,
        email: 'alice@acme.test',
        complete: () => Promise.resolve('joined'),
      });
      expect(right.status).toBe('claimed');
    });

    it('reports an expired invite as expired rather than as missing', async () => {
      const store = createRedisInviteStore(redis);
      const hash = hashInviteToken(newInviteToken());
      await store.issue({ ...invite(hash), expiresAt: new Date(Date.now() - 1_000) });

      expect(
        await store.claim({
          tokenHash: hash,
          email: 'alice@acme.test',
          complete: () => Promise.reject(new Error('must not run')),
        }),
      ).toEqual({ status: 'expired' });
      expect(
        await store.claim({
          tokenHash: hashInviteToken(newInviteToken()),
          email: 'alice@acme.test',
          complete: () => Promise.reject(new Error('must not run')),
        }),
      ).toEqual({ status: 'unknown' });
    });
  });

  describe('the idempotency store', () => {
    const response = { statusCode: 201, body: '{"ok":true}', contentType: 'application/json' };

    it('reserves a key for exactly one caller', async () => {
      const store = createRedisIdempotencyStore(redis);
      const key = unique('idem');

      const [first, second] = await Promise.all([
        store.reserve(key, 'fingerprint', MINUTE),
        store.reserve(key, 'fingerprint', MINUTE),
      ]);

      // One proceeds, the other is told the request is already in flight.
      expect([first, second].filter((entry) => entry === undefined)).toHaveLength(1);
      expect([first, second].filter((entry) => entry?.state === 'pending')).toHaveLength(1);
    });

    it('replays a completed response verbatim', async () => {
      const store = createRedisIdempotencyStore(redis);
      const key = unique('idem');

      await store.reserve(key, 'fingerprint', MINUTE);
      await store.complete(key, 'fingerprint', response, MINUTE);

      expect(await store.reserve(key, 'fingerprint', MINUTE)).toEqual({
        state: 'completed',
        fingerprint: 'fingerprint',
        response,
      });
    });

    it('releases a reservation but never a completed record', async () => {
      const store = createRedisIdempotencyStore(redis);
      const pending = unique('idem');
      const done = unique('idem');

      await store.reserve(pending, 'fingerprint', MINUTE);
      await store.release(pending);
      // A failed attempt hands the key back, so the client may retry with it.
      expect(await store.reserve(pending, 'fingerprint', MINUTE)).toBeUndefined();

      await store.reserve(done, 'fingerprint', MINUTE);
      await store.complete(done, 'fingerprint', response, MINUTE);
      await store.release(done);
      expect(await store.reserve(done, 'fingerprint', MINUTE)).toMatchObject({
        state: 'completed',
      });
    });
  });

  describe('the rate limiter', () => {
    const rule = (perMinute: number): RateLimitRule => ({
      perMinute,
      burst: perMinute,
      scope: 'organization',
      whenUnavailable: 'allow',
    });

    it('empties the bucket once and no more', async () => {
      const limiter = createRedisRateLimiter(redis);
      const key = unique('rl');

      const outcomes = await Promise.all(
        Array.from({ length: 12 }, () => limiter.take(key, rule(10))),
      );

      // Ten tokens, twelve concurrent takers: exactly ten get through, because
      // the bucket is read and written by one server-side step.
      expect(outcomes.filter((one) => one.outcome === 'allowed')).toHaveLength(10);
      expect(outcomes.filter((one) => one.outcome === 'limited')).toHaveLength(2);
    });

    it('says how long to wait, and refills by then', async () => {
      // One token a second, so the bucket cannot refill between two commands
      // however slow the runner is — the only thing that can allow the fourth
      // take is the second that actually passes.
      const limiter = createRedisRateLimiter(redis);
      const key = unique('rl');
      const slow = { ...rule(60), burst: 2 };

      await limiter.take(key, slow);
      await limiter.take(key, slow);
      const limited = await limiter.take(key, slow);

      expect(limited.outcome).toBe('limited');
      expect(limited.retryAfterSeconds).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect((await limiter.take(key, slow)).outcome).toBe('allowed');
    });

    it('reports an unreachable Redis rather than throwing', async () => {
      // The plugin's fail-open/fail-closed split is a *decision* about this
      // answer, so the answer has to exist even when the server does not.
      const gone = createRedisConnection('redis://127.0.0.1:1', { commandTimeoutMs: 200 });
      let reported: unknown;
      const limiter: RateLimiter = createRedisRateLimiter(gone, undefined, (error) => {
        reported = error;
      });

      const decision = await limiter.take(unique('rl'), rule(10));

      expect(decision.outcome).toBe('unavailable');
      expect(reported).toBeDefined();
      await gone.close();
    });
  });
});
