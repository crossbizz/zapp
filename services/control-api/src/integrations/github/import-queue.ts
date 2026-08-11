import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { idSchema } from '@zapp/contracts';
import { githubImportOutbox, type Database } from '@zapp/db';
import {
  CapabilityScanInputSchema,
  CapabilityScanOutputSchema,
  capabilityScanActivityIdempotencyKey,
  type CapabilityScanPort,
} from '@zapp/project-adapters';
import { and, asc, eq, lte } from 'drizzle-orm';
import { z } from 'zod';

import type { GitHubImportQueueEnv } from '../../env.js';
import {
  GitServiceError,
  GitServiceImportConflictError,
  type GitImportServicePort,
} from '../../git/port.js';
import {
  GitHubImportErrorCodeSchema,
  type GitHubImportWorkerStore,
} from './import-store.js';
import {
  GitHubImportProviderError,
  GitHubPrepareImportInputSchema,
  type GitHubImportProviderPort,
} from './ports.js';

export const GitHubImportQueueMessageSchema = z
  .object({
    projectId: idSchema('proj'),
    stage: z.enum(['queued', 'scan_pending']),
  })
  .strict();
export type GitHubImportQueueMessage = z.infer<typeof GitHubImportQueueMessageSchema>;

const SQS_MAX_VISIBILITY_TIMEOUT_SECONDS = 43_200;

function boundedVisibilityTimeout(rawSeconds: number): number {
  return Math.max(1, Math.min(SQS_MAX_VISIBILITY_TIMEOUT_SECONDS, Math.floor(rawSeconds)));
}

const GitHubImportQueueReceivedMessageSchema = z
  .object({ body: z.string().min(1), receiptHandle: z.string().min(1) })
  .strict();

export interface GitHubImportQueuePort {
  send(body: string): Promise<void>;
  receive(
    queueName: 'main' | 'dlq',
    input: {
      readonly maxMessages: number;
      readonly waitTimeSeconds: number;
      readonly visibilityTimeoutSeconds: number;
    },
  ): Promise<readonly { readonly body: string; readonly receiptHandle: string }[]>;
  changeVisibility(
    queueName: 'main' | 'dlq',
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void>;
  delete(queueName: 'main' | 'dlq', receiptHandle: string): Promise<void>;
  close?(): void;
}

export function createSqsGitHubImportQueue(config: GitHubImportQueueEnv): GitHubImportQueuePort {
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
  const urls = {
    main: client
      .send(new GetQueueUrlCommand({ QueueName: config.queueName }))
      .then((response) => {
        if (response.QueueUrl === undefined) throw new Error('GitHub import queue URL was not returned');
        return response.QueueUrl;
      }),
    dlq: client
      .send(new GetQueueUrlCommand({ QueueName: config.deadLetterQueueName }))
      .then((response) => {
        if (response.QueueUrl === undefined) {
          throw new Error('GitHub import dead-letter queue URL was not returned');
        }
        return response.QueueUrl;
      }),
  };
  return {
    async send(body) {
      await client.send(new SendMessageCommand({ QueueUrl: await urls.main, MessageBody: body }));
    },
    async receive(queueName, input) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: await urls[queueName],
          MaxNumberOfMessages: Math.max(1, Math.min(10, Math.floor(input.maxMessages))),
          WaitTimeSeconds: Math.max(0, Math.min(20, Math.floor(input.waitTimeSeconds))),
          VisibilityTimeout: Math.max(0, Math.floor(input.visibilityTimeoutSeconds)),
        }),
      );
      return (response.Messages ?? []).map((message) =>
        GitHubImportQueueReceivedMessageSchema.parse({
          body: message.Body,
          receiptHandle: message.ReceiptHandle,
        }),
      );
    },
    async delete(queueName, receiptHandle) {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: await urls[queueName], ReceiptHandle: receiptHandle }),
      );
    },
    async changeVisibility(queueName, receiptHandle, visibilityTimeoutSeconds) {
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: await urls[queueName],
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: boundedVisibilityTimeout(visibilityTimeoutSeconds),
        }),
      );
    },
    close() {
      client.destroy();
    },
  };
}

export function createGitHubImportPublisher(input: {
  readonly database: Database;
  readonly queue: Pick<GitHubImportQueuePort, 'send'>;
  readonly now?: () => Date;
  readonly onError?: (error: Error) => void;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async publishOnce(rawLimit: number): Promise<number> {
      const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
      return await input.database.transaction(async (tx) => {
        const instant = now();
        const rows = await tx
          .select()
          .from(githubImportOutbox)
          .where(
            and(
              eq(githubImportOutbox.status, 'pending'),
              lte(githubImportOutbox.nextAttemptAt, instant),
            ),
          )
          .orderBy(asc(githubImportOutbox.createdAt), asc(githubImportOutbox.projectId))
          .limit(limit)
          .for('update', { skipLocked: true });
        let published = 0;
        for (const row of rows) {
          try {
            const message = GitHubImportQueueMessageSchema.parse({
              projectId: row.projectId,
              stage: row.stage,
            });
            await input.queue.send(JSON.stringify(message));
            await tx
              .update(githubImportOutbox)
              .set({ status: 'published', attempts: row.attempts + 1, publishedAt: instant })
              .where(
                and(
                  eq(githubImportOutbox.projectId, row.projectId),
                  eq(githubImportOutbox.stage, row.stage),
                ),
              );
            published += 1;
          } catch (error) {
            input.onError?.(error instanceof Error ? error : new Error(String(error)));
            const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(row.attempts, 5));
            await tx
              .update(githubImportOutbox)
              .set({
                attempts: row.attempts + 1,
                nextAttemptAt: new Date(instant.getTime() + delayMs),
              })
              .where(
                and(
                  eq(githubImportOutbox.projectId, row.projectId),
                  eq(githubImportOutbox.stage, row.stage),
                ),
              );
          }
        }
        return published;
      });
    },
  };
}

