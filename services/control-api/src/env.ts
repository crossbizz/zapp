import { defineEnv } from '@zapp/config';
import { z } from 'zod';

import { LOG_LEVELS } from './logging.js';

/**
 * Everything the process needs to boot. Defaults keep `pnpm start` working with an
 * empty environment; nothing here is a secret, and nothing secret may be added
 * without going through the vault (CP-7) instead.
 */
const EnvSchema = z.object({
  /**
   * Defaults to `production` deliberately: every switch that reads this — pretty
   * logging today, and anything looser later — is safer in its production position,
   * and an unset variable should never be what turns a relaxation on. Local
   * development sets it explicitly (`.env.example`).
   */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  /** Binds every interface: the service runs in a container and is fronted by a proxy. */
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type ServiceEnv = z.infer<typeof EnvSchema>;

/** @throws Error naming the offending variables — never their values. */
export function loadEnv(source: unknown = process.env): ServiceEnv {
  return defineEnv(EnvSchema, source);
}

/**
 * Shared state, and therefore deliberately outside {@link EnvSchema}: it has no
 * default and never will. Redis holds the token denylist, the device grants,
 * the invitations, the idempotency records and the rate limit buckets (CP-5), so
 * a process that cannot name one would come up serving requests with a revoked
 * session still valid and every limit unenforced — the same reason
 * `loadAuthEnv` refuses to default a session secret.
 */
const RedisEnvSchema = z.object({ REDIS_URL: z.string().min(1) });

/** @throws Error naming the offending variable — never its value. */
export function loadRedisUrl(source: unknown = process.env): string {
  return defineEnv(RedisEnvSchema, source).REDIS_URL;
}
