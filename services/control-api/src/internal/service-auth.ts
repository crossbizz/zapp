import {
  isServiceName,
  SERVICE_TOKEN_AUDIENCES,
  type ServiceAudience,
  type ServiceName,
  type ServiceTokenRejection,
  type ServiceTokenSigner,
} from '@zapp/config';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';

import { REFRESH_COOKIE, SESSION_COOKIE, parseCookies } from '../auth/cookies.js';
import type { TokenDenylist } from '../auth/denylist.js';
import { ApiError } from '../errors.js';

/**
 * Service-to-service authentication for `/internal/*` (plan 02 CP-7, completed
 * by CP-8).
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
 * than in `Authorization: Bearer`, and why the gate makes the presence of *any*
 * user credential a rejection rather than something to ignore:
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
 *
 * The third rule, and CP-8's own, is that **a route says what a token has to
 * have been minted for**. Each internal route declares an audience, and only a
 * token carrying that audience reaches it, so a credential captured on its way
 * to the decrypt route is not a credential for whatever internal route ships
 * next. Routes that hand back something a replay would hand back again also
 * declare themselves single-use, and then the `jti` is *spent*: recorded in the
 * same Redis denylist that revokes sessions (CP-5), so the second presentation
 * of a captured token is refused by the same mechanism as a logged-out session.
 *
 * The order of the checks is itself a property. A user credential disqualifies
 * the request before the token is read; the token is verified before the
 * allowlist is consulted; and the allowlist is consulted before anything
 * touches the database. That last one is why a service that may not call this
 * route cannot use it to find out whether a secret exists — see
 * `src/internal/secrets.ts`.
 */

/**
 * Where a service token arrives. Deliberately not `Authorization` — see the
 * module comment.
 */
export const SERVICE_TOKEN_HEADER = 'x-zapp-service-token';

/** Who is calling. Minted by {@link ServiceTokenVerifier}, never by a request body. */
export interface ServiceIdentity {
  /** The calling service's name, e.g. `sandbox-service`. Matched against the allowlist. */
  readonly service: ServiceName;
  /**
   * The token's `jti` — for revocation, for spending a single-use token, and for
   * correlating a call with the credential that made it.
   */
  readonly tokenId: string;
}

/** What the *route* requires of a token, as opposed to what the token asserts. */
export interface ServiceTokenExpectations {
  /** The audience the route was registered with. A token for anything else is refused. */
  readonly audience: ServiceAudience;
  /** Whether presenting this token spends it. See {@link RequireServiceOptions.singleUse}. */
  readonly singleUse: boolean;
}

/**
 * Why a token was refused. The token's own reasons, plus the two the control
 * plane adds by keeping state: a `jti` already spent, and a replay store that
 * could not answer.
 */
export type ServiceAuthRejection =
  | ServiceTokenRejection
  /** A single-use token presented a second time. */
  | 'replayed'
  /** The replay store is unreachable, so single use cannot be guaranteed. */
  | 'unavailable'
  /** The request carried a session cookie or a bearer token. Never reaches the verifier. */
  | 'user_credential'
  /** No token, an empty one, or the header more than once. */
  | 'absent';

export type ServiceVerdict =
  | { readonly ok: true; readonly identity: ServiceIdentity }
  | { readonly ok: false; readonly reason: ServiceAuthRejection };

export interface ServiceTokenVerifier {
  /**
   * Resolves `token` to a caller, or says why it does not. Never throws for a
   * bad token: an invalid credential is an answer, not an exception. The reason
   * is for the log — the caller is told one thing for all of them.
   */
  verify(token: string, expected: ServiceTokenExpectations): Promise<ServiceVerdict>;
}

/**
 * Namespaces a service token's `jti` in the denylist.
 *
 * The same Redis database revokes user sessions by `jti` and whole logins by
 * {@link sessionFamilyKey}'s `sid:` prefix. A prefix here is cheaper than a
 * proof that a UUID can never collide with a session's hex id — and a
 * collision would mean spending a service token silently logged somebody out.
 */
