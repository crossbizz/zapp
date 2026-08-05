import { AgentEventSchema, idSchema } from '@zapp/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { waitForEventWakeup } from './publisher.js';

const RunParamsSchema = z.object({ runId: idSchema('run') }).strict();
const CursorSchema = z.coerce.number().int().nonnegative().safe();
const EventStreamQuerySchema = z.object({ after: z.string().optional() }).strict();
const EventPingSchema = z.object({ sequence: z.number().int().positive().safe() }).strict();
const EventAccessDecisionSchema = z
  .object({ access: z.enum(['user', 'support']) })
  .strict();
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const QUALITY_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_MAX_CONNECTION_MS = 4 * 60 * 60 * 1_000;
const SSE_REPLAY_PAGE_SIZE = 100;
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;
const EVENT_STREAM_MEDIA_PARAMETERS = new Map([['charset', 'utf-8']]);

export interface EventWakeupSubscription {
  next(): Promise<unknown>;
  close(): Promise<void>;
  /** Synchronously releases provider resources when graceful close cannot. */
  abort(): void;
}

export interface EventWakeupSource {
  subscribe(channel: string, signal: AbortSignal): Promise<EventWakeupSubscription>;
}

export interface EventStreamAccessContext {
  readonly organizationId: string;
  readonly runId: string;
  readonly userId: string;
}

export interface EventStreamSupportAccess {
  decide(context: EventStreamAccessContext): Promise<unknown>;
  audit(context: EventStreamAccessContext & { readonly access: 'support' }): Promise<void>;
}

export type EventStreamTimerHandle = { unref?(): void } | NodeJS.Timeout;

export interface EventStreamTimers {
  setInterval(callback: () => void, delayMs: number): EventStreamTimerHandle;
  clearInterval(handle: EventStreamTimerHandle): void;
  setTimeout(callback: () => void, delayMs: number): EventStreamTimerHandle;
  clearTimeout(handle: EventStreamTimerHandle): void;
}

export interface EventStreamDependencies {
  readonly wakeups: EventWakeupSource;
  readonly supportAccess?: EventStreamSupportAccess;
  readonly onError?: (error: Error) => unknown;
  readonly timers?: EventStreamTimers;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Bounds provider cleanup so one broken subscriber cannot block app.close(). */
  readonly cleanupTimeoutMs?: number;
}

export interface RunEventStreamRouteDependencies {
  readonly eventStream: EventStreamDependencies;
}

type RequestTenantDb = ReturnType<typeof tenantOf>['db'];
type StoredAgentEvent = Awaited<ReturnType<RequestTenantDb['events']['byRun']>>[number];

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function splitOutsideQuotedStrings(value: string, delimiter: ',' | ';'): string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) return undefined;
  parts.push(value.slice(start));
  return parts;
}

function isQuotedText(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x20 ||
    code === 0x21 ||
    (code >= 0x23 && code <= 0x5b) ||
    (code >= 0x5d && code <= 0x7e) ||
    (code >= 0x80 && code <= 0xff)
  );
}

function isQuotedPair(code: number): boolean {
  return code === 0x09 || code === 0x20 || (code >= 0x21 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
}

function parseHttpParameterValue(value: string): string | undefined {
  if (HTTP_TOKEN.test(value)) return value;
  if (value.length < 2 || value[0] !== '"' || value.at(-1) !== '"') return undefined;
  let parsed = '';
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character === '\\') {
      index += 1;
      if (index >= value.length - 1) return undefined;
      const escaped = value[index];
      if (escaped === undefined || !isQuotedPair(escaped.charCodeAt(0))) return undefined;
      parsed += escaped;
      continue;
    }
    if (character === undefined || !isQuotedText(character.charCodeAt(0))) return undefined;
    parsed += character;
  }
  return parsed;
}

