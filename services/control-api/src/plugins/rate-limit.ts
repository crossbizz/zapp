import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import fp from 'fastify-plugin';

import {
  type RateLimitClass,
  type RateLimitConfig,
  type RateLimitRule,
} from '../config/rate-limits.js';
import { ApiError } from '../errors.js';
import type { RedisCommands } from '../redis/client.js';

/**
 * Per-organization rate limiting, as a token bucket in Redis.
 *
 * Three decisions are worth the reader's time.
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
 * Which limit a route answers to.
 *
 * By path and method rather than by a per-route declaration, so the answer is
 * the same for a route nobody remembered to annotate. A route that accepts both
 * a read and a write method takes the stricter of the two.
 */
export function classifyRoute(url: string, method: string | string[]): RateLimitClass {
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
    const { config, limiter } = options;

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
      // the tenant are known. See the file header.
      const existing = route.preHandler;
      route.preHandler =
        existing === undefined
          ? [guard]
          : [...(Array.isArray(existing) ? existing : [existing]), guard];
    });

    done();
  },
  { name: 'rate-limit', fastify: '5.x' },
);
