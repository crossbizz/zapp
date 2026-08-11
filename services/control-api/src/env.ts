import { defineEnv, type ServiceTokenConfig } from '@zapp/config';
import { z } from 'zod';

import {
  StripePlatformSecretSchema,
  StripePriceCatalogSchema,
  StripeWebhookSecretSchema,
  type StripePriceCatalog,
} from './billing/stripe.js';

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

const TemporalEnvSchema = z.object({
  TEMPORAL_ADDRESS: z.string().trim().min(1),
  TEMPORAL_NAMESPACE: z.string().trim().min(1).default('default'),
});

export interface TemporalEnv {
  readonly address: string;
  readonly namespace: string;
}

export function loadTemporalEnv(source: unknown = process.env): TemporalEnv {
  const env = defineEnv(TemporalEnvSchema, source);
  return { address: env.TEMPORAL_ADDRESS, namespace: env.TEMPORAL_NAMESPACE };
}

const ArtifactStorageEnvSchema = z.object({
  ARTIFACT_ENDPOINT: z.string().url(),
  ARTIFACT_REGION: z.string().trim().min(1),
  ARTIFACT_BUCKET: z.string().trim().min(1),
  ARTIFACT_KEY: z.string().min(1),
  ARTIFACT_SECRET: z.string().min(1),
});

export interface ArtifactStorageEnv {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export function loadArtifactStorageEnv(source: unknown = process.env): ArtifactStorageEnv {
  const env = defineEnv(ArtifactStorageEnvSchema, source);
  return {
    endpoint: env.ARTIFACT_ENDPOINT.replace(/\/+$/u, ''),
    region: env.ARTIFACT_REGION,
    bucket: env.ARTIFACT_BUCKET,
    accessKeyId: env.ARTIFACT_KEY,
    secretAccessKey: env.ARTIFACT_SECRET,
  };
}

const UsageQueueEnvSchema = z
  .object({
    AWS_REGION: z.string().trim().min(1),
    AWS_ENDPOINT_URL: z.union([z.string().url(), z.literal('')]).optional(),
    AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    SQS_USAGE_QUEUE_NAME: z.string().trim().min(1).default('zapp-usage-events'),
  })
  .superRefine((value, context) => {
    if ((value.AWS_ACCESS_KEY_ID === undefined) !== (value.AWS_SECRET_ACCESS_KEY === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be supplied together',
      });
    }
  });

export interface UsageQueueEnv {
  readonly region: string;
  readonly endpoint?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly queueName: string;
}

export function loadUsageQueueEnv(source: unknown = process.env): UsageQueueEnv {
  const env = defineEnv(UsageQueueEnvSchema, source);
  return {
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL === undefined || env.AWS_ENDPOINT_URL === ''
      ? {}
      : { endpoint: env.AWS_ENDPOINT_URL }),
    ...(env.AWS_ACCESS_KEY_ID === undefined || env.AWS_SECRET_ACCESS_KEY === undefined
      ? {}
      : {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        }),
    queueName: env.SQS_USAGE_QUEUE_NAME,
  };
}

const GitHubAppEnvSchema = z.object({
  GITHUB_APP_ID: z.string().trim().min(1),
  GITHUB_APP_SLUG: z.string().trim().regex(/^[A-Za-z0-9-]+$/u),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_APP_CLIENT_ID: z.string().trim().min(1),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_API_BASE_URL: z.union([z.string().url(), z.literal('')]).optional(),
});

const GitHubAppConfigSchema = z
  .object({
    appId: z.string().min(1),
    appSlug: z.string().min(1),
    privateKey: z.string().min(1),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    webhookSecret: z.string().min(1),
    apiBaseUrl: z.string().url().optional(),
  })
  .strict();

export type GitHubAppEnv = z.infer<typeof GitHubAppConfigSchema>;

export function loadGitHubAppEnv(source: unknown = process.env): GitHubAppEnv {
  const env = defineEnv(GitHubAppEnvSchema, source);
  return GitHubAppConfigSchema.parse({
    appId: env.GITHUB_APP_ID,
    appSlug: env.GITHUB_APP_SLUG,
    privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/gu, '\n'),
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    ...(env.GITHUB_API_BASE_URL === undefined || env.GITHUB_API_BASE_URL === ''
      ? {}
      : { apiBaseUrl: env.GITHUB_API_BASE_URL.replace(/\/+$/u, '') }),
  });
}

