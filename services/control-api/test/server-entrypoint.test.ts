import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface LifecycleInput {
  readonly publisher: unknown;
  readonly listen: () => Promise<unknown>;
  readonly database: unknown;
  readonly redis: unknown;
}

const production = vi.hoisted(() => {
  const auth = { databaseUrl: 'database-url-from-auth' };
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
  const preview = {
    signingKey: Buffer.alloc(32, 0x44),
    keyVersion: 1,
    previewBaseDomain: 'preview.zapp.test',
    sandboxServiceUrl: 'https://sandbox.internal',
  };

  return {
    app,
    auth,
    database,
    eventPublisher,
    eventPublisherLifecycle,
    flexprice,
    accountingReconciler,
    accountingReconcilerLifecycle,
    preview,
    redis,
    temporal,
    temporalConnection,
    temporalEnv,
    usageConsumer,
    usageConsumerLifecycle,
    usageOutboxPublisher,
    usagePublisherLifecycle,
    usageQueue,
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
    TemporalClient: vi.fn(function TemporalClient() {
      return temporal;
    }),
    createSqsUsageQueue: vi.fn(() => usageQueue),
    createFlexpriceIngestClient: vi.fn(() => flexprice),
    createUsageEventConsumer: vi.fn(() => usageConsumer),
    createUsageEventConsumerLifecycle: vi.fn(() => usageConsumerLifecycle),
    createUsageOutboxPublisher: vi.fn(() => usageOutboxPublisher),
    createUsageOutboxPublisherLifecycle: vi.fn(() => usagePublisherLifecycle),
    createAccountingReconciler: vi.fn(() => accountingReconciler),
    createAccountingReconcilerLifecycle: vi.fn(() => accountingReconcilerLifecycle),
    createRedisCreditMirror: vi.fn(() => ({ kind: 'credit-mirror' })),
    loadAuthEnv: vi.fn(() => auth),
    loadEnv: vi.fn(() => ({
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      PORT: 4_321,
    })),
    loadGitServiceUrl: vi.fn(() => undefined),
    loadFlexpriceEnv: vi.fn(() => ({
      apiKey: 'not-a-real-flexprice-key',
      baseUrl: 'https://api.cloud.flexprice.io/v1',
    })),
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
  loadEnv: production.loadEnv,
  loadFlexpriceEnv: production.loadFlexpriceEnv,
  loadMasterKey: production.loadMasterKey,
  loadModelGatewayUrl: production.loadModelGatewayUrl,
  loadPreviewEnv: production.loadPreviewEnv,
  loadRedisUrl: production.loadRedisUrl,
  loadRunIntentHmacKey: production.loadRunIntentHmacKey,
  loadServiceTokenConfig: production.loadServiceTokenConfig,
  loadTemporalEnv: production.loadTemporalEnv,
  loadUsageQueueEnv: production.loadUsageQueueEnv,
}));
vi.mock('../src/events/lifecycle.js', () => ({
  createEventPublisherLifecycle: production.createEventPublisherLifecycle,
}));
vi.mock('../src/events/publisher.js', () => ({
  createEventPublisher: production.createEventPublisher,
}));
vi.mock('../src/git/client.js', () => ({
  loadGitServiceUrl: production.loadGitServiceUrl,
}));
vi.mock('../src/logging.js', () => ({ loggerOptions: production.loggerOptions }));
vi.mock('../src/redis/client.js', () => ({
  createRedisConnection: production.createRedisConnection,
}));
vi.mock('../src/server-bootstrap.js', () => ({
  bootstrapControlApiServer: production.bootstrapControlApiServer,
}));
vi.mock('../src/usage/outbox.js', () => ({
  createFlexpriceIngestClient: production.createFlexpriceIngestClient,
  createSqsUsageQueue: production.createSqsUsageQueue,
  createUsageEventConsumer: production.createUsageEventConsumer,
  createUsageEventConsumerLifecycle: production.createUsageEventConsumerLifecycle,
  createUsageOutboxPublisher: production.createUsageOutboxPublisher,
  createUsageOutboxPublisherLifecycle: production.createUsageOutboxPublisherLifecycle,
}));
vi.mock('../src/usage/reconciliation.js', () => ({
  createAccountingReconciler: production.createAccountingReconciler,
  createAccountingReconcilerLifecycle: production.createAccountingReconcilerLifecycle,
  createRedisCreditMirror: production.createRedisCreditMirror,
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
      }),
    );
    expect(production.connectTemporal).toHaveBeenCalledWith({
      address: production.temporalEnv.address,
    });
    expect(production.TemporalClient).toHaveBeenCalledWith({
      connection: production.temporalConnection,
      namespace: production.temporalEnv.namespace,
    });
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
        }
      | undefined;
    expect(bootstrapInput?.app).toBe(production.app);
    expect(bootstrapInput?.eventPublisherLifecycle).toBe(production.eventPublisherLifecycle);
    expect(bootstrapInput?.usageOutboxLifecycle?.start).toBeTypeOf('function');
    expect(bootstrapInput?.usageOutboxLifecycle?.close).toBeTypeOf('function');
    expect(production.createFlexpriceIngestClient).toHaveBeenCalledOnce();
    expect(production.createUsageEventConsumer).toHaveBeenCalledWith(production.flexprice);
    expect(production.createUsageEventConsumerLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: production.usageQueue,
        consumer: production.usageConsumer,
      }),
    );

    await bootstrapInput?.usageOutboxLifecycle?.start();
    expect(production.accountingReconcilerLifecycle.start).toHaveBeenCalledOnce();
    expect(production.usagePublisherLifecycle.start).toHaveBeenCalledOnce();
    expect(production.usageConsumerLifecycle.start).toHaveBeenCalledOnce();
    await bootstrapInput?.usageOutboxLifecycle?.close();
    expect(production.usageConsumerLifecycle.close).toHaveBeenCalledOnce();
    expect(production.usagePublisherLifecycle.close).toHaveBeenCalledOnce();
    expect(production.accountingReconcilerLifecycle.close).toHaveBeenCalledOnce();
    expect(production.usageQueue.close).toHaveBeenCalledOnce();

    await lifecycleInput?.listen();
    expect(production.app.listen).toHaveBeenCalledOnce();
    expect(production.app.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 4_321 });
    expect(processOnce).toHaveBeenCalledTimes(2);
    expect(processExit).not.toHaveBeenCalled();
  });
});
