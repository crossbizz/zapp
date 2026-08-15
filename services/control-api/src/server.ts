import { randomUUID } from 'node:crypto';

import { createDb } from '@zapp/db';
import { loadTemplateRegistryFile } from '@zapp/config';
import { Client, Connection } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry';

import { loadAuthEnv } from './auth/config.js';
import { composeApp, composeRunOrchestrator } from './compose.js';
import { loadRateLimitSettings } from './config/rate-limits.js';
import {
  loadEnv,
  loadArtifactStorageEnv,
  loadFlexpriceEnv,
  requireFlexpriceForEnvironment,
  loadOptionalGitHubAppEnv,
  loadGitHubImportQueueEnv,
  loadGitHubWebhookQueueEnv,
  loadMasterKey,
  loadModelGatewayUrl,
  loadNotificationEnv,
  loadPostHogEnv,
  loadIncidentWebhookSecret,
  loadRedisUrl,
  loadRunIntentHmacKey,
  loadReleaseServiceUrl,
  loadPreviewEnv,
  loadServiceTokenConfig,
  loadStripeBillingEnv,
  requireStripeBillingForEnvironment,
  loadUsageQueueEnv,
  loadTemporalEnv,
  loadVerificationServiceUrl,
} from './env.js';
import { createEventPublisherLifecycle } from './events/lifecycle.js';
import { createEventPublisher } from './events/publisher.js';
import { loadGitServiceUrl, resolveGitService } from './git/client.js';
import { loggerOptions } from './logging.js';
import {
  createAgentEventArchiveJob,
  createAgentEventArchiveLifecycle,
  createPostgresAgentEventArchiveDatabase,
  createS3AgentEventArchiveObjectStore,
  createDatabaseSnapshotRetentionAuditPort,
} from './jobs/archive.js';
import {
  createArtifactRetentionJob,
  createArtifactRetentionLifecycle,
  createDatabaseArtifactRetention,
  createS3ArtifactRetentionObjectStore,
} from './jobs/retention.js';
import {
  createDatabaseDeletionStore,
  createGitProjectDeletionTarget,
  createPostgresProjectDeletionTarget,
  createProjectDeletionJob,
  createProjectDeletionLifecycle,
  createS3ProjectDeletionTarget,
  createSandboxSnapshotDeletionTarget,
} from './jobs/deletion.js';
import { createRedisConnection } from './redis/client.js';
import { loadSupportAdminConfig } from './routes/admin.js';
import { bootstrapControlApiServer } from './server-bootstrap.js';
import { loadPricingFile } from './usage/pricing.js';
import {
  createCachedCreditBalanceGate,
  createDatabaseActiveReservationSource,
  createFlexpriceWalletClient,
  loadPlanLimitsFile,
  type UsageOpsAlertPort,
} from './usage/limits.js';
import {
  createFlexpriceIngestClient,
  createDatabaseUsageOutboxDeliveryPort,
  createRedisUsageLedgerCounter,
  createSqsUsageQueue,
  createUsageEventConsumer,
  createUsageEventConsumerLifecycle,
  createUsageOutboxPublisher,
  createUsageOutboxPublisherLifecycle,
} from './usage/outbox.js';
import {
  createAccountingReconciler,
  createAccountingReconcilerLifecycle,
  createDatabaseUsageReconciliationSource,
  createDatabaseUsageCorrectionJournal,
  createDatabaseUsageReconciliationCoordinator,
  createCoordinatedUsageReconciliationJob,
  createFlexpriceUsageAggregateClient,
  createRedisCreditMirror,
  createCreditBalanceExhaustionProducer,
  createCreditBalanceExhaustionLifecycle,
  createDatabaseCreditExhaustionStore,
  createRedisUsageRunCounter,
  createThreeWayUsageReconciler,
  createUsageReconciliationLifecycle,
} from './usage/reconciliation.js';
import {
  createGitHubWebhookPublisher,
  createGitHubWebhookPublisherLifecycle,
  createSqsGitHubWebhookQueue,
} from './integrations/github/queue.js';
import { createDbGitHubWebhookStore } from './integrations/github/store.js';
import { createGitHubProvider } from './integrations/github/app.js';
import {
  createGitHubImportConsumerLifecycle,
  createGitHubImportPublisher,
  createGitHubImportPublisherLifecycle,
  createGitHubImportWorker,
  createSqsGitHubImportQueue,
} from './integrations/github/import-queue.js';
import { createDbGitHubImportWorkerStore } from './integrations/github/import-store.js';
import { createTenantDbFactory } from './tenant/db.js';
import { createTemporalCapabilityScanPort } from './orchestrator/capability-scan.js';
import { createSandboxStorageMeasurementClient } from './sandbox/client.js';
import { createUsageLedgerRepository } from './usage/ledger.js';
import {
  createDailyStorageCollector,
  createDailyStorageCollectorLifecycle,
  createDatabaseDailyStorageClaim,
  createDatabaseMeteredProjectPort,
  createR2ArtifactStorageMeasurement,
} from './usage/collectors/storage.js';
import {
  createDatabaseNotificationDirectory,
  createNotificationProducer,
  createNotificationWorker,
  createNotificationWorkerLifecycle,
  createRedisNotificationProjection,
  createRedisNotificationState,
  usageAlertNotification,
} from './notifications/service.js';
import {
  createSesEmailSender,
  createSnsNotificationFanout,
  createSqsNotificationQueue,
} from './notifications/email.js';