export function serviceTokenKey(jti: string): string {
  return `svc:${jti}`;
}

export interface ServiceTokenVerifierDeps {
  /** The shared HS256 implementation. `createServiceTokenSigner` in `@zapp/config`. */
  readonly signer: ServiceTokenSigner;
  /**
   * Where a spent `jti` is recorded — CP-5's Redis denylist, shared with the
   * session layer. Shared deliberately: one revocation store means one place to
   * look when something has to stop working immediately.
   */
  readonly denylist: TokenDenylist;
  /** Injected in tests so expiry is asserted rather than waited for. */
  readonly now?: () => Date;
}

/**
 * The shipping verifier: signature, algorithm, issuer, audience, expiry,
 * lifetime and subject from `@zapp/config`; replay from the denylist.
 *
 * Replay is checked here rather than in the shared primitive because it is the
 * one part that needs shared state, and a signing helper that required Redis
 * would be one no other service could use. The split also states the rule: a
 * token is *valid* on its own terms, and *spendable* only once against the
 * control plane that records it.
 *
 * A single-use token is spent by the write itself — `SET NX PX`, whose reply
 * says whether this call was the one that created the key. Two concurrent
 * presentations of one token therefore both verify and exactly one wins, which
 * a read-then-write could not promise. The write happens *before* the
 * allowlist is consulted, so the rule is simply "presented once, spent" rather
 * than "spent if it turned out to be useful".
 */
export function createServiceTokenVerifier(deps: ServiceTokenVerifierDeps): ServiceTokenVerifier {
  const { signer, denylist } = deps;
  const now = deps.now ?? ((): Date => new Date());

  return {
    async verify(token, expected) {
      const verdict = await signer.verifyServiceToken(token, expected.audience, now());
      if (!verdict.ok) {
        return { ok: false, reason: verdict.reason };
      }
      const { service, jti, expiresAt } = verdict.claims;

      if (expected.singleUse) {
        let spent: boolean;
        try {
          // Expires with the token: a `jti` that can no longer verify has
          // nothing left to replay, so the list stays bounded by the number of
          // *unexpired* tokens — minutes' worth — rather than growing forever.
          spent = await denylist.deny(serviceTokenKey(jti), expiresAt);
        } catch {
          // Fail closed. A single-use guarantee that lapses when the cache is
          // unhealthy is not a guarantee, and the failure is ours to report as
          // one rather than to disguise as a bad credential.
          return { ok: false, reason: 'unavailable' };
        }
        if (!spent) {
          return { ok: false, reason: 'replayed' };
        }
      } else {
        // Reusable, but still revocable: a token explicitly denied — because it
        // leaked, or because it was spent on a single-use route — stops working
        // everywhere rather than only where it was spent.
        try {
          if (await denylist.isDenied(serviceTokenKey(jti))) {
            return { ok: false, reason: 'replayed' };
          }
        } catch {
          return { ok: false, reason: 'unavailable' };
        }
      }

      return { ok: true, identity: { service, tokenId: jti } };
    },
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
    requireService(options: RequireServiceOptions): preHandlerAsyncHookHandler;
  }
}

export interface RequireServiceOptions {
  /**
   * What a token must have been minted for. Route-scoped rather than
   * service-scoped, so a credential for this route is a credential for nothing
   * else.
   */
  readonly audience: ServiceAudience;
  /** Which services may call this route. A verified token is not by itself reach. */
  readonly callers: readonly ServiceName[];
  /**
   * Whether presenting a token here spends it.
   *
   * `true` for any route whose response a replay would reproduce — the decrypt
   * route above all, because its body is a plaintext credential and a captured
   * token must not be worth a second copy of it. The cost is that a caller
   * mints per call, which is an HMAC and no network.
   *
   * `false` is for routes that are genuinely idempotent and hot enough that a
   * token per call would be noise; the token is then still checked against the
   * denylist, so revocation works either way. There is no such route today,
   * which is why the default is the safe one.
   */
  readonly singleUse?: boolean;
}