const GitHubWebhookQueueEnvSchema = z
  .object({
    AWS_REGION: z.string().trim().min(1),
    AWS_ENDPOINT_URL: z.union([z.string().url(), z.literal('')]).optional(),
    AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    SQS_GITHUB_WEBHOOK_QUEUE_NAME: z.string().trim().min(1).default('zapp-github-webhooks'),
  })
  .superRefine((value, context) => {
    if ((value.AWS_ACCESS_KEY_ID === undefined) !== (value.AWS_SECRET_ACCESS_KEY === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be supplied together',
      });
    }
  });

const GitHubWebhookQueueConfigSchema = z
  .object({
    region: z.string().min(1),
    endpoint: z.string().url().optional(),
    accessKeyId: z.string().min(1).optional(),
    secretAccessKey: z.string().min(1).optional(),
    queueName: z.string().min(1),
  })
  .strict();

export type GitHubWebhookQueueEnv = z.infer<typeof GitHubWebhookQueueConfigSchema>;

export function loadGitHubWebhookQueueEnv(
  source: unknown = process.env,
): GitHubWebhookQueueEnv {
  const env = defineEnv(GitHubWebhookQueueEnvSchema, source);
  return GitHubWebhookQueueConfigSchema.parse({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL === undefined || env.AWS_ENDPOINT_URL === ''
      ? {}
      : { endpoint: env.AWS_ENDPOINT_URL }),
    ...(env.AWS_ACCESS_KEY_ID === undefined || env.AWS_SECRET_ACCESS_KEY === undefined
      ? {}
      : {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        }),
    queueName: env.SQS_GITHUB_WEBHOOK_QUEUE_NAME,
  });
}

const GitHubImportQueueEnvSchema = z
  .object({
    AWS_REGION: z.string().trim().min(1),
    AWS_ENDPOINT_URL: z.union([z.string().url(), z.literal('')]).optional(),
    AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    SQS_GITHUB_IMPORT_QUEUE_NAME: z.string().trim().min(1).default('zapp-github-imports'),
  })
  .superRefine((value, context) => {
    if ((value.AWS_ACCESS_KEY_ID === undefined) !== (value.AWS_SECRET_ACCESS_KEY === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be supplied together',
      });
    }
  });

const GitHubImportQueueConfigSchema = z
  .object({
    region: z.string().min(1),
    endpoint: z.string().url().optional(),
    accessKeyId: z.string().min(1).optional(),
    secretAccessKey: z.string().min(1).optional(),
    queueName: z.string().min(1),
    deadLetterQueueName: z.string().min(1),
  })
  .strict();

export type GitHubImportQueueEnv = z.infer<typeof GitHubImportQueueConfigSchema>;

export function loadGitHubImportQueueEnv(source: unknown = process.env): GitHubImportQueueEnv {
  const env = defineEnv(GitHubImportQueueEnvSchema, source);
  return GitHubImportQueueConfigSchema.parse({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL === undefined || env.AWS_ENDPOINT_URL === ''
      ? {}
      : { endpoint: env.AWS_ENDPOINT_URL }),
    ...(env.AWS_ACCESS_KEY_ID === undefined || env.AWS_SECRET_ACCESS_KEY === undefined
      ? {}
      : {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        }),
    queueName: env.SQS_GITHUB_IMPORT_QUEUE_NAME,
    deadLetterQueueName: `${env.SQS_GITHUB_IMPORT_QUEUE_NAME}-dlq`,
  });
}

const FlexpriceEnvSchema = z.object({
  FLEXPRICE_API_KEY: z.union([z.string().trim().min(1), z.literal('')]).optional(),
  FLEXPRICE_BASE_URL: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//u.test(value), 'FLEXPRICE_BASE_URL must use HTTP(S)')
    .default('https://api.cloud.flexprice.io/v1'),
});

export interface FlexpriceEnv {
  readonly apiKey: string;
  readonly baseUrl: string;
}

/** A template placeholder means the optional vendor consumer stays dormant. */
export function loadFlexpriceEnv(source: unknown = process.env): FlexpriceEnv | undefined {
  const env = defineEnv(FlexpriceEnvSchema, source);
  if (
    env.FLEXPRICE_API_KEY === undefined ||
    env.FLEXPRICE_API_KEY === '' ||
    env.FLEXPRICE_API_KEY === 'replace-me'
  ) {
    return undefined;
  }
  return {
    apiKey: env.FLEXPRICE_API_KEY,
    baseUrl: env.FLEXPRICE_BASE_URL.replace(/\/+$/u, ''),
  };
}

