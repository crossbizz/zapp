import { createHmac } from 'node:crypto';

import {
  createServiceTokenSigner,
  MAX_SERVICE_TOKEN_TTL_SECONDS,
  SERVICE_TOKEN_ISSUER,
  type ServiceName,
} from '@zapp/config';
import { ApiErrorSchema, newId } from '@zapp/contracts';
import { base64url } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { createInMemoryTokenDenylist } from '../src/auth/denylist.js';
import { SECRET_DECRYPT_AUDIENCE } from '../src/internal/secrets.js';
import {
  createServiceTokenVerifier,
  SERVICE_TOKEN_HEADER,
  serviceTokenKey,
} from '../src/internal/service-auth.js';
import { loadRateLimitSettings } from '../src/config/rate-limits.js';
import {
  classifyRoute,
  type RateLimitDecision,
  type RateLimiter,
} from '../src/plugins/rate-limit.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';
import {
  TestServiceTokens,
  TEST_PREVIOUS_SERVICE_TOKEN_SECRET,
  TEST_SERVICE_TOKEN_SECRET,
} from './support/service-tokens.js';
import { InMemoryTenantData } from './support/tenant-db.js';

/**
 * Service-to-service authentication (CP-8), through the real HTTP pipeline.
 *
 * `packages/config/test/service-token.test.ts` proves the token itself is sound
 * — algorithm pinning, audience, expiry, the subject enum, rotation. This file
 * proves the *gate* around it does what the only internal route in the system
 * needs, which is a different set of questions:
 *
 * 1. **A person still cannot get in**, and holding a perfectly valid service
 *    token does not help them: a session cookie or a bearer header disqualifies
 *    the request before the token is read.
 * 2. **A token is spent by presenting it.** `POST /internal/secrets/decrypt`
 *    hands back a plaintext credential, so a captured token must be worth at
 *    most the one call it was minted for.
 * 3. **Authentication is not reach.** A verified service that is not on the
 *    route's allowlist is refused *before anything reads a row* — so it cannot
 *    learn which secrets exist by comparing answers. The two responses are
 *    asserted byte-identical.
 * 4. **Failed attempts are counted.** The gate throws 401, which aborts the
 *    preHandler chain, so the rate-limit guard is prepended for `/internal/*`
 *    rather than appended. Without that, unauthenticated traffic against the
 *    one route that emits plaintext is unlimited (plan 02 CP-7 review).
 * 5. **A caller learns nothing from *why* it was refused.** Expired, forged,
 *    replayed, wrong audience and absent all answer the same code; only the log
 *    tells them apart.
 */

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((built) => built.app.close()));
});

const OWNER: AuthIdentity = {
  externalId: 'service-auth-owner',
  email: 'owner@acme.test',
  displayName: 'Olivia Owner',
};

const SANDBOX: ServiceName = 'sandbox-service';
/** Verified, and deliberately not on the decrypt route's allowlist. */
const GIT: ServiceName = 'git-service';

const PLAINTEXT = 'postgres://zapp:hunter2-do-not-leak@db.internal:5432/acme';

/** What the decrypt route asks of a token, for the assertions made below the HTTP layer. */
const SINGLE_USE = { audience: SECRET_DECRYPT_AUDIENCE, singleUse: true } as const;
const REUSABLE = { audience: SECRET_DECRYPT_AUDIENCE, singleUse: false } as const;

function errorOf(response: { json: () => unknown }): string {
  return ApiErrorSchema.parse(response.json()).error.code;
}

interface Wired {
  readonly built: Harness;
  readonly owner: TestSession;
  readonly organizationId: string;
  readonly secretId: string;
  decrypt: (
    headers: Record<string, string>,
    body?: Record<string, unknown>,
  ) => Promise<Awaited<ReturnType<Harness['app']['inject']>>>;
}

