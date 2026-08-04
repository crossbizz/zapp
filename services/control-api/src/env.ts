import { defineEnv } from '@zapp/config';
import { z } from 'zod';

import { LOG_LEVELS } from './logging.js';
import { KEY_BYTES, createEnvMasterKey, type MasterKeyPort } from './secrets/crypto.js';

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

/**
 * The master key that wraps every secret's data key (CP-7), and the one
 * variable in this service that *is* a secret.
 *
 * No default, for the reason `loadAuthEnv` refuses to default a session secret
 * and more so: a process that invented its own key would encrypt secrets nothing
 * else can read, and a process that shared a *published* default would encrypt
 * them so that everybody can.
 *
 * `SECRETS_PREVIOUS_MASTER_KEY` is how master-key rotation happens without
 * downtime: the new key moves in as current, the old one stays readable at
 * `version - 1` while a sweep re-wraps the data keys (nothing re-encrypts a
 * *value* — that is the whole point of the envelope), and the variable is
 * removed once `secret_metadata.key_version` shows no rows left behind.
 */
const SecretsEnvSchema = z.object({
  /** Base64 of exactly 32 bytes. Validated below rather than in the schema so the error names the variable, not the value. */
  SECRETS_MASTER_KEY: z.string().min(1),
  /** Which generation `SECRETS_MASTER_KEY` is. Moves forward on rotation; new secrets are wrapped under it. */
  SECRETS_MASTER_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  /** The generation before it, kept readable while a re-wrap sweep runs. */
  SECRETS_PREVIOUS_MASTER_KEY: z.string().min(1).optional(),
});

/** Decodes base64 and checks the length, naming the variable and never its contents. */
function masterKeyBytes(name: string, encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${name} must be base64 of exactly ${String(KEY_BYTES)} bytes (openssl rand -base64 32)`,
    );
  }
  return key;
}

/** @throws Error naming the offending variables — never their values. */
export function loadMasterKey(source: unknown = process.env): MasterKeyPort {
  const env = defineEnv(SecretsEnvSchema, source);
  const version = env.SECRETS_MASTER_KEY_VERSION;
  if (env.SECRETS_PREVIOUS_MASTER_KEY !== undefined && version < 2) {
    // Version 1 has nothing before it. A deployment that supplied a previous key
    // anyway has almost certainly forgotten to move the version forward, and
    // would then be wrapping new secrets under the generation it is retiring.
    throw new Error(
      'SECRETS_PREVIOUS_MASTER_KEY requires SECRETS_MASTER_KEY_VERSION to be at least 2',
    );
  }
  return createEnvMasterKey({
    key: masterKeyBytes('SECRETS_MASTER_KEY', env.SECRETS_MASTER_KEY),
    version,
    ...(env.SECRETS_PREVIOUS_MASTER_KEY === undefined
      ? {}
      : {
          previous: {
            key: masterKeyBytes('SECRETS_PREVIOUS_MASTER_KEY', env.SECRETS_PREVIOUS_MASTER_KEY),
            // One generation back, by construction: a scheme where the previous
            // version is also configurable is a scheme where a deployment can
            // claim the current key is older than the one it replaced.
            version: version - 1,
          },
        }),
  });
}