/** Production must never silently start without the wallet admission gate. */
export function requireFlexpriceForEnvironment(
  environment: Pick<ServiceEnv, 'NODE_ENV'>,
  flexprice: FlexpriceEnv | undefined,
): FlexpriceEnv | undefined {
  if (environment.NODE_ENV === 'production' && flexprice === undefined) {
    throw new Error('FLEXPRICE_API_KEY is required in production');
  }
  return flexprice;
}

const OptionalBillingValueSchema = z.union([z.string().trim().min(1), z.literal('')]).optional();
const StripeBillingEnvSchema = z.object({
  PLATFORM_BILLING_STRIPE_SECRET_KEY: OptionalBillingValueSchema,
  PLATFORM_BILLING_STRIPE_WEBHOOK_SECRET: OptionalBillingValueSchema,
  STRIPE_PLAN_PRICE_IDS_JSON: OptionalBillingValueSchema,
  FLEXPRICE_STRIPE_WEBHOOK_URL: z
    .union([
      z.string().url().refine((value) => /^https:\/\//u.test(value), 'must use HTTPS'),
      z.literal(''),
    ])
    .optional(),
});

export interface StripeBillingEnv {
  readonly platformSecretKey: string;
  readonly webhookSecret: string;
  readonly prices: StripePriceCatalog;
  readonly flexpriceStripeWebhookUrl: string;
}

export function loadStripeBillingEnv(source: unknown = process.env): StripeBillingEnv | undefined {
  const env = defineEnv(StripeBillingEnvSchema, source);
  const values = [
    env.PLATFORM_BILLING_STRIPE_SECRET_KEY,
    env.PLATFORM_BILLING_STRIPE_WEBHOOK_SECRET,
    env.STRIPE_PLAN_PRICE_IDS_JSON,
    env.FLEXPRICE_STRIPE_WEBHOOK_URL,
  ];
  if (values.every((value) => value === undefined || value === '' || value.includes('replace-me'))) {
    return undefined;
  }
  return {
    platformSecretKey: StripePlatformSecretSchema.parse(
      env.PLATFORM_BILLING_STRIPE_SECRET_KEY,
      { path: ['PLATFORM_BILLING_STRIPE_SECRET_KEY'] },
    ),
    webhookSecret: StripeWebhookSecretSchema.parse(
      env.PLATFORM_BILLING_STRIPE_WEBHOOK_SECRET,
      { path: ['PLATFORM_BILLING_STRIPE_WEBHOOK_SECRET'] },
    ),
    prices: StripePriceCatalogSchema.parse(
      JSON.parse(env.STRIPE_PLAN_PRICE_IDS_JSON ?? ''),
      { path: ['STRIPE_PLAN_PRICE_IDS_JSON'] },
    ),
    flexpriceStripeWebhookUrl: z.string().url().parse(
      env.FLEXPRICE_STRIPE_WEBHOOK_URL,
      { path: ['FLEXPRICE_STRIPE_WEBHOOK_URL'] },
    ),
  };
}

export function requireStripeBillingForEnvironment(
  environment: Pick<ServiceEnv, 'NODE_ENV'>,
  billing: StripeBillingEnv | undefined,
): StripeBillingEnv | undefined {
  if (environment.NODE_ENV === 'production' && billing === undefined) {
    throw new Error('PLATFORM_BILLING_STRIPE_SECRET_KEY is required in production');
  }
  return billing;
}

/**
 * Cross-instance key for the HMAC stored with durable run intent. There is no
 * default: retries must derive the same digest on every replica, while a
 * published fallback would let a database reader test guessed prompts.
 */
const RunIntentHmacEnvSchema = z.object({
  RUN_INTENT_HMAC_SECRET: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

/** @throws Error naming the variable, never its value. */
export function loadRunIntentHmacKey(source: unknown = process.env): Buffer {
  return Buffer.from(defineEnv(RunIntentHmacEnvSchema, source).RUN_INTENT_HMAC_SECRET, 'hex');
}

const PreviewEnvSchema = z.object({
  PREVIEW_SHARE_SIGNING_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  PREVIEW_SHARE_KEY_VERSION: z.coerce.number().int().positive().default(1),
  PREVIEW_BASE_DOMAIN: z.string().trim().min(1),
  SANDBOX_SERVICE_URL: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//u.test(value), 'SANDBOX_SERVICE_URL must use HTTP(S)'),
});

export interface PreviewEnv {
  readonly signingKey: Buffer;
  readonly keyVersion: number;
  readonly previewBaseDomain: string;
  readonly sandboxServiceUrl: string;
}

/** WS-12 zapp-owned preview ingress configuration. Values are never inferred from Host. */
export function loadPreviewEnv(source: unknown = process.env): PreviewEnv {
  const env = defineEnv(PreviewEnvSchema, source);
  return {
    signingKey: Buffer.from(env.PREVIEW_SHARE_SIGNING_KEY, 'hex'),
    keyVersion: env.PREVIEW_SHARE_KEY_VERSION,
    previewBaseDomain: env.PREVIEW_BASE_DOMAIN.toLowerCase(),
    sandboxServiceUrl: env.SANDBOX_SERVICE_URL.replace(/\/+$/u, ''),
  };
}

const ModelGatewayEnvSchema = z.object({
  MODEL_GATEWAY_URL: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//u.test(value), 'MODEL_GATEWAY_URL must use HTTP(S)'),
});

/** MAC-6's server-to-server completion hop. No browser or desktop receives this credential. */
export function loadModelGatewayUrl(source: unknown = process.env): string {
  return defineEnv(ModelGatewayEnvSchema, source).MODEL_GATEWAY_URL.replace(/\/+$/u, '');
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
  /**
   * The generation before it, kept readable while a re-wrap sweep runs.
   *
   * Empty is the steady state, exactly as `SESSION_JWT_SECRET_PREVIOUS` is in
   * `src/auth/config.ts`: the variable exists in `.env.example` — and therefore
   * in the `.env` `scripts/dev-up.sh` copies from it — so that a rotation is a
   * value change rather than a schema change. Accepting only "absent or
   * non-empty" made the shipped template refuse to boot on a fresh checkout,
   * which is what `test/env.test.ts` now pins.
   */
  SECRETS_PREVIOUS_MASTER_KEY: z.union([z.string().min(1), z.literal('')]).optional(),
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
  // Empty means "not rotating", the same as absent — the schema accepts it
  // because the template ships it, and everything below reads one value for
  // both rather than two spellings of no key.
  const previous =
    env.SECRETS_PREVIOUS_MASTER_KEY === '' ? undefined : env.SECRETS_PREVIOUS_MASTER_KEY;
  if (previous !== undefined && version < 2) {
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
    ...(previous === undefined
      ? {}
      : {
          previous: {
            key: masterKeyBytes('SECRETS_PREVIOUS_MASTER_KEY', previous),
            // One generation back, by construction: a scheme where the previous
            // version is also configurable is a scheme where a deployment can
            // claim the current key is older than the one it replaced.
            version: version - 1,
          },
        }),
  });
}

/**
 * The secret every zapp service signs its inter-service calls with (CP-8), and
 * the one this deployment verifies them against.
 *
 * No default, for the reason `loadAuthEnv` refuses to default a session secret:
 * a control plane that invented its own would reject every internal call, and
 * one that shared a published default would accept anybody's. Nothing else in
 * the system can reach `/internal/*` — a route with no user-facing form — so
 * "the variable is missing" has to be a refusal to start rather than a surface
 * that quietly admits nobody or, worse, everybody.
 *
 * `SERVICE_TOKEN_SECRET_PREVIOUS` is verification-only, and empty is the steady
 * state: rotation sets it to the outgoing secret, the new one moves in as
 * current, and it is emptied again once no token older than a few minutes can
 * still be in flight — which for a credential that lives five minutes is
 * essentially immediately.
 */
const ServiceTokenEnvSchema = z.object({
  /**
   * Long enough that HS256 is not the weak link, matching `AuthEnvSchema`'s
   * floor: `.env.example` documents `openssl rand -hex 32` (64 characters), and
   * the floor is low enough that a base64 secret of adequate entropy is not
   * rejected on a technicality while `replace-me` still is.
   */
  SERVICE_TOKEN_SECRET: z.string().min(32),
  SERVICE_TOKEN_SECRET_PREVIOUS: z.union([z.string().min(32), z.literal('')]).optional(),
});

/** @throws Error naming the offending variables — never their values. */
export function loadServiceTokenConfig(source: unknown = process.env): ServiceTokenConfig {
  const env = defineEnv(ServiceTokenEnvSchema, source);
  const previous = env.SERVICE_TOKEN_SECRET_PREVIOUS;
  return {
    secret: env.SERVICE_TOKEN_SECRET,
    ...(previous === undefined || previous === '' ? {} : { previousSecret: previous }),
  };
}
