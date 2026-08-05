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

export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_MAX_CONNECTION_MS = 4 * 60 * 60 * 1_000;

export interface EventWakeupSubscription {
  next(): Promise<unknown>;
  close(): Promise<void>;
}

export interface EventWakeupSource {
  subscribe(channel: string): Promise<EventWakeupSubscription>;
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
}

export interface RunEventStreamRouteDependencies {
  readonly eventStream: EventStreamDependencies;
}

type RequestTenantDb = ReturnType<typeof tenantOf>['db'];
type StoredAgentEvent = Awaited<ReturnType<RequestTenantDb['events']['byRun']>>[number];

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function acceptsEventStream(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.split(',').some((entry) => {
    const [mediaRange, ...parameters] = entry.trim().toLowerCase().split(';');
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
    if (quality !== undefined) {
      const value = Number(quality.trim().slice(2));
      if (!Number.isFinite(value) || value <= 0 || value > 1) return false;
    }
    return mediaRange === 'text/event-stream' || mediaRange === 'text/*' || mediaRange === '*/*';
  });
}

function parseCursor(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = CursorSchema.safeParse(value);
  if (!parsed.success || String(parsed.data) !== value) {
    throw new ApiError('invalid_event_cursor', 400, `${name} must be a nonnegative safe integer.`);
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
): Promise<void> {
  if (subscription === undefined) return;
  try {
    await subscription.close();
  } catch (error) {
    report(error);
  }
}

async function waitForDrain(reply: FastifyReply): Promise<void> {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      reply.raw.removeListener('drain', finish);
      reply.raw.removeListener('close', finish);
      reply.raw.removeListener('error', finish);
      resolve();
    };
    reply.raw.once('drain', finish);
    reply.raw.once('close', finish);
    reply.raw.once('error', finish);
  });
}

async function streamEvents(input: {
  readonly reply: FastifyReply;
  readonly tenantDb: RequestTenantDb;
  readonly runId: string;
  readonly after: number;
  readonly access: 'user' | 'support';
  readonly dependencies: EventStreamDependencies;
}): Promise<void> {
  const { reply, tenantDb, runId, access, dependencies } = input;
  let cursor = input.after;
  let closed = false;
  let backpressured = false;
  let pendingDrain: Promise<void> | undefined;
  let subscription: EventWakeupSubscription | undefined;
  let pendingWakeup: Promise<unknown> | undefined;
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
  const isClosed = (): boolean => closed;
  const beginBackpressure = (): Promise<void> => {
    backpressured = true;
    pendingDrain ??= waitForDrain(reply).finally(() => {
      backpressured = false;
      pendingDrain = undefined;
    });
    return pendingDrain;
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

  const heartbeat = timers.setInterval(() => {
    if (closed || backpressured) return;
    try {
      if (!reply.raw.write(': heartbeat\n\n')) void beginBackpressure();
    } catch (error) {
      report(error);
      stop();
    }
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
      subscription = await dependencies.wakeups.subscribe(`run:${runId}`);
    } catch (error) {
      report(error);
    }

    const readAndWrite = async (): Promise<void> => {
      if (closed) return;
      if (backpressured) {
        await pendingDrain;
        if (isClosed()) return;
      }
      const rows = await tenantDb.events.byRun(runId, { fromSequence: cursor + 1 });
      for (const row of rows) {
        if (isClosed()) return;
        cursor = Math.max(cursor, row.sequence);
        if (row.visibility === 'internal') continue;
        if (row.visibility === 'support' && access !== 'support') continue;
        const event = toAgentEvent(row);
        const block = `id: ${String(event.sequence)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        try {
          if (!reply.raw.write(block)) {
            await beginBackpressure();
          }
        } catch (error) {
          report(error);
          stop();
          return;
        }
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
    await closeQuietly(subscription, report);
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  }
}

export function registerRunEventStreamRoute(
  app: AppInstance,
  dependencies: RunEventStreamRouteDependencies,
): void {
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

      await streamEvents({
        reply,
        tenantDb: ctx.db,
        runId: run.id,
        after: queryAfter ?? lastEventId ?? 0,
        access: decision.access,
        dependencies: dependencies.eventStream,
      });
    },
  );
}
