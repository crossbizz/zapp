import { AgentEventSchema, newId } from '@zapp/contracts';
import { agentEvents, agentRuns, conversations, organizations, projects, users } from '@zapp/db';
import { OutgoingMessage, ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';
import { createInMemoryTokenDenylist, type TokenDenylist } from '../../src/auth/denylist.js';
import { createSessionSigner } from '../../src/auth/session.js';
import type {
  EventWakeupSource,
  EventWakeupSubscription,
  EventStreamDependencies,
  EventStreamTimerHandle,
  EventStreamTimers,
} from '../../src/events/sse.js';
import {
  SSE_AUTHORIZATION_INTERVAL_MS,
  SSE_AUTHORIZATION_TIMEOUT_MS,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_MAX_CONNECTION_MS,
} from '../../src/events/sse.js';
import { ORGANIZATION_HEADER } from '../../src/plugins/tenant.js';
import { createRedisConnection } from '../../src/redis/client.js';
import { createTenantDbFactory } from '../../src/tenant/db.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import { InMemoryUserStore, TEST_AUTH_CONFIG, TEST_RATE_LIMITS } from '../support/harness.js';
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
    const abort = (): void => {
      for (const waiter of this.pending.splice(0)) {
        waiter.reject(new Error('subscription aborted'));
      }
    };
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
      abort,
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

interface ManualTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  readonly kind: 'interval' | 'timeout';
  unref(): void;
}

