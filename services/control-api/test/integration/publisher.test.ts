import { randomBytes } from 'node:crypto';
import { getEventListeners } from 'node:events';

import type { ServiceAudience } from '@zapp/config';
import { AgentEventSchema, newId } from '@zapp/contracts';
import {
  agentRuns,
  organizations,
  projects,
  users,
} from '@zapp/db';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';
import { createDbUserStore } from '../../src/auth/users.js';
import {
  createEventPublisher,
  SSE_POLL_INTERVAL_MS,
  waitForEventWakeup,
} from '../../src/events/publisher.js';
import { SERVICE_TOKEN_HEADER } from '../../src/internal/service-auth.js';
import { createInMemoryInviteStore } from '../../src/orgs/invites.js';
import { createDbOrganizationStore } from '../../src/orgs/store.js';
import { createDbAuditSink } from '../../src/plugins/audit.js';
import { createRedisConnection, type RedisConnection } from '../../src/redis/client.js';
import { createTenantDbFactory } from '../../src/tenant/db.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import { TEST_AUTH_CONFIG, TEST_MASTER_KEY, TEST_RATE_LIMITS } from '../support/harness.js';
import { TestServiceTokens } from '../support/service-tokens.js';
import {
  hasDatabase,
  hasRedis,
  redisUrl,
  setUpTestDatabase,
  type TestDatabase,
} from './helpers.js';

const EVENTS_INGEST_AUDIENCE = 'control-api:events.ingest' as ServiceAudience;
const EventInputSchema = AgentEventSchema.omit({ id: true, sequence: true }).strict();

