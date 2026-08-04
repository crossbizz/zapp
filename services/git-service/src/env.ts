import { defineEnv } from '@zapp/config';
import { z } from 'zod';

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
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
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
