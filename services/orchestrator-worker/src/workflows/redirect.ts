import { ApplicationFailure, condition, proxyActivities, type RetryPolicy } from '@temporalio/workflow';
import {
  applyPlanDiff,
  dependentTaskClosure,
  derivePlanDiffImpact,
  PlanDiffSchema,
  PlanSchema,
  type Plan,
  type PlanDiff,
} from '@zapp/planning-engine';
import { z } from 'zod';

import type { PendingAgentEvent } from '../activities/events.js';

const idSchema = (prefix: 'run' | 'org' | 'proj' | 'art' | 'task' | 'vr'): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, 'u'));
const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
const ActivityKeySchema = z.string().min(1).max(512);
const TaskIdSchema = idSchema('task');
const taskIdListSchema = (minimum = 0) => z
  .array(TaskIdSchema)
  .min(minimum)
  .max(10_000)
  .superRefine((taskIds, context) => {
    if (new Set(taskIds).size !== taskIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'redirect_duplicate_task' });
    }
  });
const TaskIdListSchema = taskIdListSchema();
const RequiredTaskIdListSchema = taskIdListSchema(1);

const RedirectScopeSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
  })
  .strict();

export const RedirectInstructionSchema = z
  .object({
    instruction: z.string().trim().min(1).max(20_000),
    operationKey: OperationKeySchema,
  })
  .strict();
export type RedirectInstruction = z.infer<typeof RedirectInstructionSchema>;

export const PauseRedirectTasksInputSchema = RedirectScopeSchema.extend({
  affectedTaskIds: TaskIdListSchema,
  idempotencyKey: ActivityKeySchema,
}).strict();
export const PauseRedirectTasksResultSchema = z
  .object({ pausedTaskIds: TaskIdListSchema })
  .strict();

export const ResumeRedirectTasksInputSchema = RedirectScopeSchema.extend({
  planArtifactId: idSchema('art'),
  taskIds: TaskIdListSchema,
  idempotencyKey: ActivityKeySchema,
}).strict();
export const ResumeRedirectTasksResultSchema = z
  .object({ resumedTaskIds: TaskIdListSchema })
  .strict();

export const ProduceRedirectPlanDiffInputSchema = RedirectScopeSchema.extend({
  currentPlanArtifactId: idSchema('art'),
  currentPlan: PlanSchema,
  instruction: z.string().trim().min(1).max(20_000),
  affectedTaskIds: TaskIdListSchema,
  idempotencyKey: ActivityKeySchema,
}).strict();
export const ProduceRedirectPlanDiffResultSchema = z
  .object({
    planDiffArtifactId: idSchema('art'),
    planDiff: PlanDiffSchema,
  })
  .strict();

export const ApplyRedirectPlanDiffInputSchema = RedirectScopeSchema.extend({
  currentPlanArtifactId: idSchema('art'),
  currentPlan: PlanSchema,
  planDiffArtifactId: idSchema('art'),
  planDiff: PlanDiffSchema,
  idempotencyKey: ActivityKeySchema,
}).strict();
const SupersededTaskResultSchema = z
  .object({
    taskId: TaskIdSchema,
    retainedArtifactIds: z.array(idSchema('art')).max(10_000),
  })
  .strict();
export const ApplyRedirectPlanDiffResultSchema = z
  .object({
    planArtifactId: idSchema('art'),
    plan: PlanSchema,
    supersededTasks: z.array(SupersededTaskResultSchema).max(10_000),
  })
  .strict();

export const RevalidateRedirectedTasksInputSchema = RedirectScopeSchema.extend({
  planArtifactId: idSchema('art'),
  planDiffArtifactId: idSchema('art'),
  taskIds: RequiredTaskIdListSchema,
  idempotencyKey: ActivityKeySchema,
}).strict();
export const RevalidateRedirectedTasksResultSchema = z
  .object({
    verificationResultId: idSchema('vr'),
    decision: z.enum(['approved', 'rejected', 'needs_human']),
    taskIds: RequiredTaskIdListSchema,
  })
  .strict();

export const CheckpointRedirectInputSchema = RedirectScopeSchema.extend({
  planArtifactId: idSchema('art'),
  planDiffArtifactId: idSchema('art'),
  affectedTaskIds: TaskIdListSchema,
  revalidatedTaskIds: TaskIdListSchema,
  idempotencyKey: ActivityKeySchema,
}).strict();
export const CheckpointRedirectResultSchema = z
  .object({ checkpointRef: z.string().min(1).max(2_048) })
  .strict();

