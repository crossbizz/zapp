import { executeChild, proxyActivities, type RetryPolicy } from '@temporalio/workflow';
import { z } from 'zod';

import {
  TaskWorkflowActivityInputSchemas,
  TaskWorkflowActivityResultSchemas,
  type TaskWorkflowActivities,
} from '../activities/merge.js';
const idSchema = (prefix: 'run' | 'org' | 'proj'): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
const RunModeSchema = z.enum(['ask', 'prototype', 'build', 'fix', 'autonomous']);
const TaskIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const ACTIVITY_RETRY_POLICY: RetryPolicy = {
  initialInterval: '100 milliseconds',
  maximumAttempts: 3,
  nonRetryableErrorTypes: [
    'activity_idempotency_conflict',
    'activity_idempotency_key_required',
    'activity_idempotency_corrupt',
  ],
};

export const TaskWorkflowInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    taskId: TaskIdSchema,
    mode: RunModeSchema,
    model: z.string().min(1).max(160).nullable(),
    prompt: z.string().min(1).max(20_000),
    budget: z
      .object({ maxCredits: z.number().int().positive().max(1_000_000) })
      .strict()
      .nullable(),
    attempt: z.number().int().nonnegative().max(100).optional(),
  })
  .strict();
export type TaskWorkflowInput = z.infer<typeof TaskWorkflowInputSchema>;

export const TaskWorkflowResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      taskId: TaskIdSchema,
      status: z.literal('verifying'),
      baseCommitSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
      branchName: z.string().min(1).max(255),
      workspaceId: z.string().min(1).max(512),
      commitSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
    })
    .strict(),
  z
    .object({
      taskId: TaskIdSchema,
      status: z.literal('blocked'),
      baseCommitSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
      branchName: z.string().min(1).max(255),
      workspaceId: z.string().min(1).max(512),
      commitSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
      conflictTaskId: TaskIdSchema,
    })
    .strict(),
  z
    .object({
      taskId: TaskIdSchema,
      status: z.literal('failed'),
      failureType: z.string().min(1).max(160),
    })
    .strict(),
]);
export type TaskWorkflowResult = z.infer<typeof TaskWorkflowResultSchema>;

export const TaskBatchWorkflowInputSchema = z
  .object({
    runId: idSchema('run'),
    maxConcurrency: z.number().int().positive().max(100),
    tasks: z.array(TaskWorkflowInputSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.tasks.some((task) => task.runId !== input.runId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'task_batch_run_mismatch' });
    }
    if (new Set(input.tasks.map((task) => task.taskId)).size !== input.tasks.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'task_batch_duplicate_task' });
    }
  });
export type TaskBatchWorkflowInput = z.infer<typeof TaskBatchWorkflowInputSchema>;

const taskActivities = proxyActivities<TaskWorkflowActivities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  cancellationType: 'WAIT_CANCELLATION_COMPLETED',
  retry: ACTIVITY_RETRY_POLICY,
});

function operationKey(input: TaskWorkflowInput, step: string): string {
  return `${input.runId}:${input.taskId}:attempt:${String(input.attempt ?? 0)}:${step}`;
}

