import { z } from 'zod';

const idSchema = (prefix: 'run' | 'org' | 'proj'): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
const RunModeSchema = z.enum(['ask', 'prototype', 'build', 'fix', 'autonomous']);
const TaskStateSchema = z.enum([
  'queued',
  'blocked',
  'ready',
  'running',
  'waiting_for_approval',
  'verifying',
  'repairing',
  'passed',
  'failed',
  'cancelled',
  'superseded',
]);
const TaskIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const CommitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);
const OperationKeySchema = z.string().min(1).max(512);
const BranchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?:task|run)\/[A-Za-z0-9][A-Za-z0-9._-]*$/u);

const TaskScopeSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    taskId: TaskIdSchema,
  })
  .strict();

export const RecordBaseCommitInputSchema = TaskScopeSchema.extend({
  integrationBranch: BranchNameSchema,
  idempotencyKey: OperationKeySchema,
}).strict();
export const RecordBaseCommitResultSchema = z
  .object({ baseCommitSha: CommitShaSchema })
  .strict();

export const CreateTaskWorkspaceInputSchema = TaskScopeSchema.extend({
  baseCommitSha: CommitShaSchema,
  branchName: BranchNameSchema,
  idempotencyKey: OperationKeySchema,
}).strict();
export const TaskWorkspaceResultSchema = z
  .object({
    workspaceId: z.string().min(1).max(512),
    workspacePath: z.string().startsWith('/').min(2).max(4_096),
  })
  .strict();
export type TaskWorkspaceResult = z.infer<typeof TaskWorkspaceResultSchema>;

export const TransitionTaskStateInputSchema = TaskScopeSchema.extend({
  status: TaskStateSchema.extract(['running', 'verifying', 'blocked']),
  idempotencyKey: OperationKeySchema,
}).strict();

export const RunTaskBuilderSessionInputSchema = TaskScopeSchema.extend({
  workspaceId: z.string().min(1).max(512),
  mode: RunModeSchema,
  model: z.string().min(1).max(160).nullable(),
  prompt: z.string().min(1).max(20_000),
  budget: z
    .object({ maxCredits: z.number().int().positive().max(1_000_000) })
    .strict()
    .nullable(),
  idempotencyKey: OperationKeySchema,
}).strict();
export const TaskBuilderSessionResultSchema = z
  .object({
    status: z.enum(['completed', 'needs_approval', 'budget_exhausted', 'failed', 'cancelled']),
  })
  .strict();

export const CommitAndPushTaskInputSchema = TaskScopeSchema.extend({
  workspaceId: z.string().min(1).max(512),
  branchName: BranchNameSchema,
  message: z.string().min(1).max(10_000),
  idempotencyKey: OperationKeySchema,
}).strict();
export const CommitAndPushTaskResultSchema = z
  .object({ commitSha: CommitShaSchema })
  .strict();

export const MergeTaskInputSchema = TaskScopeSchema.extend({
  sourceBranch: BranchNameSchema,
  integrationBranch: BranchNameSchema,
  baseCommitSha: CommitShaSchema,
  taskCommitSha: CommitShaSchema,
  idempotencyKey: OperationKeySchema,
}).strict();
export const MergeTaskResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('merged') }).strict(),
  z
    .object({
      outcome: z.literal('conflict'),
      conflictingPaths: z.array(z.string().min(1).max(4_096)).min(1).max(1_000),
      integrationHeadSha: CommitShaSchema,
    })
    .strict(),
]);

export const CreateConflictTaskInputSchema = TaskScopeSchema.extend({
  sourceBranch: BranchNameSchema,
  integrationBranch: BranchNameSchema,
  baseCommitSha: CommitShaSchema,
  taskCommitSha: CommitShaSchema,
  integrationHeadSha: CommitShaSchema,
  conflictingPaths: z.array(z.string().min(1).max(4_096)).min(1).max(1_000),
  idempotencyKey: OperationKeySchema,
}).strict();
export const CreateConflictTaskResultSchema = z
  .object({ conflictTaskId: TaskIdSchema })
  .strict();

export const EmitTaskBlockedInputSchema = TaskScopeSchema.extend({
  conflictTaskId: TaskIdSchema,
  conflictingPaths: z.array(z.string().min(1).max(4_096)).min(1).max(1_000),
  idempotencyKey: OperationKeySchema,
}).strict();

export interface TaskWorkflowActivities {
  recordBaseCommit(
    input: z.infer<typeof RecordBaseCommitInputSchema>,
  ): Promise<z.infer<typeof RecordBaseCommitResultSchema>>;
  createTaskWorkspace(
    input: z.infer<typeof CreateTaskWorkspaceInputSchema>,
  ): Promise<TaskWorkspaceResult>;
  transitionTaskState(input: z.infer<typeof TransitionTaskStateInputSchema>): Promise<void>;
  runTaskBuilderSession(
    input: z.infer<typeof RunTaskBuilderSessionInputSchema>,
  ): Promise<z.infer<typeof TaskBuilderSessionResultSchema>>;
  commitAndPushTask(
    input: z.infer<typeof CommitAndPushTaskInputSchema>,
  ): Promise<z.infer<typeof CommitAndPushTaskResultSchema>>;
  mergeTask(
    input: z.infer<typeof MergeTaskInputSchema>,
  ): Promise<z.infer<typeof MergeTaskResultSchema>>;
  createConflictTask(
    input: z.infer<typeof CreateConflictTaskInputSchema>,
  ): Promise<z.infer<typeof CreateConflictTaskResultSchema>>;
  emitTaskBlocked(input: z.infer<typeof EmitTaskBlockedInputSchema>): Promise<void>;
}

export const TaskWorkflowActivityResultSchemas = {
  recordBaseCommit: RecordBaseCommitResultSchema,
  createTaskWorkspace: TaskWorkspaceResultSchema,
  runTaskBuilderSession: TaskBuilderSessionResultSchema,
  commitAndPushTask: CommitAndPushTaskResultSchema,
  mergeTask: MergeTaskResultSchema,
  createConflictTask: CreateConflictTaskResultSchema,
} as const;

export const TaskWorkflowActivityInputSchemas = {
  recordBaseCommit: RecordBaseCommitInputSchema,
  createTaskWorkspace: CreateTaskWorkspaceInputSchema,
  transitionTaskState: TransitionTaskStateInputSchema,
  runTaskBuilderSession: RunTaskBuilderSessionInputSchema,
  commitAndPushTask: CommitAndPushTaskInputSchema,
  mergeTask: MergeTaskInputSchema,
  createConflictTask: CreateConflictTaskInputSchema,
  emitTaskBlocked: EmitTaskBlockedInputSchema,
} as const;