/** An organization with one project and one real, encrypted secret in it. */
async function wire(options: Parameters<typeof buildHarness>[0] = {}): Promise<Wired> {
  const data = new InMemoryTenantData();
  const built = buildHarness({ tenantDb: data.factory, ...options });
  harnesses.push(built);

  const owner = await signIn(built, OWNER);
  const created = await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Acme Rockets' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const organizationId = created.json<{ organization: { id: string } }>().organization.id;
  const as = { ...owner.headers, [ORGANIZATION_HEADER]: organizationId };

  const project = await built.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: as,
    payload: { name: 'Checkout Service' },
  });
  expect(project.statusCode, project.body).toBe(201);
  const projectId = project.json<{ project: { id: string } }>().project.id;

  const secret = await built.app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/secrets`,
    headers: as,
    payload: { name: 'DATABASE_URL', value: PLAINTEXT },
  });
  expect(secret.statusCode, secret.body).toBe(201);
  const secretId = secret.json<{ secret: { id: string } }>().secret.id;

  return {
    built,
    owner,
    organizationId,
    secretId,
    decrypt: (headers, body) =>
      built.app.inject({
        method: 'POST',
        url: '/internal/secrets/decrypt',
        headers,
        payload: body ?? {
          organizationId,
          secretId,
          reason: 'injecting into a sandbox for a run',
        },
      }),
  };
}

/** A token header, for the common case. */
const bearing = (token: string): Record<string, string> => ({ [SERVICE_TOKEN_HEADER]: token });

/**
 * A JWS built by hand against the harness's secret, so a test can put anything
 * it likes in the header or the claims. A forgery the code under test produced
 * would only prove it agrees with itself.
 */
function craft(header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    base64url.encode(new TextEncoder().encode(JSON.stringify(value)));
  const input = `${encode(header)}.${encode(claims)}`;
  return `${input}.${base64url.encode(
    createHmac('sha256', TEST_SERVICE_TOKEN_SECRET).update(input).digest(),
  )}`;
}

function claimsAt(now: Date, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const issued = Math.floor(now.getTime() / 1000);
  return {
    iss: SERVICE_TOKEN_ISSUER,
    aud: SECRET_DECRYPT_AUDIENCE,
    sub: SANDBOX,
    jti: `crafted-${String(issued)}-${Math.random().toString(36).slice(2)}`,
    iat: issued,
    exp: issued + 300,
    ...overrides,
  };
}

describe('the internal gate', () => {
  it('gives an allowlisted service the plaintext, and records the token that asked', async () => {
    const wired = await wire();
    const response = await wired.decrypt(bearing(await wired.built.serviceTokens.issue(SANDBOX)));

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ value: string }>().value).toBe(PLAINTEXT);
    // The audit row names the service, which is the identity the *token* carried
    // rather than anything the body claimed.
    const [row] = wired.built.audit.events.filter((event) => event.action === 'secret.decrypted');
    expect(row).toMatchObject({ actorType: 'service', actorId: SANDBOX });
  });

  it('refuses a person holding a valid service token — session, bearer, or both', async () => {
    const wired = await wire();
    const before = wired.built.audit.events.length;

    for (const [label, extra] of [
      ['a session cookie and its CSRF header', wired.owner.headers],
      ['a bearer token', { authorization: 'Bearer whatever-a-user-holds' }],
      ['a refresh cookie alone', { cookie: wired.owner.cookie }],
    ] as [string, Record<string, string>][]) {
      // A token that would work on its own, presented alongside a user
      // credential: the user credential is what disqualifies the request, and it
      // is checked before the token is even read.
      const response = await wired.decrypt({
        ...bearing(await wired.built.serviceTokens.issue(SANDBOX)),
        ...extra,
      });

      expect(response.statusCode, label).toBe(401);
      expect(errorOf(response), label).toBe('service_unauthenticated');
      expect(response.body).not.toContain('hunter2');
    }
    expect(wired.built.audit.events).toHaveLength(before);
  });

  it('refuses an absent, empty or duplicated token header', async () => {
    const wired = await wire();
    const token = await wired.built.serviceTokens.issue(SANDBOX);

    for (const [label, headers] of [
      ['nothing at all', {}],
      ['an empty header', bearing('')],
      ['whitespace', bearing('   ')],
    ] as [string, Record<string, string>][]) {
      const response = await wired.decrypt(headers);
      expect(response.statusCode, label).toBe(401);
      expect(errorOf(response), label).toBe('service_unauthenticated');
    }

    // Two headers: judging the request on whichever one is checked first is how
    // a caller gets to present a credential that is never looked at.
    const duplicated = await wired.built.app.inject({
      method: 'POST',
      url: '/internal/secrets/decrypt',
      headers: { [SERVICE_TOKEN_HEADER]: [token, 'garbage'] },
      payload: {
        organizationId: wired.organizationId,
        secretId: wired.secretId,
        reason: 'presenting two credentials at once',
      },
    });
    expect(duplicated.statusCode).toBe(401);
    expect(errorOf(duplicated)).toBe('service_unauthenticated');
  });
});

describe('what the route will not accept as a token', () => {
  /** Every refusal is the same 401, so the table asserts the whole surface at once. */
  it('refuses expired, wrong-audience, foreign-secret, and unknown-subject tokens alike', async () => {
    const wired = await wire();
    const now = wired.built.now();
    const foreign = new TestServiceTokens({ secret: 'z'.repeat(64) });

    const cases: [string, string][] = [
      [
        'expired — one second past its exp, with clock tolerance zero',
        craft({ alg: 'HS256', typ: 'JWT' }, claimsAt(new Date(now.getTime() - 301_000))),
      ],
      [
        'minted for another audience',
        await wired.built.serviceTokens.issue(SANDBOX, { aud: 'model-gateway' }),
      ],
      ['signed with a secret this deployment does not hold', await foreign.issue(SANDBOX)],
      [
        'a subject that is not a known service',
        craft({ alg: 'HS256', typ: 'JWT' }, claimsAt(now, { sub: 'control-api' })),
      ],
      [
        'a lifetime beyond the ceiling, however it was minted',
        craft(
          { alg: 'HS256', typ: 'JWT' },
          claimsAt(now, {
            exp: Math.floor(now.getTime() / 1000) + MAX_SERVICE_TOKEN_TTL_SECONDS + 60,
          }),
        ),
      ],
      [
        // The other half of the ceiling (CP-8 review): a legal ten-minute
        // window, dated a year forward. `exp - iat` is within bounds; where the
        // window *sits* is not, and left unchecked this reaches the route with
        // a year of validity and writes a year-long denylist key.
        'a short window dated into the future',
        craft(
          { alg: 'HS256', typ: 'JWT' },
          claimsAt(new Date(now.getTime() + 365 * 86_400_000)),
        ),
      ],
      ['not a JWT at all', 'forged-or-expired'],
    ];

    for (const [label, token] of cases) {
      const response = await wired.decrypt(bearing(token));
      expect(response.statusCode, label).toBe(401);
      // One code for all of them: which one it was is in the log, because
      // telling a caller apart "expired" from "forged" tells whoever is holding
      // the wrong token which kind of wrong it is.
      expect(errorOf(response), label).toBe('service_unauthenticated');
      expect(response.body, label).not.toContain('hunter2');
    }
    expect(
      wired.built.audit.events.filter((event) => event.action === 'secret.decrypted'),
    ).toHaveLength(0);
  });

  it('refuses alg confusion — none and RS256, with a valid HMAC underneath', async () => {
    const wired = await wire();
    const claims = claimsAt(wired.built.now());

    for (const alg of ['none', 'RS256', 'ES256', 'HS512']) {
      const response = await wired.decrypt(bearing(craft({ alg, typ: 'JWT' }, claims)));
      expect(response.statusCode, alg).toBe(401);
      expect(errorOf(response), alg).toBe('service_unauthenticated');
    }

    // The control: the same claims, signed the same way, with the header saying
    // HS256. Without this the four assertions above could be passing for a
    // reason that has nothing to do with the algorithm.
    const accepted = await wired.decrypt(bearing(craft({ alg: 'HS256', typ: 'JWT' }, claims)));
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it('accepts the previous secret while a rotation is in flight, and nothing else', async () => {
    const wired = await wire({
      serviceTokenSecrets: {
        secret: TEST_SERVICE_TOKEN_SECRET,
        previousSecret: TEST_PREVIOUS_SERVICE_TOKEN_SECRET,
      },
    });
    const outgoing = new TestServiceTokens({ secret: TEST_PREVIOUS_SERVICE_TOKEN_SECRET });
    const stranger = new TestServiceTokens({ secret: 'f'.repeat(64) });

    // A service that has not restarted yet still signs with the old secret, and
    // its calls keep working — which is the whole reason the variable exists.
    const rotated = await wired.decrypt(bearing(await outgoing.issue(SANDBOX)));
    expect(rotated.statusCode, rotated.body).toBe(200);

    const forged = await wired.decrypt(bearing(await stranger.issue(SANDBOX)));
    expect(forged.statusCode).toBe(401);
    expect(errorOf(forged)).toBe('service_unauthenticated');
  });
});

describe('single use', () => {
  it('refuses the second presentation of a token, and hands back no second copy', async () => {
    const wired = await wire();
    const token = await wired.built.serviceTokens.issue(SANDBOX);

    const first = await wired.decrypt(bearing(token));
    const replayed = await wired.decrypt(bearing(token));

    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<{ value: string }>().value).toBe(PLAINTEXT);
    // The captured token is worth exactly the call it was minted for.
    expect(replayed.statusCode).toBe(401);
    expect(errorOf(replayed)).toBe('service_unauthenticated');
    expect(replayed.body).not.toContain('hunter2');
    // One release of the credential, one audit row.
    expect(
      wired.built.audit.events.filter((event) => event.action === 'secret.decrypted'),
    ).toHaveLength(1);
  });

  it('lets the same service call again with a token it minted again', async () => {
    // Single use is a property of the *token*, not a per-service lockout: a
    // sandbox starting with four secrets makes four calls.
    const wired = await wire();

    for (const attempt of [1, 2, 3]) {
      const response = await wired.decrypt(bearing(await wired.built.serviceTokens.issue(SANDBOX)));
      expect(response.statusCode, `attempt ${String(attempt)}`).toBe(200);
    }
    expect(
      wired.built.audit.events.filter((event) => event.action === 'secret.decrypted'),
    ).toHaveLength(3);
  });

  it('spends a token even when the call it was spent on failed', async () => {
    // "Presented, therefore spent" is the rule, rather than "spent if it turned
    // out to be useful" — which would let a captured token be retried against
    // every organization id in turn until one answered 200.
    const wired = await wire();
    const token = await wired.built.serviceTokens.issue(SANDBOX);

    const wrongTenant = await wired.decrypt(bearing(token), {
      organizationId: newId('org'),
      secretId: wired.secretId,
      reason: 'reaching across a tenant boundary',
    });
    expect(wrongTenant.statusCode).toBe(404);

    const retried = await wired.decrypt(bearing(token));
    expect(retried.statusCode).toBe(401);
    expect(retried.body).not.toContain('hunter2');
  });

  it('spends the jti under a namespace a session id cannot collide with', async () => {
    const denylist = createInMemoryTokenDenylist();
    const tokens = new TestServiceTokens({ denylist });
    const token = await tokens.issue(SANDBOX);

    const verdict = await tokens.verifier.verify(token, SINGLE_USE);
    expect(verdict).toMatchObject({ ok: true });
    expect(await tokens.verifier.verify(token, SINGLE_USE)).toEqual({
      ok: false,
      reason: 'replayed',
    });

    // The denied key is the prefixed one, so spending a service token can never
    // be what revokes a user session that happens to share an id.
    const jti = verdict.ok ? verdict.identity.tokenId : '';
    expect(await denylist.isDenied(serviceTokenKey(jti))).toBe(true);
    expect(await denylist.isDenied(jti)).toBe(false);
  });
});

describe('the allowlist', () => {
  it('refuses a verified service the route does not name — and tells it nothing else', async () => {
    const wired = await wire();

    const response = await wired.decrypt(bearing(await wired.built.serviceTokens.issue(GIT)));

    // 403, not 401: it is authenticated. Compromising one service's token does
    // not confer every service's reach.
    expect(response.statusCode, response.body).toBe(403);
    expect(errorOf(response)).toBe('service_not_allowed');
    expect(response.body).not.toContain('hunter2');
    expect(
      wired.built.audit.events.filter((event) => event.action === 'secret.decrypted'),
    ).toHaveLength(0);
  });

  it('answers identically whether the secret exists or not', async () => {
    /**
     * The oracle test. `git-service` holds a perfectly valid token; the only
     * difference between these two requests is that one names a secret that
     * exists. If the allowlist were consulted after the read — or if the
     * handler ran at all — the answers would differ, and an unallowlisted
     * service could enumerate a tenant's vault one 403-versus-404 at a time.
     */
    const wired = await wire();

    const real = await wired.decrypt(bearing(await wired.built.serviceTokens.issue(GIT)), {
      organizationId: wired.organizationId,
      secretId: wired.secretId,
      reason: 'probing for a secret that exists',
    });
    const absent = await wired.decrypt(bearing(await wired.built.serviceTokens.issue(GIT)), {
      organizationId: wired.organizationId,
      secretId: newId('sec'),
      reason: 'probing for a secret that does not',
    });
    const otherTenant = await wired.decrypt(bearing(await wired.built.serviceTokens.issue(GIT)), {
      organizationId: newId('org'),
      secretId: wired.secretId,
      reason: 'probing another tenant entirely',
    });

    const shape = (
      response: Awaited<ReturnType<Wired['decrypt']>>,
    ): { statusCode: number; code: string; message: string } => {
      const body = ApiErrorSchema.parse(response.json());
      return { statusCode: response.statusCode, code: body.error.code, message: body.error.message };
    };

    expect(shape(absent)).toEqual(shape(real));
    expect(shape(otherTenant)).toEqual(shape(real));
    expect(shape(real).statusCode).toBe(403);
    // …and the allowlisted caller *can* tell them apart, which is what makes the
    // assertion above about the allowlist rather than about the route being
    // uniformly unhelpful.
    const allowed = await wired.decrypt(bearing(await wired.built.serviceTokens.issue(SANDBOX)), {
      organizationId: wired.organizationId,
      secretId: newId('sec'),
      reason: 'the same probe, from a service that may ask',
    });
    expect(allowed.statusCode).toBe(404);
    expect(errorOf(allowed)).toBe('secret_not_found');
  });

  it('is a route decision, so narrowing it refuses a service that was allowed', async () => {
    const wired = await wire({ decryptCallers: ['release-service'] });

    const response = await wired.decrypt(bearing(await wired.built.serviceTokens.issue(SANDBOX)));

    expect(response.statusCode, response.body).toBe(403);
    expect(errorOf(response)).toBe('service_not_allowed');
  });
});

describe('rate limiting the internal surface', () => {
  const rule = (perMinute: number) =>
    ({ perMinute, burst: perMinute, scope: 'ip', whenUnavailable: 'deny' }) as const;

  it('is configured as a credential surface in the file that ships', () => {
    // The numbers are an operator's to change, but three properties are not,
    // and a suite that only ever ran against its own tightened config would not
    // notice them changing. Address-scoped because there is no session to key
    // on before the token is checked; fail-closed because this is a credential
    // surface; and above the mutations budget because a sandbox start is one
    // decrypt per secret.
    const { internal, mutations } = loadRateLimitSettings().classes;

    expect(internal.scope).toBe('ip');
    expect(internal.whenUnavailable).toBe('deny');
    expect(internal.perMinute).toBeGreaterThan(mutations.perMinute);
    expect(internal.burst).toBeGreaterThan(mutations.perMinute);
  });

  it('classifies /internal/* as its own class', () => {
    expect(classifyRoute('/internal/secrets/decrypt', 'POST')).toBe('internal');
    expect(classifyRoute('/internal', 'GET')).toBe('internal');
    // A path segment, not a substring: nothing outside the surface is caught.
    expect(classifyRoute('/v1/internal-things', 'GET')).toBe('reads');
  });

  it('counts attempts that never authenticate — 429 before 401', async () => {
    /**
     * The guard for `/internal/*` is prepended rather than appended, because
     * `requireService` throws 401 and aborts the chain. Without the prepend
     * these three requests would all be 401 forever: unlimited token guessing
     * and unlimited flooding of the one route that emits a plaintext (plan 02
     * CP-7 review).
     */
    const wired = await wire({ rateLimits: { internal: rule(2) } });

    const first = await wired.decrypt(bearing('not-a-token'));
    const second = await wired.decrypt(bearing('not-a-token-either'));
    const third = await wired.decrypt(bearing('nor-this-one'));

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(401);
    expect(third.statusCode).toBe(429);
    expect(errorOf(third)).toBe('rate_limited');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    // The budget headers are on the 401s too, which is the direct evidence that
    // the guard ran *before* the gate rather than after it.
    expect(first.headers['x-ratelimit-limit']).toBe('2');
    expect(first.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('spends the same budget on a valid call, and leaves room for a real caller', async () => {
    const wired = await wire({ rateLimits: { internal: rule(3) } });

    for (const attempt of [1, 2, 3]) {
      const response = await wired.decrypt(bearing(await wired.built.serviceTokens.issue(SANDBOX)));
      expect(response.statusCode, `attempt ${String(attempt)}`).toBe(200);
    }
    const fourth = await wired.decrypt(bearing(await wired.built.serviceTokens.issue(SANDBOX)));
    expect(fourth.statusCode).toBe(429);
  });

  it('fails closed when the limiter cannot answer', async () => {
    // The auth-class posture, for the same reason: this is a credential
    // surface, and protection that evaporates when the cache blips is not
    // protection. The shipped file says `deny` for this class.
    const unavailable: RateLimiter = {
      take: (): Promise<RateLimitDecision> =>
        Promise.resolve({ outcome: 'unavailable', remaining: 0, retryAfterSeconds: 1 }),
    };
    const built = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      limiter: unavailable,
    });
    harnesses.push(built);

    const response = await built.app.inject({
      method: 'POST',
      url: '/internal/secrets/decrypt',
      headers: bearing(await built.serviceTokens.issue(SANDBOX)),
      payload: { organizationId: newId('org'), secretId: newId('sec'), reason: 'a valid request' },
    });

    expect(response.statusCode).toBe(503);
    expect(errorOf(response)).toBe('rate_limiter_unavailable');
  });
});

