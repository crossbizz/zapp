import { defineEnv, type ServiceTokenConfig } from '@zapp/config';
import { z } from 'zod';

import { LOG_LEVELS } from './logging.js';
import { DEFAULT_SWEEP_INTERVAL_MS } from './sweep.js';

/**
 * Everything the git service needs to boot (plan 06 GIT-1).
 *
 * Split into loaders rather than one schema, for the reason
 * `services/control-api/src/env.ts` splits its own: the process-shape variables
 * have defaults and are harmless, and the ones naming *shared state* or
 * *credentials* have none and never will. A loader per concern is what lets a
 * script (`scripts/bootstrap.ts`) require the Forgejo connection without also
 * requiring a service-token secret it has no use for.
 */
const EnvSchema = z.object({
  /**
   * Defaults to `production` deliberately, exactly as the control plane's does:
   * every switch that reads this is safer in its production position, and an
   * unset variable must never be what turns a relaxation on.
   */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  /** Binds every interface: the service runs in a container behind a proxy. */
  HOST: z.string().min(1).default('0.0.0.0'),
  /** 4500 — plan 06's port for this service. */
  PORT: z.coerce.number().int().min(1).max(65535).default(4500),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /**
   * How often the process expires repository-scoped tokens (`src/sweep.ts`).
   *
   * Has a default because the safe value is the one that runs, and is
   * configurable because an incident is exactly when somebody wants it faster.
   * Capped at ten minutes — the token TTL ceiling — since a sweep interval
   * longer than the longest token's life would let *every* token outlive its
   * deadline, which is the failure the timer exists to prevent.
   */
  TOKEN_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(DEFAULT_SWEEP_INTERVAL_MS),
});

export type ServiceEnv = z.infer<typeof EnvSchema>;

/** @throws Error naming the offending variables — never their values. */
export function loadEnv(source: unknown = process.env): ServiceEnv {
  return defineEnv(EnvSchema, source);
}

/**
 * How to reach Forgejo, and as what.
 *
 * No defaults, for the reason the control plane refuses to default a session
 * secret: a git service that invented its own Forgejo URL would provision
 * repositories nowhere, and one that came up without an admin token would answer
 * every repository create with a 401 from a downstream — a failure that reads
 * like a bug in the caller. Both are refusals to start instead.
 *
 * `FORGEJO_ADMIN_TOKEN` is the one variable here that is a credential, and it is
 * the *only* thing in this system holding administrative reach over the Git host:
 * it creates organizations, creates repositories, and creates the ephemeral users
 * GIT-3 scopes tokens to. It never reaches a workspace, an agent or a generated
 * app, it is never logged (`redactToken` below is what makes that a property
 * rather than a habit), and it is never handed to a caller of this service — a
 * caller gets a repository-scoped token that expires.
 */
const ForgejoEnvSchema = z.object({
  /**
   * The instance's base URL, e.g. `http://localhost:3300` in dev (written into
   * `.env.local.forgejo` by `scripts/dev-up.sh`) or the private-network address
   * in a deployment (`terraform output forgejo_internal_url`).
   */
  FORGEJO_URL: z.string().url(),
  FORGEJO_ADMIN_TOKEN: z.string().min(1),
  /**
   * How long a single Forgejo API call may take.
   *
   * Bounded because of *where* the slowest of these calls happens: the control
   * plane calls `POST /internal/git/repositories` from inside the transaction
   * that creates a project, holding a pooled PostgreSQL connection open for the
   * whole round trip (`services/control-api/src/git/port.ts`). This service's own
   * deadline therefore has to be comfortably *under* that one, or the control
   * plane gives up first and the repository is created with nobody left to
   * record it.
   *
   * Five seconds: an order of magnitude more than a healthy create takes (tens
   * of milliseconds), and half of `GIT_CREATE_DEADLINE_MS`.
   */
  FORGEJO_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
});

export interface ForgejoEnv {
  readonly baseUrl: string;
  readonly adminToken: string;
  readonly timeoutMs: number;
}

/** @throws Error naming the offending variables — never their values. */
export function loadForgejoEnv(source: unknown = process.env): ForgejoEnv {
  const env = defineEnv(ForgejoEnvSchema, source);
  return {
    // Trailing slashes are how `${base}/api/v1` becomes `…//api/v1`, which some
    // proxies answer with a redirect and some with a 404. Normalized once, here,
    // rather than defended against at every call site.
    baseUrl: env.FORGEJO_URL.replace(/\/+$/, ''),
    adminToken: env.FORGEJO_ADMIN_TOKEN,
    timeoutMs: env.FORGEJO_TIMEOUT_MS,
  };
}

const ArtifactEnvSchema = z.object({
  ARTIFACT_ENDPOINT: z.string().url(),
  ARTIFACT_KEY: z.string().min(1),
  ARTIFACT_SECRET: z.string().min(1),
  ARTIFACT_BUCKET: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  ARTIFACT_REGION: z.string().min(1).default('auto'),
});

export interface ArtifactEnv {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly region: string;
}

/** Cloudflare R2 in production and the S3-compatible MinIO stack in development. */
export function loadArtifactEnv(source: unknown = process.env): ArtifactEnv {
  const env = defineEnv(ArtifactEnvSchema, source);
  return {
    endpoint: env.ARTIFACT_ENDPOINT.replace(/\/+$/, ''),
    accessKeyId: env.ARTIFACT_KEY,
    secretAccessKey: env.ARTIFACT_SECRET,
    bucket: env.ARTIFACT_BUCKET,
    region: env.ARTIFACT_REGION,
  };
}

/**
 * The secret every zapp service signs its inter-service calls with (plan 02
 * CP-8), and the one this service verifies them against.
 *
 * The same shape and the same reasoning as the control plane's loader, and it is
 * required here for a sharper reason: `/internal/git/*` is this service's *only*
 * surface. With no secret there is nothing to verify a caller with, so the
 * process would either refuse everybody or — if anyone ever defaulted it —
 * accept everybody, holding a Forgejo admin token the whole time.
 *
 * `SERVICE_TOKEN_SECRET_PREVIOUS` is verification-only and empty is the steady
 * state: rotation sets it to the outgoing secret, the new one moves in as
 * current, and it is emptied once no token older than a few minutes can still be
 * in flight — which for a credential that lives five minutes is essentially
 * immediately.
 */
const ServiceTokenEnvSchema = z.object({
  SERVICE_TOKEN_SECRET: z.string().min(32),
  SERVICE_TOKEN_SECRET_PREVIOUS: z.union([z.string().min(32), z.literal('')]).optional(),
});

/**
 * Where the audit trail is written (GIT-3).
 *
 * Shared state, and therefore deliberately without a default: `audit_events` is
 * PRD §23.6's platform-wide append-only ledger, and a git service pointed at the
 * wrong database — or at none — would mint repository credentials whose only
 * record is somewhere nobody looks.
 */
const DatabaseEnvSchema = z.object({ DATABASE_URL: z.string().min(1) });

/** @throws Error naming the offending variable — never its value. */
export function loadDatabaseUrl(source: unknown = process.env): string {
  return defineEnv(DatabaseEnvSchema, source).DATABASE_URL;
}

/** @throws Error naming the offending variables — never their values. */
export function loadServiceTokenConfig(source: unknown = process.env): ServiceTokenConfig {
  const env = defineEnv(ServiceTokenEnvSchema, source);
  const previous = env.SERVICE_TOKEN_SECRET_PREVIOUS;
  return {
    secret: env.SERVICE_TOKEN_SECRET,
    ...(previous === undefined || previous === '' ? {} : { previousSecret: previous }),
  };
}
