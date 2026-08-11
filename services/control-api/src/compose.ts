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
import type { RedisCommands, RedisConnection } from './redis/client.js';
import {
  createTemporalCapabilityScanPort,
  type CapabilityScanWorkflowClient,
} from './orchestrator/capability-scan.js';
import type { OrchestratorPort } from './orchestrator/port.js';
import { createServiceTokenVerifier } from './internal/service-auth.js';
import type { EventWakeupSource } from './events/sse.js';
import type { MasterKeyPort } from './secrets/crypto.js';
import { createTenantDbFactory } from './tenant/db.js';
import {
  createRedisPreviewRevocationSource,
  createRedisPreviewSessionStore,
  createSandboxPreviewProxy,
} from './routes/preview.js';
import { createDbPreviewShareStore } from './preview/store.js';
import type { FlexpriceEnv, PreviewEnv } from './env.js';
import type { ArtifactStorageEnv } from './env.js';
import type { GitHubAppEnv } from './env.js';
import { createS3AttachmentStorage } from './routes/attachments.js';
import type { PricingConfig } from './usage/pricing.js';
import {
  createBudgetThresholdAlerts,
  createCachedCreditBalanceGate,
  createDatabaseActiveReservationSource,
  createFlexpriceWalletClient,
  type PlanLimitsConfig,
  type CreditBalanceGate,
  type UsageOpsAlertPort,
} from './usage/limits.js';
import { createModelCompletionRepository } from './usage/model-completions.js';
import { createUsageLedgerRepository } from './usage/ledger.js';
import { createDeploymentUsageCollector } from './usage/collectors/git.js';
import { createRedisCreditMirror } from './usage/reconciliation.js';
import { createModelGatewayLocalAgentClient } from './local-agent/gateway.js';
import { createLocalAgentSessionRepository } from './local-agent/store.js';
import { createBuilderPreviewSandboxClient } from './sandbox/client.js';
import { createS3BuilderPreviewScreenshotStore } from './routes/builder-preview.js';
import { createGitHubProvider } from './integrations/github/app.js';
import { createGitHubIntegrationPort } from './integrations/github/install.js';
import {
  createRedisGitHubAuthorizationStateStore,
  createDbGitHubWebhookStore,
} from './integrations/github/store.js';
import { createSupabaseIntegrationPort } from './integrations/supabase/connect.js';
import { createSupabaseManagementClient } from './integrations/supabase/provision.js';
import {
  createNeonIntegrationPort,
  createNeonProjectManagementPort,
} from './integrations/neon/connect.js';
import { createNeonManagementClient, createNeonSqlFactory } from './integrations/neon/branches.js';
import {
  createGeneratedAppStripeIntegrationPort,
  createStripeAccountClient,
} from './integrations/stripe/connect.js';
import type { IntegrationPort } from './routes/integrations.js';

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
  /** WS-12 needs publish/subscribe in addition to request-store commands. */
  readonly previewRedis?: RedisConnection;
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
  /** MAC-6 public proxy destination; only control-api holds the service credential. */
  readonly modelGatewayUrl: string;
  /**
   * Where `services/git-service` answers, from `loadGitServiceUrl`
   * (`src/git/client.ts`). Undefined only in development, where the record-only
   * stand-in keeps `pnpm dev` working with no git service running; outside it,
   * an undefined value is a refusal to start.
   */
  readonly gitServiceUrl?: string;
  /** The whole of `config/rate-limits.json`: the class budgets and the proxy trust. */
  readonly rateLimits: RateLimitSettings;
  readonly preview?: PreviewEnv;
  readonly pricing: PricingConfig;
  /** OPS-3's configuration-owned plan policy. */
  readonly planLimits?: PlanLimitsConfig;
  /** Omitted only when Flexprice credentials are intentionally absent in local development. */
  readonly flexprice?: FlexpriceEnv;
  /** Optional server-owned gate so background reconciliation shares its exact wallet boundary. */
  readonly creditBalance?: CreditBalanceGate;
  /** OPS-7 owns delivery; this is the explicit handoff for provider-outage alerts. */
  readonly usageOpsAlerts?: UsageOpsAlertPort;
  /** Temporal client used for the tenant-bound VF-3 verification workflow. */
  readonly temporal: CapabilityScanWorkflowClient;
  readonly orchestrator?: OrchestratorPort;
  readonly artifactStorage: ArtifactStorageEnv;
  readonly github?: GitHubAppEnv;
  /** Omitted in production, where the app's own defaults apply. `false` in tests. */
  readonly logger?: LoggerConfig;
}

