import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

const LISTEN_CHANNEL = 'agent_events';
const DEFAULT_RETRY_DELAY_MS = 100;
const MAXIMUM_RETRY_DELAY_MS = 5_000;

const NotificationSchema = idSchema('run');
const SequenceRowSchema = z
  .object({ sequence: z.coerce.number().int().positive().safe() })
  .strict();
const PingSchema = z.object({ sequence: z.number().int().positive().safe() }).strict();

export const SSE_POLL_INTERVAL_MS = 2_000;

export interface EventSubscription {
  unlisten(): Promise<void>;
}

export interface EventPublisherDependencies {
  listen(channel: string, onNotification: (payload: string) => void): Promise<EventSubscription>;
  readLatestSequence(runId: string): Promise<unknown>;
  publish(channel: string, body: string): Promise<unknown>;
}

interface RetryOptions {
  readonly initialDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface EventPublisherOptions {
  readonly onError?: (error: Error) => unknown;
  readonly retry?: RetryOptions;
}

export interface EventPublisher {
  start(): void;
  ready(): Promise<void>;
  close(): Promise<void>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/**
 * One SSE wait cycle: a Redis message wakes it early, while a missing or failed
 * subscription still reaches the same PostgreSQL replay read after two seconds.
 */
export async function waitForEventWakeup<T>(input: {
  readonly wakeup: Promise<unknown>;
  readonly readFromDatabase: () => Promise<T>;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}): Promise<T> {
  const timer = new AbortController();
  const sleep = input.sleep ?? abortableSleep;
  const unavailable = new Promise<never>(() => {});
  const wakeup = input.wakeup.then(
    () => undefined,
    () => unavailable,
  );

  try {
    await Promise.race([wakeup, sleep(SSE_POLL_INTERVAL_MS, timer.signal)]);
  } finally {
    timer.abort();
  }
  return await input.readFromDatabase();
}

/** Starts one process-local bridge. PostgreSQL and Redis remain the only state. */
export function createEventPublisher(
  dependencies: EventPublisherDependencies,
  options: EventPublisherOptions = {},
): EventPublisher {
  const retryController = new AbortController();
  const sleep = options.retry?.sleep ?? abortableSleep;
  const initialDelay = Math.max(1, options.retry?.initialDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const maximumDelay = Math.max(
    initialDelay,
    options.retry?.maximumDelayMs ?? MAXIMUM_RETRY_DELAY_MS,
  );
  let started = false;
  let closed = false;
  let subscription: EventSubscription | undefined;
  let listenerLoop: Promise<void> | undefined;
  let processing = Promise.resolve();
  let markReady!: () => void;
  const isClosed = (): boolean => closed;
  const readySignal = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const report = async (error: unknown): Promise<void> => {
    try {
      await options.onError?.(asError(error));
    } catch {
      // Diagnostics must not become another publisher failure.
    }
  };

  const processNotification = async (payload: string): Promise<void> => {
    const parsedRunId = NotificationSchema.safeParse(payload);
    if (!parsedRunId.success) {
      await report(parsedRunId.error);
      return;
    }

    const row = SequenceRowSchema.safeParse(
      await dependencies.readLatestSequence(parsedRunId.data),
    );
    if (!row.success) {
      await report(row.error);
      return;
    }

    const ping = PingSchema.parse({ sequence: row.data.sequence });
    await dependencies.publish(`run:${parsedRunId.data}`, JSON.stringify(ping));
  };

  const onNotification = (payload: string): void => {
    if (closed) return;
    processing = processing
      .then(async () => {
        if (!closed) await processNotification(payload);
      })
      .catch(async (error: unknown) => {
        await report(error);
      });
  };

  const listenUntilReady = async (): Promise<void> => {
    let delay = initialDelay;
    while (!isClosed()) {
      try {
        const candidate = await dependencies.listen(LISTEN_CHANNEL, onNotification);
        if (isClosed()) {
          await candidate.unlisten();
          return;
        }
        subscription = candidate;
        markReady();
        return;
      } catch (error) {
        if (isClosed()) return;
        await report(error);
        try {
          await sleep(delay, retryController.signal);
        } catch (sleepError) {
          if (!isClosed()) await report(sleepError);
        }
        delay = Math.min(maximumDelay, delay * 2);
      }
    }
  };

  return {
    start() {
      if (started || closed) return;
      started = true;
      listenerLoop = listenUntilReady();
    },
    async ready() {
      if (!started) throw new Error('event publisher has not been started');
      await readySignal;
      if (subscription === undefined) throw new Error('event publisher closed before it was ready');
    },
    async close() {
      if (closed) return;
      closed = true;
      retryController.abort();
      markReady();
      const active = subscription;
      subscription = undefined;
      if (active !== undefined) {
        try {
          await active.unlisten();
        } catch (error) {
          await report(error);
        }
      }
      await listenerLoop;
      await processing;
    },
  };
}