describe('the verifier itself', () => {
  it('reports a replay store that cannot answer, rather than admitting the token', async () => {
    // Fail closed: a single-use guarantee that lapses when Redis is unhealthy is
    // not a guarantee. Reachable only by something already holding a valid
    // token, since every other refusal is decided before the store is touched —
    // which is why it is a 503 rather than another 401.
    const down = (): Promise<never> => Promise.reject(new Error('redis is down'));
    const broken = createServiceTokenVerifier({
      signer: createServiceTokenSigner({ secret: TEST_SERVICE_TOKEN_SECRET }),
      denylist: { deny: down, isDenied: down },
    });

    const token = await new TestServiceTokens().issue(SANDBOX);

    expect(await broken.verify(token, SINGLE_USE)).toEqual({ ok: false, reason: 'unavailable' });
    // Reusable routes consult the same store, so they fail the same way.
    expect(await broken.verify(token, REUSABLE)).toEqual({ ok: false, reason: 'unavailable' });
    // A token that was never valid is still refused as invalid: the store is
    // not consulted for it at all.
    expect(await broken.verify('not-a-token', SINGLE_USE)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('answers a 503 through the route when the replay store is down', async () => {
    const down = (): Promise<never> => Promise.reject(new Error('redis is down'));
    const built = buildHarness({ tenantDb: new InMemoryTenantData().factory });
    harnesses.push(built);
    const token = await built.serviceTokens.issue(SANDBOX);
    // Break the store the harness's verifier holds, after it has minted.
    const verifier = createServiceTokenVerifier({
      signer: createServiceTokenSigner({ secret: TEST_SERVICE_TOKEN_SECRET }),
      denylist: { deny: down, isDenied: down },
    });
    const broken = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      serviceTokenVerifier: verifier,
    });
    harnesses.push(broken);

    const response = await broken.app.inject({
      method: 'POST',
      url: '/internal/secrets/decrypt',
      headers: bearing(token),
      payload: { organizationId: newId('org'), secretId: newId('sec'), reason: 'a valid request' },
    });

    expect(response.statusCode).toBe(503);
    expect(errorOf(response)).toBe('service_auth_unavailable');
  });

  it('lets a reusable route reuse a token, but still honours revocation', async () => {
    // No route declares `singleUse: false` today, which is why the default is
    // the safe one. The behaviour is pinned so the day one does, revocation
    // still reaches it.
    const tokens = new TestServiceTokens();
    const token = await tokens.issue(SANDBOX);

    expect(await tokens.verifier.verify(token, REUSABLE)).toMatchObject({ ok: true });
    expect(await tokens.verifier.verify(token, REUSABLE)).toMatchObject({ ok: true });

    // Spending it on the single-use route revokes it everywhere.
    expect(await tokens.verifier.verify(token, SINGLE_USE)).toMatchObject({ ok: true });
    expect(await tokens.verifier.verify(token, REUSABLE)).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });
});

describe('registration guards', () => {
  it('refuses an internal route that admits nobody, or names something unknown', async () => {
    const built = buildHarness({ tenantDb: new InMemoryTenantData().factory });
    harnesses.push(built);
    await built.app.ready();

    // An empty allowlist admits nobody: a mistake to catch at boot rather than
    // a policy to discover from a 403 that never stops.
    expect(() => built.app.requireService({ audience: SECRET_DECRYPT_AUDIENCE, callers: [] })).toThrow(
      /at least one allowed service/,
    );
    // An audience nothing can mint for is a route nobody can call.
    expect(() =>
      built.app.requireService({
        audience: 'control-api:whatever' as never,
        callers: [SANDBOX],
      }),
    ).toThrow(/not a known service-token audience/);
    // A caller that is not a service can never match a verified `sub`.
    expect(() =>
      built.app.requireService({
        audience: SECRET_DECRYPT_AUDIENCE,
        callers: ['sandbox-service-2' as never],
      }),
    ).toThrow(/not a known service/);
  });
});
