import { createHmac } from 'node:crypto';

import { SignJWT, base64url } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  createServiceTokenSigner,
  isServiceName,
  MAX_SERVICE_TOKEN_TTL_SECONDS,
  SERVICE_NAMES,
  SERVICE_TOKEN_ISSUER,
  type ServiceAudience,
  type ServiceTokenVerdict,
} from '../src/service-token.js';

/**
 * The service-token primitive (plan 02 CP-8).
 *
 * Every assertion here is about a way a JWT verifier is usually wrong, because
 * "it verifies a token it just signed" is the one property that is never the
 * problem. In order: the algorithm is pinned so `none` and `RS256` cannot ask
 * the verifier to skip or to misuse the key; the audience is pinned so a
 * credential minted for one route cannot be spent on another; the issuer is
 * pinned so a session JWT is not a service token; `sub` is checked against a
 * closed set so a signature does not get to name its own caller; the lifetime
 * is bounded at *both* ends so one compromised minter cannot issue a
 * month-long credential; and the previous secret verifies while never signing,
 * so a rotation is a deploy rather than an outage.
 *
 * The tokens are minted with the shipping signer, and the forgeries with `jose`
 * and `node:crypto` directly — a forgery built by the code under test would only
 * prove it disagrees with itself.
 */

const SECRET = 'a'.repeat(64);
const PREVIOUS = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);

const AUD: ServiceAudience = 'control-api:secrets.decrypt';
const CALLER = 'sandbox-service';

const signer = createServiceTokenSigner({ secret: SECRET });
const rotating = createServiceTokenSigner({ secret: SECRET, previousSecret: PREVIOUS });

const NOW = new Date('2026-08-04T12:00:00.000Z');
const seconds = (from: Date, count: number): Date => new Date(from.getTime() + count * 1000);

/** The rejection reason, or `'ok'` — so a failed expectation prints which. */
function outcome(verdict: ServiceTokenVerdict): string {
  return verdict.ok ? 'ok' : verdict.reason;
}

