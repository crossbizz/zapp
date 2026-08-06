import type { Database } from '@zapp/db';
import { describe, expect, it, vi } from 'vitest';

import type { AppDeps } from '../src/app.js';
import { composeApp } from '../src/compose.js';
import { loadRateLimitSettings } from '../src/config/rate-limits.js';
import type { EventWakeupSource } from '../src/events/sse.js';
import type { RedisCommands } from '../src/redis/client.js';
import { TEST_AUTH_CONFIG, TEST_MASTER_KEY } from './support/harness.js';
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

describe('control-api event stream composition', () => {
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
      rateLimits: loadRateLimitSettings(),
    });

    expect(app).toBe(appCapture.app);
    expect(appCapture.buildApp).toHaveBeenCalledOnce();
    const dependencies = appCapture.buildApp.mock.calls[0]?.[0];
    expect(dependencies?.tenant?.eventStream?.wakeups).toBe(eventWakeups);
    expect(dependencies?.tenant?.runIntentHmacKey).toBe(runIntentHmacKey);
  });
});