function durableId(projectId: string, prefix: 'ws' | 'run' | 'task'): string {
  return idSchema(prefix).parse(`${prefix}_${projectId.slice('proj_'.length)}`);
}

export function createGitHubImportWorker(input: {
  readonly store: GitHubImportWorkerStore;
  readonly provider: GitHubImportProviderPort;
  readonly git: GitImportServicePort;
  readonly capabilityScan: CapabilityScanPort;
  readonly now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async process(body: string): Promise<void> {
      const message = GitHubImportQueueMessageSchema.parse(JSON.parse(body) as unknown);
      const persisted = await input.store.read(message.projectId);
      if (persisted === undefined) return;

      if (message.stage === 'queued') {
        if (persisted.status !== 'queued' && persisted.status !== 'mirroring') return;
        const current =
          persisted.status === 'queued'
            ? await input.store.markMirroring(persisted.projectId, now())
            : persisted;
        if (current === undefined || current.status !== 'mirroring') return;
        let prepared;
        try {
          prepared = await input.provider.prepareImport(
            GitHubPrepareImportInputSchema.parse({
              installationId: current.installationId,
              repo: current.repo,
              branch: current.branch,
            }),
          );
        } catch (error) {
          if (
            error instanceof GitHubImportProviderError &&
            (error.failure === 'repository_not_found' || error.failure === 'branch_not_found')
          ) {
            await input.store.fail(current.projectId, error.failure, now());
            return;
          }
          await input.store.recordRetryableFailure(current.projectId, 'github_unavailable', now());
          throw error;
        }
        let result;
        try {
          result = await input.git.importRepository({
            organizationId: current.organizationId,
            projectId: current.projectId,
            externalRepoRef: current.repo,
            sourceCloneUrl: prepared.sourceCloneUrl,
            sourceToken: prepared.sourceToken,
            sourceBranch: current.branch,
          });
        } catch (error) {
          if (error instanceof GitServiceImportConflictError) {
            await input.store.fail(current.projectId, 'mirror_failed', now());
            return;
          }
          await input.store.recordRetryableFailure(current.projectId, 'mirror_failed', now());
          throw error instanceof GitServiceError ? error : new GitServiceError('git import failed');
        }
        await input.store.completeMirror({
          projectId: current.projectId,
          externalRepoRef: result.externalRepoRef,
          branch: result.branch,
          headCommitSha: result.headCommitSha,
          scanId: `github-import:${current.projectId}`,
          now: now(),
        });
        return;
      }

      if (persisted.status !== 'scan_pending') return;
      if (persisted.branchId === null || persisted.scanId === null) {
        throw new Error('GitHub import scan state is incomplete');
      }
      const scanInput = CapabilityScanInputSchema.parse({
        scanId: persisted.scanId,
        idempotencyKey: capabilityScanActivityIdempotencyKey({
          organizationId: persisted.organizationId,
          projectId: persisted.projectId,
          scanId: persisted.scanId,
        }),
        organizationId: persisted.organizationId,
        projectId: persisted.projectId,
        branchId: persisted.branchId,
        branchName: persisted.branch,
        workspaceId: durableId(persisted.projectId, 'ws'),
        runId: durableId(persisted.projectId, 'run'),
        taskId: durableId(persisted.projectId, 'task'),
        workspaceCreatedAt: persisted.createdAt.toISOString(),
      });
      try {
        const output = CapabilityScanOutputSchema.parse(await input.capabilityScan.scan(scanInput));
        await input.store.completeScan({ projectId: persisted.projectId, output, now: now() });
      } catch (error) {
        await input.store.recordRetryableFailure(persisted.projectId, 'scan_unavailable', now());
        throw error;
      }
    },
    async settleDeadLetter(body: string): Promise<void> {
      const message = GitHubImportQueueMessageSchema.parse(JSON.parse(body) as unknown);
      const persisted = await input.store.read(message.projectId);
      if (persisted === undefined || persisted.status === 'failed' || persisted.status === 'scan_accepted') {
        return;
      }
      if (
        (message.stage === 'queued' &&
          (persisted.status === 'queued' || persisted.status === 'mirroring')) ||
        (message.stage === 'scan_pending' && persisted.status === 'scan_pending')
      ) {
        const fallback = message.stage === 'queued' ? 'mirror_failed' : 'scan_unavailable';
        await input.store.fail(
          persisted.projectId,
          GitHubImportErrorCodeSchema.parse(persisted.errorCode ?? fallback),
          now(),
        );
      }
    },
  };
}

