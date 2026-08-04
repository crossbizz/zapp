import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';

import {
  CSRF_COOKIE,
  CSRF_HEADER,
  REFRESH_COOKIE,
  SESSION_COOKIE,
  parseCookies,
} from '../auth/cookies.js';
import { sessionFamilyKey, type TokenDenylist } from '../auth/denylist.js';
import { constantTimeEquals, type SessionSigner } from '../auth/session.js';
import { ApiError } from '../errors.js';

/**
 * Session resolution: cookie or bearer in, `request.auth` out.
 *
 * Two credentials, one meaning. A browser sends the session cookie ambiently,
 * which is what makes CSRF possible; the desktop app sends an `Authorization`
 * header it had to choose to attach, which is what makes it exempt. That
 * distinction drives the CSRF rule below — so the rule cannot drift from the
 * reason it exists.
 *
 * CP-4 folds this into the full `ctx` (`{ requestId, user, organizationId,
 * role, db }`) once tenant resolution lands; until then `request.auth` is the
 * whole of it.
 */

export interface SessionContext {
  readonly userId: string;
  readonly sessionId: string;
  /** The access token's `jti` — what a logout denies. */
  readonly jti: string;
  readonly expiresAt: Date;
  /** True when the credential arrived as a cookie, i.e. was sent ambiently. */
  readonly viaCookie: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `resolveSession`/`requireSession`; `undefined` when unauthenticated. */
    auth?: SessionContext;
  }
  interface FastifyInstance {
    /** 401s unless the request carries a live session. */
    requireSession: preHandlerAsyncHookHandler;
    /**
     * Resolves a session if there is one, and never rejects. For routes that
     * have to work with a broken credential — logging out is the whole example.
     */
    resolveSession: preHandlerAsyncHookHandler;
    /** 403s a request that carries an auth cookie without a matching CSRF header. */
    requireCsrf: preHandlerAsyncHookHandler;
  }
}

export interface SessionAuthOptions {
  readonly signer: SessionSigner;
  readonly denylist: TokenDenylist;
  readonly now: () => Date;
}

const BEARER_PREFIX = 'bearer ';

/**
 * One code and one message for every way a credential can be wrong — missing,
 * malformed, expired, forged, revoked, or the wrong kind of token. Which one it
 * was is only ever useful to whoever is holding it.
 */
function unauthenticated(): ApiError {
  return new ApiError('unauthenticated', 401, 'Authentication is required.');
}

/**
 * Whether the browser attached a credential by itself. This — rather than
 * whether that credential turned out to be *valid* — is what decides if CSRF
 * applies: an expired session cookie is still an ambient credential, and a
 * logout that skipped the check because the cookie had expired would be
 * forgeable by any other site.
 */
export function carriesAuthCookie(request: FastifyRequest): boolean {
  const cookies = parseCookies(request.headers.cookie);
  return cookies.has(SESSION_COOKIE) || cookies.has(REFRESH_COOKIE);
}

/**
 * Double-submit: a page that can read the CSRF cookie can echo it in the
 * header, and a cross-site attacker who can make the browser *send* the cookie
 * still cannot *read* it. Used by `requireCsrf`, and directly by
 * `/v1/auth/refresh`, which makes the same check without a live session to hang
 * it on.
 *
 * @throws {ApiError} 403 `csrf_required` or `csrf_invalid`.
 */
export function assertCsrf(request: FastifyRequest): void {
  const header = request.headers[CSRF_HEADER];
  const submitted = (Array.isArray(header) ? header[0] : header)?.trim() ?? '';
  if (submitted === '') {
    throw new ApiError('csrf_required', 403, `The ${CSRF_HEADER} header is required.`);
  }

  const cookie = parseCookies(request.headers.cookie).get(CSRF_COOKIE) ?? '';
  if (cookie === '' || !constantTimeEquals(cookie, submitted)) {
    throw new ApiError('csrf_invalid', 403, `The ${CSRF_HEADER} header does not match the cookie.`);
  }
}

export const sessionAuth = fp<SessionAuthOptions>(
  (app, options, done) => {
    const { signer, denylist, now } = options;

    // Declared up front so every request object has the same shape — Fastify
    // (and V8) prefer that to a property that appears on some requests only.
    app.decorateRequest('auth', undefined);

    async function resolve(request: FastifyRequest): Promise<void> {
      const authorization = request.headers.authorization ?? '';
      // Case-insensitive: RFC 7235 makes the scheme token case-insensitive, and
      // a client that sends `bearer` is not an anonymous client.
      const viaCookie = !authorization.toLowerCase().startsWith(BEARER_PREFIX);
      const token = viaCookie
        ? (parseCookies(request.headers.cookie).get(SESSION_COOKIE) ?? '')
        : authorization.slice(BEARER_PREFIX.length).trim();

      if (token === '') {
        return;
      }

      const claims = await signer.verifyAccess(token, now());
      if (claims === null) {
        return;
      }
      // A token that verifies can still have been revoked — by a logout, or by
      // a refresh-token reuse that killed the whole family. One call, two keys.
      if (await denylist.isDenied(claims.jti, sessionFamilyKey(claims.sessionId))) {
        return;
      }

      request.auth = { ...claims, viaCookie };
    }

    app.decorate('resolveSession', resolve);

    app.decorate('requireSession', async (request: FastifyRequest): Promise<void> => {
      await resolve(request);
      if (request.auth === undefined) {
        throw unauthenticated();
      }
    });

    app.decorate('requireCsrf', (request: FastifyRequest): Promise<void> => {
      if (carriesAuthCookie(request)) {
        assertCsrf(request);
      }
      return Promise.resolve();
    });

    done();
  },
  { name: 'session-auth', fastify: '5.x' },
);
