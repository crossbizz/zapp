import type { Database } from '@zapp/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppDeps } from '../src/app.js';
import { composeApp } from '../src/compose.js';
import { loadRateLimitSettings } from '../src/config/rate-limits.js';
import type { EventWakeupSource } from '../src/events/sse.js';
import type { RedisCommands } from '../src/redis/client.js';
import { loadPlanLimitsConfig } from '../src/usage/limits.js';
import { TEST_AUTH_CONFIG, TEST_MASTER_KEY, TEST_PRICING } from './support/harness.js';
import { TEST_SERVICE_TOKEN_SECRET } from './support/service-tokens.js';

const appCapture = vi.hoisted(() => {
  const app = { kind: 'composed-app' };
  return {
    app,
    buildApp: vi.fn<(dependencies: AppDeps) => typeof app>().mockReturnValue(app),
  };
});

vi.mock('../src/app.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/app.js')>();
  return { ...original, buildApp: appCapture.buildApp };
});

const unusedRedis: RedisCommands = {
  get: () => Promise.reject(new Error('redis reached')),
  set: () => Promise.reject(new Error('redis reached')),
  setIfAbsent: () => Promise.reject(new Error('redis reached')),
  exists: () => Promise.reject(new Error('redis reached')),
  delete: () => Promise.reject(new Error('redis reached')),
  eval: () => Promise.reject(new Error('redis reached')),
};

const PLAN_LIMITS = loadPlanLimitsConfig({
  trial: {
    concurrentAutonomousRuns: 1,
    concurrentSandboxes: 1,
    maxResourceProfile: 'small',
    maxRunBudgetCredits: '10.0000',
    maxPreviewLifetimeHours: 1,
    artifactRetentionDays: 1,
    monthlyCredits: '10.0000',
    seats: 1,
  },
  builder: {
    concurrentAutonomousRuns: 2,
    concurrentSandboxes: 2,
    maxResourceProfile: 'standard',
    maxRunBudgetCredits: '20.0000',
    maxPreviewLifetimeHours: 2,
    artifactRetentionDays: 2,
    monthlyCredits: '20.0000',
    seats: 2,
  },
  studio: {
    concurrentAutonomousRuns: 3,
    concurrentSandboxes: 3,
    maxResourceProfile: 'large',
    maxRunBudgetCredits: '30.0000',
    maxPreviewLifetimeHours: 3,
    artifactRetentionDays: 3,
    monthlyCredits: '30.0000',
    seats: 3,
  },
});

describe('control-api event stream composition', () => {
  beforeEach(() => {
    appCapture.buildApp.mockClear();
  });

  it('hands the injected wakeup source to the composed SSE route', () => {
    // Break caught: server.ts can pass Redis correctly while composeApp drops
    // or replaces it before buildApp registers the production SSE route.
    const eventWakeups: EventWakeupSource = {
      subscribe: () => Promise.reject(new Error('subscription reached')),
    };
    const runIntentHmacKey = Buffer.alloc(32, 0x44);

    const app = composeApp({
      logger: false,
      database: {} as Database,
      redis: unusedRedis,
      eventWakeups,
      runIntentHmacKey,
      auth: {
        databaseUrl: 'postgres://127.0.0.1:1/unused',
        config: TEST_AUTH_CONFIG,
        stytch: {
          projectId: 'project-test-00000000-0000-0000-0000-000000000000',
          secret: 'secret-test-not-a-real-key',
          publicToken: 'public-token-test-abc',
        },
      },
      masterKey: TEST_MASTER_KEY,
      serviceTokens: { secret: TEST_SERVICE_TOKEN_SECRET },
      modelGatewayUrl: 'http://127.0.0.1:4100',
      rateLimits: loadRateLimitSettings(),
      pricing: TEST_PRICING,
      temporal: { workflow: {} as never },
      artifactStorage: {
        endpoint: 'http://127.0.0.1:9000',
        region: 'us-east-1',
        bucket: 'zapp-artifacts',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
      },
    });

    expect(app).toBe(appCapture.app);
    expect(appCapture.buildApp).toHaveBeenCalledOnce();
    const dependencies = appCapture.buildApp.mock.calls[0]?.[0];
    expect(dependencies?.tenant?.eventStream?.wakeups).toBe(eventWakeups);
    expect(dependencies?.tenant?.runIntentHmacKey).toBe(runIntentHmacKey);
  });

  it('joins the parsed plan policy and Flexprice credit gate into the production tenant routes', () => {
    composeApp({
      logger: false,
      database: {} as Database,
      redis: unusedRedis,
      runIntentHmacKey: Buffer.alloc(32, 0x45),
      auth: {
        databaseUrl: 'postgres://127.0.0.1:1/unused',
        config: TEST_AUTH_CONFIG,
        stytch: {
          projectId: 'project-test-00000000-0000-0000-0000-000000000000',
          secret: 'secret-test-not-a-real-key',
          publicToken: 'public-token-test-abc',
        },
      },
      masterKey: TEST_MASTER_KEY,
      serviceTokens: { secret: TEST_SERVICE_TOKEN_SECRET },
      modelGatewayUrl: 'http://127.0.0.1:4100',
      rateLimits: loadRateLimitSettings(),
      pricing: { ...TEST_PRICING, walletBalanceGraceFloor: '5.0000' },
      planLimits: PLAN_LIMITS,
      flexprice: { baseUrl: 'https://flexprice.example/v1', apiKey: 'test-key' },
      temporal: { workflow: {} as never },
      artifactStorage: {
        endpoint: 'http://127.0.0.1:9000',
        region: 'us-east-1',
        bucket: 'zapp-artifacts',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
      },
    });

    const dependencies = appCapture.buildApp.mock.calls[0]?.[0];
    expect(dependencies?.tenant?.planLimits).toBe(PLAN_LIMITS);
    expect(typeof dependencies?.tenant?.creditBalance?.availableCredits).toBe('function');
    expect(typeof dependencies?.tenant?.creditBalance?.requireRunAdmission).toBe('function');
  });
});