export async function taskWorkflow(inputValue: unknown): Promise<TaskWorkflowResult> {
  const input = TaskWorkflowInputSchema.parse(inputValue);
  const scope = {
    runId: input.runId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    taskId: input.taskId,
  } as const;
  const branchName = `task/${input.taskId}`;
  const integrationBranch = `run/${input.runId}`;
  const base = TaskWorkflowActivityResultSchemas.recordBaseCommit.parse(
    await taskActivities.recordBaseCommit(
      TaskWorkflowActivityInputSchemas.recordBaseCommit.parse({
        ...scope,
        integrationBranch,
        idempotencyKey: operationKey(input, 'record-base'),
      }),
    ),
  );
  const workspace = TaskWorkflowActivityResultSchemas.createTaskWorkspace.parse(
    await taskActivities.createTaskWorkspace(
      TaskWorkflowActivityInputSchemas.createTaskWorkspace.parse({
        ...scope,
        baseCommitSha: base.baseCommitSha,
        branchName,
        idempotencyKey: operationKey(input, 'create-workspace'),
      }),
    ),
  );
  await taskActivities.transitionTaskState(
    TaskWorkflowActivityInputSchemas.transitionTaskState.parse({
      ...scope,
      status: 'running',
      idempotencyKey: operationKey(input, 'status-running'),
    }),
  );
  const session = TaskWorkflowActivityResultSchemas.runTaskBuilderSession.parse(
    await taskActivities.runTaskBuilderSession(
      TaskWorkflowActivityInputSchemas.runTaskBuilderSession.parse({
        ...scope,
        workspaceId: workspace.workspaceId,
        mode: input.mode,
        model: input.model,
        prompt: input.prompt,
        budget: input.budget,
        idempotencyKey: operationKey(input, 'builder-session'),
      }),
    ),
  );
  if (session.status !== 'completed') {
    const failureType = `task_builder_session_${session.status}`;
    await taskActivities.transitionTaskState(
      TaskWorkflowActivityInputSchemas.transitionTaskState.parse({
        ...scope,
        status: 'failed',
        idempotencyKey: operationKey(input, 'status-failed'),
      }),
    );
    return TaskWorkflowResultSchema.parse({ taskId: input.taskId, status: 'failed', failureType });
  }
  const committed = TaskWorkflowActivityResultSchemas.commitAndPushTask.parse(
    await taskActivities.commitAndPushTask(
      TaskWorkflowActivityInputSchemas.commitAndPushTask.parse({
        ...scope,
        workspaceId: workspace.workspaceId,
        branchName,
        message: `Complete task ${input.taskId}`,
        idempotencyKey: operationKey(input, 'commit-and-push'),
      }),
    ),
  );
  await taskActivities.transitionTaskState(
    TaskWorkflowActivityInputSchemas.transitionTaskState.parse({
      ...scope,
      status: 'verifying',
      idempotencyKey: operationKey(input, 'status-verifying'),
    }),
  );
  const merged = TaskWorkflowActivityResultSchemas.mergeTask.parse(
    await taskActivities.mergeTask(
      TaskWorkflowActivityInputSchemas.mergeTask.parse({
        ...scope,
        sourceBranch: branchName,
        integrationBranch,
        baseCommitSha: base.baseCommitSha,
        taskCommitSha: committed.commitSha,
        idempotencyKey: operationKey(input, 'merge'),
      }),
    ),
  );
  if (merged.outcome === 'merged') {
    return TaskWorkflowResultSchema.parse({
      taskId: input.taskId,
      status: 'verifying',
      baseCommitSha: base.baseCommitSha,
      branchName,
      workspaceId: workspace.workspaceId,
      commitSha: committed.commitSha,
    });
  }
  const conflict = TaskWorkflowActivityResultSchemas.createConflictTask.parse(
    await taskActivities.createConflictTask(
      TaskWorkflowActivityInputSchemas.createConflictTask.parse({
        ...scope,
        sourceBranch: branchName,
        integrationBranch,
        baseCommitSha: base.baseCommitSha,
        taskCommitSha: committed.commitSha,
        integrationHeadSha: merged.integrationHeadSha,
        conflictingPaths: merged.conflictingPaths,
        idempotencyKey: operationKey(input, 'create-conflict-task'),
      }),
    ),
  );
  await taskActivities.transitionTaskState(
    TaskWorkflowActivityInputSchemas.transitionTaskState.parse({
      ...scope,
      status: 'blocked',
      idempotencyKey: operationKey(input, 'status-blocked'),
    }),
  );
  await taskActivities.emitTaskBlocked(
    TaskWorkflowActivityInputSchemas.emitTaskBlocked.parse({
      ...scope,
      conflictTaskId: conflict.conflictTaskId,
      conflictingPaths: merged.conflictingPaths,
      idempotencyKey: operationKey(input, 'event-task-blocked'),
    }),
  );
  return TaskWorkflowResultSchema.parse({
    taskId: input.taskId,
    status: 'blocked',
    baseCommitSha: base.baseCommitSha,
    branchName,
    workspaceId: workspace.workspaceId,
    commitSha: committed.commitSha,
    conflictTaskId: conflict.conflictTaskId,
  });
}

export async function runTaskBatchWorkflow(inputValue: unknown): Promise<TaskWorkflowResult[]> {
  const input = TaskBatchWorkflowInputSchema.parse(inputValue);
  const results: TaskWorkflowResult[] = [];
  for (let offset = 0; offset < input.tasks.length; offset += input.maxConcurrency) {
    const batch = input.tasks.slice(offset, offset + input.maxConcurrency);
    const completed = await Promise.all(
      batch.map((task) =>
        executeChild(taskWorkflow, {
          workflowId: `task:${input.runId}:${task.taskId}:attempt:${String(task.attempt ?? 0)}`,
          args: [task],
        }),
      ),
    );
    results.push(...completed.map((result) => TaskWorkflowResultSchema.parse(result)));
  }
  return results;
}
