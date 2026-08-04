import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/**
 * The rate limits, read from `config/rate-limits.json`.
 *
 * A file rather than constants in code, as plan 02 CP-5 requires, and the
 * reason is operational: the first thing anyone does during an incident is
 * raise or drop a limit, and that should be a configuration change and a
 * restart rather than a pull request, a build and a deploy. It is validated on
 * the way in — a malformed file refuses to boot, because a service that fell
 * back to a built-in default after failing to read its limits would be running
 * limits nobody chose.
 *
 * Not environment variables: three classes with four fields each is a shape,
 * and flattening a shape into twelve `RATE_LIMIT_*` variables is how half of
 * them end up unset in one environment.
 */

/**
 * What a route is limited *as*. Five classes, because they answer five
 * different questions: is one tenant reading too fast, is one tenant writing
 * too fast, is one address guessing credentials, is one machine polling for its
 * device grant, and is anybody flooding the service-to-service surface.
 */
export const RATE_LIMIT_CLASSES = ['auth', 'device', 'reads', 'mutations', 'internal'] as const;

export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

const RuleSchema = z
  .object({
    /** Free text for whoever opens the file next. Ignored here. */
    note: z.string().optional(),
    /** Sustained rate: how fast the bucket refills. */
    perMinute: z.number().int().positive().max(1_000_000),
    /** Bucket capacity: how many requests may arrive at once. */
    burst: z.number().int().positive().max(1_000_000),
    scope: z.enum(['organization', 'ip']),
    /** What a Redis outage means for this class — see the file's own `$comment`. */
    whenUnavailable: z.enum(['allow', 'deny']),
  })
  .strict();

export type RateLimitRule = z.infer<typeof RuleSchema>;

/**
 * How far to believe `X-Forwarded-For`.
 *
 * An `ip`-scoped limit is only a per-client limit if the address it counts is
 * the client's. This service runs in a container behind a proxy (`src/env.ts`
 * binds every interface for exactly that reason), so without this every request
 * arrives from the proxy and the whole `auth` class collapses into one global
 * bucket: one caller exhausts sign-in for everybody, and the per-attacker
 * brute-force limiting the class exists for is not delivered at all.
 *
 * The cure must not be worse. `trustProxy: true` would make `X-Forwarded-For`
 * client-controlled — a header anyone can set, and therefore a complete bypass
 * of every ip-scoped limit. So trust is *stated*: either how many hops sit
 * between this process and the client, or which addresses may speak for one.
 * Neither by default, so a deployment that forgets to say counts socket
 * addresses (safe) and says so in the log (noisy) rather than believing a
 * header nobody vouched for.
 */
const ProxySchema = z
  .object({
    note: z.string().optional(),
    /**
     * Proxies between this process and the client, counted from the socket
     * inward. `1` for a single load balancer; `0` trusts nothing.
     */
    trustedHops: z.number().int().min(0).max(10).default(0),
    /**
     * Addresses or CIDRs whose `X-Forwarded-For` is believed, for a topology
     * where the hop count varies. Also accepts proxy-addr's names —
     * `loopback`, `linklocal`, `uniquelocal`.
     */
    trustedProxies: z.array(z.string().min(1)).default([]),
  })
  .strict()
  // One or the other. proxy-addr takes a hop count *or* an allowlist, and a
  // file that set both would be asking for a resolution nobody chose.
  .refine((proxy) => proxy.trustedHops === 0 || proxy.trustedProxies.length === 0, {
    message: 'set trustedHops or trustedProxies, not both',
  });

export type ProxyTrust = z.infer<typeof ProxySchema>;

const ConfigSchema = z
  .object({
    /** The file documents itself; nothing reads this. */
    $comment: z.union([z.string(), z.array(z.string())]).optional(),
    proxy: ProxySchema.default({}),
    classes: z
      .object({
        auth: RuleSchema,
        device: RuleSchema,
        reads: RuleSchema,
        mutations: RuleSchema,
        internal: RuleSchema,
      })
      .strict(),
  })
  .strict();

export type RateLimitConfig = z.infer<typeof ConfigSchema>['classes'];

/** The whole file: the class budgets, and how far to believe a forwarded address. */
export interface RateLimitSettings {
  readonly classes: RateLimitConfig;
  readonly proxy: ProxyTrust;
}

/**
 * {@link ProxyTrust} as Fastify's `trustProxy` option.
 *
 * `false` is the default and the safe one: `request.ip` is then the socket's
 * peer, which is wrong behind a proxy but is never *attacker-chosen*.
 */
export function trustProxyOption(proxy: ProxyTrust): number | string[] | false {
  if (proxy.trustedProxies.length > 0) {
    return [...proxy.trustedProxies];
  }
  return proxy.trustedHops > 0 ? proxy.trustedHops : false;
}

/**
 * `<package>/config/rate-limits.json`, from `src/config/` and from `dist/config/`
 * alike — the two are the same distance from the package root, so one relative
 * URL serves the built service and `tsx` in development.
 */
export const RATE_LIMITS_PATH = fileURLToPath(
  new URL('../../config/rate-limits.json', import.meta.url),
);

const cache = new Map<string, RateLimitSettings>();

/**
 * @throws Error naming the fields that failed, never the file's contents — the
 * same rule `defineEnv` follows, for the same reason.
 */
export function loadRateLimitSettings(path: string = RATE_LIMITS_PATH): RateLimitSettings {
  const cached = cache.get(path);
  if (cached !== undefined) {
    return cached;
  }

  const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => {
        const field = issue.path.join('.') || 'configuration';
        // Our own wording for a rule the shape cannot express, never the file's
        // contents — the same line `defineEnv` draws.
        return issue.code === 'custom' ? `${field} (${issue.message})` : field;
      })
      .join(', ');
    throw new Error(`Invalid rate limit configuration (${path}): ${fields}`);
  }

  const settings: RateLimitSettings = { classes: parsed.data.classes, proxy: parsed.data.proxy };
  cache.set(path, settings);
  return settings;
}
