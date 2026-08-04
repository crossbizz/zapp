import type { Database } from '@zapp/db';

import { buildApp, type AppInstance } from './app.js';
import type { AuthEnv } from './auth/config.js';
import { createRedisTokenDenylist } from './auth/denylist.js';
import { createRedisDeviceStore } from './auth/device.js';
import { createStytchAuthPort } from './auth/stytch.js';
import { createDbUserStore } from './auth/users.js';
import type { RateLimitConfig } from './config/rate-limits.js';
import { createRecordOnlyGitService } from './git/port.js';
import type { LoggerConfig } from './logging.js';
import { createRedisInviteStore } from './orgs/invites.js';
import { createDbOrganizationStore } from './orgs/store.js';
import { createDbAuditSink } from './plugins/audit.js';
import { createRedisIdempotencyStore } from './plugins/idempotency.js';
import { createRedisRateLimiter } from './plugins/rate-limit.js';
import type { RedisCommands } from './redis/client.js';
import { createTenantDbFactory } from './tenant/db.js';

/**
 * The composition the deployed service runs — every port bound to its shipping
 * implementation, in one place.
 *
 * Separate from `server.ts` on purpose. `server.ts` reads the environment,
 * opens the handles and listens; those three things cannot be exercised by a
 * test, and while the composition lived alongside them it could not be either.
 * That is not hypothetical: for a whole task the only entrypoint that listens
 * omitted `tenant`, so `/v1/projects` and `/v1/runs` were absent from the
 * running service while the isolation suite — which built its own app — proved
 * they were isolated (plan 02 CP-4 review). `test/compose.test.ts` now asserts
 * this function's output serves them.
 *
 * Everything here is a decision that belongs to the deployment rather than to a
 * route: which database, which cache, which identity provider, which limits.
 */
export interface ServiceRuntime {
  readonly database: Database;
  readonly redis: RedisCommands;
  readonly auth: AuthEnv;
  readonly rateLimits: RateLimitConfig;
  /** Omitted in production, where the app's own defaults apply. `false` in tests. */
  readonly logger?: LoggerConfig;
}

export function composeApp(runtime: ServiceRuntime): AppInstance {
  const { database, redis } = runtime;

  return buildApp({
    ...(runtime.logger === undefined ? {} : { logger: runtime.logger }),
    auth: {
      port: createStytchAuthPort(runtime.auth.stytch),
      users: createDbUserStore(database),
      config: runtime.auth.config,
      denylist: createRedisTokenDenylist(redis),
      deviceStore: createRedisDeviceStore(redis),
    },
    orgs: {
      organizations: createDbOrganizationStore(database),
      invites: createRedisInviteStore(redis),
      // The real `audit_events` writer: every mutating route's row lands in the
      // same transaction as the mutation (CP-5).
      audit: createDbAuditSink(database),
    },
    // Not optional in a deployment, and `buildApp` says so: without it the
    // tenant plugin is unregistered and every tenant-scoped route is simply
    // absent.
    tenant: {
      tenantDb: createTenantDbFactory(database),
      // Named here rather than left to `buildApp`'s default, because this file
      // is where a port's shipping binding is supposed to be legible: today the
      // record-only stand-in, which writes the `repositories` row and its
      // `internal_repo_ref` and contacts nothing. Plan 06's GIT-2 swaps in the
      // Forgejo client on this line and nothing else moves.
      git: createRecordOnlyGitService(),
    },
    limits: {
      config: runtime.rateLimits,
      limiter: createRedisRateLimiter(redis),
      idempotency: createRedisIdempotencyStore(redis),
    },
  });
}
