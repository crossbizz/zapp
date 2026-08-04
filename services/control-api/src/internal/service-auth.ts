import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';

import { REFRESH_COOKIE, SESSION_COOKIE, parseCookies } from '../auth/cookies.js';
import { ApiError } from '../errors.js';

/**
 * Service-to-service authentication for `/internal/*` (plan 02 CP-7; CP-8 ships
 * the HMAC verifier this port describes).
 *
 * There is exactly one rule here, and everything else is its consequence: **a
 * user credential must never satisfy an internal route.** The internal surface
 * exists because some operations have no user-facing form at all — decrypting a
 * secret is the whole example (PRD §22.2: "Read secret values: No through UI",
 * for every role including Owner) — so a route here that a browser could reach
 * with a valid session would be a hole straight through the permission matrix,
 * not a shortcut around it.
 *
 * That is why a service token arrives on {@link SERVICE_TOKEN_HEADER} rather
 * than in `Authorization: Bearer`, and why {@link ServiceAuthOptions} makes the
 * presence of *any* user credential a rejection rather than something to ignore:
 *
 *   - A shared header would make "is this a user token or a service token?" a
 *     question about the token's contents — one verifier's bug away from a user
 *     access token being accepted as a service one.
 *   - Ignoring a session cookie instead of refusing it would let a request that
 *     a browser sent ambiently succeed on the strength of a header, which is the
 *     shape of every CSRF bug. Refusing means an internal route is unreachable
 *     from a browser context by construction — not merely unauthorized.
 *
 * The second rule is the allowlist. A verified token says *who* is calling; the
 * route says which services may call it. Compromising any service's token
 * therefore does not confer every service's reach, and adding a caller to an
 * internal route is a visible edit rather than a deployment detail.
 */

/**
 * Where a service token arrives. Deliberately not `Authorization` — see the
 * module comment.
 */
export const SERVICE_TOKEN_HEADER = 'x-zapp-service-token';

/** Who is calling. Minted by {@link ServiceTokenVerifier}, never by a request body. */
export interface ServiceIdentity {
  /** The calling service's name, e.g. `sandbox-service`. Matched against the allowlist. */
  readonly service: string;
  /**
   * The token's own identifier, when its format has one — for revocation and
   * for correlating a call with the credential that made it. CP-8 fills this in.
   */
  readonly tokenId?: string;
}

export interface ServiceTokenVerifier {
  /**
   * Resolves `token` to a caller, or `undefined` when it is not a valid,
   * unexpired service token. Never throws for a bad token: an invalid credential
   * is an answer, not an exception.
   */
  verify(token: string): Promise<ServiceIdentity | undefined>;
}

/**
 * The shipping verifier until CP-8 lands: every token is refused.
 *
 * Fail-closed rather than absent. A deployment that has not configured service
 * tokens yet answers 401 on `/internal/*` — the route exists, is documented, and
 * admits nobody — instead of the two alternatives, which are a 404 that hides
 * whether the surface is deployed at all and a permissive stand-in that
 * eventually ships. `composeApp` binds this explicitly so the day CP-8 replaces
 * it is one line in one file.
 */
export function createDenyAllServiceTokenVerifier(): ServiceTokenVerifier {
  return {
    verify: () => Promise.resolve(undefined),
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireService`; `undefined` on every user-facing route. */
    service?: ServiceIdentity;
  }
  interface FastifyInstance {
    /**
     * Refuses anything that is not a verified, allowlisted service call.
     * Composed *instead of* `requireSession`, never alongside it.
     */
    requireService(allowed: readonly string[]): preHandlerAsyncHookHandler;
  }
}

export interface ServiceAuthOptions {
  readonly verifier: ServiceTokenVerifier;
}

/**
 * One code and one message for every way a service credential can be wrong —
 * missing, malformed, expired, forged, or a user session presented in its place.
 * A caller learning *which* would learn whether the token it holds is a real one
 * that lacks reach or a fake one that does not verify.
 */
function unauthenticated(): ApiError {
  return new ApiError('service_unauthenticated', 401, 'A valid service token is required.');
}

/** Whether this request carries a credential that belongs to a person. */
function carriesUserCredential(request: FastifyRequest): boolean {
  if ((request.headers.authorization ?? '') !== '') {
    return true;
  }
  const cookies = parseCookies(request.headers.cookie);
  return cookies.has(SESSION_COOKIE) || cookies.has(REFRESH_COOKIE);
}

/** Narrows `request.service` for a handler on a route that declared `requireService`. */
export function serviceOf(request: FastifyRequest): ServiceIdentity {
  const service = request.service;
  if (service === undefined) {
    // Not reachable from a route with `requireService`. Reaching it means an
    // internal route was registered without one, and a 500 is the honest
    // outcome — the alternative is a handler improvising a caller.
    throw new Error('this route requires the service-auth plugin (app.requireService)');
  }
  return service;
}

export const serviceAuth = fp<ServiceAuthOptions>(
  (app, options, done) => {
    const { verifier } = options;

    // Declared up front so every request object has the same shape — Fastify
    // (and V8) prefer that to a property that appears on some requests only.
    app.decorateRequest('service', undefined);

    app.decorate('requireService', (allowed: readonly string[]): preHandlerAsyncHookHandler => {
      const allowlist = new Set(allowed);
      if (allowlist.size === 0) {
        // At registration, not per request: an internal route with an empty
        // allowlist admits nobody, which is a mistake to catch at boot rather
        // than a policy to enforce at runtime.
        throw new Error('requireService needs at least one allowed service');
      }

      return async (request: FastifyRequest): Promise<void> => {
        // First, and before the token is even read: a request carrying a user
        // credential is refused whatever else it carries. See the module
        // comment — this is what makes an internal route unreachable from a
        // browser rather than merely unauthorized there.
        if (carriesUserCredential(request)) {
          throw unauthenticated();
        }

        const raw = request.headers[SERVICE_TOKEN_HEADER];
        // An array means the header arrived more than once; taking the first is
        // how a request that presents two credentials gets to be judged on
        // whichever one is not being checked.
        if (Array.isArray(raw)) {
          throw unauthenticated();
        }
        const token = raw?.trim() ?? '';
        if (token === '') {
          throw unauthenticated();
        }

        const identity = await verifier.verify(token);
        if (identity === undefined) {
          throw unauthenticated();
        }

        if (!allowlist.has(identity.service)) {
          // 403 rather than 404 or 401: the caller is authenticated, so it
          // already knows this route exists, and telling it that its *reach* is
          // the problem is what makes a misconfigured deployment debuggable.
          // Nothing about another tenant or another service is disclosed.
          throw new ApiError(
            'service_not_allowed',
            403,
            'That service may not call this endpoint.',
          );
        }

        request.service = identity;
      };
    });

    done();
  },
  { name: 'service-auth', fastify: '5.x' },
);
