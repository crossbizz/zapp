import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

const LISTEN_CHANNEL = 'agent_events';
const DEFAULT_RETRY_DELAY_MS = 100;
const MAXIMUM_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAXIMUM_PENDING_RUNS = 256;

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
  readonly maximumPendingRuns?: number;
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
  const configuredPendingRuns = options.maximumPendingRuns;
  const maximumPendingRuns =
    configuredPendingRuns === undefined || !Number.isFinite(configuredPendingRuns)
      ? DEFAULT_MAXIMUM_PENDING_RUNS
      : Math.min(
          DEFAULT_MAXIMUM_PENDING_RUNS,
          Math.max(1, Math.floor(configuredPendingRuns)),
        );
  let started = false;
  let closed = false;
  let subscription: EventSubscription | undefined;
  let listenerLoop: Promise<void> | undefined;
  const pendingRuns = new Map<string, { pending: boolean }>();
  let overloadReported = false;
  let markReady!: () => void;
  const isClosed = (): boolean => closed;
  const readySignal = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const report = (error: unknown): void => {
    try {
      void Promise.resolve(options.onError?.(asError(error))).catch(() => {});
    } catch {
      // Diagnostics must not become another publisher failure.
    }
  };

  const releaseSubscription = async (candidate: EventSubscription): Promise<void> => {
    try {
      await candidate.unlisten();
    } catch (error) {
      report(error);
    }
  };

  const acquireSubscription = (): Promise<EventSubscription | undefined> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        settled = true;
        retryController.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        finish();
        resolve(undefined);
      };
      let attempt: Promise<EventSubscription>;
      try {
        attempt = dependencies.listen(LISTEN_CHANNEL, onNotification);
      } catch (error) {
        reject(asError(error));
        return;
      }
      retryController.signal.addEventListener('abort', onAbort, { once: true });
      attempt.then(
        (candidate) => {
          if (settled) {
            void releaseSubscription(candidate);
            return;
          }
          finish();
          resolve(candidate);
        },
        (error: unknown) => {
          if (settled) return;
          finish();
          reject(asError(error));
        },
      );
      if (retryController.signal.aborted) onAbort();
    });

  const processNotification = async (runId: string): Promise<void> => {
    const row = SequenceRowSchema.safeParse(
      await dependencies.readLatestSequence(runId),
    );
    if (isClosed()) return;
    if (!row.success) {
      report(row.error);
      return;
    }

    const ping = PingSchema.parse({ sequence: row.data.sequence });
    await dependencies.publish(`run:${runId}`, JSON.stringify(ping));
  };

  const processPendingRun = async (
    runId: string,
    state: { pending: boolean },
  ): Promise<void> => {
    try {
      while (state.pending && !isClosed()) {
        state.pending = false;
        try {
          await processNotification(runId);
        } catch (error) {
          report(error);
        }
      }
    } finally {
      if (pendingRuns.get(runId) === state) pendingRuns.delete(runId);
      if (pendingRuns.size < maximumPendingRuns) overloadReported = false;
    }
  };

  const onNotification = (payload: string): void => {
    if (closed) return;
    const parsedRunId = NotificationSchema.safeParse(payload);
    if (!parsedRunId.success) {
      report(parsedRunId.error);
      return;
    }
    const existing = pendingRuns.get(parsedRunId.data);
    if (existing !== undefined) {
      existing.pending = true;
      return;
    }
    if (pendingRuns.size >= maximumPendingRuns) {
      if (!overloadReported) {
        overloadReported = true;
        report(new Error('event publisher wakeup capacity reached; wakeup dropped'));
      }
      return;
    }
    const state = { pending: true };
    pendingRuns.set(parsedRunId.data, state);
    void processPendingRun(parsedRunId.data, state);
  };

  const listenUntilReady = async (): Promise<void> => {
    let delay = initialDelay;
    while (!isClosed()) {
      try {
        const candidate = await acquireSubscription();
        if (candidate === undefined) return;
        if (isClosed()) {
          await releaseSubscription(candidate);
          return;
        }
        subscription = candidate;
        markReady();
        return;
      } catch (error) {
        if (isClosed()) return;
        report(error);
        try {
          await sleep(delay, retryController.signal);
        } catch (sleepError) {
          if (!isClosed()) report(sleepError);
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
      pendingRuns.clear();
      const active = subscription;
      subscription = undefined;
      if (active !== undefined) await releaseSubscription(active);
      await listenerLoop;
    },
  };
}
