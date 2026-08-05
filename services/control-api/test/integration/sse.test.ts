import { AgentEventSchema, newId } from '@zapp/contracts';
import { agentEvents, agentRuns, organizations, projects, users } from '@zapp/db';
import { ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';
import { createSessionSigner } from '../../src/auth/session.js';
import type {
  EventWakeupSource,
  EventWakeupSubscription,
  EventStreamDependencies,
  EventStreamTimerHandle,
  EventStreamTimers,
} from '../../src/events/sse.js';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_MAX_CONNECTION_MS,
} from '../../src/events/sse.js';
import { ORGANIZATION_HEADER } from '../../src/plugins/tenant.js';
import { createRedisConnection } from '../../src/redis/client.js';
import { createTenantDbFactory } from '../../src/tenant/db.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import {
  InMemoryUserStore,
  TEST_AUTH_CONFIG,
  TEST_RATE_LIMITS,
} from '../support/harness.js';
import { InMemoryOrganizationStore } from '../support/org-store.js';
import {
  hasDatabase,
  hasRedis,
  redisUrl,
  setUpTestDatabase,
  type TestDatabase,
} from './helpers.js';

interface PendingWakeup {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

class TestWakeupSource implements EventWakeupSource {
  readonly channels: string[] = [];
  closed = 0;
  private readonly queued: unknown[] = [];
  private readonly pending: PendingWakeup[] = [];

  subscribe(channel: string): Promise<EventWakeupSubscription> {
    this.channels.push(channel);
    return Promise.resolve({
      next: () => {
        const queued = this.queued.shift();
        if (queued !== undefined) return Promise.resolve(queued);
        return new Promise<unknown>((resolve, reject) => {
          this.pending.push({ resolve, reject });
        });
      },
      close: () => {
        this.closed += 1;
        for (const waiter of this.pending.splice(0)) {
          waiter.reject(new Error('subscription closed'));
        }
        return Promise.resolve();
      },
    });
  }

  emit(value: unknown): void {
    const waiter = this.pending.shift();
    if (waiter === undefined) this.queued.push(value);
    else waiter.resolve(value);
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

class ManualTimers implements EventStreamTimers {
  readonly scheduled: { callback: () => void; delayMs: number; kind: 'interval' | 'timeout' }[] = [];
  readonly cleared: EventStreamTimerHandle[] = [];

  setInterval(callback: () => void, delayMs: number): EventStreamTimerHandle {
    const handle = { callback, delayMs, kind: 'interval' as const, unref: () => undefined };
    this.scheduled.push(handle);
    return handle;
  }

  clearInterval(handle: EventStreamTimerHandle): void {
    this.cleared.push(handle);
  }

  setTimeout(callback: () => void, delayMs: number): EventStreamTimerHandle {
    const handle = { callback, delayMs, kind: 'timeout' as const, unref: () => undefined };
    this.scheduled.push(handle);
    return handle;
  }

  clearTimeout(handle: EventStreamTimerHandle): void {
    this.cleared.push(handle);
  }

  fire(delayMs: number, kind: 'interval' | 'timeout'): void {
    const timer = this.scheduled.find((candidate) => candidate.delayMs === delayMs && candidate.kind === kind);
    if (timer === undefined) throw new Error(`No ${kind} scheduled for ${String(delayMs)} ms`);
    timer.callback();
  }
}

interface SseMessage {
  readonly id: number;
  readonly event: string;
  readonly data: unknown;
}

async function readMessages(
  response: Response,
  count: number,
  timeoutMs = 2_000,
  onMessage?: (message: SseMessage) => void,
): Promise<SseMessage[]> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('SSE response has no body');
  const decoder = new TextDecoder();
  const messages: SseMessage[] = [];
  let pending = '';
  const timeout = setTimeout(() => void reader.cancel('SSE test timeout'), timeoutMs);
  try {
    while (messages.length < count) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new Error('SSE chunk is not bytes');
      pending += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let boundary = pending.indexOf('\n\n');
      while (boundary >= 0) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (!block.startsWith(':')) {
          const fields = new Map(
            block.split('\n').map((line) => {
              const separator = line.indexOf(':');
              const value = line.slice(separator + 1).replace(/^ /, '');
              return [line.slice(0, separator), value] as const;
            }),
          );
          const message = {
            id: Number(fields.get('id')),
            event: fields.get('event') ?? '',
            data: JSON.parse(fields.get('data') ?? 'null') as unknown,
          };
          messages.push(message);
          onMessage?.(message);
        }
        boundary = pending.indexOf('\n\n');
      }
    }
  } finally {
    clearTimeout(timeout);
    if (messages.length < count) await reader.cancel();
  }
  return messages;
}

