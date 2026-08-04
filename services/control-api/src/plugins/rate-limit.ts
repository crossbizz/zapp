import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import fp from 'fastify-plugin';

import type {
  ProxyTrust,
  RateLimitClass,
  RateLimitConfig,
  RateLimitRule,
} from '../config/rate-limits.js';
import { ApiError } from '../errors.js';
import type { RedisCommands } from '../redis/client.js';

/**
 * Per-organization rate limiting, as a token bucket in Redis.
 *
 * Four decisions are worth the reader's time.
 *
 * **1. Routes are enrolled at registration, not by hand.** The plugin adds a
 * `preHandler` to every route registered after it (`onRoute`), so a route cannot
 * be added without a limit — the failure mode of a per-route opt-in is that the
 * one endpoint somebody forgot is the one that gets hammered. `/healthz` is
 * registered before this plugin and is exempt by construction: a limiter that
 * can fail a liveness probe can take a healthy process out of rotation.
 *
 * **2. The guard runs *after* the route's own preHandlers.** It is appended, so
 * the session and the tenant are already resolved and the bucket can be keyed by
 * organization rather than by address — which is what makes the limit a fair
 * share per tenant instead of a shared ceiling that one busy customer spends on
 * behalf of everyone behind the same NAT. The cost is that an unauthenticated
 * flood is rejected by `requireSession` instead of here, which is the cheaper of
 * the two rejections anyway.
 *
 * **3. A Redis outage is a decision, not an exception.** `whenUnavailable` in
 * `config/rate-limits.json` says what each class does when the bucket cannot be
 * read: reads and mutations **fail open**, because a limiter that takes the
 * control plane down with the cache is worse than one that misses a window;
 * `/v1/auth/*` **fails closed**, because brute-force protection that evaporates
 * exactly when the infrastructure is unhealthy is not protection. Both halves
 * are configuration, so an operator can change either without a deploy.
 *
 * **4. An `ip`-scoped class is only as good as the address it counts.** Behind a
 * proxy every request arrives from the proxy, so a class keyed by address
 * collapses into one global bucket — one caller exhausting sign-in for everyone
 * and no per-attacker limiting at all. `request.ip` resolves `X-Forwarded-For`
 * only as far as `proxy` in `config/rate-limits.json` says to; the default is
 * to trust nothing, and this plugin says so in the log at boot rather than
 * letting a misconfigured deployment be quietly ineffective. Trusting the
 * header unconditionally is not the alternative — it is the bypass.
 */