function runId(): string {
  return newId('run');
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe('event publisher failure and recovery', () => {
  it('retries an initial LISTEN failure with exponential delays capped at the configured maximum', async () => {
    // Break caught: a failed initial LISTEN either kills the publisher, spins,
    // or lets its delay grow beyond the bound.
    let attempts = 0;
    const delays: number[] = [];
    const publisher = createEventPublisher(
      {
        listen() {
          attempts += 1;
          if (attempts < 5) return Promise.reject(new Error('postgres unavailable'));
          return Promise.resolve({ unlisten: () => Promise.resolve() });
        },
        readLatestSequence: () => Promise.resolve(undefined),
        publish: () => Promise.resolve(),
      },
      {
        retry: {
          initialDelayMs: 25,
          maximumDelayMs: 100,
          sleep(delayMs) {
            delays.push(delayMs);
            return Promise.resolve();
          },
        },
      },
    );

    publisher.start();
    await publisher.ready();

    expect(attempts).toBe(5);
    expect(delays).toEqual([25, 50, 100, 100]);
    await publisher.close();
  });

  it('reports one Redis rejection and still publishes a later notification', async () => {
    // Break caught: one rejected Redis command breaks the serialized callback
    // chain and silently drops every later PostgreSQL notification.
    const currentRunId = runId();
    let notify: ((payload: string) => void) | undefined;
    let sequence = 1;
    let publishAttempt = 0;
    const delivered: Array<{ channel: string; body: string }> = [];
    const errors: Error[] = [];
    const publisher = createEventPublisher(
      {
        listen(_channel, onNotification) {
          notify = onNotification;
          return Promise.resolve({ unlisten: () => Promise.resolve() });
        },
        readLatestSequence: () => Promise.resolve({ sequence }),
        publish(channel, body) {
          publishAttempt += 1;
          if (publishAttempt === 1) return Promise.reject(new Error('redis unavailable'));
          delivered.push({ channel, body });
          return Promise.resolve();
        },
      },
      { onError: (error) => errors.push(error) },
    );

    publisher.start();
    await publisher.ready();
    notify?.(currentRunId);
    await vi.waitFor(() => {
      expect(errors.map((error) => error.message)).toContain('redis unavailable');
    });

    sequence = 2;
    notify?.(currentRunId);
    await vi.waitFor(() => {
      expect(delivered).toEqual([
        { channel: `run:${currentRunId}`, body: '{"sequence":2}' },
      ]);
    });
    await publisher.close();
  });

  it('contains a synchronous reporter throw and processes the next notification', async () => {
    // Break caught: a diagnostic callback must never poison the serialized
    // notification chain or make publisher shutdown reject.
    const currentRunId = runId();
    let notify: ((payload: string) => void) | undefined;
    let sequence = 1;
    let publishAttempt = 0;
    let reports = 0;
    const delivered: string[] = [];
    const publisher = createEventPublisher(
      {
        listen(_channel, onNotification) {
          notify = onNotification;
          return Promise.resolve({ unlisten: () => Promise.resolve() });
        },
        readLatestSequence: () => Promise.resolve({ sequence }),
        publish(_channel, body) {
          publishAttempt += 1;
          if (publishAttempt === 1) return Promise.reject(new Error('redis unavailable'));
          delivered.push(body);
          return Promise.resolve();
        },
      },
      {
        onError() {
          reports += 1;
          throw new Error('synchronous reporter failure');
        },
      },
    );

    publisher.start();
    await publisher.ready();
    notify?.(currentRunId);
    await vi.waitFor(() => {
      expect(reports).toBe(1);
    });

    sequence = 2;
    notify?.(currentRunId);
    await vi.waitFor(() => {
      expect(delivered).toEqual(['{"sequence":2}']);
    });
    await expect(publisher.close()).resolves.toBeUndefined();
  });

  it('contains a rejected reporter promise and processes the next notification', async () => {
    // Break caught: an async diagnostic rejection must be observed internally,
    // without becoming an unhandled rejection or breaking later work.
    const currentRunId = runId();
    let notify: ((payload: string) => void) | undefined;
    let sequence = 1;
    let publishAttempt = 0;
    let reports = 0;
    const delivered: string[] = [];
    const publisher = createEventPublisher(
      {
        listen(_channel, onNotification) {
          notify = onNotification;
          return Promise.resolve({ unlisten: () => Promise.resolve() });
        },
        readLatestSequence: () => Promise.resolve({ sequence }),
        publish(_channel, body) {
          publishAttempt += 1;
          if (publishAttempt === 1) return Promise.reject(new Error('redis unavailable'));
          delivered.push(body);
          return Promise.resolve();
        },
      },
      {
        onError() {
          reports += 1;
          return Promise.reject(new Error('asynchronous reporter failure'));
        },
      },
    );

    publisher.start();
    await publisher.ready();
    notify?.(currentRunId);
    await vi.waitFor(() => {
      expect(reports).toBe(1);
    });

    sequence = 2;
    notify?.(currentRunId);
    await vi.waitFor(() => {
      expect(delivered).toEqual(['{"sequence":2}']);
    });
    await expect(publisher.close()).resolves.toBeUndefined();
  });

  it('ignores malformed notifications and valid runs with no committed event', async () => {
    // Break caught: unvalidated input creates a Redis channel, or a missing row
    // is turned into an invented sequence ping.
    const currentRunId = runId();
    let notify: ((payload: string) => void) | undefined;
    const delivered: Array<{ channel: string; body: string }> = [];
    const errors: Error[] = [];
    const publisher = createEventPublisher(
      {
        listen(_channel, onNotification) {
          notify = onNotification;
          return Promise.resolve({ unlisten: () => Promise.resolve() });
        },
        readLatestSequence: () => Promise.resolve(undefined),
        publish(channel, body) {
          delivered.push({ channel, body });
          return Promise.resolve();
        },
      },
      { onError: (error) => errors.push(error) },
    );

    publisher.start();
    await publisher.ready();
    notify?.('not-a-run-id');
    notify?.(currentRunId);

    await vi.waitFor(() => {
      expect(errors).toHaveLength(2);
    });
    expect(delivered).toEqual([]);
    await publisher.close();
  });

  it('serializes a notification burst so emitted high-water pings never regress', async () => {
    // Break caught: async LISTEN callbacks run concurrently and a slow older
    // read publishes after a newer one.
    const currentRunId = runId();
    let notify: ((payload: string) => void) | undefined;
    const firstRead = deferred<{ sequence: number }>();
    let reads = 0;
    const delivered: string[] = [];
    const publisher = createEventPublisher({
      listen(_channel, onNotification) {
        notify = onNotification;
        return Promise.resolve({ unlisten: () => Promise.resolve() });
      },
      async readLatestSequence() {
        reads += 1;
        return reads === 1 ? await firstRead.promise : { sequence: 3 };
      },
      publish(_channel, body) {
        delivered.push(body);
        return Promise.resolve();
      },
    });

    publisher.start();
    await publisher.ready();
    notify?.(currentRunId);
    notify?.(currentRunId);
    firstRead.resolve({ sequence: 2 });

    await vi.waitFor(() => {
      expect(delivered).toEqual(['{"sequence":2}', '{"sequence":3}']);
    });
    await publisher.close();
  });

  it('falls back to a database read after exactly 2,000 ms when the Redis wake-up fails', async () => {
    // Break caught: a failed subscription rejects the SSE loop or changes the
    // documented polling interval, leaving PostgreSQL replay unreachable.
    const delays: number[] = [];
    let databaseReads = 0;

    const rows = await waitForEventWakeup({
      wakeup: Promise.reject(new Error('subscription lost')),
      readFromDatabase() {
        databaseReads += 1;
        return Promise.resolve([{ sequence: 7 }]);
      },
      sleep(delayMs) {
        delays.push(delayMs);
        return Promise.resolve();
      },
    });

    expect(delays).toEqual([2_000]);
    expect(SSE_POLL_INTERVAL_MS).toBe(2_000);
    expect(databaseReads).toBe(1);
    expect(rows).toEqual([{ sequence: 7 }]);
  });

  it('aborts a pending retry on close without another LISTEN attempt', async () => {
    // Break caught: close leaves a backoff timer alive, which later opens a
    // listener on a service that already shut down.
    let attempts = 0;
    let retrySignal: AbortSignal | undefined;
    const retryStarted = deferred<undefined>();
    const publisher = createEventPublisher(
      {
        listen() {
          attempts += 1;
          return Promise.reject(new Error('postgres unavailable'));
        },
        readLatestSequence: () => Promise.resolve(undefined),
        publish: () => Promise.resolve(),
      },
      {
        retry: {
          initialDelayMs: 25,
          maximumDelayMs: 100,
          sleep(_delayMs, signal) {
            retrySignal = signal;
            retryStarted.resolve(undefined);
            return new Promise<void>((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  resolve();
                },
                { once: true },
              );
            });
          },
        },
      },
    );

    publisher.start();
    await retryStarted.promise;
    await publisher.close();

    expect(retrySignal?.aborted).toBe(true);
    expect(attempts).toBe(1);
  });

  it('removes each default retry abort listener after its delay completes', async () => {
    // Break caught: completed default backoff timers otherwise retain one
    // listener each on the process-long retry signal until shutdown.
    const NativeAbortController = globalThis.AbortController;
    const signals: AbortSignal[] = [];
    class TrackingAbortController extends NativeAbortController {
      constructor() {
        super();
        signals.push(this.signal);
      }
    }

    vi.useFakeTimers();
    vi.stubGlobal('AbortController', TrackingAbortController);
    let attempts = 0;
    const publisher = createEventPublisher({
      listen() {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new Error('postgres unavailable'));
        return Promise.resolve({ unlisten: () => Promise.resolve() });
      },
      readLatestSequence: () => Promise.resolve(undefined),
      publish: () => Promise.resolve(),
    });

    try {
      publisher.start();
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);
      await publisher.ready();

      expect(attempts).toBe(3);
      expect(signals).toHaveLength(1);
      const retrySignal = signals[0];
      if (retrySignal === undefined) throw new Error('retry signal was not created');
      expect(getEventListeners(retrySignal, 'abort')).toHaveLength(0);
    } finally {
      await publisher.close();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('unsubscribes exactly once and rejects notifications after close', async () => {
    // Break caught: close forgets the dedicated LISTEN subscription or accepts
    // callbacks after shutdown and publishes with a closing Redis client.
    let notify: ((payload: string) => void) | undefined;
    let unlistens = 0;
    const delivered: string[] = [];
    const publisher = createEventPublisher({
      listen(_channel, onNotification) {
        notify = onNotification;
        return Promise.resolve({
          unlisten() {
            unlistens += 1;
            return Promise.resolve();
          },
        });
      },
      readLatestSequence: () => Promise.resolve({ sequence: 1 }),
      publish(_channel, body) {
        delivered.push(body);
        return Promise.resolve();
      },
    });

    publisher.start();
    await publisher.ready();
    await publisher.close();
    notify?.(runId());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unlistens).toBe(1);
    expect(delivered).toEqual([]);
  });
});

