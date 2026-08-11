import { idSchema } from '@zapp/contracts';
import { usageOutbox, type Database } from '@zapp/db';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { and, asc, eq, lte } from 'drizzle-orm';
import { z } from 'zod';

import type { UsageQueueEnv } from '../env.js';

export const FlexpriceUsageEventSchema = z
  .object({
    event_name: z.string().trim().min(1),
    external_customer_id: idSchema('org'),
    event_id: z.string().trim().min(1),
    timestamp: z.string().datetime({ offset: true }),
    properties: z
      .object({
        project_id: idSchema('proj').nullable(),
        run_id: idSchema('run').nullable(),
        task_id: idSchema('task').nullable(),
        quantity: z.number().finite(),
        unit: z.string().min(1),
        provider: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

export type FlexpriceUsageEvent = z.infer<typeof FlexpriceUsageEventSchema>;

const UsageQueueMessageSchema = z
  .object({
    outboxId: z.string().min(1),
    event: FlexpriceUsageEventSchema,
  })
  .strict();

export interface UsageQueuePublisherPort {
  send(body: string): Promise<void>;
  close?(): void;
}

export interface UsageQueueReceivedMessage {
  readonly body: string;
  readonly receiptHandle: string;
}

export interface UsageQueueConsumerPort {
  receive(input: {
    readonly maxMessages: number;
    readonly waitTimeSeconds: number;
    readonly visibilityTimeoutSeconds: number;
  }): Promise<readonly UsageQueueReceivedMessage[]>;
  delete(receiptHandle: string): Promise<void>;
}

export interface UsageQueuePort extends UsageQueuePublisherPort, UsageQueueConsumerPort {}

const UsageQueueReceivedMessageSchema = z
  .object({
    body: z.string().min(1),
    receiptHandle: z.string().min(1),
  })
  .strict();

export function createSqsUsageQueue(config: UsageQueueEnv): UsageQueuePort {
  const client = new SQSClient({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.accessKeyId === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey ?? '',
          },
        }),
  });
  const queueUrl = client
    .send(new GetQueueUrlCommand({ QueueName: config.queueName }))
    .then((response) => {
      if (response.QueueUrl === undefined) throw new Error('usage queue URL was not returned');
      return response.QueueUrl;
    });
  return {
    async send(body) {
      await client.send(new SendMessageCommand({ QueueUrl: await queueUrl, MessageBody: body }));
    },
    async receive(input) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: await queueUrl,
          MaxNumberOfMessages: Math.max(1, Math.min(10, Math.floor(input.maxMessages))),
          WaitTimeSeconds: Math.max(0, Math.min(20, Math.floor(input.waitTimeSeconds))),
          VisibilityTimeout: Math.max(0, Math.floor(input.visibilityTimeoutSeconds)),
        }),
      );
      return (response.Messages ?? []).map((message) =>
        UsageQueueReceivedMessageSchema.parse({
          body: message.Body,
          receiptHandle: message.ReceiptHandle,
        }),
      );
    },
    async delete(receiptHandle) {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: await queueUrl, ReceiptHandle: receiptHandle }),
      );
    },
    close() {
      client.destroy();
    },
  };
}

export interface UsageOutboxPublisherOptions {
  readonly database: Database;
  readonly queue: UsageQueuePublisherPort;
  readonly now?: () => Date;
  readonly onError?: (error: Error) => void;
}

export function createUsageOutboxPublisher(options: UsageOutboxPublisherOptions) {
  const now = options.now ?? ((): Date => new Date());
  return {
    async publishOnce(rawLimit: number): Promise<number> {
      const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
      return await options.database.transaction(async (tx) => {
        const instant = now();
        const rows = await tx
          .select()
          .from(usageOutbox)
          .where(and(eq(usageOutbox.status, 'pending'), lte(usageOutbox.nextAttemptAt, instant)))
          .orderBy(asc(usageOutbox.createdAt), asc(usageOutbox.id))
          .limit(limit)
          .for('update', { skipLocked: true });
        let published = 0;
        for (const row of rows) {
          try {
            const event = FlexpriceUsageEventSchema.parse(row.eventJson);
            await options.queue.send(
              JSON.stringify(UsageQueueMessageSchema.parse({ outboxId: row.id, event })),
            );
            await tx
              .update(usageOutbox)
              .set({
                status: 'published',
                attempts: row.attempts + 1,
                publishedAt: instant,
              })
              .where(eq(usageOutbox.id, row.id));
            published += 1;
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            options.onError?.(failure);
            const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(row.attempts, 5));
            await tx
              .update(usageOutbox)
              .set({
                attempts: row.attempts + 1,
                nextAttemptAt: new Date(instant.getTime() + delayMs),
              })
              .where(eq(usageOutbox.id, row.id));
          }
        }
        return published;
      });
    },
  };
}

