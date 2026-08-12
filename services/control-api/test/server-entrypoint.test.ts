import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface LifecycleInput {
  readonly publisher: unknown;
  readonly listen: () => Promise<unknown>;
  readonly database: unknown;
  readonly redis: unknown;
}

interface TemporalClientInput {
  readonly connection: unknown;
  readonly namespace: string;
  readonly interceptors?: {
    readonly workflow?: readonly unknown[];
  };
}

const PLATFORM_STRIPE_SECRET = ['sk', 'test', 'platformbilling'].join('_');
const PLATFORM_STRIPE_WEBHOOK_SECRET = ['whsec', 'platformbilling'].join('_');

const production = vi.hoisted(() => {
  const auth = {
    databaseUrl: 'database-url-from-auth',
    config: { appBaseUrl: 'https://app.zapp.test' },
  };
  const database = {
    db: { kind: 'production-database-client' },
    sql: { listen: vi.fn() },
    close: vi.fn(() => Promise.resolve()),
  };
  const redis = {
    publish: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const temporalEnv = { address: 'temporal.test:7233', namespace: 'zapp-test' };
  const temporalConnection = { close: vi.fn(() => Promise.resolve()) };
  const temporal = { workflow: { kind: 'production-temporal-client' } };
  const app = {
    listen: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    addHook: vi.fn(),
    log: { error: vi.fn(), info: vi.fn() },
  };
  const eventPublisher = { kind: 'production-event-publisher' };
  const eventPublisherLifecycle = {
    start: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const usageQueue = {
    send: vi.fn(() => Promise.resolve()),
    receive: vi.fn(() => Promise.resolve([])),
    delete: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
  };
  const notificationQueue = {
    send: vi.fn(() => Promise.resolve()),
    receive: vi.fn(() => Promise.resolve([])),
    delete: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
  };
  const notificationState = { kind: 'notification-state' };
  const notificationProducer = { enqueue: vi.fn(() => Promise.resolve()) };
  const notificationEmail = { send: vi.fn(), close: vi.fn() };
  const notificationFanout = { publish: vi.fn(), close: vi.fn() };
  const notificationWorker = { processOnce: vi.fn(() => Promise.resolve(0)) };
  const notificationLifecycle = {
    start: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const usageOutboxPublisher = { publishOnce: vi.fn(() => Promise.resolve(0)) };
  const usagePublisherLifecycle = {
    start: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const flexprice = { ingest: vi.fn(() => Promise.resolve()) };
  const usageConsumer = { consume: vi.fn(() => Promise.resolve()) };
  const usageConsumerLifecycle = {
    start: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const accountingReconciler = {
    runOnce: vi.fn(() => Promise.resolve({ acquired: true, mirrored: 0 })),
  };
  const accountingReconcilerLifecycle = {
    start: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const creditExhaustionLifecycle = {
    start: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const usageReconciliationSource = {
    scopes: { kind: 'usage-reconciliation-scopes' },
    ledger: { kind: 'usage-reconciliation-ledger' },
  };
  const usageRunCounter = { kind: 'usage-run-counter' };
  const flexpriceUsageAggregate = { kind: 'flexprice-usage-aggregate' };
  const threeWayUsageReconciler = { kind: 'three-way-usage-reconciler' };
  const usageReconciliationLifecycle = {
    start: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const usageCounter = { kind: 'usage-ledger-counter' };
  const usageDelivery = { kind: 'usage-delivery' };
  const usageCorrections = { kind: 'usage-corrections' };
  const usageCoordinator = { kind: 'usage-coordinator' };
  const coordinatedReconciler = { kind: 'coordinated-reconciler' };
  const storageLedger = { kind: 'storage-ledger' };
  const dailyStorageCollector = {
    collect: vi.fn(() => Promise.resolve({ projects: 0, recorded: 0 })),
  };
  const dailyStorageLifecycle = {
    start: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const preview = {
    signingKey: Buffer.alloc(32, 0x44),
    keyVersion: 1,
    previewBaseDomain: 'preview.zapp.test',
    sandboxServiceUrl: 'https://sandbox.internal',
  };
  const artifactStorage = {
    endpoint: 'http://minio.test:9000',
    region: 'us-east-1',
    bucket: 'zapp-artifacts',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
  };
  const github = {
    appId: 'github-app-id',
    appSlug: 'zapp-test',
    privateKey: 'not-a-real-private-key',
    clientId: 'github-client-id',
    clientSecret: 'github-client-secret',
    webhookSecret: 'github-webhook-secret',
  };
  const githubWebhookQueue = { send: vi.fn(() => Promise.resolve()), close: vi.fn() };
  const githubWebhookPublisher = { publishOnce: vi.fn(() => Promise.resolve(0)) };
  const githubWebhookLifecycle = {
    start: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const githubImportQueue = {
    send: vi.fn(() => Promise.resolve()),
    receive: vi.fn(() => Promise.resolve([])),
    changeVisibility: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
  };
  const githubImportPublisher = { publishOnce: vi.fn(() => Promise.resolve(0)) };
  const githubImportPublisherLifecycle = {
    start: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const githubImportConsumerLifecycle = {
    start: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const githubImportWorker = { process: vi.fn(), settleDeadLetter: vi.fn() };
  const githubProvider = { kind: 'github-provider' };
  const githubImportStore = { kind: 'github-import-store' };
  const tenantDb = { kind: 'tenant-db' };
  const capabilityScan = { kind: 'capability-scan' };
  const gitService = { kind: 'git-service' };

  return {
    app,
    auth,
    database,
    eventPublisher,
    eventPublisherLifecycle,
    flexprice,
    accountingReconciler,
    accountingReconcilerLifecycle,
    usageReconciliationSource,
    usageRunCounter,
    flexpriceUsageAggregate,
    threeWayUsageReconciler,
    usageReconciliationLifecycle,
    usageCounter,
    usageDelivery,
    usageCorrections,
    usageCoordinator,
    coordinatedReconciler,
    storageLedger,
    dailyStorageCollector,
    dailyStorageLifecycle,
    preview,
    artifactStorage,
    github,
    githubWebhookQueue,
    githubWebhookPublisher,
    githubWebhookLifecycle,
    githubImportQueue,
    githubImportPublisher,
    githubImportPublisherLifecycle,
    githubImportConsumerLifecycle,
    githubImportWorker,
    githubProvider,
    githubImportStore,
    tenantDb,
    capabilityScan,
    gitService,
    redis,
    temporal,
    temporalConnection,
    temporalEnv,
    usageConsumer,
    usageConsumerLifecycle,
    usageOutboxPublisher,
    usagePublisherLifecycle,
    usageQueue,
    notificationQueue,
    notificationState,
    notificationProducer,
    notificationEmail,
    notificationFanout,
    notificationWorker,
    notificationLifecycle,
    bootstrapControlApiServer: vi
      .fn<(input: unknown) => Promise<void>>()
      .mockResolvedValue(undefined),
    composeApp: vi.fn<(input: unknown) => typeof app>().mockReturnValue(app),
    createDb: vi.fn<(url: string) => typeof database>().mockReturnValue(database),
    createEventPublisher: vi
      .fn<(dependencies: unknown, options: unknown) => typeof eventPublisher>()
      .mockReturnValue(eventPublisher),
    createEventPublisherLifecycle: vi
      .fn<(input: LifecycleInput) => typeof eventPublisherLifecycle>()
      .mockReturnValue(eventPublisherLifecycle),
    createRedisConnection: vi
      .fn<(url: string, options: unknown) => typeof redis>()
      .mockReturnValue(redis),
    connectTemporal: vi.fn(() => Promise.resolve(temporalConnection)),
    TemporalClient: vi.fn(function TemporalClient(options: TemporalClientInput) {
      void options;
      return temporal;
    }),
    createSqsUsageQueue: vi.fn(() => usageQueue),
    createSqsNotificationQueue: vi.fn(() => notificationQueue),
    createSesEmailSender: vi.fn(() => notificationEmail),
    createSnsNotificationFanout: vi.fn(() => notificationFanout),
    createRedisNotificationState: vi.fn(() => notificationState),
    createNotificationProducer: vi.fn(() => notificationProducer),
    createDatabaseNotificationDirectory: vi.fn(() => ({ kind: 'notification-directory' })),
    createRedisNotificationProjection: vi.fn(() => ({ kind: 'notification-projection' })),
    createNotificationWorker: vi.fn(() => notificationWorker),
    createNotificationWorkerLifecycle: vi.fn(() => notificationLifecycle),
    usageAlertNotification: vi.fn((input: unknown) => input),
    createFlexpriceIngestClient: vi.fn(() => flexprice),
    createUsageEventConsumer: vi.fn(() => usageConsumer),
    createUsageEventConsumerLifecycle: vi.fn(() => usageConsumerLifecycle),
    createUsageOutboxPublisher: vi.fn(() => usageOutboxPublisher),
    createUsageOutboxPublisherLifecycle: vi.fn(() => usagePublisherLifecycle),
    createRedisUsageLedgerCounter: vi.fn(() => usageCounter),
    createDatabaseUsageOutboxDeliveryPort: vi.fn(() => usageDelivery),
    createAccountingReconciler: vi.fn(() => accountingReconciler),
    createAccountingReconcilerLifecycle: vi.fn(() => accountingReconcilerLifecycle),
    createRedisCreditMirror: vi.fn(() => ({ kind: 'credit-mirror' })),
    createDatabaseUsageReconciliationSource: vi.fn(() => usageReconciliationSource),
    createRedisUsageRunCounter: vi.fn(() => usageRunCounter),
    createFlexpriceUsageAggregateClient: vi.fn(() => flexpriceUsageAggregate),
    createThreeWayUsageReconciler: vi.fn(() => threeWayUsageReconciler),
    createUsageReconciliationLifecycle: vi.fn(() => usageReconciliationLifecycle),
    createCreditBalanceExhaustionProducer: vi.fn(() => ({
      runOnce: vi.fn(() => Promise.resolve()),
    })),
    createCreditBalanceExhaustionLifecycle: vi.fn(() => creditExhaustionLifecycle),
    createDatabaseCreditExhaustionStore: vi.fn(() => ({ kind: 'credit-exhaustion-store' })),
    createDatabaseUsageCorrectionJournal: vi.fn(() => usageCorrections),
    createDatabaseUsageReconciliationCoordinator: vi.fn(() => usageCoordinator),
    createCoordinatedUsageReconciliationJob: vi.fn(() => coordinatedReconciler),
    createUsageLedgerRepository: vi.fn(() => storageLedger),
    createDailyStorageCollector: vi.fn(() => dailyStorageCollector),
    createDailyStorageCollectorLifecycle: vi.fn(() => dailyStorageLifecycle),
    createDatabaseDailyStorageClaim: vi.fn(() => ({ kind: 'storage-claim' })),
    createDatabaseMeteredProjectPort: vi.fn(() => ({ kind: 'metered-projects' })),
    createR2ArtifactStorageMeasurement: vi.fn(() => ({ kind: 'r2-measurement' })),
    createSandboxStorageMeasurementClient: vi.fn(() => ({ kind: 'sandbox-measurement' })),
    createGitHubProvider: vi.fn(() => githubProvider),
    createDbGitHubWebhookStore: vi.fn(() => ({ kind: 'github-webhook-store' })),
    createSqsGitHubWebhookQueue: vi.fn(() => githubWebhookQueue),
    createGitHubWebhookPublisher: vi.fn(() => githubWebhookPublisher),
    createGitHubWebhookPublisherLifecycle: vi.fn(() => githubWebhookLifecycle),
    createSqsGitHubImportQueue: vi.fn(() => githubImportQueue),
    createGitHubImportPublisher: vi.fn(() => githubImportPublisher),
    createGitHubImportPublisherLifecycle: vi.fn(() => githubImportPublisherLifecycle),
    createGitHubImportConsumerLifecycle: vi.fn(() => githubImportConsumerLifecycle),
    createGitHubImportWorker: vi.fn(() => githubImportWorker),
    createDbGitHubImportWorkerStore: vi.fn(() => githubImportStore),
    createTenantDbFactory: vi.fn(() => tenantDb),
    createTemporalCapabilityScanPort: vi.fn(() => capabilityScan),
    resolveGitService: vi.fn(() => gitService),
    loadAuthEnv: vi.fn(() => auth),
    loadArtifactStorageEnv: vi.fn(() => artifactStorage),
    loadEnv: vi.fn(() => ({
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      PORT: 4_321,
    })),
    loadGitServiceUrl: vi.fn(() => undefined),
    loadGitHubAppEnv: vi.fn(() => github),
    loadGitHubWebhookQueueEnv: vi.fn(() => ({
      region: 'us-east-1',
      queueName: 'zapp-github-webhooks',
    })),
    loadGitHubImportQueueEnv: vi.fn(() => ({
      region: 'us-east-1',
      queueName: 'zapp-github-imports',
      deadLetterQueueName: 'zapp-github-imports-dlq',
    })),
    loadPostHogEnv: vi.fn(() => undefined),
    loadIncidentWebhookSecret: vi.fn(() => undefined),
    loadFlexpriceEnv: vi.fn(() => ({
      apiKey: 'not-a-real-flexprice-key',
      baseUrl: 'https://api.cloud.flexprice.io/v1',
    })),
    requireFlexpriceForEnvironment: vi.fn((_environment: unknown, flexprice: unknown) => flexprice),
    loadStripeBillingEnv: vi.fn(() => ({
      platformSecretKey: PLATFORM_STRIPE_SECRET,
      webhookSecret: PLATFORM_STRIPE_WEBHOOK_SECRET,
      prices: { builder: 'price_builder123', studio: 'price_studio123' },
      flexpriceStripeWebhookUrl:
        'https://api.cloud.flexprice.io/v1/webhooks/stripe/tenant/environment',
    })),
    requireStripeBillingForEnvironment: vi.fn((_environment: unknown, billing: unknown) => billing),
    loadMasterKey: vi.fn(() => ({ kind: 'production-master-key' })),
    loadModelGatewayUrl: vi.fn(() => 'http://model-gateway.test:4100'),
    loadPreviewEnv: vi.fn(() => preview),
    loadRateLimitSettings: vi.fn(() => ({ kind: 'production-rate-limits' })),
    loadRedisUrl: vi.fn(() => 'redis-url-from-env'),
    loadRunIntentHmacKey: vi.fn(() => Buffer.alloc(32, 0x33)),
    loadServiceTokenConfig: vi.fn(() => ({ kind: 'production-service-tokens' })),
    loadTemporalEnv: vi.fn(() => temporalEnv),
    loadUsageQueueEnv: vi.fn(() => ({
      region: 'us-east-1',
      endpoint: 'http://localstack.test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      queueName: 'zapp-usage-events',
    })),
    loadNotificationEnv: vi.fn(() => ({
      region: 'us-east-1',
      endpoint: 'http://localstack.test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      queueName: 'zapp-notifications',
      source: 'dev@zapp.local',
      topicArn: 'arn:aws:sns:us-east-1:000000000000:zapp-notifications',
    })),
    loggerOptions: vi
      .fn<(input: unknown) => { level: string }>()
      .mockReturnValue({ level: 'silent' }),
  };
});

vi.mock('@zapp/db', () => ({ createDb: production.createDb }));
vi.mock('@temporalio/client', () => ({
  Client: production.TemporalClient,
  Connection: { connect: production.connectTemporal },
}));
vi.mock('../src/auth/config.js', () => ({ loadAuthEnv: production.loadAuthEnv }));
vi.mock('../src/compose.js', () => ({ composeApp: production.composeApp }));
vi.mock('../src/config/rate-limits.js', () => ({
  loadRateLimitSettings: production.loadRateLimitSettings,
}));
vi.mock('../src/env.js', () => ({
  loadArtifactStorageEnv: production.loadArtifactStorageEnv,
  loadEnv: production.loadEnv,
  loadFlexpriceEnv: production.loadFlexpriceEnv,
  requireFlexpriceForEnvironment: production.requireFlexpriceForEnvironment,
  loadStripeBillingEnv: production.loadStripeBillingEnv,
  requireStripeBillingForEnvironment: production.requireStripeBillingForEnvironment,
  loadGitHubAppEnv: production.loadGitHubAppEnv,
  loadGitHubImportQueueEnv: production.loadGitHubImportQueueEnv,
  loadGitHubWebhookQueueEnv: production.loadGitHubWebhookQueueEnv,
  loadPostHogEnv: production.loadPostHogEnv,
  loadIncidentWebhookSecret: production.loadIncidentWebhookSecret,
  loadMasterKey: production.loadMasterKey,
  loadModelGatewayUrl: production.loadModelGatewayUrl,
  loadPreviewEnv: production.loadPreviewEnv,
  loadRedisUrl: production.loadRedisUrl,
  loadRunIntentHmacKey: production.loadRunIntentHmacKey,
  loadServiceTokenConfig: production.loadServiceTokenConfig,
  loadTemporalEnv: production.loadTemporalEnv,
  loadUsageQueueEnv: production.loadUsageQueueEnv,
  loadNotificationEnv: production.loadNotificationEnv,
}));
vi.mock('../src/notifications/service.js', () => ({
  createDatabaseNotificationDirectory: production.createDatabaseNotificationDirectory,
  createNotificationProducer: production.createNotificationProducer,
  createNotificationWorker: production.createNotificationWorker,
  createNotificationWorkerLifecycle: production.createNotificationWorkerLifecycle,
  createRedisNotificationProjection: production.createRedisNotificationProjection,
  createRedisNotificationState: production.createRedisNotificationState,
  usageAlertNotification: production.usageAlertNotification,
}));
vi.mock('../src/notifications/email.js', () => ({
  createSesEmailSender: production.createSesEmailSender,
  createSnsNotificationFanout: production.createSnsNotificationFanout,
  createSqsNotificationQueue: production.createSqsNotificationQueue,
}));
vi.mock('../src/events/lifecycle.js', () => ({
  createEventPublisherLifecycle: production.createEventPublisherLifecycle,
}));
vi.mock('../src/events/publisher.js', () => ({
  createEventPublisher: production.createEventPublisher,
}));
vi.mock('../src/git/client.js', () => ({
  loadGitServiceUrl: production.loadGitServiceUrl,
  resolveGitService: production.resolveGitService,
}));
vi.mock('../src/integrations/github/app.js', () => ({
  createGitHubProvider: production.createGitHubProvider,
}));
vi.mock('../src/integrations/github/store.js', () => ({
  createDbGitHubWebhookStore: production.createDbGitHubWebhookStore,
}));
vi.mock('../src/integrations/github/queue.js', () => ({
  createSqsGitHubWebhookQueue: production.createSqsGitHubWebhookQueue,
  createGitHubWebhookPublisher: production.createGitHubWebhookPublisher,
  createGitHubWebhookPublisherLifecycle: production.createGitHubWebhookPublisherLifecycle,
}));
vi.mock('../src/integrations/github/import-store.js', () => ({
  createDbGitHubImportWorkerStore: production.createDbGitHubImportWorkerStore,
}));
vi.mock('../src/integrations/github/import-queue.js', () => ({
  createSqsGitHubImportQueue: production.createSqsGitHubImportQueue,
  createGitHubImportPublisher: production.createGitHubImportPublisher,
  createGitHubImportPublisherLifecycle: production.createGitHubImportPublisherLifecycle,
  createGitHubImportConsumerLifecycle: production.createGitHubImportConsumerLifecycle,
  createGitHubImportWorker: production.createGitHubImportWorker,
}));
vi.mock('../src/tenant/db.js', () => ({
  createTenantDbFactory: production.createTenantDbFactory,
}));
vi.mock('../src/orchestrator/capability-scan.js', () => ({
  createTemporalCapabilityScanPort: production.createTemporalCapabilityScanPort,
}));
vi.mock('../src/logging.js', () => ({ loggerOptions: production.loggerOptions }));
vi.mock('../src/redis/client.js', () => ({
  createRedisConnection: production.createRedisConnection,
}));
vi.mock('../src/server-bootstrap.js', () => ({
  bootstrapControlApiServer: production.bootstrapControlApiServer,
}));
vi.mock('../src/usage/outbox.js', () => ({
  createDatabaseUsageOutboxDeliveryPort: production.createDatabaseUsageOutboxDeliveryPort,
  createFlexpriceIngestClient: production.createFlexpriceIngestClient,
  createSqsUsageQueue: production.createSqsUsageQueue,
  createUsageEventConsumer: production.createUsageEventConsumer,
  createUsageEventConsumerLifecycle: production.createUsageEventConsumerLifecycle,
  createUsageOutboxPublisher: production.createUsageOutboxPublisher,
  createUsageOutboxPublisherLifecycle: production.createUsageOutboxPublisherLifecycle,
  createRedisUsageLedgerCounter: production.createRedisUsageLedgerCounter,
}));
vi.mock('../src/usage/reconciliation.js', () => ({
  createAccountingReconciler: production.createAccountingReconciler,
  createAccountingReconcilerLifecycle: production.createAccountingReconcilerLifecycle,
  createDatabaseUsageReconciliationSource: production.createDatabaseUsageReconciliationSource,
  createFlexpriceUsageAggregateClient: production.createFlexpriceUsageAggregateClient,
  createRedisCreditMirror: production.createRedisCreditMirror,
  createRedisUsageRunCounter: production.createRedisUsageRunCounter,
  createThreeWayUsageReconciler: production.createThreeWayUsageReconciler,
  createUsageReconciliationLifecycle: production.createUsageReconciliationLifecycle,
  createCreditBalanceExhaustionProducer: production.createCreditBalanceExhaustionProducer,
  createCreditBalanceExhaustionLifecycle: production.createCreditBalanceExhaustionLifecycle,
  createDatabaseCreditExhaustionStore: production.createDatabaseCreditExhaustionStore,
  createDatabaseUsageCorrectionJournal: production.createDatabaseUsageCorrectionJournal,
  createDatabaseUsageReconciliationCoordinator:
    production.createDatabaseUsageReconciliationCoordinator,
  createCoordinatedUsageReconciliationJob: production.createCoordinatedUsageReconciliationJob,
}));
vi.mock('../src/usage/ledger.js', () => ({
  createUsageLedgerRepository: production.createUsageLedgerRepository,
}));
vi.mock('../src/usage/collectors/storage.js', () => ({
  createDailyStorageCollector: production.createDailyStorageCollector,
  createDailyStorageCollectorLifecycle: production.createDailyStorageCollectorLifecycle,
  createDatabaseDailyStorageClaim: production.createDatabaseDailyStorageClaim,
  createDatabaseMeteredProjectPort: production.createDatabaseMeteredProjectPort,
  createR2ArtifactStorageMeasurement: production.createR2ArtifactStorageMeasurement,
}));
vi.mock('../src/sandbox/client.js', () => ({
  createSandboxStorageMeasurementClient: production.createSandboxStorageMeasurementClient,
}));

describe('control-api production entrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bootstraps the composed app with the lifecycle assembled from production handles', async () => {
    // Break caught: server.ts listens outside the lifecycle, bypasses bootstrap,
    // omits it, or supplies a lifecycle other than the production assembly.
    const processOnce = vi.spyOn(process, 'once').mockReturnValue(process);
    const processExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    });

    await import('../src/server.js');

    expect(production.composeApp).toHaveBeenCalledOnce();
    expect(production.composeApp).toHaveBeenCalledWith(
      expect.objectContaining({
        redis: production.redis,
        eventWakeups: production.redis,
        runIntentHmacKey: Buffer.alloc(32, 0x33),
        preview: production.preview,
        previewRedis: production.redis,
        modelGatewayUrl: 'http://model-gateway.test:4100',
        temporal: production.temporal,
        artifactStorage: production.artifactStorage,
      }),
    );
    expect(production.connectTemporal).toHaveBeenCalledWith({
      address: production.temporalEnv.address,
    });
    expect(production.TemporalClient).toHaveBeenCalledOnce();
    const temporalClientInput = production.TemporalClient.mock.calls[0]?.[0];
    expect(temporalClientInput).toMatchObject({
      connection: production.temporalConnection,
      namespace: production.temporalEnv.namespace,
    });
    expect(temporalClientInput?.interceptors?.workflow).toHaveLength(1);
    expect(production.app.listen).not.toHaveBeenCalled();
    expect(production.createEventPublisherLifecycle).toHaveBeenCalledOnce();
    const lifecycleInput = production.createEventPublisherLifecycle.mock.calls[0]?.[0];
    expect(lifecycleInput?.publisher).toBe(production.eventPublisher);
    expect(lifecycleInput?.listen).toBeTypeOf('function');
    expect(lifecycleInput?.database).toBe(production.database);
    expect(lifecycleInput?.redis).toBe(production.redis);
    expect(production.bootstrapControlApiServer).toHaveBeenCalledOnce();
    const bootstrapInput = production.bootstrapControlApiServer.mock.calls[0]?.[0] as
      | {
          readonly app: unknown;
          readonly eventPublisherLifecycle: unknown;
          readonly usageOutboxLifecycle?: {
            readonly start: () => Promise<void>;
            readonly close: () => Promise<void>;
          };
          readonly notificationLifecycle?: {
            readonly start: () => Promise<void>;
            readonly close: () => Promise<void>;
          };
        }
      | undefined;
    expect(bootstrapInput?.app).toBe(production.app);
    expect(bootstrapInput?.eventPublisherLifecycle).toBe(production.eventPublisherLifecycle);
    expect(bootstrapInput?.usageOutboxLifecycle?.start).toBeTypeOf('function');
    expect(bootstrapInput?.usageOutboxLifecycle?.close).toBeTypeOf('function');
    expect(bootstrapInput?.notificationLifecycle?.start).toBeTypeOf('function');
    expect(bootstrapInput?.notificationLifecycle?.close).toBeTypeOf('function');
    expect(production.createFlexpriceIngestClient).toHaveBeenCalledTimes(2);
    expect(production.createUsageEventConsumer).toHaveBeenCalledWith(
      production.flexprice,
      production.usageDelivery,
    );
    expect(production.createUsageEventConsumerLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: production.usageQueue,
        consumer: production.usageConsumer,
      }),
    );
    expect(production.createDatabaseUsageReconciliationSource).toHaveBeenCalledWith(
      production.database.db,
    );
    expect(production.createRedisUsageRunCounter).toHaveBeenCalledWith(production.redis);
    expect(production.createFlexpriceUsageAggregateClient).toHaveBeenCalledOnce();
    expect(production.createThreeWayUsageReconciler).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: production.usageReconciliationSource.scopes,
        ledger: production.usageReconciliationSource.ledger,
        redis: production.usageRunCounter,
        flexprice: production.flexpriceUsageAggregate,
        corrections: production.usageCorrections,
      }),
    );
    expect(production.createUsageReconciliationLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ reconciler: production.coordinatedReconciler }),
    );
    expect(production.createDailyStorageCollectorLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ collector: production.dailyStorageCollector }),
    );

    await bootstrapInput?.usageOutboxLifecycle?.start();
    expect(production.accountingReconcilerLifecycle.start).toHaveBeenCalledOnce();
    expect(production.dailyStorageLifecycle.start).toHaveBeenCalledOnce();
    expect(production.usageReconciliationLifecycle.start).toHaveBeenCalledOnce();
    expect(production.usagePublisherLifecycle.start).toHaveBeenCalledOnce();
    expect(production.usageConsumerLifecycle.start).toHaveBeenCalledOnce();
    await bootstrapInput?.usageOutboxLifecycle?.close();
    expect(production.usageConsumerLifecycle.close).toHaveBeenCalledOnce();
    expect(production.usagePublisherLifecycle.close).toHaveBeenCalledOnce();
    expect(production.usageReconciliationLifecycle.close).toHaveBeenCalledOnce();
    expect(production.dailyStorageLifecycle.close).toHaveBeenCalledOnce();
    expect(production.accountingReconcilerLifecycle.close).toHaveBeenCalledOnce();
    expect(production.usageQueue.close).toHaveBeenCalledOnce();

    await lifecycleInput?.listen();
    expect(production.app.listen).toHaveBeenCalledOnce();
    expect(production.app.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 4_321 });
    expect(processOnce).toHaveBeenCalledTimes(2);
    expect(processExit).not.toHaveBeenCalled();
  });
});
