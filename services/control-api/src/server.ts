import { randomUUID } from 'node:crypto';

import { createDb } from '@zapp/db';
import { Client, Connection } from '@temporalio/client';

import { loadAuthEnv } from './auth/config.js';
import { composeApp } from './compose.js';
import { loadRateLimitSettings } from './config/rate-limits.js';
import {
  loadEnv,
  loadArtifactStorageEnv,
  loadFlexpriceEnv,
  loadMasterKey,
  loadModelGatewayUrl,
  loadRedisUrl,
  loadRunIntentHmacKey,
  loadPreviewEnv,
  loadServiceTokenConfig,
  loadUsageQueueEnv,
  loadTemporalEnv,
} from './env.js';
import { createEventPublisherLifecycle } from './events/lifecycle.js';
import { createEventPublisher } from './events/publisher.js';
import { loadGitServiceUrl } from './git/client.js';
import { loggerOptions } from './logging.js';
import { createRedisConnection } from './redis/client.js';
import { bootstrapControlApiServer } from './server-bootstrap.js';
import { loadPricingFile } from './usage/pricing.js';
import {
  createFlexpriceIngestClient,
  createSqsUsageQueue,
  createUsageEventConsumer,
  createUsageEventConsumerLifecycle,
  createUsageOutboxPublisher,
  createUsageOutboxPublisherLifecycle,
} from './usage/outbox.js';
import {
  createAccountingReconciler,
  createAccountingReconcilerLifecycle,
  createRedisCreditMirror,
} from './usage/reconciliation.js';

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
const pricing = await loadPricingFile(new URL('../../../config/pricing.json', import.meta.url));
const usageQueueConfig = loadUsageQueueEnv();
const flexpriceConfig = loadFlexpriceEnv();
const temporalEnv = loadTemporalEnv();
const artifactStorage = loadArtifactStorageEnv();

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
  rateLimits,
  pricing,
  temporal,
  artifactStorage,
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
const usageQueue = createSqsUsageQueue(usageQueueConfig);
const usagePublisherLifecycle = createUsageOutboxPublisherLifecycle({
  publisher: createUsageOutboxPublisher({
    database: database.db,
    queue: usageQueue,
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
        consumer: createUsageEventConsumer(createFlexpriceIngestClient(flexpriceConfig)),
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
const usageOutboxLifecycle = {
  async start() {
    await accountingReconcilerLifecycle.start();
    await usagePublisherLifecycle.start();
    await usageConsumerLifecycle?.start();
  },
  async close() {
    await usageConsumerLifecycle?.close();
    await usagePublisherLifecycle.close();
    await accountingReconcilerLifecycle.close();
    usageQueue.close?.();
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
  await bootstrapControlApiServer({ app, eventPublisherLifecycle, usageOutboxLifecycle });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