async function readBlock(response: Response, timeoutMs = 2_000): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('SSE response has no body');
  const decoder = new TextDecoder();
  let pending = '';
  const timeout = setTimeout(() => void reader.cancel('SSE block timeout'), timeoutMs);
  try {
    while (!pending.includes('\n\n')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new Error('SSE chunk is not bytes');
      pending += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
    }
    return pending.slice(0, pending.indexOf('\n\n'));
  } finally {
    clearTimeout(timeout);
  }
}

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe.skipIf(!hasDatabase)('resumable run SSE stream', () => {
  let database: TestDatabase;
  let app: AppInstance | undefined;
  let baseUrl: string;
  let wakeups: TestWakeupSource;
  let organizationId: string;
  let projectId: string;
  let runId: string;
  let userId: string;
  let authorization: string;
  let usersStore: InMemoryUserStore;
  let organizationStore: InMemoryOrganizationStore;
  let eventReadCount: number;

  beforeAll(async () => {
    database = await setUpTestDatabase();
  }, 120_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await database.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    if (app !== undefined) await app.close();
    await database.truncateIdentity();
    wakeups = new TestWakeupSource();
    organizationId = newId('org');
    projectId = newId('proj');
    runId = newId('run');
    userId = newId('user');

    await database.db.insert(users).values({
      id: userId,
      email: `${userId}@sse.test`,
      displayName: 'SSE Owner',
      avatarUrl: null,
      externalId: null,
    });
    await database.db.insert(organizations).values({
      id: organizationId,
      name: 'SSE Org',
      slug: `sse-${organizationId.slice(-8).toLowerCase()}`,
      plan: 'trial',
      billingCustomerId: null,
    });
    await database.db.insert(projects).values({
      id: projectId,
      organizationId,
      name: 'SSE Project',
      slug: `sse-${projectId.slice(-8).toLowerCase()}`,
      description: null,
      sourceType: 'prompt',
      supportLevel: 'compatible',
      createdBy: userId,
    });
    await database.db.insert(agentRuns).values({
      id: runId,
      organizationId,
      projectId,
      branchId: null,
      mode: 'build',
      status: 'running',
      specificationId: null,
      temporalWorkflowId: runId,
      startedBy: userId,
      budgetJson: null,
    });

    usersStore = new InMemoryUserStore();
    usersStore.users.set(userId, {
      id: userId,
      email: `${userId}@sse.test`,
      displayName: 'SSE Owner',
      avatarUrl: null,
    });
    organizationStore = new InMemoryOrganizationStore();
    organizationStore.organizations.set(organizationId, {
      id: organizationId,
      name: 'SSE Org',
      slug: `sse-${organizationId.slice(-8).toLowerCase()}`,
      plan: 'trial',
    });
    organizationStore.memberships.set(`${organizationId}\u0000${userId}`, {
      organizationId,
      userId,
      role: 'owner',
      status: 'active',
    });
    const tokens = await createSessionSigner({ secret: TEST_AUTH_CONFIG.sessionSecret }).mintSession({
      userId,
      now: new Date(),
    });
    authorization = `Bearer ${tokens.access.token}`;

    eventReadCount = 0;
    await startApp();
  }, 120_000);

  async function startApp(eventStream: Partial<EventStreamDependencies> = {}): Promise<void> {
    if (app !== undefined) await app.close();
    const tenantDb = createTenantDbFactory(database.db);
    const nextApp = buildApp({
      logger: false,
      auth: { port: new FakeAuthPort(), users: usersStore, config: TEST_AUTH_CONFIG },
      orgs: { organizations: organizationStore },
      tenant: {
        tenantDb: (tenantOrganizationId) => {
          const scoped = tenantDb(tenantOrganizationId);
          return {
            ...scoped,
            events: {
              ...scoped.events,
              async byRun(requestRunId, range) {
                eventReadCount += 1;
                return await scoped.events.byRun(requestRunId, range);
              },
            },
          };
        },
        eventStream: { wakeups, ...eventStream },
      },
      limits: { config: TEST_RATE_LIMITS },
    });
    app = nextApp;
    baseUrl = await nextApp.listen({ host: '127.0.0.1', port: 0 });
  }

  it('replays sequences strictly after Last-Event-ID and then emits a live event within two seconds', async () => {
    // Break caught: keeping the legacy JSON page, using >= cursor, tailing Redis
    // payloads instead of PostgreSQL, or failing to wake the live tail.
    await insertEvents([1, 2, 3, 4, 5]);
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
      headers: {
        accept: 'text/event-stream',
        authorization,
        [ORGANIZATION_HEADER]: organizationId,
        'last-event-id': '2',
      },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    let replayed!: () => void;
    const replayComplete = new Promise<void>((resolve) => {
      replayed = resolve;
    });
    const replayIds: number[] = [];
    const messagesPromise = readMessages(response, 4, 2_000, (message) => {
      replayIds.push(message.id);
      if (replayIds.length === 3) replayed();
    });
    await replayComplete;
    expect(replayIds).toEqual([3, 4, 5]);
    await insertEvents([6]);
    wakeups.emit('{"sequence":6}');
    const messages = await messagesPromise;
    controller.abort();

    expect(wakeups.channels).toEqual([`run:${runId}`]);
    expect(messages.map((message) => message.id)).toEqual([3, 4, 5, 6]);
    expect(messages.map((message) => message.event)).toEqual([
      'task.started',
      'task.started',
      'task.started',
      'task.started',
    ]);
    expect(messages.map((message) => AgentEventSchema.parse(message.data).sequence)).toEqual([
      3, 4, 5, 6,
    ]);
  });

  it.skipIf(!hasRedis)('live-tails a real Redis run channel by rereading PostgreSQL', async () => {
    // Break caught: production composition lacks a Redis subscriber, trusts the
    // ping as event data, or subscribes to a channel other than run:{runId}.
    const redis = createRedisConnection(redisUrl(), { commandTimeoutMs: 2_000 });
    await startApp({ wakeups: redis });
    const controller = new AbortController();
    try {
      const response = await connect({ after: '1', signal: controller.signal });
      const live = readMessages(response, 1);
      await insertEvents([2]);
      await redis.publish(`run:${runId}`, '{"sequence":2}');
      expect((await live).map((message) => message.id)).toEqual([2]);
    } finally {
      controller.abort();
      await redis.close();
    }
  });

  it('never emits internal events and advances past hidden rows', async () => {
    // Break caught: removing either visibility filter leaks internal/support data,
    // while failing to advance over hidden rows re-reads them forever.
    await insertEvents([
      { sequence: 1, visibility: 'user' },
      { sequence: 2, visibility: 'internal' },
      { sequence: 3, visibility: 'support' },
    ]);
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });
    const messages = readMessages(response, 2);
    await insertEvents([{ sequence: 4, visibility: 'user' }]);
    wakeups.emit('{"sequence":4}');
    expect((await messages).map((message) => message.id)).toEqual([1, 4]);
    controller.abort();
  });

  it('resumes from a stable cursor without sending an event twice', async () => {
    // Break caught: inclusive replay (>=) duplicates the cursor event after reconnect.
    await insertEvents([1, 2, 3]);
    const firstController = new AbortController();
    const first = await connect({ lastEventId: '1', signal: firstController.signal });
    expect((await readMessages(first, 2)).map((message) => message.id)).toEqual([2, 3]);
    firstController.abort();

    const secondController = new AbortController();
    const second = await connect({ after: '3', signal: secondController.signal });
    const next = readMessages(second, 1);
    await insertEvents([4]);
    wakeups.emit('{"sequence":4}');
    expect((await next).map((message) => message.id)).toEqual([4]);
    secondController.abort();
  });

  it('gives after precedence while validating every supplied cursor', async () => {
    // Break caught: reading Last-Event-ID first replays 2/3; ignoring a malformed
    // shadowed header accepts ambiguous resume state.
    await insertEvents([1, 2, 3, 4]);
    const controller = new AbortController();
    const response = await connect({ after: '3', lastEventId: '1', signal: controller.signal });
    expect((await readMessages(response, 1)).map((message) => message.id)).toEqual([4]);
    controller.abort();

    const invalidShadowed = await fetch(`${baseUrl}/v1/runs/${runId}/events?after=3`, {
      headers: requestHeaders({ lastEventId: '-1' }),
    });
    expect(invalidShadowed.status).toBe(400);
  });

  it.each([
    ['after', '-1'],
    ['after', '1.5'],
    ['after', '01'],
    ['after', '9007199254740992'],
    ['Last-Event-ID', '-1'],
    ['Last-Event-ID', '1.5'],
    ['Last-Event-ID', '01'],
    ['Last-Event-ID', '9007199254740992'],
  ])('rejects invalid supplied %s cursor %s before streaming', async (kind, value) => {
    // Break caught: coercive cursor parsing accepts negatives, fractions,
    // alternate spellings, or integers whose sequence cannot be represented safely.
    const url = `${baseUrl}/v1/runs/${runId}/events${kind === 'after' ? `?after=${value}` : ''}`;
    const response = await fetch(url, {
      headers: requestHeaders(
        kind === 'Last-Event-ID' ? { lastEventId: value } : {},
      ),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/event-stream');
  });

  it('returns 404 for a run outside the selected tenant before hijacking', async () => {
    // Break caught: looking up the run without the tenant scope leaks its existence.
    const otherOrganizationId = newId('org');
    organizationStore.organizations.set(otherOrganizationId, {
      id: otherOrganizationId,
      name: 'Other Org',
      slug: `other-${otherOrganizationId.slice(-8).toLowerCase()}`,
      plan: 'trial',
    });
    organizationStore.memberships.set(`${otherOrganizationId}\u0000${userId}`, {
      organizationId: otherOrganizationId,
      userId,
      role: 'owner',
      status: 'active',
    });
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
      headers: { ...requestHeaders(), [ORGANIZATION_HEADER]: otherOrganizationId },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/event-stream');
  });

  it('requires Accept to permit text/event-stream', async () => {
    // Break caught: the route hijacks clients that requested JSON and leaves them hanging.
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
      headers: { ...requestHeaders(), accept: 'application/json' },
    });
    expect(response.status).toBe(406);
  });

  it('allows only an injected audited support decision and still hides internal events', async () => {
    // Break caught: a support decision without its audit, or a broad visibility
    // predicate, exposes internal events without the mandatory evidence trail.
    const audits: unknown[] = [];
    await startApp({
      supportAccess: {
        decide: () => Promise.resolve({ access: 'support' }),
        audit: (entry) => {
          audits.push(entry);
          return Promise.resolve();
        },
      },
    });
    await insertEvents([
      { sequence: 1, visibility: 'user' },
      { sequence: 2, visibility: 'internal' },
      { sequence: 3, visibility: 'support' },
    ]);
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });
    expect((await readMessages(response, 2)).map((message) => message.id)).toEqual([1, 3]);
    expect(audits).toEqual([{ organizationId, runId, userId, access: 'support' }]);
    controller.abort();
  });

  it('fails closed before streaming when the support audit is rejected', async () => {
    // Break caught: support visibility is granted even though its mandatory
    // cross-tenant audit evidence could not be persisted.
    await startApp({
      supportAccess: {
        decide: () => Promise.resolve({ access: 'support' }),
        audit: () => Promise.reject(new Error('audit unavailable')),
      },
    });
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
      headers: requestHeaders(),
    });
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/event-stream');
  });

  it('does not let an ordinary session elevate through the query string', async () => {
    // Break caught: adding a support=true query backdoor creates an unaudited product role.
    await insertEvents([{ sequence: 1, visibility: 'support' }]);
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/events?support=true`, {
      headers: requestHeaders(),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/event-stream');
  });

  it('writes a heartbeat comment on the exact 15-second interval', async () => {
    // Break caught: omitting the heartbeat lets intermediaries silently reap an idle stream.
    const timers = new ManualTimers();
    await startApp({ timers });
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });
    timers.fire(SSE_HEARTBEAT_INTERVAL_MS, 'interval');
    expect(await readBlock(response)).toBe(': heartbeat');
    controller.abort();
  });

  it('contains heartbeat write and rejected diagnostic failures while cleaning resources', async () => {
    // Break caught: a socket write throw or rejected diagnostic hook escapes as
    // an unhandled rejection and strands the Redis subscription/timers.
    const timers = new ManualTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const writeSpy = vi.spyOn(ServerResponse.prototype, 'write');
    writeSpy.mockImplementation(function (this: ServerResponse) {
      writeSpy.mockRestore();
      throw new Error('socket write failed');
    });
    await startApp({
      timers,
      onError: () => Promise.reject(new Error('diagnostic rejected')),
    });
    try {
      const response = await connect();
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error('SSE response has no body');
      timers.fire(SSE_HEARTBEAT_INTERVAL_MS, 'interval');
      expect((await reader.read()).done).toBe(true);
      await eventually(() => {
        expect(wakeups.closed).toBe(1);
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(timers.cleared).toHaveLength(2);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('uses CP-14 exact 2,000ms polling when Redis is unavailable', async () => {
    // Break caught: an unavailable subscription either terminates the stream or
    // polls at a divergent interval from the CP-14 contract.
    vi.spyOn(wakeups, 'subscribe').mockRejectedValue(new Error('redis unavailable'));
    let releasePoll!: () => void;
    const delays: number[] = [];
    await startApp({
      sleep: (delayMs) => {
        delays.push(delayMs);
        return new Promise<void>((resolve) => {
          releasePoll = resolve;
        });
      },
    });
    const controller = new AbortController();
    const response = await connect({ after: '1', signal: controller.signal });
    await insertEvents([2]);
    await eventually(() => {
      expect(delays).toEqual([2_000]);
    });
    releasePoll();
    expect((await readMessages(response, 1)).map((message) => message.id)).toEqual([2]);
    controller.abort();
  });

  it('does not read the database again while socket backpressure awaits drain', async () => {
    // Break caught: ignoring write(false) keeps tail-reading and grows unbounded memory.
    await insertEvents([1]);
    let blockedResponse: ServerResponse | undefined;
    const captureBlockedResponse = (response: ServerResponse): void => {
      blockedResponse = response;
    };
    let blocked = false;
    const writeSpy = vi.spyOn(ServerResponse.prototype, 'write');
    writeSpy.mockImplementation(function (this: ServerResponse, chunk: unknown) {
      writeSpy.mockRestore();
      if (typeof chunk !== 'string') throw new Error('Expected an SSE string write');
      const result = this.write(chunk);
      if (!blocked && chunk.startsWith('id: 1')) {
        blocked = true;
        captureBlockedResponse(this);
        return false;
      }
      return result;
    });
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });
    await eventually(() => {
      expect(blocked).toBe(true);
    });
    await insertEvents([2]);
    wakeups.emit('{"sequence":2}');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(eventReadCount).toBe(1);
    blockedResponse?.emit('drain');
    expect((await readMessages(response, 2)).map((message) => message.id)).toEqual([1, 2]);
    expect(blockedResponse?.listenerCount('drain')).toBe(0);
    controller.abort();
  });

  it('cleans the subscription and timers promptly on client disconnect', async () => {
    // Break caught: disconnect leaves Redis waiters/listeners and four-hour timers alive.
    const timers = new ManualTimers();
    await startApp({ timers });
    const controller = new AbortController();
    await connect({ signal: controller.signal });
    await eventually(() => {
      expect(wakeups.pendingCount).toBe(1);
    });
    controller.abort();
    await eventually(() => {
      expect(wakeups.closed).toBe(1);
    });
    expect(timers.cleared).toHaveLength(2);
  });

  it('ends the stream and cleans resources at the four-hour cap', async () => {
    // Break caught: removing the lifetime cap leaves immortal subscriptions behind.
    const timers = new ManualTimers();
    await startApp({ timers });
    const response = await connect();
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE response has no body');
    timers.fire(SSE_MAX_CONNECTION_MS, 'timeout');
    expect((await reader.read()).done).toBe(true);
    await eventually(() => {
      expect(wakeups.closed).toBe(1);
    });
    expect(timers.cleared).toHaveLength(2);
  });

  it('contains malformed ping rejections and falls back without accumulating waiters', async () => {
    // Break caught: JSON/Zod rejection escapes as unhandled, or each poll cycle
    // allocates another unresolved subscription.next promise.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    let releasePoll!: () => void;
    const delays: number[] = [];
    await startApp({
      sleep: (delayMs) => {
        delays.push(delayMs);
        return new Promise<void>((resolve) => {
          releasePoll = resolve;
        });
      },
    });
    try {
      const controller = new AbortController();
      const response = await connect({ after: '1', signal: controller.signal });
      wakeups.emit('{not-json');
      await eventually(() => {
        expect(delays).toEqual([2_000]);
      });
      expect(wakeups.pendingCount).toBe(0);
      await insertEvents([2]);
      releasePoll();
      expect((await readMessages(response, 1)).map((message) => message.id)).toEqual([2]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      controller.abort();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  function requestHeaders(input: { lastEventId?: string } = {}): Record<string, string> {
    return {
      accept: 'text/event-stream',
      authorization,
      [ORGANIZATION_HEADER]: organizationId,
      ...(input.lastEventId === undefined ? {} : { 'last-event-id': input.lastEventId }),
    };
  }

  async function connect(input: {
    after?: string;
    lastEventId?: string;
    signal?: AbortSignal;
  } = {}): Promise<Response> {
    const response = await fetch(
      `${baseUrl}/v1/runs/${runId}/events${input.after === undefined ? '' : `?after=${input.after}`}`,
      {
        headers: requestHeaders(
          input.lastEventId === undefined ? {} : { lastEventId: input.lastEventId },
        ),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    return response;
  }

  async function insertEvents(
    events: readonly (number | { sequence: number; visibility: 'user' | 'internal' | 'support' })[],
  ): Promise<void> {
    await database.db.insert(agentEvents).values(
      events.map((input) => {
        const sequence = typeof input === 'number' ? input : input.sequence;
        const visibility = typeof input === 'number' ? 'user' : input.visibility;
        return {
        id: newId('evt'),
        organizationId,
        runId,
        sequence,
        type: 'task.started' as const,
        payloadJson: { sequence },
        visibility,
        occurredAt: new Date(`2026-08-04T12:00:${String(sequence).padStart(2, '0')}.000Z`),
        projectId,
        phaseId: null,
        taskId: null,
        agentId: null,
        };
      }),
    );
  }
});