function acceptsEventStream(value: string | undefined): boolean {
  if (value === undefined) return false;
  const entries = splitOutsideQuotedStrings(value, ',');
  if (entries === undefined) return false;
  let selected:
    | {
        readonly typeSpecificity: number;
        readonly parameterSpecificity: number;
        readonly quality: number;
      }
    | undefined;
  for (const rawEntry of entries) {
    const segments = splitOutsideQuotedStrings(rawEntry, ';');
    if (segments === undefined) return false;
    const [rawMediaRange, ...parameters] = segments;
    const mediaRange = rawMediaRange?.trim().toLowerCase();
    if (mediaRange === undefined || mediaRange === '') return false;
    const slash = mediaRange.indexOf('/');
    if (slash <= 0 || slash !== mediaRange.lastIndexOf('/')) return false;
    const type = mediaRange.slice(0, slash);
    const subtype = mediaRange.slice(slash + 1);
    if (
      (type !== '*' && !HTTP_TOKEN.test(type)) ||
      (subtype !== '*' && !HTTP_TOKEN.test(subtype)) ||
      (type === '*' && subtype !== '*')
    ) {
      return false;
    }

    let quality = 1;
    let qualitySeen = false;
    const mediaParameters = new Map<string, string>();
    for (const rawParameter of parameters) {
      const parameter = rawParameter.trim();
      const equals = parameter.indexOf('=');
      if (equals < 0) {
        if (!qualitySeen || !HTTP_TOKEN.test(parameter)) return false;
        continue;
      }
      if (equals === 0) return false;
      const name = parameter.slice(0, equals).trim();
      const rawParameterValue = parameter.slice(equals + 1).trim();
      if (!HTTP_TOKEN.test(name) || rawParameterValue === '') return false;
      if (name.toLowerCase() === 'q') {
        if (qualitySeen || !QUALITY_VALUE.test(rawParameterValue)) return false;
        qualitySeen = true;
        quality = Number(rawParameterValue);
      } else {
        const parameterValue = parseHttpParameterValue(rawParameterValue);
        if (parameterValue === undefined) return false;
        if (qualitySeen) continue;
        const normalizedName = name.toLowerCase();
        if (mediaParameters.has(normalizedName)) return false;
        mediaParameters.set(normalizedName, parameterValue.toLowerCase());
      }
    }

    const typeSpecificity =
      type === 'text' && subtype === 'event-stream'
        ? 2
        : type === 'text' && subtype === '*'
          ? 1
          : type === '*' && subtype === '*'
            ? 0
            : undefined;
    if (typeSpecificity === undefined) continue;
    const parametersMatch = [...mediaParameters].every(([name, parameterValue]) => {
      return EVENT_STREAM_MEDIA_PARAMETERS.get(name) === parameterValue;
    });
    if (!parametersMatch) continue;
    const parameterSpecificity = mediaParameters.size;
    if (
      selected === undefined ||
      typeSpecificity > selected.typeSpecificity ||
      (typeSpecificity === selected.typeSpecificity &&
        parameterSpecificity > selected.parameterSpecificity)
    ) {
      selected = { typeSpecificity, parameterSpecificity, quality };
    } else if (
      typeSpecificity === selected.typeSpecificity &&
      parameterSpecificity === selected.parameterSpecificity &&
      quality > selected.quality
    ) {
      selected = { typeSpecificity, parameterSpecificity, quality };
    }
  }
  return selected !== undefined && selected.quality > 0;
}

function parseCursor(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = CursorSchema.safeParse(value);
  if (!parsed.success || String(parsed.data) !== value) {
    throw new ApiError(
      'invalid_event_cursor',
      400,
      `${name} must be a nonnegative safe integer.`,
    );
  }
  return parsed.data;
}

function toAgentEvent(row: StoredAgentEvent): z.infer<typeof AgentEventSchema> {
  return AgentEventSchema.parse({
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    occurredAt: row.occurredAt.toISOString(),
    organizationId: row.organizationId,
    projectId: row.projectId,
    ...(row.phaseId === null ? {} : { phaseId: row.phaseId }),
    ...(row.taskId === null ? {} : { taskId: row.taskId }),
    ...(row.agentId === null ? {} : { agentId: row.agentId }),
    type: row.type,
    visibility: row.visibility,
    payload: row.payloadJson,
  });
}

function parseEventPing(value: unknown): z.infer<typeof EventPingSchema> {
  if (typeof value !== 'string') return EventPingSchema.parse(value);
  return EventPingSchema.parse(JSON.parse(value) as unknown);
}

async function closeQuietly(
  subscription: EventWakeupSubscription | undefined,
  report: (error: unknown) => void,
  timeoutMs: number,
): Promise<void> {
  if (subscription === undefined) return;
  let timer: NodeJS.Timeout | undefined;
  const close = Promise.resolve()
    .then(async () => {
      await subscription.close();
    })
    .then(
      () => 'closed' as const,
      (error: unknown) => {
        report(error);
        return 'failed' as const;
      },
    );
  const timedOut = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timed-out');
    }, timeoutMs);
    timer.unref();
  });
  const outcome = await Promise.race([close, timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome === 'timed-out') {
    report(new Error(`event wakeup subscription close exceeded ${String(timeoutMs)} ms`));
  }
  if (outcome !== 'closed') {
    try {
      subscription.abort();
    } catch (error) {
      report(error);
    }
  }
}

