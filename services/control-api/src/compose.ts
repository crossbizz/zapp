import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import type { Database } from '@zapp/db';

import { buildApp, type AppInstance } from './app.js';
import type { AuthEnv } from './auth/config.js';
import { createRedisTokenDenylist } from './auth/denylist.js';
import { createRedisDeviceStore } from './auth/device.js';
import { createStytchAuthPort } from './auth/stytch.js';
import { createDbUserStore } from './auth/users.js';
import type { RateLimitSettings } from './config/rate-limits.js';
import { resolveGitService } from './git/client.js';
import type { LoggerConfig } from './logging.js';
import { createRedisInviteStore } from './orgs/invites.js';
import { createDbOrganizationStore } from './orgs/store.js';
import { createDbAuditSink } from './plugins/audit.js';
import { createRedisIdempotencyStore } from './plugins/idempotency.js';
import { createRedisRateLimiter } from './plugins/rate-limit.js';
import type { RedisCommands } from './redis/client.js';
import { createServiceTokenVerifier } from './internal/service-auth.js';
import type { EventWakeupSource } from './events/sse.js';
import type { MasterKeyPort } from './secrets/crypto.js';
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
  /** Shared 32-byte key returned by `loadRunIntentHmacKey`. */
  readonly runIntentHmacKey: Buffer;
  /** CP-15 pub/sub port. Omission is refused outside development by buildApp. */
  readonly eventWakeups?: EventWakeupSource;
  readonly auth: AuthEnv;
  /**
   * The vault's master key, from `loadMasterKey` (`src/env.ts`). Required rather
   * than optional: a control plane deployed without one has no secrets surface
   * at all, and discovering that from a 404 in staging is worse than refusing to
   * boot.
   */
  readonly masterKey: MasterKeyPort;
  /**
   * The secret `/internal/*` verifies service tokens against, from
   * `loadServiceTokenConfig` (`src/env.ts`). Required for the same reason the
   * master key is: with no secret there is no internal surface, and a control
   * plane that discovered that from a 401 in staging discovered it too late.
   */
  readonly serviceTokens: ServiceTokenConfig;
  /**
   * Where `services/git-service` answers, from `loadGitServiceUrl`
   * (`src/git/client.ts`). Undefined only in development, where the record-only
   * stand-in keeps `pnpm dev` working with no git service running; outside it,
   * an undefined value is a refusal to start.
   */
  readonly gitServiceUrl?: string;
  /** The whole of `config/rate-limits.json`: the class budgets and the proxy trust. */
  readonly rateLimits: RateLimitSettings;
  /** Omitted in production, where the app's own defaults apply. `false` in tests. */
  readonly logger?: LoggerConfig;
}

export function composeApp(runtime: ServiceRuntime): AppInstance {
  const { database, redis } = runtime;
  /**
   * One denylist for both credential kinds.
   *
   * A session `jti`, a login family and a service token's `jti` all mean the
   * same thing to it — "this must stop working now" — and one store is one
   * place to look during an incident. They cannot collide: sessions are keyed
   * by hex ids and `sid:`, service tokens by `svc:` (`serviceTokenKey`).
   */
  const denylist = createRedisTokenDenylist(redis);

  return buildApp({
    ...(runtime.logger === undefined ? {} : { logger: runtime.logger }),
    auth: {
      port: createStytchAuthPort(runtime.auth.stytch),
      users: createDbUserStore(database),
      config: runtime.auth.config,
      denylist,
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
      runIntentHmacKey: runtime.runIntentHmacKey,
      ...(runtime.eventWakeups === undefined
        ? {}
        : { eventStream: { wakeups: runtime.eventWakeups } }),
      /**
       * The git service (plan 06 GIT-2), which is what CP-6 said would land on
       * this line — and it did, without anything else moving.
       *
       * `resolveGitService` refuses to start when `GIT_SERVICE_URL` is unset
       * outside development, for the reason the fallbacks below are refused
       * there: a control plane that quietly kept the record-only stand-in would
       * create projects whose `repositories` rows point at repositories that do
       * not exist, and the first symptom would be a clone failure in somebody
       * else's service, days later.
       */
      git: resolveGitService({
        baseUrl: runtime.gitServiceUrl,
        serviceTokens: runtime.serviceTokens,
      }),
    },
    secrets: {
      masterKey: runtime.masterKey,
      /**
       * The HMAC verifier CP-7 left a deny-all stand-in for (CP-8).
       *
       * Two collaborators and nothing else: the shared HS256 implementation
       * every zapp service signs with (`@zapp/config`), and the denylist above,
       * which is what makes a single-use token single-use. Both are named here
       * rather than defaulted, because this file is where a port's shipping
       * binding is supposed to be legible — and because a verifier that
       * defaulted its replay store to a process-local one would enforce single
       * use per replica, which is not enforcing it.
       */
      serviceTokens: createServiceTokenVerifier({
        signer: createServiceTokenSigner(runtime.serviceTokens),
        denylist,
      }),
    },
    limits: {
      config: runtime.rateLimits.classes,
      proxy: runtime.rateLimits.proxy,
      limiter: createRedisRateLimiter(redis),
      idempotency: createRedisIdempotencyStore(redis),
    },
  });
}