export function composeApp(runtime: ServiceRuntime): AppInstance {
  const { database, redis } = runtime;
  const previewRuntime =
    runtime.preview === undefined
      ? undefined
      : {
          config: runtime.preview,
          proxy: createSandboxPreviewProxy({
            baseUrl: runtime.preview.sandboxServiceUrl,
            serviceTokens: runtime.serviceTokens,
          }),
        };
  /**
   * One denylist for both credential kinds.
   *
   * A session `jti`, a login family and a service token's `jti` all mean the
   * same thing to it — "this must stop working now" — and one store is one
   * place to look during an incident. They cannot collide: sessions are keyed
   * by hex ids and `sid:`, service tokens by `svc:` (`serviceTokenKey`).
   */
  const denylist = createRedisTokenDenylist(redis);
  const usageLedger = createUsageLedgerRepository({ database });
  const tenantDb = createTenantDbFactory(database);
  const organizations = createDbOrganizationStore(database);
  const usageOpsAlerts: UsageOpsAlertPort =
    runtime.usageOpsAlerts ??
    {
      emit: (alert) => {
        process.emitWarning(
          `usage ops alert: ${alert.type} for organization ${alert.organizationId}`,
        );
        return Promise.resolve();
      },
    };
  const budgetAlerts = createBudgetThresholdAlerts({ redis, alerts: usageOpsAlerts });
  const creditBalance =
    runtime.creditBalance ??
    (runtime.flexprice === undefined
      ? undefined
      : createCachedCreditBalanceGate({
          wallets: createFlexpriceWalletClient(runtime.flexprice),
          redis,
          activeRuns: {
            list: (organizationId, limit) =>
              tenantDb(organizationId).runs.listActiveRunIds(limit),
          },
          reservations: createDatabaseActiveReservationSource(database),
          graceFloorCredits:
            runtime.pricing.walletBalanceGraceFloor ??
            (() => {
              throw new Error('pricing walletBalanceGraceFloor is required with Flexprice enabled');
            })(),
          alerts: usageOpsAlerts,
        }));
  const githubStateStore =
    runtime.github === undefined ? undefined : createRedisGitHubAuthorizationStateStore(redis);
  const githubProvider =
    runtime.github === undefined
      ? undefined
      : createGitHubProvider({
          appId: runtime.github.appId,
          clientId: runtime.github.clientId,
          clientSecret: runtime.github.clientSecret,
          privateKey: runtime.github.privateKey,
          ...(runtime.github.apiBaseUrl === undefined
            ? {}
            : { baseUrl: runtime.github.apiBaseUrl }),
        });
  const githubIntegration =
    githubStateStore === undefined || githubProvider === undefined
      ? undefined
      : createGitHubIntegrationPort({
          tenantDb,
          provider: githubProvider,
          stateStore: githubStateStore,
        });
  const supabaseIntegration = createSupabaseIntegrationPort({
    database,
    masterKey: runtime.masterKey,
    management: createSupabaseManagementClient(),
  });
  const neonIntegration = createNeonIntegrationPort({
    database,
    masterKey: runtime.masterKey,
    management: createNeonProjectManagementPort({
      management: createNeonManagementClient(),
      sql: createNeonSqlFactory(),
    }),
  });
  const stripeIntegration = createGeneratedAppStripeIntegrationPort({
    database,
    masterKey: runtime.masterKey,
    accounts: createStripeAccountClient(),
  });
  const integrationPort: IntegrationPort = {
    connect: (request) => {
      if (request.provider === 'supabase') return supabaseIntegration.connect(request);
      if (request.provider === 'neon') return neonIntegration.connect(request);
      if (request.provider === 'stripe') return stripeIntegration.connect(request);
      if (githubIntegration !== undefined) {
        return githubIntegration.connect(request);
      }
      return Promise.reject(new Error('integration service unavailable'));
    },
  };

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
      organizations,
      invites: createRedisInviteStore(redis),
      // The real `audit_events` writer: every mutating route's row lands in the
      // same transaction as the mutation (CP-5).
      audit: createDbAuditSink(database),
    },
    // Not optional in a deployment, and `buildApp` says so: without it the
    // tenant plugin is unregistered and every tenant-scoped route is simply
    // absent.
    tenant: {
      tenantDb,
      integrationPort,
      runIntentHmacKey: runtime.runIntentHmacKey,
      pricing: runtime.pricing,
      ...(runtime.planLimits === undefined ? {} : { planLimits: runtime.planLimits }),
      ...(creditBalance === undefined ? {} : { creditBalance }),
      deploymentUsage: createDeploymentUsageCollector({
        ledger: usageLedger,
        pricing: runtime.pricing,
      }),
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
      capabilityScan: createTemporalCapabilityScanPort(runtime.temporal),
      ...(runtime.orchestrator === undefined ? {} : { orchestrator: runtime.orchestrator }),
      attachmentStorage: createS3AttachmentStorage(runtime.artifactStorage),
      ...(previewRuntime === undefined
        ? {}
        : {
            builderPreviewSandbox: createBuilderPreviewSandboxClient({
              baseUrl: previewRuntime.config.sandboxServiceUrl,
              serviceTokens: runtime.serviceTokens,
            }),
            builderPreviewProxy: previewRuntime.proxy,
            builderPreviewScreenshotStore: createS3BuilderPreviewScreenshotStore(
              runtime.artifactStorage,
            ),
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
    modelCompletions: createModelCompletionRepository({
      database,
      mirror: createRedisCreditMirror(redis),
      budgetAlerts,
    }),
    usageLedger,
    localAgent: {
      sessions: createLocalAgentSessionRepository({
        database,
        pricing: runtime.pricing,
        ...(runtime.planLimits === undefined ? {} : { plans: runtime.planLimits }),
      }),
      gateway: createModelGatewayLocalAgentClient({
        baseUrl: runtime.modelGatewayUrl,
        serviceTokens: runtime.serviceTokens,
      }),
      ...(creditBalance === undefined ? {} : { creditBalance }),
    },
    ...(runtime.github === undefined ||
    githubStateStore === undefined ||
    githubProvider === undefined
      ? {}
      : {
          github: {
            appSlug: runtime.github.appSlug,
            stateStore: githubStateStore,
            provider: githubProvider,
          },
          githubWebhook: {
            secret: runtime.github.webhookSecret,
            store: createDbGitHubWebhookStore(database),
          },
        }),
    ...(previewRuntime === undefined
      ? {}
      : {
          preview: {
            shares: createDbPreviewShareStore(database),
            sessions: createRedisPreviewSessionStore(
              runtime.previewRedis ??
                (() => {
                  throw new Error('preview Redis publisher missing');
                })(),
            ),
            revocations: createRedisPreviewRevocationSource(
              runtime.previewRedis ??
                (() => {
                  throw new Error('preview Redis subscriber missing');
                })(),
            ),
            proxy: previewRuntime.proxy,
            signingKey: previewRuntime.config.signingKey,
            keyVersion: previewRuntime.config.keyVersion,
            appBaseUrl: new URL(runtime.auth.config.appBaseUrl),
            previewBaseDomain: previewRuntime.config.previewBaseDomain,
          },
        }),
  });
}
