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

  it('delivers a later notification while its diagnostic promise is still pending', async () => {
    // Break caught: a slow diagnostic sink becomes part of the serialized
    // delivery chain and blocks unrelated Redis wakeups.
    const currentRunId = runId();
    const reporter = deferred<undefined>();
    const delivered = deferred<undefined>();
    let notify: ((payload: string) => void) | undefined;
    let sequence = 1;
    let publishAttempt = 0;
    let reports = 0;
    const publisher = createEventPublisher(
      {
        listen(_channel, onNotification) {
          notify = onNotification;
          return Promise.resolve({ unlisten: () => Promise.resolve() });
        },
        readLatestSequence: () => Promise.resolve({ sequence }),
        publish() {
          publishAttempt += 1;
          if (publishAttempt === 1) return Promise.reject(new Error('redis unavailable'));
          delivered.resolve(undefined);
          return Promise.resolve();
        },
      },
      {
        onError() {
          reports += 1;
          return reporter.promise;
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
    const deliveryState = await Promise.race([
      delivered.promise.then(() => 'delivered' as const),
      new Promise<'blocked'>((resolve) => {
        setImmediate(() => {
          resolve('blocked');
        });
      }),
    ]);

    reporter.resolve(undefined);
    await delivered.promise;
    await publisher.close();
    expect(deliveryState).toBe('delivered');
  });

  it('closes while a diagnostic promise remains pending', async () => {
    // Break caught: shutdown waits forever for an observability sink after a
    // publish failure even though the publisher owns no work in that sink.
    const currentRunId = runId();
    const reporter = deferred<undefined>();
    let notify: ((payload: string) => void) | undefined;
    let reports = 0;
    const publisher = createEventPublisher(
      {
        listen(_channel, onNotification) {
          notify = onNotification;
          return Promise.resolve({ unlisten: () => Promise.resolve() });
        },
        readLatestSequence: () => Promise.resolve({ sequence: 1 }),
        publish: () => Promise.reject(new Error('redis unavailable')),
      },
      {
        onError() {
          reports += 1;
          return reporter.promise;
        },
      },
    );

    publisher.start();
    await publisher.ready();
    notify?.(currentRunId);
    await vi.waitFor(() => {
      expect(reports).toBe(1);
    });

    const closing = publisher.close();
    const closeState = await Promise.race([
      closing.then(() => 'closed' as const),
      new Promise<'blocked'>((resolve) => {
        setImmediate(() => {
          resolve('blocked');
        });
      }),
    ]);

    reporter.resolve(undefined);
    await closing;
    expect(closeState).toBe('closed');
  });

  it('coalesces 10,000 malformed diagnostics without blocking delivery or close', async () => {
    // Break caught: a stalled diagnostic sink retains one promise/error closure
    // per malformed hint instead of one bounded, payload-free summary.
    const currentRunId = runId();
    const firstReport = deferred<undefined>();
    const summaryReport = deferred<undefined>();
    const delivered = deferred<undefined>();
    const malformedPayload = 'malformed-payload-marker';
    let notify: ((payload: string) => void) | undefined;
    let reports = 0;
    let summaryMessage: string | undefined;
    const publisher = createEventPublisher(
      {
        listen(_channel, onNotification) {
          notify = onNotification;
          return Promise.resolve({ unlisten: () => Promise.resolve() });
        },
        readLatestSequence: () => Promise.resolve({ sequence: 1 }),
        publish() {
          delivered.resolve(undefined);
          return Promise.resolve();
        },
      },
      {
        onError(error) {
          reports += 1;
          if (reports === 1) return firstReport.promise;
          summaryMessage = error.message;
          return summaryReport.promise;
        },
      },
    );

    publisher.start();
    await publisher.ready();
    for (let index = 0; index < 10_000; index += 1) notify?.(malformedPayload);

    expect(reports).toBe(1);
    notify?.(currentRunId);
    const deliveryState = await Promise.race([
      delivered.promise.then(() => 'delivered' as const),
      new Promise<'blocked'>((resolve) => {
        setImmediate(() => {
          resolve('blocked');
        });
      }),
    ]);

    firstReport.resolve(undefined);
    await vi.waitFor(() => {
      expect(reports).toBe(2);
    });
    expect(summaryMessage).toBe('event publisher diagnostics suppressed (1000 or more)');
    expect(summaryMessage).not.toContain(malformedPayload);

    const closing = publisher.close();
    const closeState = await Promise.race([
      closing.then(() => 'closed' as const),
      new Promise<'blocked'>((resolve) => {
        setImmediate(() => {
          resolve('blocked');
        });
      }),
    ]);
    summaryReport.resolve(undefined);
    await closing;

    expect(deliveryState).toBe('delivered');
    expect(closeState).toBe('closed');
    expect(reports).toBe(2);
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

  it('coalesces 5,000 duplicate wakeups behind one blocked publish', async () => {
    // Break caught: every duplicate notification allocates another promise
    // closure and repeats the same high-water read after the blockage clears.
    const currentRunId = runId();
    const firstPublish = deferred<undefined>();
    const publishStarted = deferred<undefined>();
    let notify: ((payload: string) => void) | undefined;
    let sequence = 1;
    const delivered: string[] = [];
    const publisher = createEventPublisher({
      listen(_channel, onNotification) {
        notify = onNotification;
        return Promise.resolve({ unlisten: () => Promise.resolve() });
      },
      readLatestSequence: () => Promise.resolve({ sequence }),
      publish(_channel, body) {
        delivered.push(body);
        if (delivered.length === 1) {
          publishStarted.resolve(undefined);
          return firstPublish.promise;
        }
        return Promise.resolve();
      },
    });

    publisher.start();
    await publisher.ready();
    notify?.(currentRunId);
    await publishStarted.promise;

    sequence = 2;
    for (let index = 0; index < 5_000; index += 1) notify?.(currentRunId);
    firstPublish.resolve(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await publisher.close();

    expect(delivered).toEqual(['{"sequence":1}', '{"sequence":2}']);
  });

  it('publishes another run while the first run publish is blocked', async () => {
    // Break caught: one slow Redis command globally starves wakeups for every
    // other run even though their monotonic ordering is independent.
    const blockedRunId = runId();
    const progressingRunId = runId();
    const blockedPublish = deferred<undefined>();
    const publishStarted = deferred<undefined>();
    const progressed = deferred<undefined>();
    let notify: ((payload: string) => void) | undefined;
    const publisher = createEventPublisher({
      listen(_channel, onNotification) {
        notify = onNotification;
        return Promise.resolve({ unlisten: () => Promise.resolve() });
      },
      readLatestSequence: () => Promise.resolve({ sequence: 1 }),
      publish(channel) {
        if (channel === `run:${blockedRunId}`) {
          publishStarted.resolve(undefined);
          return blockedPublish.promise;
        }
        if (channel === `run:${progressingRunId}`) progressed.resolve(undefined);
        return Promise.resolve();
      },
    });

    publisher.start();
    await publisher.ready();
    notify?.(blockedRunId);
    await publishStarted.promise;
    notify?.(progressingRunId);
    const progressState = await Promise.race([
      progressed.promise.then(() => 'progressed' as const),
      new Promise<'blocked'>((resolve) => {
        setImmediate(() => {
          resolve('blocked');
        });
      }),
    ]);

    blockedPublish.resolve(undefined);
    await publisher.close();
    expect(progressState).toBe('progressed');
  });

  it('bounds 5,000 distinct wakeups and closes with one publish blocked', async () => {
    // Break caught: a notification flood retains one work closure per run and
    // shutdown waits for a blocked Redis command before dropping hint work.
    const blockedRunId = runId();
    const blockedPublish = deferred<undefined>();
    const publishStarted = deferred<undefined>();
    let notify: ((payload: string) => void) | undefined;
    let reads = 0;
    const reports: Error[] = [];
    const publisher = createEventPublisher(
      {
        listen(_channel, onNotification) {
          notify = onNotification;
          return Promise.resolve({ unlisten: () => Promise.resolve() });
        },
        readLatestSequence() {
          reads += 1;
          return Promise.resolve({ sequence: 1 });
        },
        publish(channel) {
          if (channel === `run:${blockedRunId}`) {
            publishStarted.resolve(undefined);
            return blockedPublish.promise;
          }
          return Promise.resolve();
        },
      },
      {
        maximumPendingRuns: 32,
        onError(error) {
          reports.push(error);
          return Promise.reject(new Error('diagnostic unavailable'));
        },
      },
    );

    publisher.start();
    await publisher.ready();
    notify?.(blockedRunId);
    await publishStarted.promise;
    for (let index = 0; index < 4_999; index += 1) notify?.(runId());
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const readsWhileBlocked = reads;
    const closing = publisher.close();
    const closeState = await Promise.race([
      closing.then(() => 'closed' as const),
      new Promise<'blocked'>((resolve) => {
        setImmediate(() => {
          resolve('blocked');
        });
      }),
    ]);
    blockedPublish.resolve(undefined);
    await closing;

    expect(readsWhileBlocked).toBe(32);
    expect(reports).toHaveLength(1);
    expect(closeState).toBe('closed');
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

  it('closes promptly while LISTEN is stalled and unlistens its late subscription', async () => {
    // Break caught: shutdown waits for postgres.js connection acquisition to
    // time out, or abandons a subscription that resolves after shutdown.
    const listening = deferred<{ unlisten(): Promise<void> }>();
    let attempts = 0;
    let unlistens = 0;
    const publisher = createEventPublisher({
      listen() {
        attempts += 1;
        return listening.promise;
      },
      readLatestSequence: () => Promise.resolve(undefined),
      publish: () => Promise.resolve(),
    });

    publisher.start();
    await vi.waitFor(() => {
      expect(attempts).toBe(1);
    });

    const closing = publisher.close();
    const closeState = await Promise.race([
      closing.then(() => 'closed' as const),
      new Promise<'stalled'>((resolve) => {
        setImmediate(() => {
          resolve('stalled');
        });
      }),
    ]);

    listening.resolve({
      unlisten() {
        unlistens += 1;
        return Promise.resolve();
      },
    });
    await closing;

    expect(closeState).toBe('closed');
    await vi.waitFor(() => {
      expect(unlistens).toBe(1);
    });
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
      requestFingerprint: `seed:${currentRunId}`,
      status: 'running',
      specificationId: null,
      temporalWorkflowId: currentRunId,
      startedBy: userId,
      budgetJson: null,
    });
  });

  it('publishes the committed high-water sequence on the exact run channel within 2 s of commit', async () => {
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
      const response = await postEvents([event()]);
      expect(response.statusCode, response.body).toBe(201);
      // The clock starts at commit (the 201), not at request start, and the
      // bound is 2 s rather than the production 500 ms SLO. Every break this
      // test exists to catch — no LISTEN bridge, wrong channel, fabricated
      // sequence, publish-before-commit — fails at ANY bound; the wall-clock
      // number only has to be tight enough to notice the bridge is gone. On
      // macOS Docker the cold insert alone takes ~900 ms and fanout jitters
      // past 500 ms about one run in four; the production SLO is enforced by
      // ops metrics on production infra, not by this laptop-stack test.
      const startedAt = Date.now();

      await vi.waitFor(
        () => {
          expect(received).toContainEqual({
            channel,
            body: '{"sequence":1}',
            at: expect.any(Number) as number,
          });
        },
        { timeout: 2_000, interval: 10 },
      );
      const ping = received.find((message) => message.body === '{"sequence":1}');
      expect((ping?.at ?? Number.POSITIVE_INFINITY) - startedAt).toBeLessThanOrEqual(2_000);

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