/**
 * The listen entrypoint, and nothing else: read the environment, open the
 * handles, hand them to {@link composeApp}, serve. Every wiring decision lives
 * in `compose.ts`, where a test can assert it.
 */

const env = loadEnv();
// Fails fast and by name: a control plane that cannot verify a session, does
// not know which database it owns, cannot reach the store holding its revoked
// sessions, or has no limits configured must not accept the first request.
const auth = loadAuthEnv();
const redisUrl = loadRedisUrl();
const rateLimits = loadRateLimitSettings();
// And cannot open its own vault. A service that came up without the master key
// would serve every secrets route as a 500 at the first write, which is a worse
// way to learn the key is missing than not starting.
const masterKey = loadMasterKey();
// And cannot tell one of its own services from anybody else. `/internal/*` is
// the surface with no user-facing form at all, so a deployment that cannot
// verify a service token must not come up serving it (CP-8).
const serviceTokens = loadServiceTokenConfig();
// Durable run retries compare this keyed digest across replicas. Missing or
// malformed means refusal to boot; a process-local production key would strand
// every retry that reached another instance.
const runIntentHmacKey = loadRunIntentHmacKey();
const preview = loadPreviewEnv();
const modelGatewayUrl = loadModelGatewayUrl();
// Where projects' repositories are actually created (plan 06 GIT-2). Undefined
// is allowed here and refused by `composeApp` outside development — the decision
// belongs next to the binding, where a test can assert it.
const gitServiceUrl = loadGitServiceUrl();
const verificationServiceUrl = loadVerificationServiceUrl();
const releaseServiceUrl = loadReleaseServiceUrl();
const pricing = await loadPricingFile(new URL('../../../config/pricing.json', import.meta.url));
const planLimits = await loadPlanLimitsFile(new URL('../../../config/plans.json', import.meta.url));
const templates = await loadTemplateRegistryFile(
  new URL('../../../config/templates.json', import.meta.url),
);
const usageQueueConfig = loadUsageQueueEnv();
const notificationConfig = loadNotificationEnv();
const flexpriceConfig = requireFlexpriceForEnvironment(env, loadFlexpriceEnv());
const stripeBillingConfig = requireStripeBillingForEnvironment(env, loadStripeBillingEnv());
const temporalEnv = loadTemporalEnv();
const artifactStorage = loadArtifactStorageEnv();
const github = loadOptionalGitHubAppEnv(env);
const posthog = loadPostHogEnv();
const incidentWebhookSecret = loadIncidentWebhookSecret(process.env, env.NODE_ENV);
const admin = loadSupportAdminConfig();