export interface RedirectActivities {
  /** Atomically moves the dependency closure out of runnable states before replanning. */
  pauseRedirectTasks(
    input: z.infer<typeof PauseRedirectTasksInputSchema>,
  ): Promise<z.infer<typeof PauseRedirectTasksResultSchema>>;
  /** Restores still-active paused tasks to their pre-redirect runnable state. */
  resumeRedirectTasks(
    input: z.infer<typeof ResumeRedirectTasksInputSchema>,
  ): Promise<z.infer<typeof ResumeRedirectTasksResultSchema>>;
  /** Planner-owned activity that persists the strict PlanDiff as an immutable artifact. */
  produceRedirectPlanDiff(
    input: z.infer<typeof ProduceRedirectPlanDiffInputSchema>,
  ): Promise<z.infer<typeof ProduceRedirectPlanDiffResultSchema>>;
  /**
   * Atomically persists the replacement plan and marks obsolete task rows superseded.
   * Implementations must never delete task rows or their artifact rows.
   */
  applyRedirectPlanDiff(
    input: z.infer<typeof ApplyRedirectPlanDiffInputSchema>,
  ): Promise<z.infer<typeof ApplyRedirectPlanDiffResultSchema>>;
  /** Verifies only completed tasks in the reverse dependency closure of changed work. */
  revalidateRedirectedTasks(
    input: z.infer<typeof RevalidateRedirectedTasksInputSchema>,
  ): Promise<z.infer<typeof RevalidateRedirectedTasksResultSchema>>;
  checkpointRedirect(
    input: z.infer<typeof CheckpointRedirectInputSchema>,
  ): Promise<z.infer<typeof CheckpointRedirectResultSchema>>;
}

const RETRY_POLICY: RetryPolicy = {
  initialInterval: '100 milliseconds',
  maximumAttempts: 3,
  nonRetryableErrorTypes: [
    'activity_idempotency_conflict',
    'activity_idempotency_key_required',
    'activity_idempotency_corrupt',
  ],
};
const redirectActivities = proxyActivities<RedirectActivities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  retry: RETRY_POLICY,
});

export interface RedirectApprovalResolution {
  readonly decision: 'approved' | 'rejected';
  readonly operationKey: string;
  readonly approvalId?: string | undefined;
  readonly approvalKind?: 'specification' | 'plan' | 'plan_diff' | undefined;
}

export type RedirectPaidBoundary = 'produce_plan_diff' | 'revalidate';

export interface RedirectPlanChangeHooks<ControlResult = never> {
  emit(
    type: PendingAgentEvent['type'],
    suffix: string,
    payload: Record<string, unknown>,
    taskId?: string,
  ): Promise<void>;
  transitionRunStatus(status: 'paused' | 'waiting_for_approval' | 'running', suffix: string): Promise<void>;
  beforePaidBoundary(boundary: RedirectPaidBoundary): Promise<ControlResult | undefined>;
  requestApproval(artifactId: string): Promise<{ readonly approvalId: string }>;
  approvalFor(artifactId: string): RedirectApprovalResolution | undefined;
  cancellationRequested(): boolean;
}

export interface RedirectPlanChangeInput {
  readonly runId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly currentPlanArtifactId: string;
  readonly currentPlan: Plan;
  readonly redirect: RedirectInstruction;
  readonly directAffectedTaskIds: readonly string[];
  readonly completedTaskIds: readonly string[];
}

const RedirectPlanChangeInputSchema = RedirectScopeSchema.extend({
  currentPlanArtifactId: idSchema('art'),
  currentPlan: PlanSchema,
  redirect: RedirectInstructionSchema,
  directAffectedTaskIds: TaskIdListSchema,
  completedTaskIds: TaskIdListSchema,
}).strict();

export type RedirectPlanChangeResult<ControlResult = never> =
  | {
      readonly status: 'applied';
      readonly planArtifactId: string;
      readonly plan: Plan;
      readonly checkpointRef: string;
      readonly supersededTaskIds: readonly string[];
      readonly revalidatedTaskIds: readonly string[];
    }
  | {
      readonly status: 'rejected';
      readonly planArtifactId: string;
      readonly plan: Plan;
      readonly checkpointRef: string;
      readonly supersededTaskIds: readonly [];
      readonly revalidatedTaskIds: readonly [];
    }
  | { readonly status: 'controlled'; readonly result: ControlResult }
  | { readonly status: 'cancelled' };

