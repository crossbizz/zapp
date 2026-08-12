import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import { Worker, type NativeConnection, type WorkerOptions } from '@temporalio/worker';
import {
  TEMPORAL_RUN_WORKFLOW_TYPES,
  projectTemporalRunSignal,
  projectTemporalRunStart,
} from '@zapp/contracts';
import { createActivityIdempotencyRepository, type Database } from '@zapp/db';
import { z } from 'zod';

import type { EventActivities } from './activities/events.js';
import type { ApprovalActivities } from './activities/approvals.js';
import type { CapabilityScanActivities } from './activities/capability-scan.js';
import {
  createActivityIdempotencyInterceptor,
  type ActivityIdempotencyStore,
} from './activities/idempotency.js';
import type { SessionActivities } from './activities/session.js';
import type { WorkspaceActivities } from './activities/workspace.js';
import type { TaskWorkflowActivities } from './activities/merge.js';
import type { RepairActivities } from './activities/repair.js';
import type { FeatureFlagActivities } from './activities/feature-flags.js';
import type { VerifyPhaseActivities } from './activities/verify-phase.js';
import {
  fixWorkflow,
  FixWorkflowInputSchema,
  type FixModeActivities,
  type FixVerificationActivities,
} from './workflows/fix.js';
import {
  autonomousPlanApprovalSignal,
  autonomousSpecificationApprovalSignal,
  autonomousWorkflow,
  AutonomousWorkflowInputSchema,
  type AutonomousActivities,
} from './workflows/autonomous.js';
import {
  buildWorkflow,
  runWorkflow,
  RunWorkflowInputSchema,
  type BuildModeActivities,
} from './workflows/run.js';
import type { RedirectActivities } from './workflows/redirect.js';

export type RunActivities =
  & EventActivities
  & SessionActivities
  & WorkspaceActivities
  & ApprovalActivities;
export type ProductionRunActivities =
  & RunActivities
  & TaskWorkflowActivities
  & AutonomousActivities
  & FeatureFlagActivities
  & RedirectActivities
  & BuildModeActivities
  & FixModeActivities;
export type ProductionVerificationActivities =
  & CapabilityScanActivities
  & VerifyPhaseActivities
  & RepairActivities
  & FixVerificationActivities;

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
  if (typeof options.activities.evaluateFeatureFlag !== 'function') {
    throw new TypeError('Production run workers require feature-flag activities');
  }
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

export function createProductionCapabilityScanWorker(options: {
  readonly connection: NativeConnection;
  readonly activities: CapabilityScanActivities;
  readonly database: Database;
  readonly shutdownGraceTime?: WorkerOptions['shutdownGraceTime'];
}): Promise<Worker> {
  return Worker.create({
    connection: options.connection,
    taskQueue: TASK_QUEUES.verification,
    workflowsPath: workflowPath(),
    activities: options.activities,
    interceptors: {
      activity: [
        createActivityIdempotencyInterceptor({
          store: createActivityIdempotencyRepository(options.database),
        }),
      ],
    },
    ...(options.shutdownGraceTime === undefined
      ? {}
      : { shutdownGraceTime: options.shutdownGraceTime }),
  });
}

/** Production queue composition once phase verification is enabled beside capability scans. */
export function createProductionVerificationWorker(options: {
  readonly connection: NativeConnection;
  readonly activities: ProductionVerificationActivities;
  readonly database: Database;
  readonly shutdownGraceTime?: WorkerOptions['shutdownGraceTime'];
}): Promise<Worker> {
  return Worker.create({
    connection: options.connection,
    taskQueue: TASK_QUEUES.verification,
    workflowsPath: workflowPath(),
    activities: options.activities,
    interceptors: {
      activity: [
        createActivityIdempotencyInterceptor({
          store: createActivityIdempotencyRepository(options.database),
        }),
      ],
    },
    ...(options.shutdownGraceTime === undefined
      ? {}
      : { shutdownGraceTime: options.shutdownGraceTime }),
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
  useDedicatedBuildWorkflow: boolean,
): TemporalOrchestrator {
  return {
    async startRun(inputValue) {
      const projected = projectTemporalRunStart(inputValue);
      const workflowType =
        projected.workflowType === TEMPORAL_RUN_WORKFLOW_TYPES.build &&
        !useDedicatedBuildWorkflow
          ? TEMPORAL_RUN_WORKFLOW_TYPES.ask
          : projected.workflowType;
      const workflow = {
        [TEMPORAL_RUN_WORKFLOW_TYPES.ask]: runWorkflow,
        [TEMPORAL_RUN_WORKFLOW_TYPES.build]: buildWorkflow,
        [TEMPORAL_RUN_WORKFLOW_TYPES.fix]: fixWorkflow,
        [TEMPORAL_RUN_WORKFLOW_TYPES.autonomous]: autonomousWorkflow,
      }[workflowType];
      const input =
        projected.workflowType === TEMPORAL_RUN_WORKFLOW_TYPES.autonomous
          ? AutonomousWorkflowInputSchema.parse(projected.input)
          : projected.workflowType === TEMPORAL_RUN_WORKFLOW_TYPES.fix
            ? FixWorkflowInputSchema.parse(projected.input)
            : RunWorkflowInputSchema.parse(projected.input);
      try {
        await client.workflow.start(workflow, {
          taskQueue,
          workflowId: input.workflowId,
          args: [input],
        });
      } catch (error) {
        if (
          error instanceof WorkflowExecutionAlreadyStartedError &&
          error.workflowId === input.workflowId &&
          error.workflowType === workflowType
        ) return;
        throw error;
      }
    },
    async signalRun(inputValue) {
      const special = z
        .object({
          runId: z.string().regex(/^run_[0-9A-HJKMNP-TV-Z]{26}$/u),
          workflowId: z.string().min(1).max(255),
          signal: z.string().min(1).max(100),
          operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u),
          artifactId: z.string().min(1).max(512).optional(),
          decision: z.enum(['approved', 'rejected']).optional(),
        })
        .passthrough()
        .parse(inputValue);
      const handle = client.workflow.getHandle(special.workflowId);
      if (special.signal === 'autonomous_specification_approval') {
        await handle.signal(autonomousSpecificationApprovalSignal, {
          runId: special.runId,
          artifactId: z.string().min(1).max(512).parse(special.artifactId),
          decision: z.enum(['approved', 'rejected']).parse(special.decision),
          operationKey: special.operationKey,
        });
      } else if (special.signal === 'autonomous_plan_approval') {
        await handle.signal(autonomousPlanApprovalSignal, {
          runId: special.runId,
          artifactId: z.string().regex(/^art_[0-9A-HJKMNP-TV-Z]{26}$/u).parse(special.artifactId),
          decision: z.enum(['approved', 'rejected']).parse(special.decision),
          operationKey: special.operationKey,
        });
      } else {
        const projected = projectTemporalRunSignal(inputValue);
        await handle.signal(projected.signalName, projected.payload);
      }
      return { applied: true };
    },
  };
}

export function createTemporalOrchestrator(options: {
  readonly client: Pick<Client, 'workflow'>;
}): TemporalOrchestrator {
  return createTemporalOrchestratorForQueue(options.client, TASK_QUEUES.agentRuns, true);
}

export function createTestTemporalOrchestrator(options: {
  readonly client: Pick<Client, 'workflow'>;
  readonly taskQueue: string;
}): TemporalOrchestrator {
  if (TaskQueueSchema.safeParse(options.taskQueue).success) {
    throw new TypeError('A test Temporal orchestrator must not target a production queue');
  }
  return createTemporalOrchestratorForQueue(options.client, options.taskQueue, false);
}