describe('signing', () => {
  it('mints a token the verifier accepts, with claims from the signature', async () => {
    const issued = await signer.signServiceToken({ service: CALLER, aud: AUD, now: NOW });

    const verdict = await signer.verifyServiceToken(issued.token, AUD, NOW);

    expect(outcome(verdict)).toBe('ok');
    if (!verdict.ok) {
      return;
    }
    expect(verdict.claims).toEqual({
      service: CALLER,
      audience: AUD,
      jti: issued.jti,
      issuedAt: NOW,
      expiresAt: issued.expiresAt,
    });
    // Five minutes by default (`DEFAULT_SERVICE_TOKEN_TTL_SECONDS`).
    expect(issued.expiresAt.getTime() - NOW.getTime()).toBe(300_000);
  });

  it('gives every token its own jti — the thing a single-use route spends', async () => {
    const mint = (): Promise<{ jti: string }> =>
      signer.signServiceToken({ service: CALLER, aud: AUD, now: NOW });
    const jtis = new Set((await Promise.all([mint(), mint(), mint()])).map((token) => token.jti));

    expect(jtis.size).toBe(3);
  });

  it('refuses to mint a long-lived credential', async () => {
    for (const ttlSec of [MAX_SERVICE_TOKEN_TTL_SECONDS + 1, 86_400, 0, -1, 1.5, Number.NaN]) {
      await expect(
        signer.signServiceToken({ service: CALLER, aud: AUD, ttlSec, now: NOW }),
      ).rejects.toThrow(/ttlSec/);
    }
    // The ceiling itself is allowed: it is a maximum, not an exclusive bound.
    await expect(
      signer.signServiceToken({
        service: CALLER,
        aud: AUD,
        ttlSec: MAX_SERVICE_TOKEN_TTL_SECONDS,
        now: NOW,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a service or an audience outside the enums, at runtime', async () => {
    await expect(
      signer.signServiceToken({
        // A JavaScript caller, or a value that arrived typed as `string`.
        service: 'attacker-service' as never,
        aud: AUD,
        now: NOW,
      }),
    ).rejects.toThrow(/not a known service/);

    await expect(
      signer.signServiceToken({ service: CALLER, aud: 'control-api:anything' as never, now: NOW }),
    ).rejects.toThrow(/not a known audience/);
  });
});

describe('verification', () => {
  it('refuses a token minted for another audience', async () => {
    // Same secret, same issuer, same service, valid signature, unexpired: the
    // audience is the only thing wrong with it, and it is enough.
    const issued = await signer.signServiceToken({
      service: CALLER,
      aud: 'model-gateway',
      now: NOW,
    });

    expect(outcome(await signer.verifyServiceToken(issued.token, AUD, NOW))).toBe('audience');
  });

  it('refuses an expired token, to the second', async () => {
    const issued = await signer.signServiceToken({
      service: CALLER,
      aud: AUD,
      ttlSec: 60,
      now: NOW,
    });

    // One second before it lapses, and one second after. Clock tolerance is
    // zero, so there is no third answer in between.
    expect(outcome(await signer.verifyServiceToken(issued.token, AUD, seconds(NOW, 59)))).toBe('ok');
    expect(outcome(await signer.verifyServiceToken(issued.token, AUD, seconds(NOW, 61)))).toBe(
      'expired',
    );
  });

  it('refuses a token signed with a secret this deployment does not hold', async () => {
    const foreign = createServiceTokenSigner({ secret: OTHER });
    const issued = await foreign.signServiceToken({ service: CALLER, aud: AUD, now: NOW });

    expect(outcome(await signer.verifyServiceToken(issued.token, AUD, NOW))).toBe('signature');
  });

  it('refuses garbage without throwing', async () => {
    for (const token of ['', 'not-a-jwt', 'a.b.c', '...', 'eyJhbGciOiJIUzI1NiJ9..']) {
      const verdict = await signer.verifyServiceToken(token, AUD, NOW);
      expect(verdict.ok, token).toBe(false);
    }
  });

  it('refuses a subject that is not one of the known services', async () => {
    // Signed with the real secret and otherwise perfect — which is the point:
    // holding the secret must not let a caller name itself whatever it likes,
    // because the name is what a route's allowlist decides on.
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(SERVICE_TOKEN_ISSUER)
      .setAudience(AUD)
      .setSubject('sandbox-service-2')
      .setJti('forged-jti')
      .setIssuedAt(NOW)
      .setExpirationTime(seconds(NOW, 300))
      .sign(new TextEncoder().encode(SECRET));

    expect(outcome(await signer.verifyServiceToken(forged, AUD, NOW))).toBe('service');
  });

  it('refuses a token from another issuer, so a session JWT is not a service token', async () => {
    const notOurs = await new SignJWT({ kind: 'access' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      // What `createSessionSigner` puts in a user's access token.
      .setIssuer('https://zapp.build')
      .setAudience(AUD)
      .setSubject(CALLER)
      .setJti('session-jti')
      .setIssuedAt(NOW)
      .setExpirationTime(seconds(NOW, 300))
      .sign(new TextEncoder().encode(SECRET));

    expect(outcome(await signer.verifyServiceToken(notOurs, AUD, NOW))).toBe('issuer');
  });

  it('refuses a token missing the claims the system depends on', async () => {
    const key = new TextEncoder().encode(SECRET);
    const base = (): SignJWT =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(SERVICE_TOKEN_ISSUER)
        .setAudience(AUD)
        .setSubject(CALLER);

    // No `exp`: a credential that never expires.
    const noExpiry = await base().setJti('j').setIssuedAt(NOW).sign(key);
    // No `jti`: nothing for a single-use route to spend.
    const noId = await base().setIssuedAt(NOW).setExpirationTime(seconds(NOW, 300)).sign(key);
    // No `iat`: nothing to measure the lifetime ceiling against.
    const noIssuedAt = await base().setJti('j').setExpirationTime(seconds(NOW, 300)).sign(key);

    for (const token of [noExpiry, noId, noIssuedAt]) {
      expect(outcome(await signer.verifyServiceToken(token, AUD, NOW))).toBe('incomplete');
    }
  });

  it('refuses a token whose own lifetime exceeds the ceiling, however it was minted', async () => {
    // The signer refuses to mint this; a patched or compromised one would not.
    // Since every service shares the secret, the bound has to be checked by the
    // verifier too or it is a bound on politeness.
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(SERVICE_TOKEN_ISSUER)
      .setAudience(AUD)
      .setSubject(CALLER)
      .setJti('long-lived')
      .setIssuedAt(NOW)
      .setExpirationTime(seconds(NOW, 30 * 24 * 60 * 60))
      .sign(new TextEncoder().encode(SECRET));

    expect(outcome(await signer.verifyServiceToken(forged, AUD, NOW))).toBe('lifetime');
  });

  it('refuses a short window dated into the future, which is the same attack', async () => {
    /**
     * The half `exp - iat` misses (CP-8 review). This token's window is a
     * perfectly legal ten minutes wide — it is *where the window sits* that is
     * wrong, and nothing else looks: `jwtVerify` compares `exp` against now, so
     * a future `exp` passes, and it reads `iat` only when `maxTokenAge` is set,
     * so a future `iat` is never questioned.
     *
     * Left unchecked this is a year-long credential, and — spent on the
     * single-use decrypt route — a denylist key with a year-long TTL chosen by
     * whoever minted it.
     */
    const aYearOn = seconds(NOW, 365 * 24 * 60 * 60);
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(SERVICE_TOKEN_ISSUER)
      .setAudience(AUD)
      .setSubject(CALLER)
      .setJti('post-dated')
      .setIssuedAt(aYearOn)
      .setExpirationTime(seconds(aYearOn, MAX_SERVICE_TOKEN_TTL_SECONDS))
      .sign(new TextEncoder().encode(SECRET));

    // Not in a year's time, and not today.
    expect(outcome(await signer.verifyServiceToken(forged, AUD, NOW))).toBe('lifetime');
    expect(outcome(await signer.verifyServiceToken(forged, AUD, seconds(NOW, 180 * 86_400)))).toBe(
      'lifetime',
    );
    // The honest token of the same width, verified at the same instant, is fine
    // — so the refusal is about where the window sits, not how wide it is.
    const honest = await signer.signServiceToken({
      service: CALLER,
      aud: AUD,
      ttlSec: MAX_SERVICE_TOKEN_TTL_SECONDS,
      now: NOW,
    });
    expect(outcome(await signer.verifyServiceToken(honest.token, AUD, NOW))).toBe('ok');
  });

  it('refuses a back-dated token whose remaining validity is short', async () => {
    // The other side of the pair, and the case that keeps *both* checks
    // falsifiable: this token expires five minutes from now, so the bound
    // measured from now is satisfied — it is the claimed *width*, a year, that
    // is not. `iat` is a claim about the token's age that a trail may record,
    // and one that lies about it by a year is not a token this system minted.
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(SERVICE_TOKEN_ISSUER)
      .setAudience(AUD)
      .setSubject(CALLER)
      .setJti('back-dated')
      .setIssuedAt(seconds(NOW, -365 * 86_400))
      .setExpirationTime(seconds(NOW, 300))
      .sign(new TextEncoder().encode(SECRET));

    expect(outcome(await signer.verifyServiceToken(forged, AUD, NOW))).toBe('lifetime');
  });

  it('refuses an aud array, even one that contains the expected audience', async () => {
    // jose is satisfied by membership. A token addressed to four audiences at
    // once is not a token addressed to this route, and only a changed minter
    // produces one — which is the caller the audience check exists for.
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(SERVICE_TOKEN_ISSUER)
      .setAudience([AUD, 'model-gateway', 'git-service'])
      .setSubject(CALLER)
      .setJti('multi-addressed')
      .setIssuedAt(NOW)
      .setExpirationTime(seconds(NOW, 300))
      .sign(new TextEncoder().encode(SECRET));

    expect(outcome(await signer.verifyServiceToken(forged, AUD, NOW))).toBe('audience');
  });

  it('names a not-yet-valid token for what it is, rather than as a missing claim', async () => {
    // Nothing here mints an `nbf`, so seeing one means a minter that is not this
    // module — and an operator reading `incomplete` would go looking for the
    // wrong bug.
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(SERVICE_TOKEN_ISSUER)
      .setAudience(AUD)
      .setSubject(CALLER)
      .setJti('early')
      .setIssuedAt(NOW)
      .setNotBefore(seconds(NOW, 60))
      .setExpirationTime(seconds(NOW, 300))
      .sign(new TextEncoder().encode(SECRET));

    expect(outcome(await signer.verifyServiceToken(forged, AUD, NOW))).toBe('not_yet_valid');
  });
});

describe('algorithm confusion', () => {
  /** A JWS built by hand, so the header says whatever this test needs it to say. */
  function craft(header: Record<string, unknown>, payload: Record<string, unknown>): string {
    const encode = (value: unknown): string =>
      base64url.encode(new TextEncoder().encode(JSON.stringify(value)));
    const signingInput = `${encode(header)}.${encode(payload)}`;
    const signature = base64url.encode(
      createHmac('sha256', SECRET).update(signingInput).digest(),
    );
    return `${signingInput}.${signature}`;
  }

  const claims = {
    iss: SERVICE_TOKEN_ISSUER,
    aud: AUD,
    sub: CALLER,
    jti: 'forged',
    iat: Math.floor(NOW.getTime() / 1000),
    exp: Math.floor(NOW.getTime() / 1000) + 300,
  };

  it('refuses alg: none, signature or no signature', async () => {
    const unsigned = `${base64url.encode(
      new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    )}.${base64url.encode(new TextEncoder().encode(JSON.stringify(claims)))}.`;

    for (const token of [unsigned, craft({ alg: 'none', typ: 'JWT' }, claims)]) {
      const verdict = await signer.verifyServiceToken(token, AUD, NOW);
      expect(verdict.ok).toBe(false);
      expect(outcome(verdict)).not.toBe('ok');
    }
  });

  it('refuses an asymmetric alg, even with a correct HMAC over the secret', async () => {
    // The classic confusion: the header claims RS256 so that a verifier which
    // trusts it treats the key as a public key. The signature here is a valid
    // HS256 MAC, so only the pinned algorithm can be what refuses this.
    for (const alg of ['RS256', 'ES256', 'HS384', 'HS512']) {
      const verdict = await signer.verifyServiceToken(
        craft({ alg, typ: 'JWT' }, claims),
        AUD,
        NOW,
      );
      expect(outcome(verdict), alg).toBe('algorithm');
    }
  });

  it('accepts the same claims when the header says HS256 — the control', async () => {
    // Without this, every assertion above could be passing because the crafted
    // token is malformed in some way that has nothing to do with `alg`.
    expect(outcome(await signer.verifyServiceToken(craft({ alg: 'HS256' }, claims), AUD, NOW))).toBe(
      'ok',
    );
  });
});

describe('secret rotation', () => {
  it('verifies a token minted under the previous secret', async () => {
    const old = createServiceTokenSigner({ secret: PREVIOUS });
    const issued = await old.signServiceToken({ service: CALLER, aud: AUD, now: NOW });

    expect(outcome(await rotating.verifyServiceToken(issued.token, AUD, NOW))).toBe('ok');
    // …and only while the rotation is in flight: a deployment that has finished
    // it drops the variable and the token stops verifying.
    expect(outcome(await signer.verifyServiceToken(issued.token, AUD, NOW))).toBe('signature');
  });

  it('signs only with the current secret', async () => {
    const issued = await rotating.signServiceToken({ service: CALLER, aud: AUD, now: NOW });

    // Verifiable by a deployment holding only the current secret, which is what
    // "never signs with the previous one" has to mean in practice.
    expect(outcome(await signer.verifyServiceToken(issued.token, AUD, NOW))).toBe('ok');
    expect(
      outcome(
        await createServiceTokenSigner({ secret: PREVIOUS }).verifyServiceToken(
          issued.token,
          AUD,
          NOW,
        ),
      ),
    ).toBe('signature');
  });

  it('still refuses a bad claim rather than falling through to the previous key', async () => {
    // The rotation loop tries the next key only when the *signature* failed.
    // A token whose audience is wrong must not become "signature" — an operator
    // reading the log would go looking for a forgery instead of a caller that
    // asked for the wrong route.
    const issued = await rotating.signServiceToken({
      service: CALLER,
      aud: 'git-service',
      now: NOW,
    });

    expect(outcome(await rotating.verifyServiceToken(issued.token, AUD, NOW))).toBe('audience');
  });

  it('ignores an empty previous secret rather than treating it as a key', async () => {
    // `SERVICE_TOKEN_SECRET_PREVIOUS=` is the steady state in `.env.example`.
    const withEmpty = createServiceTokenSigner({ secret: SECRET, previousSecret: '' });
    const issued = await withEmpty.signServiceToken({ service: CALLER, aud: AUD, now: NOW });

    expect(outcome(await withEmpty.verifyServiceToken(issued.token, AUD, NOW))).toBe('ok');
    // An empty key would verify an unsigned-in-practice token; it must not be
    // in the list at all.
    const emptyKeyed = createServiceTokenSigner({ secret: '' });
    const forged = await emptyKeyed.signServiceToken({ service: CALLER, aud: AUD, now: NOW });
    expect(outcome(await withEmpty.verifyServiceToken(forged.token, AUD, NOW))).toBe('signature');
  });
});

describe('the service enum', () => {
  it('names exactly the six services plan 02 CP-8 defines', () => {
    expect([...SERVICE_NAMES]).toEqual([
      'orchestrator-worker',
      'sandbox-service',
      'verification-service',
      'release-service',
      'git-service',
      'model-gateway',
    ]);
  });

  it('recognises members and nothing else', () => {
    for (const name of SERVICE_NAMES) {
      expect(isServiceName(name)).toBe(true);
    }
    for (const name of ['', 'control-api', 'sandbox', 'SANDBOX-SERVICE', 42, null, undefined]) {
      expect(isServiceName(name), String(name)).toBe(false);
    }
  });
});