interface UsageOutboxBatchPublisher {
  publishOnce(limit: number): Promise<number>;
}

type UsageTimerHandle = number | object;

interface UsageOutboxTimers {
  setInterval(callback: () => void, delayMs: number): UsageTimerHandle;
  clearInterval(handle: UsageTimerHandle): void;
}

export interface UsageOutboxPublisherLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The production poller for transactional usage rows. Startup performs one
 * synchronous flush so a deployment cannot advertise readiness while every
 * already-committed ledger event is stranded. Later polls are single-flight;
 * shutdown stops scheduling and drains the active queue send before shared
 * database handles are closed.
 */
export function createUsageOutboxPublisherLifecycle(options: {
  readonly publisher: UsageOutboxBatchPublisher;
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly onError?: (error: Error) => void;
  readonly timers?: UsageOutboxTimers;
}): UsageOutboxPublisherLifecycle {
  const timers =
    options.timers ??
    ({
      setInterval: (callback, delayMs) => setInterval(callback, delayMs),
      clearInterval: (handle) => {
        clearInterval(handle as ReturnType<typeof setInterval>);
      },
    } satisfies UsageOutboxTimers);
  let interval: UsageTimerHandle | undefined;
  let active: Promise<void> | undefined;
  let closed = false;

  function poll(): void {
    if (closed || active !== undefined) return;
    active = options.publisher
      .publishOnce(options.batchSize)
      .then(() => undefined)
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        active = undefined;
      });
  }

  return {
    async start() {
      if (closed) throw new Error('usage outbox lifecycle is closed');
      await options.publisher.publishOnce(options.batchSize);
      interval = timers.setInterval(poll, options.intervalMs);
    },
    async close() {
      closed = true;
      if (interval !== undefined) {
        timers.clearInterval(interval);
        interval = undefined;
      }
      await active;
    },
  };
}

export interface FlexpriceIngestPort {
  ingest(event: FlexpriceUsageEvent): Promise<void>;
}

export function createFlexpriceIngestClient(options: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
}): FlexpriceIngestPort {
  const request = options.fetch ?? globalThis.fetch;
  const endpoint = new URL('events', `${options.baseUrl.replace(/\/+$/u, '')}/`);
  return {
    async ingest(rawEvent) {
      const event = FlexpriceUsageEventSchema.parse(rawEvent);
      const response = await request(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
        },
        body: JSON.stringify(event),
      });
      if (response.status !== 202) {
        throw new Error(`Flexprice event ingestion failed with status ${String(response.status)}`);
      }
    },
  };
}

export function createUsageEventConsumer(flexprice: FlexpriceIngestPort) {
  return {
    async consume(body: string): Promise<void> {
      const message = UsageQueueMessageSchema.parse(JSON.parse(body) as unknown);
      await flexprice.ingest(message.event);
    },
  };
}

interface UsageEventConsumer {
  consume(body: string): Promise<void>;
}

export interface UsageEventConsumerLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createUsageEventConsumerLifecycle(options: {
  readonly queue: UsageQueueConsumerPort;
  readonly consumer: UsageEventConsumer;
  readonly batchSize: number;
  readonly waitTimeSeconds: number;
  readonly visibilityTimeoutSeconds: number;
  readonly intervalMs: number;
  readonly onError?: (error: Error) => void;
  readonly timers?: UsageOutboxTimers;
}): UsageEventConsumerLifecycle {
  const timers =
    options.timers ??
    ({
      setInterval: (callback, delayMs) => setInterval(callback, delayMs),
      clearInterval: (handle) => {
        clearInterval(handle as ReturnType<typeof setInterval>);
      },
    } satisfies UsageOutboxTimers);
  let interval: UsageTimerHandle | undefined;
  let active: Promise<void> | undefined;
  let closed = false;

  async function pollOnce(): Promise<void> {
    const messages = await options.queue.receive({
      maxMessages: options.batchSize,
      waitTimeSeconds: options.waitTimeSeconds,
      visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
    });
    for (const message of messages) {
      try {
        await options.consumer.consume(message.body);
        await options.queue.delete(message.receiptHandle);
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  function poll(): void {
    if (closed || active !== undefined) return;
    active = pollOnce()
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        active = undefined;
      });
  }

  return {
    async start() {
      if (closed) throw new Error('usage event consumer lifecycle is closed');
      await pollOnce();
      interval = timers.setInterval(poll, options.intervalMs);
    },
    async close() {
      closed = true;
      if (interval !== undefined) {
        timers.clearInterval(interval);
        interval = undefined;
      }
      await active;
    },
  };
}
