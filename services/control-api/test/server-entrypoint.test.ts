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
  const app = {
    listen: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    log: { error: vi.fn(), info: vi.fn() },
  };
  const eventPublisher = { kind: 'production-event-publisher' };
  const eventPublisherLifecycle = {
    start: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };

  return {
    app,
    auth,
    database,
    eventPublisher,
    eventPublisherLifecycle,
    redis,
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
    loadAuthEnv: vi.fn(() => auth),
    loadEnv: vi.fn(() => ({
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      PORT: 4_321,
    })),
    loadGitServiceUrl: vi.fn(() => undefined),
    loadMasterKey: vi.fn(() => ({ kind: 'production-master-key' })),
    loadRateLimitSettings: vi.fn(() => ({ kind: 'production-rate-limits' })),
    loadRedisUrl: vi.fn(() => 'redis-url-from-env'),
    loadRunIntentHmacKey: vi.fn(() => Buffer.alloc(32, 0x33)),
    loadServiceTokenConfig: vi.fn(() => ({ kind: 'production-service-tokens' })),
    loggerOptions: vi
      .fn<(input: unknown) => { level: string }>()
      .mockReturnValue({ level: 'silent' }),
  };
});

vi.mock('@zapp/db', () => ({ createDb: production.createDb }));
vi.mock('../src/auth/config.js', () => ({ loadAuthEnv: production.loadAuthEnv }));
vi.mock('../src/compose.js', () => ({ composeApp: production.composeApp }));
vi.mock('../src/config/rate-limits.js', () => ({
  loadRateLimitSettings: production.loadRateLimitSettings,
}));
vi.mock('../src/env.js', () => ({
  loadEnv: production.loadEnv,
  loadMasterKey: production.loadMasterKey,
  loadRedisUrl: production.loadRedisUrl,
  loadRunIntentHmacKey: production.loadRunIntentHmacKey,
  loadServiceTokenConfig: production.loadServiceTokenConfig,
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
      }),
    );
    expect(production.app.listen).not.toHaveBeenCalled();
    expect(production.createEventPublisherLifecycle).toHaveBeenCalledOnce();
    const lifecycleInput = production.createEventPublisherLifecycle.mock.calls[0]?.[0];
    expect(lifecycleInput?.publisher).toBe(production.eventPublisher);
    expect(lifecycleInput?.listen).toBeTypeOf('function');
    expect(lifecycleInput?.database).toBe(production.database);
    expect(lifecycleInput?.redis).toBe(production.redis);
    expect(production.bootstrapControlApiServer).toHaveBeenCalledOnce();
    expect(production.bootstrapControlApiServer).toHaveBeenCalledWith({
      app: production.app,
      eventPublisherLifecycle: production.eventPublisherLifecycle,
    });

    await lifecycleInput?.listen();
    expect(production.app.listen).toHaveBeenCalledOnce();
    expect(production.app.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 4_321 });
    expect(processOnce).toHaveBeenCalledTimes(2);
    expect(processExit).not.toHaveBeenCalled();
  });
});
