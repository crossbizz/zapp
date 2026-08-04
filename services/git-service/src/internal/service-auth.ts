import {
  isServiceName,
  type ServiceAudience,
  type ServiceName,
  type ServiceTokenSigner,
} from '@zapp/config';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';

import { ApiError } from '../errors.js';

/**
 * Who may call this service (plan 06 GIT-2).
 *
 * Every route here is `/internal/*` — there is no user-facing surface at all,
 * and there must not be one. This service holds the Forgejo admin token, which
 * is the single credential in the system with administrative reach over every
 * tenant's source code. A request that reached it with a browser's ambient
 * credentials would not be a privilege escalation; it would be the whole
 * privilege.
 *
 * So the same three rules the control plane's `/internal/*` gate applies
 * (`services/control-api/src/internal/service-auth.ts`), for the same reasons:
 *
 * 1. **A user credential disqualifies the request before the token is read.**
 *    Not ignored — refused. Ignoring a cookie would let a request a browser sent
 *    ambiently succeed on the strength of a header, which is the shape of every
 *    CSRF bug; refusing makes this service unreachable from a browser context by
 *    construction rather than merely unauthorized there.
 * 2. **The audience is checked.** A token minted for the git service is not a
 *    token for the control plane's decrypt route, and vice versa.
 * 3. **An allowlist, not merely authentication.** A verified token says who is
 *    calling; the route says who may. Compromising one service's token does not
 *    confer every service's reach.
 *
 * **What this deliberately does not do, and the reason:** it does not spend a
 * `jti`. The control plane's verifier records a single-use token in Redis
 * (CP-8), and this service has no Redis — adding one for replay protection alone
 * would be a new dependency, a new failure mode and a new thing to run. The
 * exposure it buys is bounded and stated rather than hidden: a captured token
 * lives at most {@link MAX_SERVICE_TOKEN_TTL_SECONDS}, everything it could reach
 * is already reachable by the service it was stolen from, and the highest-value
 * route — minting a repository-scoped token (GIT-3) — writes an audit row per
 * call, so a replay is visible even where it is not refused. When this service
 * grows a cache for any other reason, the verifier should start spending the
 * `jti`; until then this comment is the record of what is not being enforced.
 */

/** Where a service token arrives. Deliberately not `Authorization` — see rule 1. */
export const SERVICE_TOKEN_HEADER = 'x-zapp-service-token';

/**
 * What a token must have been minted for to reach this service.
 *
 * The service's own name rather than a per-route audience, and the difference
 * from the control plane's `control-api:secrets.decrypt` is worth stating: that
 * one narrows a token to a single endpoint because its response body *is* a
 * credential. Nothing here hands back a long-lived one, the routes are a single
 * coherent capability ("act on this tenant's repositories"), and a caller that
 * may create a repository is a caller that may read its commits.
 */
export const GIT_SERVICE_AUDIENCE: ServiceAudience = 'git-service';

/** Who is calling, from the signature and never from a request body. */
export interface ServiceIdentity {
  readonly service: ServiceName;
  /** The token's `jti`, for correlating a call with the credential that made it. */
  readonly tokenId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireService`; absent on every route that did not ask for it. */
    service?: ServiceIdentity;
  }
  interface FastifyInstance {
    requireService(options: RequireServiceOptions): preHandlerAsyncHookHandler;
  }
}

export interface RequireServiceOptions {
  /** Which services may call this route. A verified token is not by itself reach. */
  readonly callers: readonly ServiceName[];
}

export interface ServiceAuthOptions {
  /** The shared HS256 implementation — `createServiceTokenSigner` in `@zapp/config`. */
  readonly signer: ServiceTokenSigner;
  /** Injected in tests so expiry is asserted rather than waited for. */
  readonly now?: () => Date;
}

/** Narrows `request.service` for a handler on a route that declared `requireService`. */
export function serviceOf(request: FastifyRequest): ServiceIdentity {
  const service = request.service;
  if (service === undefined) {
    // Not reachable from a route with `requireService`. Reaching it means a
    // route was registered without one, and a 500 is the honest outcome — the
    // alternative is a handler improvising a caller.
    throw new Error('this route requires the service-auth plugin (app.requireService)');
  }
  return service;
}

/**
 * One code and one message for every way a service credential can be wrong.
 *
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
  // Any cookie at all. The control plane can name its two session cookies
  // because it defines them; this service has no session layer, so "a browser
  // sent this" is the whole signal and it is the right one to refuse on.
  return (request.headers.cookie ?? '') !== '';
}

export const serviceAuth = fp<ServiceAuthOptions>(
  (app, options, done) => {
    const { signer } = options;
    const now = options.now ?? ((): Date => new Date());

    // Declared up front so every request object has the same shape.
    app.decorateRequest('service', undefined);

    app.decorate(
      'requireService',
      (routeOptions: RequireServiceOptions): preHandlerAsyncHookHandler => {
        const allowlist = new Set<string>(routeOptions.callers);

        // At registration rather than per request: a route with an empty allowlist
        // admits nobody, and a caller that is not a service admits nobody either.
        // Both are mistakes to catch at boot rather than policies to discover from
        // a 401 that never stops.
        if (allowlist.size === 0) {
          throw new Error('requireService needs at least one allowed service');
        }
        for (const caller of routeOptions.callers) {
          if (!isServiceName(caller)) {
            throw new Error(`requireService: ${String(caller)} is not a known service`);
          }
        }

        return async (request: FastifyRequest): Promise<void> => {
          if (carriesUserCredential(request)) {
            request.log.warn(
              { errorCode: 'service_unauthenticated', reason: 'user_credential' },
              'service token refused',
            );
            throw unauthenticated();
          }

          const raw = request.headers[SERVICE_TOKEN_HEADER];
          // An array means the header arrived more than once; taking the first is
          // how a request that presents two credentials gets judged on whichever
          // one is not being checked.
          if (Array.isArray(raw)) {
            throw unauthenticated();
          }
          const token = raw?.trim() ?? '';
          if (token === '') {
            request.log.warn(
              { errorCode: 'service_unauthenticated', reason: 'absent' },
              'service token refused',
            );
            throw unauthenticated();
          }

          const verdict = await signer.verifyServiceToken(token, GIT_SERVICE_AUDIENCE, now());
          if (!verdict.ok) {
            // The reason is for the operator: `expired` is a clock to fix and
            // `signature` is an attack to investigate. The caller is told one
            // thing for all of them.
            request.log.warn(
              { errorCode: 'service_unauthenticated', reason: verdict.reason },
              'service token refused',
            );
            throw unauthenticated();
          }

          if (!allowlist.has(verdict.claims.service)) {
            // 403 rather than 404 or 401: the caller is authenticated, so it
            // already knows this route exists, and telling it that its *reach* is
            // the problem is what makes a misconfigured deployment debuggable.
            // Decided before the handler runs, so a service that may not call this
            // route learns nothing about a tenant by calling it.
            request.log.warn(
              { errorCode: 'service_not_allowed', service: verdict.claims.service },
              'service not allowed on this route',
            );
            throw new ApiError(
              'service_not_allowed',
              403,
              'That service may not call this endpoint.',
            );
          }

          request.service = { service: verdict.claims.service, tokenId: verdict.claims.jti };
        };
      },
    );

    done();
  },
  { name: 'git-service-auth', fastify: '5.x' },
);