function operationSuffix(operationKey: string): string {
  return OperationKeySchema.parse(operationKey).slice(-12);
}

function sameTaskIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((taskId, index) => taskId === right[index]);
}

function samePlan(left: Plan, right: Plan): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function affectedCompletedTaskIds(
  plan: Plan,
  diff: PlanDiff,
  completedTaskIds: readonly string[],
): readonly string[] {
  const knownIds = new Set(plan.tasks.map(({ id }) => id));
  const changedIds = [
    ...diff.supersededTaskIds,
    ...diff.modifiedTasks.map(({ id }) => id),
  ].filter((taskId, index, values) => knownIds.has(taskId) && values.indexOf(taskId) === index);
  if (changedIds.length === 0) return [];
  const closure = new Set(dependentTaskClosure(plan, changedIds));
  return plan.tasks
    .map(({ id }) => id)
    .filter((taskId) => closure.has(taskId) && completedTaskIds.includes(taskId));
}

async function checkpoint(
  input: RedirectPlanChangeInput,
  planArtifactId: string,
  planDiffArtifactId: string,
  affectedTaskIds: readonly string[],
  revalidatedTaskIds: readonly string[],
): Promise<string> {
  const result = CheckpointRedirectResultSchema.parse(
    await redirectActivities.checkpointRedirect(
      CheckpointRedirectInputSchema.parse({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planArtifactId,
        planDiffArtifactId,
        affectedTaskIds,
        revalidatedTaskIds,
        idempotencyKey: `${input.runId}:redirect:${operationSuffix(input.redirect.operationKey)}:checkpoint`,
      }),
    ),
  );
  return result.checkpointRef;
}

async function resumeTasks(
  input: RedirectPlanChangeInput,
  planArtifactId: string,
  taskIds: readonly string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  const suffix = operationSuffix(input.redirect.operationKey);
  const resumed = ResumeRedirectTasksResultSchema.parse(
    await redirectActivities.resumeRedirectTasks(
      ResumeRedirectTasksInputSchema.parse({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planArtifactId,
        taskIds,
        idempotencyKey: `${input.runId}:redirect:${suffix}:resume`,
      }),
    ),
  );
  if (!sameTaskIds(resumed.resumedTaskIds, taskIds)) {
    throw ApplicationFailure.nonRetryable(
      'Redirect resume result does not match the active paused task set',
      'redirect_resume_identity_mismatch',
    );
  }
}