/** What a bucket said. `unavailable` is not a failure to handle here — it is an answer. */
export interface RateLimitDecision {
  readonly outcome: 'allowed' | 'limited' | 'unavailable';
  /** Tokens left after this request. Zero when the answer was not `allowed`. */
  readonly remaining: number;
  /** Whole seconds until the next token, for `retry-after`. At least 1. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Takes one token from `key`'s bucket. Never rejects: an outage is reported, not thrown. */
  take(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}

/** Milliseconds per token, from a per-minute rate. */
function refillPerMs(rule: RateLimitRule): number {
  return rule.perMinute / 60_000;
}

function retryAfter(missing: number, rule: RateLimitRule): number {
  return Math.max(1, Math.ceil(missing / refillPerMs(rule) / 1000));
}

/**
 * One `EVAL`, because a token bucket read and then written is not a token
 * bucket: two requests that read the same count both spend it.
 *
 * The bucket is lazy — nothing refills it on a timer. It stores how many tokens
 * were left and when, and every read pays forward the time since. A bucket
 * nobody has touched for its whole refill window is indistinguishable from a
 * fresh one, which is why the key can expire and be recreated without anyone
 * gaining or losing an allowance.
 */
const TAKE = `
  local burst = tonumber(ARGV[1])
  local perMs = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])
  local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
  local tokens = tonumber(state[1])
  local at = tonumber(state[2])
  if tokens == nil or at == nil then
    tokens = burst
    at = now
  end
  if now > at then
    tokens = math.min(burst, tokens + (now - at) * perMs)
    at = now
  end
  local allowed = 0
  local missing = 1 - tokens
  if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
    missing = 0
  end
  redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(at))
  redis.call('PEXPIRE', KEYS[1], ARGV[4])
  return {allowed, math.floor(tokens), tostring(missing)}
`;

/**
 * The shipping limiter. `onUnavailable` is called with whatever Redis did
 * instead of answering, so the choice made in configuration is still visible in
 * the log rather than being a silent allow.
 */
export function createRedisRateLimiter(
  redis: RedisCommands,
  now: () => Date = () => new Date(),
  onUnavailable?: (error: unknown) => void,
): RateLimiter {
  return {
    async take(key, rule) {
      // Long enough that a full bucket is reachable from empty; anything older
      // than that is indistinguishable from a bucket that was never used.
      const ttl = Math.ceil(rule.burst / refillPerMs(rule)) + 1_000;
      let reply: unknown;
      try {
        reply = await redis.eval(
          TAKE,
          [key],
          [rule.burst, refillPerMs(rule), now().getTime(), ttl],
        );
      } catch (error) {
        onUnavailable?.(error);
        return { outcome: 'unavailable', remaining: 0, retryAfterSeconds: 1 };
      }

      if (!Array.isArray(reply)) {
        onUnavailable?.(new Error('rate limiter returned an unreadable reply'));
        return { outcome: 'unavailable', remaining: 0, retryAfterSeconds: 1 };
      }
      const [allowed, remaining, missing] = reply as unknown[];
      if (allowed === 1) {
        return {
          outcome: 'allowed',
          remaining: typeof remaining === 'number' ? remaining : 0,
          retryAfterSeconds: 0,
        };
      }
      return {
        outcome: 'limited',
        remaining: 0,
        retryAfterSeconds: retryAfter(Number(missing), rule),
      };
    },
  };
}

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Process-local, with the same arithmetic — for tests, and for a single-process
 * development run. `buildApp` refuses to fall back to it outside development:
 * per-instance buckets multiply every limit by the number of instances, which
 * is a limit nobody configured.
 */
export function createInMemoryRateLimiter(now: () => Date = () => new Date()): RateLimiter {
  const buckets = new Map<string, Bucket>();

  return {
    take(key, rule) {
      const at = now().getTime();
      const bucket = buckets.get(key) ?? { tokens: rule.burst, at };
      if (at > bucket.at) {
        bucket.tokens = Math.min(rule.burst, bucket.tokens + (at - bucket.at) * refillPerMs(rule));
        bucket.at = at;
      }

      if (bucket.tokens < 1) {
        buckets.set(key, bucket);
        return Promise.resolve({
          outcome: 'limited',
          remaining: 0,
          retryAfterSeconds: retryAfter(1 - bucket.tokens, rule),
        } as const);
      }

      bucket.tokens -= 1;
      buckets.set(key, bucket);
      return Promise.resolve({
        outcome: 'allowed',
        remaining: Math.floor(bucket.tokens),
        retryAfterSeconds: 0,
      } as const);
    },
  };
}

/** Never limited: a liveness probe that a cache outage can fail is not a liveness probe. */
const EXEMPT_ROUTES = new Set(['/healthz']);

/**
 * Routes whose class is not the one their path would imply.
 *
 * One entry, and it is a budget rather than an exception: the desktop app polls
 * `POST /v1/auth/device/token` at the interval `GET /v1/auth/device` hands it,
 * for as long as the grant lives. Counted against the `auth` class that traffic
 * is indistinguishable from a credential search, so the poll would exhaust the
 * bucket partway through its own grant window — and take the browser leg of the
 * same sign-in down with it, since `/login`, `/callback` and `/device/approve`
 * share the class. Its own class is sized for the poll (`config/rate-limits.json`,
 * pinned against `DEVICE_POLL_INTERVAL_SECONDS` by `test/plugins.test.ts`), and
 * the credential surface keeps its tight one.
 */
const CLASS_BY_PATH = new Map<string, RateLimitClass>([['/v1/auth/device/token', 'device']]);

/**
 * The service-to-service surface (`src/internal/service-auth.ts`), which is the
 * one place where decision 2 in the file header is not merely a trade-off but a
 * hole.
 *
 * Every other route's guard is *appended*, so it runs after the session and the
 * tenant are resolved and can key the bucket by organization. An internal route
 * has no session to wait for, and its own `requireService` preHandler throws
 * 401 on a bad token — which aborts the chain before an appended guard ever
 * runs. The result, until CP-8, was that failed service-token attempts against
 * `POST /internal/secrets/decrypt` were the only *completely unlimited* traffic
 * in the service, on the one route in the system whose success response is a
 * plaintext credential (plan 02 CP-7 review).
 *
 * So the guard for these routes is prepended instead: counted before anything
 * decides whether the caller is real, at the cost of keying by address rather
 * than by caller. That cost is small here — an internal caller is a pod in the
 * cluster, not a browser behind a NAT.
 */
function isInternalRoute(url: string): boolean {
  return url === '/internal' || url.startsWith('/internal/');
}

/**
 * Which limit a route answers to.
 *
 * By path and method rather than by a per-route declaration, so the answer is
 * the same for a route nobody remembered to annotate. A route that accepts both
 * a read and a write method takes the stricter of the two.
 */
export function classifyRoute(url: string, method: string | string[]): RateLimitClass {
  const named = CLASS_BY_PATH.get(url);
  if (named !== undefined) {
    return named;
  }
  if (isInternalRoute(url)) {
    return 'internal';
  }
  if (url === '/v1/auth' || url.startsWith('/v1/auth/')) {
    return 'auth';
  }
  const methods = Array.isArray(method) ? method : [method];
  const reads = methods.every((one) => ['GET', 'HEAD', 'OPTIONS'].includes(one.toUpperCase()));
  return reads ? 'reads' : 'mutations';
}

/** The bucket this request spends from — see the file header on scope. */
function bucketKey(
  request: FastifyRequest,
  routeClass: RateLimitClass,
  rule: RateLimitRule,
): string {
  if (rule.scope === 'organization') {
    const organizationId = request.tenant?.organizationId;
    if (organizationId !== undefined) {
      return `rl:${routeClass}:org:${organizationId}`;
    }
    // An internal caller has no tenant and no user, but it does have a verified
    // identity (`src/internal/service-auth.ts`) — so it gets its own bucket
    // rather than falling through to the address one, where every internal
    // service in the cluster would share a single budget with whatever else
    // egresses from that address. A busy sandbox fleet must not be able to
    // rate-limit the release service.
    const service = request.service?.service;
    if (service !== undefined) {
      return `rl:${routeClass}:service:${service}`;
    }
    // A mutation with no tenant context is still somebody's: creating an
    // organization mints a Stytch organization per success (plan 02 CP-3
    // review), so it is counted against the caller rather than left unlimited.
    const userId = request.auth?.userId;
    if (userId !== undefined) {
      return `rl:${routeClass}:user:${userId}`;
    }
  }
  return `rl:${routeClass}:ip:${request.ip}`;
}

export interface RateLimitOptions {
  readonly config: RateLimitConfig;
  readonly limiter: RateLimiter;
  /**
   * Reported, not applied: `request.ip` is resolved by Fastify, which was built
   * with this same setting (`src/app.ts`). The plugin takes it because the
   * plugin is what silently stops working when it is wrong — so the plugin is
   * what should say so.
   */
  readonly proxy: ProxyTrust;
}

function limited(retryAfterSeconds: number): ApiError {
  return new ApiError('rate_limited', 429, 'Too many requests. Please retry in a moment.', {
    retryAfterSeconds,
  });
}

function unavailable(): ApiError {
  return new ApiError(
    'rate_limiter_unavailable',
    503,
    'This endpoint is temporarily unavailable. Please retry in a moment.',
  );
}

export const rateLimit = fp<RateLimitOptions>(
  (app, options, done) => {
    const { config, limiter, proxy } = options;

    const byAddress = Object.entries(config)
      .filter(([, rule]) => rule.scope === 'ip')
      .map(([name]) => name);
    if (byAddress.length > 0 && proxy.trustedHops === 0 && proxy.trustedProxies.length === 0) {
      // Correct for a process nothing sits in front of, and wrong the moment one
      // does — at which point every one of these classes becomes a single shared
      // bucket for the whole internet. Loud rather than silent, because the
      // failure has no other symptom until somebody is locked out.
      app.log.warn(
        { classes: byAddress },
        'no proxy trust configured: address-scoped rate limits count the socket peer, ' +
          'which is the proxy if one is in front of this service (config/rate-limits.json → proxy)',
      );
    }

    function guardFor(routeClass: RateLimitClass) {
      const rule = config[routeClass];
      return async function enforce(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        const decision = await limiter.take(bucketKey(request, routeClass, rule), rule);
        reply.header('x-ratelimit-limit', String(rule.perMinute));
        reply.header('x-ratelimit-remaining', String(decision.remaining));

        if (decision.outcome === 'allowed') {
          return;
        }
        if (decision.outcome === 'unavailable') {
          request.log.warn(
            { rateLimitClass: routeClass, whenUnavailable: rule.whenUnavailable },
            'rate limiter unavailable',
          );
          if (rule.whenUnavailable === 'allow') {
            return;
          }
          reply.header('retry-after', String(decision.retryAfterSeconds));
          throw unavailable();
        }

        reply.header('retry-after', String(decision.retryAfterSeconds));
        request.log.info({ errorCode: 'rate_limited', rateLimitClass: routeClass }, 'rate limited');
        throw limited(decision.retryAfterSeconds);
      };
    }

    const guards = new Map<RateLimitClass, ReturnType<typeof guardFor>>();

    app.addHook('onRoute', (route: RouteOptions) => {
      if (EXEMPT_ROUTES.has(route.url)) {
        return;
      }
      const routeClass = classifyRoute(route.url, route.method);
      const guard = guards.get(routeClass) ?? guardFor(routeClass);
      guards.set(routeClass, guard);

      // Appended, not prepended — the whole point is to run once the session and
      // the tenant are known. See the file header. The exception is the internal
      // surface, whose own gate throws before an appended guard would run: see
      // {@link isInternalRoute}.
      const existing = route.preHandler;
      const chain = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
      route.preHandler = isInternalRoute(route.url) ? [guard, ...chain] : [...chain, guard];
    });

    done();
  },
  { name: 'rate-limit', fastify: '5.x' },
);
