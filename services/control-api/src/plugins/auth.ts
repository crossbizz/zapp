import { timingSafeEqual } from 'node:crypto';

import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';

import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, parseCookies } from '../auth/cookies.js';
import type { TokenDenylist } from '../auth/denylist.js';
import type { SessionSigner } from '../auth/session.js';
import { ApiError } from '../errors.js';

/**
 * Session resolution: cookie or bearer in, `request.auth` out.
 *
 * Two credentials, one meaning. A browser sends the session cookie ambiently,
 * which is what makes CSRF possible; the desktop app sends an `Authorization`
 * header it had to choose to attach, which is what makes it exempt. That
 * distinction is recorded on the request as {@link SessionContext.viaCookie}
 * and is the only input to the CSRF rule below — so the rule cannot drift from
 * the reason it exists.
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
    /** Set by `requireSession`; `undefined` on unauthenticated routes. */
    auth?: SessionContext;
  }
  interface FastifyInstance {
    /** 401s unless the request carries a live session. */
    requireSession: preHandlerAsyncHookHandler;
    /**
     * 403s a cookie-authenticated request without a matching CSRF header.
     * Runs after {@link FastifyInstance.requireSession}, whose verdict on how
     * the request authenticated is the whole input to this one.
     */
    requireCsrf: preHandlerAsyncHookHandler;
  }
}

export interface SessionAuthOptions {
  readonly signer: SessionSigner;
  readonly denylist: TokenDenylist;
  readonly now: () => Date;
}

const BEARER_PREFIX = 'Bearer ';

/**
 * One code and one message for every way a credential can be wrong — missing,
 * malformed, expired, forged, revoked, or the wrong kind of token. Which one it
 * was is only ever useful to whoever is holding it.
 */
function unauthenticated(): ApiError {
  return new ApiError('unauthenticated', 401, 'Authentication is required.');
}

/** Constant-time comparison that tolerates a length mismatch instead of throwing. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Double-submit: a page that can read the CSRF cookie can echo it in the
 * header, and a cross-site attacker who can make the browser *send* the cookie
 * still cannot *read* it. Called by `requireCsrf` for session routes, and
 * directly by `/v1/auth/refresh`, which has to make the same check without a
 * live session to hang it on.
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
  if (cookie === '' || !equals(cookie, submitted)) {
    throw new ApiError('csrf_invalid', 403, `The ${CSRF_HEADER} header does not match the cookie.`);
  }
}

export const sessionAuth = fp<SessionAuthOptions>(
  (app, options, done) => {
    const { signer, denylist, now } = options;

    // Declared up front so every request object has the same shape — Fastify
    // (and V8) prefer that to a property that appears on some requests only.
    app.decorateRequest('auth', undefined);

    app.decorate('requireSession', async (request: FastifyRequest): Promise<void> => {
      const authorization = request.headers.authorization ?? '';
      const viaCookie = !authorization.startsWith(BEARER_PREFIX);
      const token = viaCookie
        ? (parseCookies(request.headers.cookie).get(SESSION_COOKIE) ?? '')
        : authorization.slice(BEARER_PREFIX.length).trim();

      if (token === '') {
        throw unauthenticated();
      }

      const claims = await signer.verifyAccess(token, now());
      // A token that verifies can still have been revoked: logging out and
      // spending a refresh token both work by denying a `jti` that has not
      // expired yet.
      if (claims === null || (await denylist.isDenied(claims.jti))) {
        throw unauthenticated();
      }

      request.auth = { ...claims, viaCookie };
    });

    app.decorate('requireCsrf', (request: FastifyRequest): Promise<void> => {
      if (request.auth?.viaCookie === true) {
        assertCsrf(request);
      }
      return Promise.resolve();
    });

    done();
  },
  { name: 'session-auth', fastify: '5.x' },
);