export interface ServiceAuthOptions {
  readonly verifier: ServiceTokenVerifier;
}

/**
 * One code and one message for every way a service credential can be wrong —
 * missing, malformed, expired, forged, replayed, or a user session presented in
 * its place. A caller learning *which* would learn whether the token it holds is
 * a real one that lacks reach or a fake one that does not verify.
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

    app.decorate('requireService', (options: RequireServiceOptions): preHandlerAsyncHookHandler => {
      const { audience, callers, singleUse = true } = options;
      const allowlist = new Set<string>(callers);

      // All three at registration rather than per request. An internal route
      // with an empty allowlist admits nobody; one with an audience nothing can
      // mint for, or a caller that is not a service, admits nobody either — and
      // each is a mistake to catch at boot rather than a policy to discover
      // from a 401 that never stops.
      if (allowlist.size === 0) {
        throw new Error('requireService needs at least one allowed service');
      }
      if (!(SERVICE_TOKEN_AUDIENCES as readonly string[]).includes(audience)) {
        throw new Error(`requireService: ${audience} is not a known service-token audience`);
      }
      for (const caller of callers) {
        if (!isServiceName(caller)) {
          throw new Error(`requireService: ${String(caller)} is not a known service`);
        }
      }

      /** Logs why, server-side, and returns what the caller is told instead. */
      function refuse(request: FastifyRequest, reason: ServiceAuthRejection): ApiError {
        if (reason === 'unavailable') {
          request.log.error(
            { errorCode: 'service_auth_unavailable', audience },
            'service token replay store unavailable',
          );
          // Ours, not the caller's, and the only failure here a caller should
          // retry. Reachable only by something already holding a valid token:
          // every other refusal is decided before the replay store is touched.
          return new ApiError(
            'service_auth_unavailable',
            503,
            'Service authentication is temporarily unavailable.',
          );
        }
        request.log.warn(
          { errorCode: 'service_unauthenticated', reason, audience },
          'service token refused',
        );
        return unauthenticated();
      }

      return async (request: FastifyRequest): Promise<void> => {
        // First, and before the token is even read: a request carrying a user
        // credential is refused whatever else it carries. See the module
        // comment — this is what makes an internal route unreachable from a
        // browser rather than merely unauthorized there.
        if (carriesUserCredential(request)) {
          throw refuse(request, 'user_credential');
        }

        const raw = request.headers[SERVICE_TOKEN_HEADER];
        // An array means the header arrived more than once; taking the first is
        // how a request that presents two credentials gets to be judged on
        // whichever one is not being checked.
        if (Array.isArray(raw)) {
          throw refuse(request, 'absent');
        }
        const token = raw?.trim() ?? '';
        if (token === '') {
          throw refuse(request, 'absent');
        }

        const verdict = await verifier.verify(token, { audience, singleUse });
        if (!verdict.ok) {
          throw refuse(request, verdict.reason);
        }

        if (!allowlist.has(verdict.identity.service)) {
          // 403 rather than 404 or 401: the caller is authenticated, so it
          // already knows this route exists, and telling it that its *reach* is
          // the problem is what makes a misconfigured deployment debuggable.
          // Decided here, before the handler runs, so the answer cannot depend
          // on anything in the database — a service that may not call this
          // route learns nothing from calling it.
          request.log.warn(
            { errorCode: 'service_not_allowed', service: verdict.identity.service, audience },
            'service not allowed on this route',
          );
          throw new ApiError(
            'service_not_allowed',
            403,
            'That service may not call this endpoint.',
          );
        }

        request.service = verdict.identity;
      };
    });

    done();
  },
  { name: 'service-auth', fastify: '5.x' },
);