const database = createDb(auth.databaseUrl);
// The app does not exist yet, and a connection error can arrive at any time
// after this line. Routed through a mutable sink so it reaches the same logger
// as everything else rather than a bare `console`.
let logRedisError: (error: Error) => void = () => {};
const redis = createRedisConnection(redisUrl, {
  onError: (error) => {
    logRedisError(error);
  },
});
const temporalConnection = await Connection.connect({ address: temporalEnv.address });
const temporal = new Client({
  connection: temporalConnection,
  namespace: temporalEnv.namespace,
  interceptors: { workflow: [new OpenTelemetryWorkflowClientInterceptor()] },
});
const notificationQueue = createSqsNotificationQueue(notificationConfig);
const notificationState = createRedisNotificationState(redis);
const notificationProducer = createNotificationProducer({ queue: notificationQueue });
const notificationEmail = createSesEmailSender(notificationConfig);
const notificationFanout = createSnsNotificationFanout(notificationConfig);
const notificationWorker = createNotificationWorker({
  queue: notificationQueue,
  state: notificationState,
  directory: createDatabaseNotificationDirectory(database.db),
  email: notificationEmail,
  projections: createRedisNotificationProjection(redis, notificationState),
  fanout: notificationFanout,
  webBaseUrl: new URL(auth.config.appBaseUrl),
});
const usageOpsAlerts: UsageOpsAlertPort = {
  async emit(alert) {
    if (alert.type === 'run_budget_threshold') {
      await notificationProducer.enqueue(
        usageAlertNotification({
          organizationId: alert.organizationId,
          runId: alert.runId,
          threshold: alert.threshold,
          occurredAt: new Date().toISOString(),
        }),
      );
      return;
    }
    process.emitWarning(`usage ops alert: ${alert.type} for organization ${alert.organizationId}`);
  },
};
const tenantDb = createTenantDbFactory(database.db);
const creditBalance =
  flexpriceConfig === undefined
    ? undefined
    : createCachedCreditBalanceGate({
        wallets: createFlexpriceWalletClient(flexpriceConfig),
        redis,
        activeRuns: {
          list: (organizationId, limit) => tenantDb(organizationId).runs.listActiveRunIds(limit),
        },
        reservations: createDatabaseActiveReservationSource(database.db),
        graceFloorCredits: pricing.walletBalanceGraceFloor ?? '0.0000',
        alerts: usageOpsAlerts,
      });
