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
 * What a route is limited *as*. Three classes, because they answer three
 * different questions: is one tenant reading too fast, is one tenant writing
 * too fast, and is one address guessing credentials.
 */
export const RATE_LIMIT_CLASSES = ['auth', 'reads', 'mutations'] as const;

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

const ConfigSchema = z
  .object({
    /** The file documents itself; nothing reads this. */
    $comment: z.union([z.string(), z.array(z.string())]).optional(),
    classes: z
      .object({
        auth: RuleSchema,
        reads: RuleSchema,
        mutations: RuleSchema,
      })
      .strict(),
  })
  .strict();

export type RateLimitConfig = z.infer<typeof ConfigSchema>['classes'];

/**
 * `<package>/config/rate-limits.json`, from `src/config/` and from `dist/config/`
 * alike — the two are the same distance from the package root, so one relative
 * URL serves the built service and `tsx` in development.
 */
export const RATE_LIMITS_PATH = fileURLToPath(
  new URL('../../config/rate-limits.json', import.meta.url),
);

const cache = new Map<string, RateLimitConfig>();

/**
 * @throws Error naming the fields that failed, never the file's contents — the
 * same rule `defineEnv` follows, for the same reason.
 */
export function loadRateLimits(path: string = RATE_LIMITS_PATH): RateLimitConfig {
  const cached = cache.get(path);
  if (cached !== undefined) {
    return cached;
  }

  const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid rate limit configuration (${path}): ${fields}`);
  }

  cache.set(path, parsed.data.classes);
  return parsed.data.classes;
}
