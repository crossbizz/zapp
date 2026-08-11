import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import type { GitHubWebhookQueueEnv } from '../../env.js';
import {
  GitHubWebhookQueueMessageSchema,
  type GitHubWebhookQueueMessage,
} from './schemas.js';
import type {
  GitHubWebhookPublishInput,
  GitHubWebhookReceipt,
  GitHubWebhookStore,
} from './store.js';

export interface GitHubWebhookQueuePort {
  send(body: string): Promise<void>;
  close?(): void;
}

export function createSqsGitHubWebhookQueue(config: GitHubWebhookQueueEnv): GitHubWebhookQueuePort {
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
      if (response.QueueUrl === undefined) throw new Error('GitHub webhook queue URL was not returned');
      return response.QueueUrl;
    });
  return {
    async send(body) {
      await client.send(new SendMessageCommand({ QueueUrl: await queueUrl, MessageBody: body }));
    },
    close() {
      client.destroy();
    },
  };
}

interface MemoryRow extends GitHubWebhookReceipt {
  status: 'pending' | 'published';
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}

export function createInMemoryGitHubWebhookStore(): GitHubWebhookStore {
  const rows = new Map<string, MemoryRow>();
  return {
    claim(receipt) {
      if (rows.has(receipt.deliveryId)) return Promise.resolve(false);
      rows.set(receipt.deliveryId, {
        ...receipt,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: receipt.receivedAt,
        publishedAt: null,
      });
      return Promise.resolve(true);
    },
    async publishBatch(input: GitHubWebhookPublishInput) {
      const pending = [...rows.values()]
        .filter((row) => row.status === 'pending' && row.nextAttemptAt <= input.now)
        .sort(
          (left, right) =>
            left.receivedAt.getTime() - right.receivedAt.getTime() ||
            left.deliveryId.localeCompare(right.deliveryId),
        )
        .slice(0, input.limit);
      let published = 0;
      for (const row of pending) {
        try {
          await input.send(row);
          row.status = 'published';
          row.attempts += 1;
          row.publishedAt = input.now;
          published += 1;
        } catch (error) {
          input.onError?.(error instanceof Error ? error : new Error(String(error)));
          const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(row.attempts, 5));
          row.attempts += 1;
          row.nextAttemptAt = new Date(input.now.getTime() + delayMs);
        }
      }
      return published;
    },
  };
}

function installationIdOf(payload: Record<string, unknown>): string | undefined {
  const installation = payload['installation'];
  if (typeof installation !== 'object' || installation === null || Array.isArray(installation)) {
    return undefined;
  }
  const id = (installation as Record<string, unknown>)['id'];
  if (typeof id !== 'number' && typeof id !== 'string') return undefined;
  const value = String(id).trim();
  return value === '' ? undefined : value;
}

export function createGitHubWebhookPublisher(input: {
  readonly store: GitHubWebhookStore;
  readonly queue: GitHubWebhookQueuePort;
  readonly now?: () => Date;
  readonly onError?: (error: Error) => void;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async publishOnce(rawLimit: number): Promise<number> {
      const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
      return await input.store.publishBatch({
        limit,
        now: now(),
        async send(receipt) {
          const message: GitHubWebhookQueueMessage = {
            deliveryId: receipt.deliveryId,
            eventName: receipt.eventName,
            ...(installationIdOf(receipt.payload) === undefined
              ? {}
              : { installationId: installationIdOf(receipt.payload) }),
            payload: receipt.payload,
          };
          await input.queue.send(JSON.stringify(GitHubWebhookQueueMessageSchema.parse(message)));
        },
        ...(input.onError === undefined ? {} : { onError: input.onError }),
      });
    },
  };
}

export interface GitHubWebhookPublisherLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createGitHubWebhookPublisherLifecycle(input: {
  readonly publisher: { publishOnce(limit: number): Promise<number> };
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly onError?: (error: Error) => void;
}): GitHubWebhookPublisherLifecycle {
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let closed = false;
  const poll = (): void => {
    if (closed || active !== undefined) return;
    active = input.publisher
      .publishOnce(input.batchSize)
      .then(() => undefined)
      .catch((error: unknown) => {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        active = undefined;
      });
  };
  return {
    async start() {
      if (closed) throw new Error('GitHub webhook publisher lifecycle is closed');
      await input.publisher.publishOnce(input.batchSize);
      timer = setInterval(poll, input.intervalMs);
    },
    async close() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await active;
    },
  };
}