const runOrchestrator = composeRunOrchestrator({
  temporal,
  nodeEnv: env.NODE_ENV,
  workflowProfile: env.RUN_WORKFLOW_PROFILE,
});
const app = composeApp({
  logger: loggerOptions({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' }),
  database: database.db,
  redis,
  previewRedis: redis,
  eventWakeups: redis,
  runIntentHmacKey,
  auth,
  masterKey,
  serviceTokens,
  modelGatewayUrl,
  preview,
  ...(gitServiceUrl === undefined ? {} : { gitServiceUrl }),
  ...(verificationServiceUrl === undefined ? {} : { verificationServiceUrl }),
  ...(releaseServiceUrl === undefined ? {} : { releaseServiceUrl }),
  rateLimits,
  pricing,
  planLimits,
  templates,
  nodeEnv: env.NODE_ENV,
  runWorkflowProfile: env.RUN_WORKFLOW_PROFILE,
  sandboxProvider: env.SANDBOX_PROVIDER,
  orchestrator: runOrchestrator,
  ...(flexpriceConfig === undefined ? {} : { flexprice: flexpriceConfig }),
  ...(stripeBillingConfig === undefined ? {} : { billing: stripeBillingConfig }),
  ...(creditBalance === undefined ? {} : { creditBalance }),
  usageOpsAlerts,
  temporal,
  artifactStorage,
  ...(github === undefined ? {} : { github }),
  posthog,
  ...(incidentWebhookSecret === undefined ? {} : { incidentWebhookSecret }),
  admin,
  notifications: {
    state: notificationState,
    enqueue: (trigger) => notificationProducer.enqueue(trigger),
  },
});

app.addHook('onClose', async () => {
  await temporalConnection.close();
});

logRedisError = (error) => {
  // Not fatal: the rate limiter fails open for reads and closed for auth by
  // configuration, and the session layer reports its own failures per request.
  app.log.error({ err: error }, 'redis connection error');
};

const eventPublisher = createEventPublisher(
  {
    async listen(channel, onNotification) {
      return await database.sql.listen(channel, onNotification);
    },
    async readLatestSequence(runId) {
      const [row] = await database.sql<{ sequence: string }[]>`
        select sequence::text as sequence
          from agent_events
         where run_id = ${runId}
         order by sequence desc
         limit 1
      `;
      return row;
    },
    async publish(channel, body) {
      await redis.publish(channel, body);
    },
  },
  {
    onError: (error) => {
      app.log.error({ err: error }, 'event publisher error');
    },
  },
);

const eventPublisherLifecycle = createEventPublisherLifecycle({
  publisher: eventPublisher,
  listen: async () => {
    await app.listen({ host: env.HOST, port: env.PORT });
  },
  database,
  redis,
});
const archiveLifecycle = createAgentEventArchiveLifecycle({
  job: createAgentEventArchiveJob({
    database: createPostgresAgentEventArchiveDatabase({
      async query(statement) {
        return await database.sql.unsafe(statement);
      },
    }),
    objectStore: createS3AgentEventArchiveObjectStore(artifactStorage),
    snapshots: createDatabaseSnapshotRetentionAuditPort(database.db),
  }),
  onError: (error) => {
    app.log.error({ err: error }, 'agent event archival failed');
  },
  onSnapshotViolations: (violations) => {
    app.log.error(
      { snapshotIds: violations.map((violation) => violation.snapshotId) },
      'sandbox snapshot retention policy violation',
    );
  },
});
const retentionLifecycle = createArtifactRetentionLifecycle({
  job: createArtifactRetentionJob({
    database: createDatabaseArtifactRetention(database.db),
    objects: createS3ArtifactRetentionObjectStore(artifactStorage),
  }),
  onError: (error) => {
    app.log.error({ errorName: error.name }, 'artifact retention failed');
  },
});
const deletionLifecycle =
  gitServiceUrl === undefined
    ? undefined
    : createProjectDeletionLifecycle({
        job: createProjectDeletionJob({
          store: createDatabaseDeletionStore(database.db),
          workerId: `control-api-${randomUUID()}`,
          snapshots: createSandboxSnapshotDeletionTarget({
            baseUrl: preview.sandboxServiceUrl,
            serviceTokens,
          }),
          git: createGitProjectDeletionTarget({ baseUrl: gitServiceUrl, serviceTokens }),
          objects: createS3ProjectDeletionTarget(artifactStorage),
          postgres: createPostgresProjectDeletionTarget(database.db),
        }),
        onError: (error) => {
          app.log.error({ errorName: error.name }, 'project deletion failed');
        },
      });
const usageQueue = createSqsUsageQueue(usageQueueConfig);
const usageCounter = createRedisUsageLedgerCounter(redis);
const storageLedger = createUsageLedgerRepository({ database: database.db });
const dailyStorageLifecycle = createDailyStorageCollectorLifecycle({
  collector: createDailyStorageCollector({
    projects: createDatabaseMeteredProjectPort(database.db),
    artifactStorage: createR2ArtifactStorageMeasurement(artifactStorage),
    sandboxStorage: createSandboxStorageMeasurementClient({
      baseUrl: preview.sandboxServiceUrl,
      serviceTokens,
    }),
    claims: createDatabaseDailyStorageClaim({
      database: database.db,
      owner: `control-api-${randomUUID()}`,
    }),
    ledger: storageLedger,
    pricing,
  }),
  onError: (error) => {
    app.log.error({ err: error }, 'daily storage metering failed');
  },
});
const usagePublisherLifecycle = createUsageOutboxPublisherLifecycle({
  publisher: createUsageOutboxPublisher({
    database: database.db,
    queue: usageQueue,
    counter: usageCounter,
    onError: (error) => {
      app.log.error({ err: error }, 'usage outbox publish failed');
    },
  }),
  batchSize: 100,
  intervalMs: 1_000,
  onError: (error) => {
    app.log.error({ err: error }, 'usage outbox poll failed');
  },
});
const usageConsumerLifecycle =
  flexpriceConfig === undefined
    ? undefined
    : createUsageEventConsumerLifecycle({
        queue: usageQueue,
        consumer: createUsageEventConsumer(
          createFlexpriceIngestClient(flexpriceConfig),
          createDatabaseUsageOutboxDeliveryPort(database.db),
        ),
        batchSize: 10,
        waitTimeSeconds: 10,
        visibilityTimeoutSeconds: 30,
        intervalMs: 1_000,
        onError: (error) => {
          app.log.error({ err: error }, 'Flexprice usage ingestion failed');
        },
      });
const accountingReconcilerLifecycle = createAccountingReconcilerLifecycle({
  reconciler: createAccountingReconciler({
    database: database.db,
    mirror: createRedisCreditMirror(redis),
    owner: `control-api-${randomUUID()}`,
  }),
  batchSize: 100,
  intervalMs: 30_000,
  onError: (error) => {
    app.log.error({ err: error }, 'run credit reconciliation failed');
  },
});
const creditExhaustionProducer =
  creditBalance === undefined
    ? undefined
    : createCreditBalanceExhaustionProducer({
        store: createDatabaseCreditExhaustionStore({
          database: database.db,
          owner: `control-api-${randomUUID()}`,
          leaseMs: 120_000,
        }),
        creditBalance,
        orchestrator: runOrchestrator,
        organizationBatchSize: 1,
        batchSize: 100,
        signalConcurrency: 8,
        signalTimeoutMs: 3_000,
      });
const creditExhaustionLifecycle =
  creditExhaustionProducer === undefined
    ? undefined
    : createCreditBalanceExhaustionLifecycle({
        producer: creditExhaustionProducer,
        intervalMs: 30_000,
        onError: (error) => {
          app.log.error({ err: error }, 'credit exhaustion signal poll failed');
        },
      });
const usageReconciliationLifecycle =
  flexpriceConfig === undefined
    ? undefined
    : (() => {
        const source = createDatabaseUsageReconciliationSource(database.db);
        const ingest = createFlexpriceIngestClient(flexpriceConfig);
        const reconciler = createThreeWayUsageReconciler({
          scopes: source.scopes,
          ledger: source.ledger,
          redis: createRedisUsageRunCounter(redis),
          flexprice: createFlexpriceUsageAggregateClient(flexpriceConfig),
          corrections: createDatabaseUsageCorrectionJournal({
            database: database.db,
            ingest,
          }),
          alerts: {
            driftDetected(input) {
              app.log.error({ usageDrift: input }, 'usage reconciliation drift detected');
              return Promise.resolve();
            },
            driftHealed(input) {
              app.log.info({ usageDrift: input }, 'usage reconciliation drift healed');
              return Promise.resolve();
            },
          },
        });
        return createUsageReconciliationLifecycle({
          reconciler: createCoordinatedUsageReconciliationJob({
            coordinator: createDatabaseUsageReconciliationCoordinator({
              database: database.db,
              owner: `control-api-${randomUUID()}`,
            }),
            reconciler,
          }),
          onError: (error) => {
            app.log.error({ err: error }, 'three-way usage reconciliation failed');
          },
        });
      })();
const usageOutboxLifecycle = {
  async start() {
    await accountingReconcilerLifecycle.start();
    await creditExhaustionLifecycle?.start();
    await dailyStorageLifecycle.start();
    await usagePublisherLifecycle.start();
    await usageConsumerLifecycle?.start();
    await usageReconciliationLifecycle?.start();
  },
  async close() {
    await usageReconciliationLifecycle?.close();
    await dailyStorageLifecycle.close();
    await usageConsumerLifecycle?.close();
    await usagePublisherLifecycle.close();
    await accountingReconcilerLifecycle.close();
    await creditExhaustionLifecycle?.close();
    usageQueue.close?.();
  },
};
const githubLifecycles =
  github === undefined
    ? undefined
    : (() => {
        const githubQueue = createSqsGitHubWebhookQueue(loadGitHubWebhookQueueEnv());
        const githubPublisherLifecycle = createGitHubWebhookPublisherLifecycle({
          publisher: createGitHubWebhookPublisher({
            store: createDbGitHubWebhookStore(database.db),
            queue: githubQueue,
            onError: (error) => {
              app.log.error({ err: error }, 'GitHub webhook outbox publish failed');
            },
          }),
          batchSize: 100,
          intervalMs: 1_000,
          onError: (error) => {
            app.log.error({ err: error }, 'GitHub webhook outbox poll failed');
          },
        });
        const webhook = {
          start: () => githubPublisherLifecycle.start(),
          async close() {
            await githubPublisherLifecycle.close();
            githubQueue.close?.();
          },
        };
        const githubImportQueue = createSqsGitHubImportQueue(loadGitHubImportQueueEnv());
        const githubImportWorker = createGitHubImportWorker({
          store: createDbGitHubImportWorkerStore({
            database: database.db,
            tenantDb: createTenantDbFactory(database.db),
          }),
          provider: createGitHubProvider({
            appId: github.appId,
            clientId: github.clientId,
            clientSecret: github.clientSecret,
            privateKey: github.privateKey,
            ...(github.apiBaseUrl === undefined ? {} : { baseUrl: github.apiBaseUrl }),
          }),
          git: resolveGitService({ baseUrl: gitServiceUrl, serviceTokens }),
          capabilityScan: createTemporalCapabilityScanPort(temporal),
        });
        const githubImportPublisherLifecycle = createGitHubImportPublisherLifecycle({
          publisher: createGitHubImportPublisher({
            database: database.db,
            queue: githubImportQueue,
            onError: (error) => {
              app.log.error({ errorName: error.name }, 'GitHub import outbox publish failed');
            },
          }),
          batchSize: 100,
          intervalMs: 1_000,
          onError: (error) => {
            app.log.error({ errorName: error.name }, 'GitHub import outbox poll failed');
          },
        });
        const githubImportConsumerLifecycle = createGitHubImportConsumerLifecycle({
          queue: githubImportQueue,
          worker: githubImportWorker,
          batchSize: 10,
          waitTimeSeconds: 10,
          visibilityTimeoutSeconds: 180,
          intervalMs: 1_000,
          onError: (error) => {
            app.log.error({ errorName: error.name }, 'GitHub import delivery failed');
          },
        });
        const imports = {
          async start() {
            await githubImportPublisherLifecycle.start();
            await githubImportConsumerLifecycle.start();
          },
          async close() {
            await githubImportConsumerLifecycle.close();
            await githubImportPublisherLifecycle.close();
            githubImportQueue.close?.();
          },
        };
        return { webhook, imports };
      })();
const notificationWorkerLifecycle = createNotificationWorkerLifecycle({
  worker: notificationWorker,
  onError: (error) => {
    app.log.error({ errorName: error.name }, 'notification delivery failed');
  },
});
const notificationLifecycle = {
  start: () => notificationWorkerLifecycle.start(),
  async close() {
    await notificationWorkerLifecycle.close();
    notificationQueue.close?.();
    notificationEmail.close();
    notificationFanout.close();
  },
};

/**
 * `close()` stops accepting connections, drains what is in flight, then runs every
 * `onClose` hook — which is where a plugin releases the handle it opened (the database
 * pool, the Redis client). Teardown therefore stays with whoever created the handle,
 * and this entrypoint does not grow a list.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // `once`: a second signal should kill an already-draining process, not re-enter.
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await bootstrapControlApiServer({
    app,
    eventPublisherLifecycle,
    usageOutboxLifecycle,
    ...(githubLifecycles === undefined
      ? {}
      : {
          githubWebhookLifecycle: githubLifecycles.webhook,
          githubImportLifecycle: githubLifecycles.imports,
        }),
    notificationLifecycle,
    archiveLifecycle,
    retentionLifecycle,
    ...(deletionLifecycle === undefined ? {} : { deletionLifecycle }),
  });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
