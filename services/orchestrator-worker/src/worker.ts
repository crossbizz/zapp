import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ApplicationFailure } from '@temporalio/activity';
import type { Client } from '@temporalio/client';
import { Worker, type NativeConnection, type WorkerOptions } from '@temporalio/worker';
import { createActivityIdempotencyRepository, type Database } from '@zapp/db';
import { z } from 'zod';

import type { EventActivities } from './activities/events.js';
import type { ApprovalActivities } from './activities/approvals.js';
import {
  createActivityIdempotencyInterceptor,
  type ActivityIdempotencyStore,
} from './activities/idempotency.js';
import type { SessionActivities } from './activities/session.js';
import type { WorkspaceActivities } from './activities/workspace.js';
import type { TaskWorkflowActivities } from './activities/merge.js';
import {
  budgetApprovalResolvedSignal,
  runWorkflow,
  RunWorkflowInputSchema,
} from './workflows/run.js';

export type RunActivities =
  & EventActivities
  & SessionActivities
  & WorkspaceActivities
  & ApprovalActivities;
export type ProductionRunActivities = RunActivities & TaskWorkflowActivities;

export const TASK_QUEUES = {
  agentRuns: 'agent-runs',
  verification: 'verification',
  releases: 'releases',
} as const;

export const TaskQueueSchema = z.enum([
  TASK_QUEUES.agentRuns,
  TASK_QUEUES.verification,
  TASK_QUEUES.releases,
]);
export type TaskQueue = z.infer<typeof TaskQueueSchema>;

interface CommonRunWorkerOptions {
  readonly connection: NativeConnection;
  readonly activities: RunActivities;
  readonly shutdownGraceTime?: WorkerOptions['shutdownGraceTime'];
  readonly maxHeartbeatThrottleInterval?: WorkerOptions['maxHeartbeatThrottleInterval'];
}

export type RunWorkerOptions = CommonRunWorkerOptions &
  (
    | {
        readonly taskQueue: TaskQueue;
        readonly idempotencyStore: ActivityIdempotencyStore;
        readonly testOnlyBypassActivityIdempotency?: never;
      }
    | {
        readonly taskQueue: string;
        readonly idempotencyStore?: never;
        readonly testOnlyBypassActivityIdempotency: true;
      }
  );

function workflowPath(): string {
  const source = fileURLToPath(new URL('./workflows/run.ts', import.meta.url));
  if (existsSync(source)) return source;
  return fileURLToPath(new URL('./workflows/run.js', import.meta.url));
}

export function createRunWorker(options: RunWorkerOptions): Promise<Worker> {
  if (
    options.testOnlyBypassActivityIdempotency === true &&
    TaskQueueSchema.safeParse(options.taskQueue).success
  ) {
    throw new TypeError('Activity idempotency cannot be bypassed on a production Temporal queue');
  }
  const interceptors =
    'idempotencyStore' in options
      ? { activity: [createActivityIdempotencyInterceptor({ store: options.idempotencyStore })] }
      : undefined;
  return Worker.create({
    connection: options.connection,
    taskQueue: options.taskQueue,
    workflowsPath: workflowPath(),
    activities: options.activities,
    ...(interceptors === undefined ? {} : { interceptors }),
    ...(options.shutdownGraceTime === undefined
      ? {}
      : { shutdownGraceTime: options.shutdownGraceTime }),
    ...(options.maxHeartbeatThrottleInterval === undefined
      ? {}
      : { maxHeartbeatThrottleInterval: options.maxHeartbeatThrottleInterval }),
  });
}

export function createProductionRunWorker(
  options: Omit<CommonRunWorkerOptions, 'activities'> & {
    readonly activities: ProductionRunActivities;
    readonly taskQueue: TaskQueue;
    readonly database: Database;
  },
): Promise<Worker> {
  return createRunWorker({
    connection: options.connection,
    taskQueue: TaskQueueSchema.parse(options.taskQueue),
    activities: options.activities,
    idempotencyStore: createActivityIdempotencyRepository(options.database),
    ...(options.shutdownGraceTime === undefined
      ? {}
      : { shutdownGraceTime: options.shutdownGraceTime }),
    ...(options.maxHeartbeatThrottleInterval === undefined
      ? {}
      : { maxHeartbeatThrottleInterval: options.maxHeartbeatThrottleInterval }),
  });
}

/** Business outcomes are explicit Temporal failures and are never retried. */
export function createBusinessFailure(type: string, message: string): ApplicationFailure {
  const parsedType = z.string().regex(/^[a-z][a-z0-9_]{1,127}$/u).parse(type);
  const parsedMessage = z.string().min(1).max(1_024).parse(message);
  return ApplicationFailure.nonRetryable(parsedMessage, parsedType);
}

export interface TemporalOrchestrator {
  startRun(input: unknown): Promise<void>;
  signalRun(input: unknown): Promise<{ applied: boolean }>;
}

function createTemporalOrchestratorForQueue(
  client: Pick<Client, 'workflow'>,
  taskQueue: string,
): TemporalOrchestrator {
  return {
    async startRun(inputValue) {
      const input = RunWorkflowInputSchema.parse(inputValue);
      await client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: input.workflowId,
        args: [input],
      });
    },
    async signalRun(inputValue) {
      const input = z
        .object({
          workflowId: z.string().min(1).max(255),
          signal: z.string().min(1).max(100),
          approvalId: z.string().optional(),
          decision: z.enum(['approved', 'rejected']).optional(),
          absoluteCeiling: z.string().optional(),
        })
        .passthrough()
        .parse(inputValue);
      const handle = client.workflow.getHandle(input.workflowId);
      if (input.signal === 'budget_approval') {
        await handle.signal(budgetApprovalResolvedSignal, {
          approvalId: input.approvalId,
          decision: input.decision,
          ...(input.absoluteCeiling === undefined
            ? {}
            : { absoluteCeiling: input.absoluteCeiling }),
        });
      } else {
        await handle.signal(input.signal);
      }
      return { applied: true };
    },
  };
}

export function createTemporalOrchestrator(options: {
  readonly client: Pick<Client, 'workflow'>;
}): TemporalOrchestrator {
  return createTemporalOrchestratorForQueue(options.client, TASK_QUEUES.agentRuns);
}

export function createTestTemporalOrchestrator(options: {
  readonly client: Pick<Client, 'workflow'>;
  readonly taskQueue: string;
}): TemporalOrchestrator {
  if (TaskQueueSchema.safeParse(options.taskQueue).success) {
    throw new TypeError('A test Temporal orchestrator must not target a production queue');
  }
  return createTemporalOrchestratorForQueue(options.client, options.taskQueue);
}
