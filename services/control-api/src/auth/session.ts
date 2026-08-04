import { randomBytes } from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

/**
 * zapp's own sessions.
 *
 * The identity provider proves *who* someone is, once, at the callback. From
 * then on the client carries a JWT this service minted and signs for itself, so
 * every later request is validated locally: no provider round trip on the hot
 * path, no provider outage taking the API down with it, and one place — here —
 * that decides what a session means.
 *
 * HS256 with a shared secret rather than a keypair: the only verifier is this
 * service, so an asymmetric key would buy nothing and cost a distribution
 * problem. `SESSION_JWT_SECRET_PREVIOUS` is accepted for *verification only*,
 * which is what makes a rotation a deploy rather than a mass logout.
 */

/** PRD §22.1: a session lasts a working day, then the refresh token has to speak up. */
export const ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A login handshake that takes longer than this is not a login any more. */
export const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;

const ISSUER = 'https://zapp.build';
const AUDIENCE = 'zapp-control-api';

/**
 * Which token this is, checked on every verification. Without it, a 30-day
 * refresh token would be a perfectly valid 30-day session cookie — the two
 * differ only in lifetime and intent, and intent has to be signed.
 */
type TokenKind = 'access' | 'refresh' | 'state';

const KIND_CLAIM = 'kind';

export interface IssuedToken {
  readonly token: string;
  /** The `jti`, which is what a logout or a rotation denies. */
  readonly jti: string;
  readonly expiresAt: Date;
}

export interface SessionTokens {
  /** Stable across rotations: it is what ties a chain of tokens to one login. */
  readonly sessionId: string;
  readonly access: IssuedToken;
  readonly refresh: IssuedToken;
}

export interface SessionClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly jti: string;
  readonly expiresAt: Date;
}

/** What the login redirect carries through the provider and back. */
export interface LoginState {
  /** Matched against the cookie set at `/v1/auth/login`. */
  readonly nonce: string;
  /** Present when the browser leg is completing a desktop device grant. */
  readonly userCode?: string;
}

export interface SessionSigner {
  mintSession(input: { userId: string; sessionId?: string; now: Date }): Promise<SessionTokens>;
  verifyAccess(token: string, now: Date): Promise<SessionClaims | null>;
  verifyRefresh(token: string, now: Date): Promise<SessionClaims | null>;
  mintLoginState(input: LoginState & { now: Date }): Promise<string>;
  verifyLoginState(token: string, now: Date): Promise<LoginState | null>;
}

export interface SignerConfig {
  readonly secret: string;
  /** Verified against, never signed with. Set only while a rotation is in flight. */
  readonly previousSecret?: string;
}

/** 16 bytes, hex — the alphabet cookies accept without escaping. */
export function randomToken(): string {
  return randomBytes(16).toString('hex');
}

export function createSessionSigner(config: SignerConfig): SessionSigner {
  const encoder = new TextEncoder();
  const signingKey = encoder.encode(config.secret);
  // Order matters: the current key is tried first, so a rotation costs one
  // failed verification only for tokens minted before it.
  const verificationKeys = [signingKey];
  if (config.previousSecret !== undefined && config.previousSecret !== '') {
    verificationKeys.push(encoder.encode(config.previousSecret));
  }

  async function mint(
    kind: TokenKind,
    claims: Record<string, string>,
    subject: string,
    jti: string,
    now: Date,
    ttlMs: number,
  ): Promise<IssuedToken> {
    const expiresAt = new Date(now.getTime() + ttlMs);
    const token = await new SignJWT({ ...claims, [KIND_CLAIM]: kind })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(subject)
      .setJti(jti)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .sign(signingKey);
    return { token, jti, expiresAt };
  }

  /**
   * Verification failures are indistinguishable to the caller by design: a
   * forged signature, an expired token, a refresh token in a session cookie and
   * an unknown key all answer `null`. Telling them apart is only ever useful to
   * whoever is holding the wrong token.
   */
  async function verify(
    token: string,
    kind: TokenKind,
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    for (const key of verificationKeys) {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: ISSUER,
          audience: AUDIENCE,
          currentDate: now,
          clockTolerance: 0,
        });
        return payload[KIND_CLAIM] === kind ? payload : null;
      } catch {
        // Try the next key; an exhausted list is a rejection, below.
      }
    }
    return null;
  }

  function toSessionClaims(payload: Record<string, unknown>): SessionClaims | null {
    const { sub, sid, jti, exp } = payload;
    if (
      typeof sub !== 'string' ||
      typeof sid !== 'string' ||
      typeof jti !== 'string' ||
      typeof exp !== 'number'
    ) {
      return null;
    }
    return { userId: sub, sessionId: sid, jti, expiresAt: new Date(exp * 1000) };
  }

  return {
    async mintSession({ userId, sessionId = randomToken(), now }) {
      const [access, refresh] = await Promise.all([
        mint('access', { sid: sessionId }, userId, randomToken(), now, ACCESS_TOKEN_TTL_MS),
        mint('refresh', { sid: sessionId }, userId, randomToken(), now, REFRESH_TOKEN_TTL_MS),
      ]);
      return { sessionId, access, refresh };
    },

    async verifyAccess(token, now) {
      const payload = await verify(token, 'access', now);
      return payload === null ? null : toSessionClaims(payload);
    },

    async verifyRefresh(token, now) {
      const payload = await verify(token, 'refresh', now);
      return payload === null ? null : toSessionClaims(payload);
    },

    async mintLoginState({ nonce, userCode, now }) {
      // The state is signed rather than opaque so it can carry the device-grant
      // binding through the provider without a second cookie — and so a browser
      // cannot invent one. The nonce still has to match the cookie; this only
      // makes the *contents* tamper-evident.
      const claims = userCode === undefined ? { nonce } : { nonce, userCode };
      const issued = await mint('state', claims, 'login', randomToken(), now, LOGIN_STATE_TTL_MS);
      return issued.token;
    },

    async verifyLoginState(token, now) {
      const payload = await verify(token, 'state', now);
      if (payload === null || typeof payload['nonce'] !== 'string') {
        return null;
      }
      const userCode = payload['userCode'];
      return typeof userCode === 'string'
        ? { nonce: payload['nonce'], userCode }
        : { nonce: payload['nonce'] };
    },
  };
}