async function subscribeUntilClosed(input: {
  readonly source: EventWakeupSource;
  readonly channel: string;
  readonly signal: AbortSignal;
  readonly report: (error: unknown) => void;
  readonly cleanupTimeoutMs: number;
}): Promise<EventWakeupSubscription | undefined> {
  const { source, channel, signal, report, cleanupTimeoutMs } = input;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => {
      resolve(undefined);
    };
    if (signal.aborted) resolve(undefined);
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const pending = Promise.resolve().then(async () => await source.subscribe(channel, signal));
  try {
    const subscription = await Promise.race([pending, aborted]);
    if (subscription !== undefined && !signal.aborted) return subscription;
    if (subscription !== undefined) {
      await closeQuietly(subscription, report, cleanupTimeoutMs);
    } else {
      void pending.then(
        async (lateSubscription) => {
          await closeQuietly(lateSubscription, report, cleanupTimeoutMs);
        },
        () => undefined,
      );
    }
    return undefined;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

async function waitForDrain(reply: FastifyReply, signal: AbortSignal): Promise<void> {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      reply.raw.removeListener('drain', finish);
      reply.raw.removeListener('close', finish);
      reply.raw.removeListener('error', finish);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    reply.raw.once('drain', finish);
    reply.raw.once('close', finish);
    reply.raw.once('error', finish);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

async function settleUntilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => {
      resolve(undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

async function streamEvents(input: {
  readonly reply: FastifyReply;
  readonly tenantDb: RequestTenantDb;
  readonly runId: string;
  readonly after: number;
  readonly access: 'user' | 'support';
  readonly dependencies: EventStreamDependencies;
  readonly shutdownSignal: AbortSignal;
}): Promise<void> {
  const { reply, tenantDb, runId, access, dependencies, shutdownSignal } = input;
  let cursor = input.after;
  let closed = false;
  let backpressured = false;
  let pendingDrain: Promise<void> | undefined;
  let subscription: EventWakeupSubscription | undefined;
  let pendingWakeup: Promise<unknown> | undefined;
  let writeQueue = Promise.resolve();
  let heartbeatPending = false;
  const closeController = new AbortController();
  const timers: EventStreamTimers = dependencies.timers ?? {
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: (handle) => {
      clearInterval(handle as NodeJS.Timeout);
    },
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => {
      clearTimeout(handle as NodeJS.Timeout);
    },
  };
  const cleanupTimeoutMs = Math.max(
    1,
    dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
  );
  const report = (error: unknown): void => {
    try {
      void Promise.resolve(dependencies.onError?.(asError(error))).catch(() => undefined);
    } catch {
      // A diagnostic hook cannot be allowed to break stream cleanup.
    }
  };
  const stop = (): void => {
    if (closed) return;
    closed = true;
    closeController.abort();
  };
  const stopForShutdown = (): void => {
    stop();
    if (!reply.raw.writableEnded) reply.raw.end();
    if (!reply.raw.destroyed) reply.raw.destroy();
  };
  const isClosed = (): boolean => closed;
  const beginBackpressure = (): Promise<void> => {
    backpressured = true;
    pendingDrain ??= waitForDrain(reply, closeController.signal).finally(() => {
      backpressured = false;
      pendingDrain = undefined;
    });
    return pendingDrain;
  };
  const writeFrame = (frame: string): Promise<void> => {
    const operation = writeQueue.then(async () => {
      if (backpressured) await pendingDrain;
      if (isClosed()) return;
      if (!reply.raw.write(frame)) await beginBackpressure();
    });
    writeQueue = operation.catch(() => undefined);
    return operation;
  };
  const waitForWriter = async (): Promise<void> => {
    for (;;) {
      const pending = writeQueue;
      await pending;
      if (pending === writeQueue) return;
    }
  };

  reply.hijack();
  reply.raw.writeHead(200, {
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
  });
  reply.raw.flushHeaders();
  reply.raw.on('close', stop);
  reply.raw.on('error', stop);
  shutdownSignal.addEventListener('abort', stopForShutdown, { once: true });
  if (shutdownSignal.aborted) stopForShutdown();

  const heartbeat = timers.setInterval(() => {
    if (closed || heartbeatPending) return;
    heartbeatPending = true;
    void writeFrame(': heartbeat\n\n')
      .catch((error: unknown) => {
        report(error);
        stop();
      })
      .finally(() => {
        heartbeatPending = false;
      });
  }, SSE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  const lifetime = timers.setTimeout(() => {
    stop();
    reply.raw.end();
  }, SSE_MAX_CONNECTION_MS);
  lifetime.unref?.();

  const sleep = (delayMs: number, signal: AbortSignal): Promise<void> => {
    if (dependencies.sleep !== undefined) {
      const combined = AbortSignal.any([signal, closeController.signal]);
      const onAbort = (): void => {
        resolveAbort();
      };
      let resolveAbort!: () => void;
      const abort = new Promise<void>((resolve) => {
        resolveAbort = resolve;
        if (combined.aborted) {
          resolve();
          return;
        }
        combined.addEventListener('abort', onAbort, { once: true });
      });
      return Promise.race([dependencies.sleep(delayMs, combined), abort]).finally(() => {
        combined.removeEventListener('abort', onAbort);
      });
    }
    const combined = AbortSignal.any([signal, closeController.signal]);
    if (combined.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        combined.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      combined.addEventListener('abort', finish, { once: true });
    });
  };

  try {
    try {
      subscription = await subscribeUntilClosed({
        source: dependencies.wakeups,
        channel: `run:${runId}`,
        signal: closeController.signal,
        report,
        cleanupTimeoutMs,
      });
    } catch (error) {
      report(error);
    }

    const readAndWrite = async (): Promise<void> => {
      while (!isClosed()) {
        await waitForWriter();
        if (isClosed()) return;
        if (cursor === Number.MAX_SAFE_INTEGER) return;
        const rows = await settleUntilAborted(
          tenantDb.events.byRun(runId, {
            fromSequence: cursor + 1,
            limit: SSE_REPLAY_PAGE_SIZE,
          }),
          closeController.signal,
        );
        if (rows === undefined) return;
        await waitForWriter();
        for (const row of rows) {
          await waitForWriter();
          if (isClosed()) return;
          cursor = Math.max(cursor, row.sequence);
          if (row.visibility === 'internal') continue;
          if (row.visibility === 'support' && access !== 'support') continue;
          const event = toAgentEvent(row);
          const block = `id: ${String(event.sequence)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          try {
            await writeFrame(block);
          } catch (error) {
            report(error);
            stop();
            return;
          }
        }
        if (rows.length < SSE_REPLAY_PAGE_SIZE) return;
      }
    };

    await readAndWrite();
    while (!isClosed()) {
      if (subscription !== undefined && pendingWakeup === undefined) {
        pendingWakeup = subscription.next().then(parseEventPing);
      }
      const wakeup = pendingWakeup ?? Promise.reject(new Error('Redis subscription unavailable'));
      await waitForEventWakeup({ wakeup, readFromDatabase: readAndWrite, sleep });
      if (pendingWakeup !== undefined) {
        const settled = await Promise.race([
          pendingWakeup.then(() => true, () => true),
          Promise.resolve(false),
        ]);
        if (settled) pendingWakeup = undefined;
      }
    }
  } catch (error) {
    if (!isClosed()) report(error);
  } finally {
    closed = true;
    closeController.abort();
    timers.clearInterval(heartbeat);
    timers.clearTimeout(lifetime);
    reply.raw.removeListener('close', stop);
    reply.raw.removeListener('error', stop);
    shutdownSignal.removeEventListener('abort', stopForShutdown);
    await closeQuietly(subscription, report, cleanupTimeoutMs);
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  }
}

export function registerRunEventStreamRoute(
  app: AppInstance,
  dependencies: RunEventStreamRouteDependencies,
): void {
  const activeStreams = new Set<{
    readonly controller: AbortController;
    readonly completed: Promise<void>;
  }>();
  app.addHook('preClose', async () => {
    const streams = [...activeStreams];
    for (const stream of streams) stream.controller.abort();
    await Promise.all(
      streams.map((stream) => {
        return stream.completed;
      }),
    );
  });

  app.get(
    '/v1/runs/:runId/events',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: RunParamsSchema,
        querystring: EventStreamQuerySchema,
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) {
        throw new ApiError('run_not_found', 404, 'That run does not exist.');
      }
      authorize(ctx, 'view_project');
      if (!acceptsEventStream(request.headers.accept)) {
        throw new ApiError('event_stream_required', 406, 'Accept must permit text/event-stream.');
      }
      const queryAfter = parseCursor(request.query.after, 'after');
      const headerValue = request.headers['last-event-id'];
      const lastEventId = parseCursor(
        Array.isArray(headerValue) ? headerValue[0] : headerValue,
        'Last-Event-ID',
      );

      const accessContext: EventStreamAccessContext = {
        organizationId: ctx.organizationId,
        runId: run.id,
        userId: actorOf(request),
      };
      const decision = EventAccessDecisionSchema.parse(
        dependencies.eventStream.supportAccess === undefined
          ? { access: 'user' }
          : await dependencies.eventStream.supportAccess.decide(accessContext),
      );
      if (decision.access === 'support') {
        await dependencies.eventStream.supportAccess?.audit({ ...accessContext, access: 'support' });
      }

      const shutdownController = new AbortController();
      let markCompleted!: () => void;
      const activeStream = {
        controller: shutdownController,
        completed: new Promise<void>((resolve) => {
          markCompleted = resolve;
        }),
      };
      activeStreams.add(activeStream);
      try {
        await streamEvents({
          reply,
          tenantDb: ctx.db,
          runId: run.id,
          after: queryAfter ?? lastEventId ?? 0,
          access: decision.access,
          dependencies: dependencies.eventStream,
          shutdownSignal: shutdownController.signal,
        });
      } finally {
        activeStreams.delete(activeStream);
        markCompleted();
      }
    },
  );
}