describe.skipIf(!hasDatabase || !hasRedis)('PostgreSQL NOTIFY to Redis fanout', () => {
  let database: TestDatabase;
  let app: AppInstance;
  let redis: RedisConnection;
  let subscriber: Redis;
  let tokens: TestServiceTokens;
  let organizationId: string;
  let projectId: string;
  let currentRunId: string;

  beforeAll(async () => {
    database = await setUpTestDatabase();
    tokens = new TestServiceTokens();
    app = buildApp({
      logger: false,
      auth: {
        port: new FakeAuthPort(),
        users: createDbUserStore(database.db),
        config: TEST_AUTH_CONFIG,
      },
      orgs: {
        organizations: createDbOrganizationStore(database.db),
        invites: createInMemoryInviteStore(),
        audit: createDbAuditSink(database.db),
      },
      tenant: { tenantDb: createTenantDbFactory(database.db) },
      secrets: { masterKey: TEST_MASTER_KEY, serviceTokens: tokens.verifier },
      limits: { config: TEST_RATE_LIMITS },
    });
    await app.ready();
    redis = createRedisConnection(redisUrl(), { commandTimeoutMs: 2_000 });
    subscriber = new Redis(redisUrl(), {
      commandTimeout: 2_000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    subscriber.on('error', () => {});
    await subscriber.connect();
  }, 120_000);

  afterAll(async () => {
    subscriber.disconnect();
    await redis.close();
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    await database.truncateIdentity();
    const userId = newId('user');
    organizationId = newId('org');
    projectId = newId('proj');
    currentRunId = newId('run');
    await database.db.insert(users).values({
      id: userId,
      email: `${userId}@publisher.test`,
      displayName: 'Publisher Owner',
      avatarUrl: null,
      externalId: null,
    });
    await database.db.insert(organizations).values({
      id: organizationId,
      name: 'Publisher Org',
      slug: `publisher-${organizationId.slice(-8).toLowerCase()}`,
      plan: 'trial',
      billingCustomerId: null,
    });
    await database.db.insert(projects).values({
      id: projectId,
      organizationId,
      name: 'Publisher Project',
      slug: `publisher-${projectId.slice(-8).toLowerCase()}`,
      description: null,
      sourceType: 'prompt',
      supportLevel: 'compatible',
      createdBy: userId,
    });
    await database.db.insert(agentRuns).values({
      id: currentRunId,
      organizationId,
      projectId,
      branchId: null,
      mode: 'build',
      status: 'running',
      specificationId: null,
      temporalWorkflowId: currentRunId,
      startedBy: userId,
      budgetJson: null,
    });
  });

  it('publishes the committed high-water sequence on the exact run channel within 500 ms', async () => {
    // Break caught: no LISTEN bridge, wrong channel/body, publishing before
    // commit, or fabricating sequence 1 instead of reading the current high-water.
    const publisher = createEventPublisher({
      async listen(channelName, onNotification) {
        return await database.sql.listen(channelName, onNotification);
      },
      async readLatestSequence(notifiedRunId) {
        const [row] = await database.sql<{ sequence: string }[]>`
          select sequence::text as sequence
            from agent_events
           where run_id = ${notifiedRunId}
           order by sequence desc
           limit 1
        `;
        return row;
      },
      async publish(channelName, body) {
        await redis.publish(channelName, body);
      },
    });
    const channel = `run:${currentRunId}`;
    const received: Array<{ channel: string; body: string; at: number }> = [];
    const onMessage = (receivedChannel: string, body: string): void => {
      if (receivedChannel === channel) {
        received.push({ channel: receivedChannel, body, at: Date.now() });
      }
    };
    subscriber.on('message', onMessage);
    await subscriber.subscribe(channel);
    publisher.start();
    await publisher.ready();

    try {
      const startedAt = Date.now();
      const response = await postEvents([event()]);
      expect(response.statusCode, response.body).toBe(201);

      await vi.waitFor(
        () => {
          expect(received).toContainEqual({
            channel,
            body: '{"sequence":1}',
            at: expect.any(Number) as number,
          });
        },
        { timeout: 500, interval: 10 },
      );
      const ping = received.find((message) => message.body === '{"sequence":1}');
      expect((ping?.at ?? Number.POSITIVE_INFINITY) - startedAt).toBeLessThanOrEqual(500);

      const second = await postEvents([
        event({ idempotencyMarker: randomBytes(4).toString('hex'), type: 'phase.started' }),
        event({ idempotencyMarker: randomBytes(4).toString('hex'), type: 'task.started' }),
      ]);
      expect(second.statusCode, second.body).toBe(201);
      await vi.waitFor(() => {
        expect(received.map((message) => message.body)).toContain('{"sequence":3}');
      });
    } finally {
      await publisher.close();
      await subscriber.unsubscribe(channel);
      subscriber.off('message', onMessage);
    }
  });

  function event(overrides: Record<string, unknown> = {}) {
    return EventInputSchema.parse({
      runId: currentRunId,
      occurredAt: '2026-08-04T12:00:00.000Z',
      organizationId,
      projectId,
      type: 'run.started',
      visibility: 'internal',
      payload: { source: 'orchestrator', ...overrides },
      ...(typeof overrides.type === 'string' ? { type: overrides.type } : {}),
    });
  }

  async function postEvents(events: readonly ReturnType<typeof event>[]) {
    const token = await tokens.issue('orchestrator-worker', { aud: EVENTS_INGEST_AUDIENCE });
    return await app.inject({
      method: 'POST',
      url: `/internal/runs/${currentRunId}/events`,
      headers: {
        [SERVICE_TOKEN_HEADER]: token,
        'idempotency-key': `publisher-${randomBytes(8).toString('hex')}`,
      },
      payload: events,
    });
  }
});