export async function processRedirectPlanChange<ControlResult = never>(
  inputValue: RedirectPlanChangeInput,
  hooks: RedirectPlanChangeHooks<ControlResult>,
): Promise<RedirectPlanChangeResult<ControlResult>> {
  const input = RedirectPlanChangeInputSchema.parse(inputValue);
  const scope = {
    runId: input.runId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  };
  const currentPlan = input.currentPlan;
  const currentPlanArtifactId = input.currentPlanArtifactId;
  const redirect = input.redirect;
  const directAffectedTaskIds = input.directAffectedTaskIds;
  const completedTaskIds = input.completedTaskIds;
  const suffix = operationSuffix(redirect.operationKey);
  const affectedTaskIds = dependentTaskClosure(currentPlan, directAffectedTaskIds);

  await hooks.transitionRunStatus('paused', `redirect-paused:${suffix}`);
  if (affectedTaskIds.length > 0) {
    const paused = PauseRedirectTasksResultSchema.parse(
      await redirectActivities.pauseRedirectTasks(
        PauseRedirectTasksInputSchema.parse({
          ...scope,
          affectedTaskIds,
          idempotencyKey: `${scope.runId}:redirect:${suffix}:pause`,
        }),
      ),
    );
    if (!sameTaskIds(paused.pausedTaskIds, affectedTaskIds)) {
      throw ApplicationFailure.nonRetryable(
        'Redirect pause result does not match the dependency closure',
        'redirect_pause_identity_mismatch',
      );
    }
  }
  await hooks.emit('run.paused', `redirect-paused:${suffix}`, {
    reason: 'redirect_requested',
    operationKey: redirect.operationKey,
    affectedTaskIds,
  });

  const plannerControl = await hooks.beforePaidBoundary('produce_plan_diff');
  if (plannerControl !== undefined) return { status: 'controlled', result: plannerControl };
  const produced = ProduceRedirectPlanDiffResultSchema.parse(
    await redirectActivities.produceRedirectPlanDiff(
      ProduceRedirectPlanDiffInputSchema.parse({
        ...scope,
        currentPlanArtifactId,
        currentPlan,
        instruction: redirect.instruction,
        affectedTaskIds,
        idempotencyKey: `${scope.runId}:redirect:${suffix}:produce-diff`,
      }),
    ),
  );
  await hooks.emit('artifact.created', `redirect-diff:${suffix}`, {
    artifactId: produced.planDiffArtifactId,
    artifactType: 'plan_diff',
    planDiff: produced.planDiff,
  });

  const effectiveImpact = derivePlanDiffImpact(currentPlan, produced.planDiff);
  const material = Object.values(effectiveImpact).some(Boolean);
  if (material) {
    const requestedApproval = await hooks.requestApproval(produced.planDiffArtifactId);
    await hooks.transitionRunStatus('waiting_for_approval', `redirect-waiting:${suffix}`);
    await hooks.emit('conversation.card', `redirect-card:${suffix}`, {
      card: {
        version: 1,
        kind: 'plan',
        cardId: `card_${scope.runId}:plan-diff:${suffix}`,
        approvalId: requestedApproval.approvalId,
        artifactId: produced.planDiffArtifactId,
        approvalKind: 'plan_diff',
      },
    });
    await hooks.emit('approval.requested', `redirect-approval-requested:${suffix}`, {
      gate: 'plan_diff',
      approvalId: requestedApproval.approvalId,
      type: 'plan_diff',
      status: 'pending',
      request: { artifactId: produced.planDiffArtifactId, impact: effectiveImpact },
      artifactId: produced.planDiffArtifactId,
      impact: effectiveImpact,
    });
    const matchingApproval = (): RedirectApprovalResolution | undefined => {
      const resolution = hooks.approvalFor(produced.planDiffArtifactId);
      if (
        resolution === undefined ||
        (resolution.approvalId !== undefined &&
          resolution.approvalId !== requestedApproval.approvalId) ||
        (resolution.approvalKind !== undefined && resolution.approvalKind !== 'plan_diff')
      ) return undefined;
      return resolution;
    };
    await condition(
      () =>
        matchingApproval() !== undefined ||
        hooks.cancellationRequested(),
    );
    if (hooks.cancellationRequested()) return { status: 'cancelled' };
    const resolution = matchingApproval();
    if (resolution === undefined) {
      throw ApplicationFailure.nonRetryable(
        'Redirect approval disappeared after its condition resolved',
        'redirect_approval_missing',
      );
    }
    await hooks.emit('approval.resolved', `redirect-approval-resolved:${suffix}`, {
      gate: 'plan_diff',
      approvalId: requestedApproval.approvalId,
      approvalKind: 'plan_diff',
      artifactId: produced.planDiffArtifactId,
      decision: resolution.decision,
      resolution: 'human',
      operationKey: resolution.operationKey,
    });
    if (resolution.decision === 'rejected') {
      const checkpointRef = await checkpoint(
        input,
        currentPlanArtifactId,
        produced.planDiffArtifactId,
        affectedTaskIds,
        [],
      );
      await resumeTasks(input, currentPlanArtifactId, affectedTaskIds);
      await hooks.transitionRunStatus('running', `redirect-rejected-resumed:${suffix}`);
      await hooks.emit('run.resumed', `redirect-rejected-resumed:${suffix}`, {
        checkpointRef,
        operationKey: redirect.operationKey,
        planArtifactId: currentPlanArtifactId,
        redirectDecision: 'rejected',
      });
      return {
        status: 'rejected',
        planArtifactId: currentPlanArtifactId,
        plan: currentPlan,
        checkpointRef,
        supersededTaskIds: [],
        revalidatedTaskIds: [],
      };
    }
  } else {
    await hooks.emit('approval.resolved', `redirect-auto-approved:${suffix}`, {
      gate: 'plan_diff',
      artifactId: produced.planDiffArtifactId,
      decision: 'approved',
      resolution: 'policy_auto',
      impact: effectiveImpact,
    });
  }

  const expectedPlan = applyPlanDiff(currentPlan, produced.planDiff);
  const applied = ApplyRedirectPlanDiffResultSchema.parse(
    await redirectActivities.applyRedirectPlanDiff(
      ApplyRedirectPlanDiffInputSchema.parse({
        ...scope,
        currentPlanArtifactId,
        currentPlan,
        planDiffArtifactId: produced.planDiffArtifactId,
        planDiff: produced.planDiff,
        idempotencyKey: `${scope.runId}:redirect:${suffix}:apply`,
      }),
    ),
  );
  if (!samePlan(applied.plan, expectedPlan)) {
    throw ApplicationFailure.nonRetryable(
      'Applied redirect plan does not match the approved PlanDiff',
      'redirect_applied_plan_mismatch',
    );
  }
  const supersededTaskIds = applied.supersededTasks.map(({ taskId }) => taskId);
  if (!sameTaskIds(supersededTaskIds, produced.planDiff.supersededTaskIds)) {
    throw ApplicationFailure.nonRetryable(
      'Applied redirect did not preserve every superseded task row',
      'redirect_superseded_identity_mismatch',
    );
  }
  for (const superseded of applied.supersededTasks) {
    await hooks.emit(
      'task.updated',
      `redirect-superseded:${suffix}:${superseded.taskId}`,
      {
        taskId: superseded.taskId,
        status: 'superseded',
        retainedArtifactIds: superseded.retainedArtifactIds,
      },
      superseded.taskId,
    );
  }

  const revalidatedTaskIds = affectedCompletedTaskIds(
    currentPlan,
    produced.planDiff,
    completedTaskIds,
  );
  if (revalidatedTaskIds.length > 0) {
    const revalidationControl = await hooks.beforePaidBoundary('revalidate');
    if (revalidationControl !== undefined) {
      return { status: 'controlled', result: revalidationControl };
    }
    const verification = RevalidateRedirectedTasksResultSchema.parse(
      await redirectActivities.revalidateRedirectedTasks(
        RevalidateRedirectedTasksInputSchema.parse({
          ...scope,
          planArtifactId: applied.planArtifactId,
          planDiffArtifactId: produced.planDiffArtifactId,
          taskIds: revalidatedTaskIds,
          idempotencyKey: `${scope.runId}:redirect:${suffix}:revalidate`,
        }),
      ),
    );
    if (!sameTaskIds(verification.taskIds, revalidatedTaskIds)) {
      throw ApplicationFailure.nonRetryable(
        'Redirect verification result includes tasks outside the dependency closure',
        'redirect_revalidation_identity_mismatch',
      );
    }
    await hooks.emit('verification.completed', `redirect-revalidated:${suffix}`, {
      reason: 'redirect_dependency_revalidation',
      planDiffArtifactId: produced.planDiffArtifactId,
      verificationResultId: verification.verificationResultId,
      decision: verification.decision,
      taskIds: verification.taskIds,
    });
    if (verification.decision !== 'approved') {
      throw ApplicationFailure.nonRetryable(
        'Redirect invalidated completed dependency-affected work',
        verification.decision === 'needs_human'
          ? 'redirect_revalidation_needs_human'
          : 'redirect_revalidation_failed',
      );
    }
  }

  const checkpointRef = await checkpoint(
    input,
    applied.planArtifactId,
    produced.planDiffArtifactId,
    affectedTaskIds,
    revalidatedTaskIds,
  );
  const activeTaskIds = new Set(applied.plan.tasks.map(({ id }) => id));
  const completed = new Set(completedTaskIds);
  const resumableTaskIds = affectedTaskIds.filter(
    (taskId) => activeTaskIds.has(taskId) && !completed.has(taskId),
  );
  await resumeTasks(input, applied.planArtifactId, resumableTaskIds);
  await hooks.emit('artifact.created', `redirect-checkpoint:${suffix}`, {
    artifactType: 'run_checkpoint',
    checkpointRef,
    planArtifactId: applied.planArtifactId,
    planDiffArtifactId: produced.planDiffArtifactId,
  });
  await hooks.transitionRunStatus('running', `redirect-resumed:${suffix}`);
  await hooks.emit('run.resumed', `redirect-resumed:${suffix}`, {
    checkpointRef,
    operationKey: redirect.operationKey,
    planArtifactId: applied.planArtifactId,
    planDiffArtifactId: produced.planDiffArtifactId,
  });
  return {
    status: 'applied',
    planArtifactId: applied.planArtifactId,
    plan: applied.plan,
    checkpointRef,
    supersededTaskIds,
    revalidatedTaskIds,
  };
}