class ManualTimers implements EventStreamTimers {
  readonly scheduled: ManualTimer[] = [];
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
    const timer = this.scheduled.find(
      (candidate) => candidate.delayMs === delayMs && candidate.kind === kind,
    );
    if (timer === undefined) throw new Error(`No ${kind} scheduled for ${String(delayMs)} ms`);
    timer.callback();
  }

  latest(delayMs: number, kind: 'interval' | 'timeout'): ManualTimer {
    const timer = this.scheduled
      .filter((candidate) => candidate.delayMs === delayMs && candidate.kind === kind)
      .at(-1);
    if (timer === undefined) throw new Error(`No ${kind} scheduled for ${String(delayMs)} ms`);
    return timer;
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

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function expectSettlesWithin(promise: Promise<unknown>, timeoutMs = 500): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Promise did not settle within ${String(timeoutMs)} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
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
  let accessJti: string;
  let accessExpiresAt: Date;
  let clock: Date;
  let denylist: TokenDenylist;
  let denylistHangs: boolean;
  let usersStore: InMemoryUserStore;
  let organizationStore: InMemoryOrganizationStore;
  let eventReadCount: number;
  let eventReadRanges: { readonly fromSequence?: number; readonly limit?: number }[];

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
    const conversationId = newId('conv');
    await database.db.insert(conversations).values({
      id: conversationId,
      organizationId,
      projectId,
      createdBy: userId,
      title: 'SSE test run',
    });
    await database.db.insert(agentRuns).values({
      id: runId,
      organizationId,
      projectId,
      conversationId,
      conversationRunNumber: 1,
      branchId: null,
      mode: 'build',
      requestFingerprint: `seed:${runId}`,
      status: 'running',
      specificationId: null,
      temporalWorkflowId: runId,
      startedBy: userId,
      budgetJson: null,
      planMaxCredits: '1000.0000',
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
    clock = new Date();
    const tokens = await createSessionSigner({
      secret: TEST_AUTH_CONFIG.sessionSecret,
    }).mintSession({
      userId,
      now: clock,
    });
    authorization = `Bearer ${tokens.access.token}`;
    accessJti = tokens.access.jti;
    accessExpiresAt = tokens.access.expiresAt;
    denylistHangs = false;
    const inMemoryDenylist = createInMemoryTokenDenylist(() => clock);
    denylist = {
      deny: async (key, expiresAt) => await inMemoryDenylist.deny(key, expiresAt),
      isDenied: async (...keys) => {
        if (denylistHangs) return await new Promise<boolean>(() => undefined);
        return await inMemoryDenylist.isDenied(...keys);
      },
    };

    eventReadCount = 0;
    eventReadRanges = [];
    await startApp();
  }, 120_000);

  async function startApp(
    eventStream: Partial<EventStreamDependencies> = {},
    hooks: {
      readonly beforeEventRead?: () => Promise<void>;
      readonly afterEventRead?: () => void;
    } = {},
  ): Promise<void> {
    if (app !== undefined) await app.close();
    const tenantDb = createTenantDbFactory(database.db);
    const nextApp = buildApp({
      logger: false,
      auth: {
        port: new FakeAuthPort(),
        users: usersStore,
        config: TEST_AUTH_CONFIG,
        denylist,
      },
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
                eventReadRanges.push({
                  ...(range?.fromSequence === undefined
                    ? {}
                    : { fromSequence: range.fromSequence }),
                  ...(range?.limit === undefined ? {} : { limit: range.limit }),
                });
                await hooks.beforeEventRead?.();
                const rows = await scoped.events.byRun(requestRunId, range);
                hooks.afterEventRead?.();
                return rows;
              },
            },
          };
        },
        eventStream: { wakeups, ...eventStream },
      },
      limits: { config: TEST_RATE_LIMITS },
      now: () => clock,
    });
    nextApp.addHook('onRequest', (_request, reply) => {
      reply.header('x-route-hook', 'preserved');
      return Promise.resolve();
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
    expect(response.headers.get('x-route-hook')).toBe('preserved');

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

  it('replays typed user and assistant messages in sequence order', async () => {
    await insertEvents([
      {
        sequence: 1,
        visibility: 'user',
        type: 'message.user',
        payload: {
          messageId: 'msg_01J8ME7YQZJ2V9Q0X3T5B6K7NF',
          content: 'Make the hero concise.',
          attachments: [],
          source: 'api',
        },
      },
      {
        sequence: 2,
        visibility: 'user',
        type: 'message.assistant',
        payload: {
          messageId: 'msg_01J8ME7YQZJ2V9Q0X3T5B6K7NG',
          turnId: 'turn_01J8ME7YQZJ2V9Q0X3T5B6K7NH',
          content: 'Done.',
          model: 'anthropic/claude-sonnet-5',
        },
      },
    ]);
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });
    const messages = await readMessages(response, 2);
    controller.abort();

    expect(messages.map((message) => message.id)).toEqual([1, 2]);
    expect(messages.map((message) => AgentEventSchema.parse(message.data).type)).toEqual([
      'message.user',
      'message.assistant',
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
      headers: requestHeaders(kind === 'Last-Event-ID' ? { lastEventId: value } : {}),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/event-stream');
    expect(eventReadRanges).toEqual([]);
  });

  it('queries safely from the highest incrementable cursor', async () => {
    // Break caught: rejecting the whole safe-integer boundary loses a valid
    // resume point; adding one twice sends an unsafe number to PostgreSQL.
    const controller = new AbortController();
    await connect({ after: '9007199254740990', signal: controller.signal });
    await eventually(() => {
      expect(eventReadRanges).toEqual([{ fromSequence: Number.MAX_SAFE_INTEGER, limit: 100 }]);
    });
    controller.abort();
  });

  it('never increments a stored maximum-safe sequence for another replay page', async () => {
    await insertEvents([
      ...Array.from({ length: 99 }, (_value, index) => index + 1),
      Number.MAX_SAFE_INTEGER,
    ]);
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });
    expect((await readMessages(response, 100, 5_000)).map((message) => message.id)).toEqual([
      ...Array.from({ length: 99 }, (_value, index) => index + 1),
      Number.MAX_SAFE_INTEGER,
    ]);
    await eventually(() => {
      expect(eventReadRanges).toEqual([{ fromSequence: 1, limit: 100 }]);
    });
    controller.abort();
  });

  it.each(['after', 'Last-Event-ID'])('accepts a maximum-safe %s resume cursor', async (kind) => {
    // Break caught: the server can emit MAX_SAFE_INTEGER, so rejecting it on
    // reconnect makes the last successfully delivered event non-resumable.
    const controller = new AbortController();
    const response = await connect({
      ...(kind === 'after'
        ? { after: String(Number.MAX_SAFE_INTEGER) }
        : { lastEventId: String(Number.MAX_SAFE_INTEGER) }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(eventReadRanges).toEqual([]);
    controller.abort();
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

  it('uses exact, then type wildcard, then global wildcard Accept quality', async () => {
    // Break caught: choosing the largest q across matching ranges lets */* undo
    // an explicit text/event-stream refusal.
    const refused = ['text/event-stream;q=0, */*;q=1', 'text/*;q=0, */*;q=1', '*/*;q=0'];
    for (const accept of refused) {
      const response = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
        headers: { ...requestHeaders(), accept },
      });
      expect(response.status, accept).toBe(406);
    }

    const permitted = [
      'text/event-stream;q=0.2, text/*;q=0, */*;q=0',
      'text/*;q=0.2, */*;q=0',
      '*/*;q=0.2',
    ];
    let closedStreams = wakeups.closed;
    for (const accept of permitted) {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
        headers: { ...requestHeaders(), accept },
        signal: controller.signal,
      });
      expect(response.status, accept).toBe(200);
      const cancellation = cancelResponseBody(response);
      controller.abort();
      await expectSettlesWithin(cancellation);
      closedStreams += 1;
      await eventually(() => {
        expect(wakeups.closed).toBe(closedStreams);
      });
    }
  });

  it('uses matching media parameters before q as Accept specificity', async () => {
    // Break caught: the emitted representation is text/event-stream;charset=utf-8.
    // A matching parameterized refusal outranks the unparameterized fallback.
    const refused = [
      'text/event-stream;charset=utf-8;q=0, text/event-stream;q=1',
      'text/event-stream;charset="utf-8";q=0, text/event-stream;q=1',
      'text/event-stream;foo=bar;q=1, text/event-stream;q=0',
    ];
    for (const accept of refused) {
      const response = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
        headers: { ...requestHeaders(), accept },
      });
      expect(response.status, accept).toBe(406);
    }

    const permitted = [
      'text/event-stream;charset=utf-8;q=1, text/event-stream;q=0',
      'text/event-stream;charset="UTF-8";q=1, text/event-stream;q=0',
      'text/event-stream;q=1;trace',
      'text/event-stream;q=1;extension=accepted',
      'text/event-stream;q=1;extension="quoted value"',
      'text/event-stream;q=1;extension="quoted, value; one range"',
    ];
    let closedStreams = wakeups.closed;
    for (const accept of permitted) {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
        headers: { ...requestHeaders(), accept },
        signal: controller.signal,
      });
      expect(response.status, accept).toBe(200);
      const cancellation = cancelResponseBody(response);
      controller.abort();
      await expectSettlesWithin(cancellation);
      closedStreams += 1;
      await eventually(() => {
        expect(wakeups.closed).toBe(closedStreams);
      });
    }
  });

  it('does not let an aborted replay cancel a later stream lookup', async () => {
    // Break caught: releasing the replay's reserved PostgreSQL connection before
    // its CancelRequest settles lets that request cancel a later run lookup on
    // the same backend, turning a valid rapid reconnect into HTTP 500.
    await startApp({
      concurrencyLimits: { perUser: 100, perOrganization: 100, perProcess: 100 },
    });
    const firstController = new AbortController();
    const firstResponse = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
      headers: requestHeaders(),
      signal: firstController.signal,
    });
    expect(firstResponse.status, 'aborted replay').toBe(200);
    const firstCancellation = cancelResponseBody(firstResponse);
    firstController.abort();

    const reconnectController = new AbortController();
    const reconnectResponse = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
      headers: requestHeaders(),
      signal: reconnectController.signal,
    });
    expect(reconnectResponse.status, 'rapid reconnect').toBe(200);
    const reconnectCancellation = cancelResponseBody(reconnectResponse);
    reconnectController.abort();

    await expectSettlesWithin(Promise.all([firstCancellation, reconnectCancellation]), 500);
    await eventually(() => {
      expect(wakeups.pendingCount).toBe(0);
    });
  }, 10_000);

  it.each([
    'text/event-stream;q=wat',
    'text/event-stream;q=1.001',
    'text/event-stream;q=0.1234',
    'text/event-stream;q=0;q=1',
    'text/event-stream;broken',
    'text/event-stream;charset="utf-8',
    'text/event-stream;q=1;extension="broken\\"',
  ])('returns 406 for malformed Accept value %s', async (accept) => {
    // Break caught: Number coercion or ignored malformed parameters negotiates
    // an SSE stream from an invalid Accept field.
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
      headers: { ...requestHeaders(), accept },
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
      expect(timers.cleared).toHaveLength(3);
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

  it('closes an idle active stream before Fastify waits for its handler', async () => {
    // Break caught: removing route-level preClose cleanup makes app.close wait
    // forever for an idle SSE handler that is itself waiting on Redis.
    const timers = new ManualTimers();
    await startApp({ timers });
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });
    await eventually(() => {
      expect(wakeups.pendingCount).toBe(1);
    });

    const closePromise = app?.close();
    if (closePromise === undefined) throw new Error('SSE app was not started');
    let settled = false;
    try {
      await expectSettlesWithin(closePromise);
      settled = true;
    } finally {
      if (!settled) controller.abort();
      await closePromise;
      await cancelResponseBody(response);
      controller.abort();
    }

    expect(wakeups.closed).toBe(1);
    expect(timers.cleared).toHaveLength(3);
    expect(new Set(timers.cleared).size).toBe(3);
  });

  it('closes a backpressured active stream before Fastify waits for its handler', async () => {
    // Break caught: shutdown aborts only ordinary waiters and strands a handler
    // waiting for drain, so app.close never settles under socket pressure.
    await insertEvents([1]);
    const timers = new ManualTimers();
    await startApp({ timers });
    let blockedResponse: ServerResponse | undefined;
    const captureBlockedResponse = (response: ServerResponse): void => {
      blockedResponse = response;
    };
    const writeSpy = vi.spyOn(ServerResponse.prototype, 'write');
    writeSpy.mockImplementation(function (this: ServerResponse, chunk: unknown) {
      writeSpy.mockRestore();
      if (typeof chunk !== 'string') throw new Error('Expected an SSE string write');
      this.write(chunk);
      captureBlockedResponse(this);
      return false;
    });
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });
    await eventually(() => {
      expect(blockedResponse).toBeDefined();
    });

    const closePromise = app?.close();
    if (closePromise === undefined) throw new Error('SSE app was not started');
    let settled = false;
    try {
      await expectSettlesWithin(closePromise);
      settled = true;
    } finally {
      if (!settled) {
        blockedResponse?.emit('drain');
        controller.abort();
      }
      await closePromise;
      await cancelResponseBody(response);
      controller.abort();
    }

    expect(wakeups.closed).toBe(1);
    expect(timers.cleared).toHaveLength(3);
    expect(new Set(timers.cleared).size).toBe(3);
    expect(blockedResponse?.listenerCount('drain')).toBe(0);
  });

  it('closes the app when wakeup subscription setup never settles', async () => {
    // Break caught: aborting only the live-tail loop cannot release a handler
    // still awaiting a provider whose subscribe promise never settles.
    const never = new Promise<EventWakeupSubscription>(() => undefined);
    let subscriptionSetupAborted = false;
    await startApp({
      wakeups: {
        subscribe: (_channel, signal) => {
          signal.addEventListener(
            'abort',
            () => {
              subscriptionSetupAborted = true;
            },
            { once: true },
          );
          return never;
        },
      },
      cleanupTimeoutMs: 25,
    });
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });

    const closePromise = app?.close();
    if (closePromise === undefined) throw new Error('SSE app was not started');
    await expectSettlesWithin(closePromise);
    expect(subscriptionSetupAborted).toBe(true);
    await cancelResponseBody(response);
    controller.abort();
  });

  it('bounds a provider close that never settles during app shutdown', async () => {
    // Break caught: preClose waits for stream completion, so an unbounded
    // provider close turns graceful shutdown into an infinite wait.
    const errors: Error[] = [];
    const forceAbort = vi.fn();
    await startApp({
      wakeups: {
        subscribe: () =>
          Promise.resolve({
            next: () => new Promise<unknown>(() => undefined),
            close: () => new Promise<void>(() => undefined),
            abort: forceAbort,
          }),
      },
      cleanupTimeoutMs: 25,
      onError: (error) => {
        errors.push(error);
      },
    });
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });

    const closePromise = app?.close();
    if (closePromise === undefined) throw new Error('SSE app was not started');
    await expectSettlesWithin(closePromise);
    expect(errors.map((error) => error.message)).toContain(
      'event wakeup subscription close exceeded 25 ms',
    );
    expect(forceAbort).toHaveBeenCalledOnce();
    await cancelResponseBody(response);
    controller.abort();
  });

  it('replays bounded pages in database order without gaps or duplicates', async () => {
    // Break caught: omitting the fixed limit materializes a run's complete event
    // history in one read instead of advancing through bounded database pages.
    await insertEvents(Array.from({ length: 205 }, (_value, index) => index + 1));
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });
    const messages = await readMessages(response, 205, 5_000);
    controller.abort();

    expect(messages.map((message) => message.id)).toEqual(
      Array.from({ length: 205 }, (_value, index) => index + 1),
    );
    expect(eventReadRanges).toEqual([
      { fromSequence: 1, limit: 100 },
      { fromSequence: 101, limit: 100 },
      { fromSequence: 201, limit: 100 },
    ]);
  });

  it('advances through a full hidden-only page to the next visible event', async () => {
    // Break caught: stopping when a page emits no frames strands the cursor on
    // 100 internal rows and never reaches the user-visible event on page two.
    await insertEvents([
      ...Array.from({ length: 100 }, (_value, index) => ({
        sequence: index + 1,
        visibility: 'internal' as const,
      })),
      { sequence: 101, visibility: 'user' },
    ]);
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });
    expect((await readMessages(response, 1)).map((message) => message.id)).toEqual([101]);
    controller.abort();

    expect(eventReadRanges).toEqual([
      { fromSequence: 1, limit: 100 },
      { fromSequence: 101, limit: 100 },
    ]);
  });

  it('does not fetch the next replay page while an event frame owns pressure', async () => {
    // Break caught: page iteration continues after write(false), reading page
    // two before the socket has accepted page one's first frame.
    await insertEvents(Array.from({ length: 101 }, (_value, index) => index + 1));
    let blockedResponse: ServerResponse | undefined;
    const captureBlockedResponse = (response: ServerResponse): void => {
      blockedResponse = response;
    };
    const writeSpy = vi.spyOn(ServerResponse.prototype, 'write');
    writeSpy.mockImplementation(function (this: ServerResponse, chunk: unknown) {
      if (typeof chunk !== 'string') throw new Error('Expected an SSE string write');
      const result = OutgoingMessage.prototype.write.call(this, chunk, 'utf8');
      if (blockedResponse === undefined && chunk.startsWith('id:')) {
        captureBlockedResponse(this);
        return false;
      }
      return result;
    });
    const controller = new AbortController();
    const response = await connect({ signal: controller.signal });
    await eventually(() => {
      expect(blockedResponse).toBeDefined();
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(eventReadRanges).toEqual([{ fromSequence: 1, limit: 100 }]);

    blockedResponse?.emit('drain');
    expect((await readMessages(response, 101, 5_000)).map((message) => message.id)).toEqual(
      Array.from({ length: 101 }, (_value, index) => index + 1),
    );
    expect(eventReadRanges).toEqual([
      { fromSequence: 1, limit: 100 },
      { fromSequence: 101, limit: 100 },
    ]);
    controller.abort();
  });

  it('does not write events or fetch another page while a heartbeat owns pressure', async () => {
    // Break caught: a heartbeat write(false) racing an in-flight DB read lets
    // event frames and the next replay page bypass the shared pressure gate.
    await insertEvents(Array.from({ length: 101 }, (_value, index) => index + 1));
    const timers = new ManualTimers();
    let readStarted!: () => void;
    let releaseRead!: () => void;
    let readFinished!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      readFinished = resolve;
    });
    await startApp(
      { timers },
      {
        beforeEventRead: () => {
          readStarted();
          return release;
        },
        afterEventRead: readFinished,
      },
    );

    let blockedResponse: ServerResponse | undefined;
    const captureBlockedResponse = (response: ServerResponse): void => {
      blockedResponse = response;
    };
    let heartbeatWrites = 0;
    let eventWrites = 0;
    const writeSpy = vi.spyOn(ServerResponse.prototype, 'write');
    writeSpy.mockImplementation(function (this: ServerResponse, chunk: unknown) {
      if (typeof chunk !== 'string') throw new Error('Expected an SSE string write');
      const result = OutgoingMessage.prototype.write.call(this, chunk, 'utf8');
      if (chunk.startsWith(': heartbeat')) {
        heartbeatWrites += 1;
        if (blockedResponse === undefined) {
          captureBlockedResponse(this);
          return false;
        }
      }
      if (chunk.startsWith('id:')) eventWrites += 1;
      return result;
    });

    const controller = new AbortController();
    const responsePromise = connect({ signal: controller.signal });
    await started;
    await responsePromise;
    timers.fire(SSE_HEARTBEAT_INTERVAL_MS, 'interval');
    await eventually(() => {
      expect(blockedResponse).toBeDefined();
    });
    timers.fire(SSE_HEARTBEAT_INTERVAL_MS, 'interval');
    timers.fire(SSE_HEARTBEAT_INTERVAL_MS, 'interval');
    releaseRead();

    try {
      await finished;
      await new Promise((resolve) => setImmediate(resolve));
      expect(heartbeatWrites).toBe(1);
      expect(eventWrites).toBe(0);
      expect(eventReadRanges).toEqual([{ fromSequence: 1, limit: 100 }]);

      blockedResponse?.emit('drain');
      await eventually(() => {
        expect(eventWrites).toBeGreaterThan(0);
        expect(eventReadRanges).toEqual([
          { fromSequence: 1, limit: 100 },
          { fromSequence: 101, limit: 100 },
        ]);
      });
    } finally {
      blockedResponse?.emit('drain');
      controller.abort();
    }
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
    }, 5_000);
    controller.abort();
    await eventually(() => {
      expect(wakeups.closed).toBe(1);
    }, 5_000);
    expect(timers.cleared).toHaveLength(3);
  });

  it.each([
    ['user', { perUser: 1, perOrganization: 8, perProcess: 8 }],
    ['organization', { perUser: 8, perOrganization: 1, perProcess: 8 }],
    ['process', { perUser: 8, perOrganization: 8, perProcess: 1 }],
  ] as const)('rejects a second stream at the %s concurrent limit', async (_scope, limits) => {
    // Break caught: request-rate limits permit a burst of long-lived streams,
    // each of which otherwise owns a Redis subscriber for four hours.
    await startApp({ concurrencyLimits: limits });
    const controller = new AbortController();
    const rejectedController = new AbortController();
    try {
      await connect({ signal: controller.signal });
      await eventually(() => {
        expect(wakeups.pendingCount).toBe(1);
      });

      const rejected = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
        headers: requestHeaders(),
        signal: rejectedController.signal,
      });
      expect(rejected.status).toBe(429);
      await expect(rejected.json()).resolves.toMatchObject({
        error: { code: 'event_stream_limit' },
      });
    } finally {
      rejectedController.abort();
      controller.abort();
    }
  });

  it('ends an active stream when its session is revoked', async () => {
    // Break caught: the opening preHandler was the only denylist check, so a
    // logout kept receiving future tenant events for four hours.
    const timers = new ManualTimers();
    await startApp({ timers });
    const response = await connect();
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE response has no body');
    await eventually(() => {
      expect(wakeups.pendingCount).toBe(1);
    });

    await denylist.deny(accessJti, accessExpiresAt);
    timers.fire(SSE_AUTHORIZATION_INTERVAL_MS, 'interval');
    await eventually(() => {
      expect(wakeups.closed).toBe(1);
    });
    expect((await reader.read()).done).toBe(true);
  });

  it('ends an active stream when its organization membership is removed', async () => {
    // Break caught: retaining the tenant-scoped handle after removal bypassed
    // the membership lookup that every new request performs.
    const timers = new ManualTimers();
    await startApp({ timers });
    const response = await connect();
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE response has no body');
    await eventually(() => {
      expect(wakeups.pendingCount).toBe(1);
    });

    organizationStore.memberships.set(`${organizationId}\u0000${userId}`, {
      organizationId,
      userId,
      role: 'owner',
      status: 'removed',
    });
    timers.fire(SSE_AUTHORIZATION_INTERVAL_MS, 'interval');
    await eventually(() => {
      expect(wakeups.closed).toBe(1);
    });
    expect((await reader.read()).done).toBe(true);
  });

  it('ends an active stream when its access token expires', async () => {
    const timers = new ManualTimers();
    await startApp({ timers });
    const response = await connect();
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE response has no body');
    await eventually(() => {
      expect(wakeups.pendingCount).toBe(1);
    });

    clock = new Date(accessExpiresAt.getTime() + 1);
    timers.fire(SSE_AUTHORIZATION_INTERVAL_MS, 'interval');
    const authorizationDeadline = timers.latest(SSE_AUTHORIZATION_TIMEOUT_MS, 'timeout');
    await eventually(() => {
      expect(wakeups.closed).toBe(1);
    });
    expect((await reader.read()).done).toBe(true);
    expect(timers.cleared).toContain(authorizationDeadline);
  });

  it('fails closed when active stream revalidation never settles', async () => {
    const timers = new ManualTimers();
    await startApp({ timers });
    const response = await connect();
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE response has no body');
    await eventually(() => {
      expect(wakeups.pendingCount).toBe(1);
    });

    denylistHangs = true;
    timers.fire(SSE_AUTHORIZATION_INTERVAL_MS, 'interval');
    const authorizationDeadline = timers.latest(SSE_AUTHORIZATION_TIMEOUT_MS, 'timeout');
    timers.fire(SSE_AUTHORIZATION_TIMEOUT_MS, 'timeout');
    await eventually(() => {
      expect(wakeups.closed).toBe(1);
    });
    expect((await reader.read()).done).toBe(true);
    expect(timers.cleared).toContain(authorizationDeadline);
  });

  it('clears the authorization deadline and abort listener when the client closes mid-check', async () => {
    const timers = new ManualTimers();
    const errors: Error[] = [];
    await startApp({
      timers,
      onError: (error) => {
        errors.push(error);
      },
    });
    const controller = new AbortController();
    await connect({ signal: controller.signal });
    await eventually(() => {
      expect(wakeups.pendingCount).toBe(1);
    });

    denylistHangs = true;
    const addAbort = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    const removeAbort = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    timers.fire(SSE_AUTHORIZATION_INTERVAL_MS, 'interval');
    const authorizationDeadline = timers.latest(SSE_AUTHORIZATION_TIMEOUT_MS, 'timeout');
    const authorizationAbortListeners = addAbort.mock.calls
      .filter(([type]) => type === 'abort')
      .map(([, listener]) => listener);
    expect(authorizationAbortListeners).toHaveLength(1);

    controller.abort();
    await eventually(() => {
      expect(wakeups.closed).toBe(1);
    });
    expect(timers.cleared).toContain(authorizationDeadline);
    expect(
      authorizationAbortListeners.every((listener) =>
        removeAbort.mock.calls.some(
          ([type, removedListener]) => type === 'abort' && removedListener === listener,
        ),
      ),
    ).toBe(true);

    authorizationDeadline.callback();
    await Promise.resolve();
    expect(errors).toEqual([]);
  });

  it('ends a support stream when support access is lost', async () => {
    const timers = new ManualTimers();
    let support = true;
    await startApp({
      timers,
      supportAccess: {
        decide: () => Promise.resolve({ access: support ? 'support' : 'user' }),
        audit: () => Promise.resolve(),
      },
    });
    const response = await connect();
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE response has no body');
    await eventually(() => {
      expect(wakeups.pendingCount).toBe(1);
    });

    support = false;
    timers.fire(SSE_AUTHORIZATION_INTERVAL_MS, 'interval');
    await eventually(() => {
      expect(wakeups.closed).toBe(1);
    });
    expect((await reader.read()).done).toBe(true);
  });

  it('fails closed when active support access revalidation never settles', async () => {
    const timers = new ManualTimers();
    let decisions = 0;
    await startApp({
      timers,
      supportAccess: {
        decide: () => {
          decisions += 1;
          return decisions === 1
            ? Promise.resolve({ access: 'support' })
            : new Promise<never>(() => undefined);
        },
        audit: () => Promise.resolve(),
      },
    });
    const response = await connect();
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE response has no body');
    await eventually(() => {
      expect(wakeups.pendingCount).toBe(1);
    });

    timers.fire(SSE_AUTHORIZATION_INTERVAL_MS, 'interval');
    timers.fire(SSE_AUTHORIZATION_TIMEOUT_MS, 'timeout');
    await eventually(() => {
      expect(wakeups.closed).toBe(1);
    });
    expect((await reader.read()).done).toBe(true);
  });

  it('closes promptly while an event database read is stalled', async () => {
    // Break caught: abandoning the route's Drizzle promise let app.close()
    // return while the real PostgreSQL query and its pool connection survived.
    let markLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lock = database.sql.begin(async (sql) => {
      await sql.unsafe('lock table agent_events in access exclusive mode');
      markLocked();
      await release;
    });
    await locked;

    const blockedReplayCount = async (): Promise<number> => {
      const [row] = await database.sql<{ count: number }[]>`
        select count(*)::int as count
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike '%agent_events%'
      `;
      return row?.count ?? 0;
    };

    try {
      await connect();
      await eventually(async () => {
        expect(await blockedReplayCount()).toBe(1);
      });
      const activeApp = app;
      if (activeApp === undefined) throw new Error('SSE app did not start');
      await activeApp.close();
      await eventually(async () => {
        expect(await blockedReplayCount()).toBe(0);
      });
    } finally {
      releaseLock();
      await lock;
    }
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
    expect(timers.cleared).toHaveLength(3);
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

  async function connect(
    input: {
      after?: string;
      lastEventId?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
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
    events: readonly (
      | number
      | {
          sequence: number;
          visibility: 'user' | 'internal' | 'support';
          type?: 'task.started' | 'message.user' | 'message.assistant';
          payload?: Record<string, unknown>;
        }
    )[],
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
          type: typeof input === 'number' ? ('task.started' as const) : (input.type ?? 'task.started'),
          payloadJson: typeof input === 'number' ? { sequence } : (input.payload ?? { sequence }),
          visibility,
          occurredAt: new Date(Date.UTC(2026, 7, 4, 12, 0, 0, sequence % 1_000)),
          projectId,
          phaseId: null,
          taskId: null,
          agentId: null,
        };
      }),
    );
  }
});