type TimerHandle = number | object;
interface ImportTimers {
  setInterval(callback: () => void, delayMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export interface GitHubImportLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createGitHubImportPublisherLifecycle(input: {
  readonly publisher: { publishOnce(limit: number): Promise<number> };
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly onError?: (error: Error) => void;
  readonly timers?: ImportTimers;
}): GitHubImportLifecycle {
  const timers = input.timers ?? {
    setInterval: (callback: () => void, delayMs: number) => setInterval(callback, delayMs),
    clearInterval: (handle: TimerHandle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
  let timer: TimerHandle | undefined;
  let active: Promise<void> | undefined;
  let closed = false;
  const poll = (): void => {
    if (closed || active !== undefined) return;
    active = input.publisher
      .publishOnce(input.batchSize)
      .then(() => undefined)
      .catch((error: unknown) => input.onError?.(error instanceof Error ? error : new Error(String(error))))
      .finally(() => {
        active = undefined;
      });
  };
  return {
    async start() {
      if (closed) throw new Error('GitHub import publisher lifecycle is closed');
      await input.publisher.publishOnce(input.batchSize);
      timer = timers.setInterval(poll, input.intervalMs);
    },
    async close() {
      closed = true;
      if (timer !== undefined) timers.clearInterval(timer);
      timer = undefined;
      await active;
    },
  };
}

export function createGitHubImportConsumerLifecycle(input: {
  readonly queue: GitHubImportQueuePort;
  readonly worker: { process(body: string): Promise<void>; settleDeadLetter(body: string): Promise<void> };
  readonly batchSize: number;
  readonly waitTimeSeconds: number;
  readonly visibilityTimeoutSeconds: number;
  readonly intervalMs: number;
  readonly onError?: (error: Error) => void;
  readonly timers?: ImportTimers;
}): GitHubImportLifecycle {
  const timers = input.timers ?? {
    setInterval: (callback: () => void, delayMs: number) => setInterval(callback, delayMs),
    clearInterval: (handle: TimerHandle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
  let timer: TimerHandle | undefined;
  let active: Promise<void> | undefined;
  let closed = false;
  const leaseVisibilityTimeoutSeconds = boundedVisibilityTimeout(
    input.visibilityTimeoutSeconds,
  );
  const heartbeatIntervalMs = Math.max(
    1,
    Math.floor((leaseVisibilityTimeoutSeconds * 1_000) / 3),
  );

  async function processWithVisibilityLease(
    queueName: 'main' | 'dlq',
    message: { readonly body: string; readonly receiptHandle: string },
  ): Promise<void> {
    let leaseTimer: TimerHandle | undefined;
    let heartbeat: Promise<void> | undefined;
    const leaseState = { failed: false };
    const stopHeartbeat = (): void => {
      if (leaseTimer !== undefined) timers.clearInterval(leaseTimer);
      leaseTimer = undefined;
    };
    const extendVisibility = (): void => {
      if (leaseState.failed || heartbeat !== undefined) return;
      heartbeat = input.queue
        .changeVisibility(queueName, message.receiptHandle, leaseVisibilityTimeoutSeconds)
        .catch((error: unknown) => {
          leaseState.failed = true;
          stopHeartbeat();
          input.onError?.(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          heartbeat = undefined;
        });
    };
    leaseTimer = timers.setInterval(extendVisibility, heartbeatIntervalMs);
    try {
      if (queueName === 'main') await input.worker.process(message.body);
      else await input.worker.settleDeadLetter(message.body);
      stopHeartbeat();
      await heartbeat;
      if (!leaseState.failed) await input.queue.delete(queueName, message.receiptHandle);
    } catch (error) {
      input.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      stopHeartbeat();
      await heartbeat;
    }
  }

  async function receive(queueName: 'main' | 'dlq'): Promise<void> {
    const messages = await input.queue.receive(queueName, {
      maxMessages: input.batchSize,
      waitTimeSeconds: input.waitTimeSeconds,
      visibilityTimeoutSeconds: leaseVisibilityTimeoutSeconds,
    });
    await Promise.all(
      messages.map((message) => processWithVisibilityLease(queueName, message)),
    );
  }
  async function pollBatch(): Promise<void> {
    await receive('main');
    await receive('dlq');
  }
  const poll = (): void => {
    if (closed || active !== undefined) return;
    active = pollBatch().finally(() => {
      active = undefined;
    });
  };
  return {
    async start() {
      if (closed) throw new Error('GitHub import consumer lifecycle is closed');
      await pollBatch();
      timer = timers.setInterval(poll, input.intervalMs);
    },
    async close() {
      closed = true;
      if (timer !== undefined) timers.clearInterval(timer);
      timer = undefined;
      await active;
    },
  };
}
