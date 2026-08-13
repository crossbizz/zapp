import {
  ApplicationFailure,
  condition,
  continueAsNew,
  defineSignal,
  executeChild,
  patched,
  proxyActivities,
  setHandler,
  workflowInfo,
  type RetryPolicy,
} from '@temporalio/workflow';
import {
  ConversationCardIdSchema,
  ConversationCardResponseSchema,
  type ConversationCardResponse,
} from '@zapp/contracts/conversation-cards';
import { AutonomousWorkflowStartInputSchema } from '@zapp/contracts/temporal-run';
import { PlanSchema, type PlanTask } from '@zapp/planning-engine';
import {
  createInterviewSession,
  InterviewCategorySchema,
  InterviewStateSchema,
} from '@zapp/specification-engine/interview';
import { z } from 'zod';

import type { EventActivities, PendingAgentEvent } from '../activities/events.js';
import type { ApprovalActivities, RunApprovalActivities } from '../activities/approvals.js';
import type { FeatureFlagActivities } from '../activities/feature-flags.js';
import {
  BudgetApprovalResolutionSchema,
  budgetApprovalResolvedSignal,
  decodeBudgetApprovalResolution,
  immutableRunCeiling,
} from './budget-approval.js';
import {
  runTaskBatchWorkflow,
  TaskWorkflowResultSchema,
  type TaskWorkflowInput,
} from './task.js';
import {
  processRedirectPlanChange,
  type RedirectPlanChangeHooks,
} from './redirect.js';
import {
  RetryFailedTaskSignalSchema,
  SkipOptionalPhaseSignalSchema,
  retryFailedTaskEligibility,
  retryFailedTaskSignal,
  skipOptionalPhaseEligibility,
  skipOptionalPhaseSignal,
} from './builder-control.js';

const idSchema = (
  prefix: 'run' | 'org' | 'proj' | 'art' | 'rel' | 'phase' | 'task' | 'vr' | 'appr',
): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, 'u'));
const CommitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);
const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
const ActivityKeySchema = z.string().min(1).max(512);
const ArtifactReferenceSchema = z.string().min(1).max(512);

const RuntimePlanSchema = PlanSchema.superRefine((plan, context) => {
  const phaseSequences = new Map(plan.phases.map((phase) => [phase.id, phase.sequence]));
  const taskPhases = new Map(plan.tasks.map((task) => [task.id, task.phaseId]));
  for (const [index, phase] of plan.phases.entries()) {
    if (!idSchema('phase').safeParse(phase.id).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'autonomous_phase_id_invalid',
        path: ['phases', index, 'id'],
      });
    }
  }
  for (const [index, task] of plan.tasks.entries()) {
    if (!idSchema('task').safeParse(task.id).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'autonomous_task_id_invalid',
        path: ['tasks', index, 'id'],
      });
    }
    const taskSequence = phaseSequences.get(task.phaseId);
    for (const [dependencyIndex, dependencyId] of task.dependsOn.entries()) {
      const dependencyPhase = taskPhases.get(dependencyId);
      const dependencySequence =
        dependencyPhase === undefined ? undefined : phaseSequences.get(dependencyPhase);
      if (
        taskSequence !== undefined &&
        dependencySequence !== undefined &&
        dependencySequence > taskSequence
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'autonomous_task_depends_on_future_phase',
          path: ['tasks', index, 'dependsOn', dependencyIndex],
        });
      }
    }
  }
  const allocatedCredits = plan.tasks.reduce(
    (total, task) => total + Math.max(1, task.estimate.credits),
    0,
  );
  if (allocatedCredits > plan.budget.credits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'autonomous_plan_task_budget_exceeds_plan_budget',
      path: ['budget', 'credits'],
    });
  }
});

const CompletedPhaseSchema = z
  .object({
    phaseId: idSchema('phase'),
    commitSha: CommitShaSchema,
    verificationResultId: idSchema('vr'),
    checkpointRef: z.string().min(1).max(2_048),
  })
  .strict();

const AutonomousRedirectSchema = z
  .object({
    instruction: z.string().trim().min(1).max(20_000),
    operationKey: OperationKeySchema,
  })
  .strict();

const AutonomousControlStateSchema = z
  .object({
    seenOperationKeys: z.array(OperationKeySchema).max(1_000),
    pauseRequested: z.boolean(),
    resumeRequested: z.boolean(),
    cancelRequested: z.boolean(),
    creditBalanceExhausted: z.boolean().default(false),
    creditBalanceOperationKey: OperationKeySchema.nullable().default(null),
    creditApprovalResolution: BudgetApprovalResolutionSchema.nullable().default(null),
    pendingRedirects: z.array(AutonomousRedirectSchema).max(100),
    pendingRetries: z.array(RetryFailedTaskSignalSchema).max(100).default([]),
    pendingSkips: z.array(SkipOptionalPhaseSignalSchema).max(100).default([]),
    failedTaskIds: z.array(idSchema('task')).max(10_000).default([]),
    startedTaskIds: z.array(idSchema('task')).max(10_000).default([]),
    skippedPhaseIds: z.array(idSchema('phase')).max(1_000).default([]),
    taskAttempts: z.record(idSchema('task'), z.number().int().nonnegative().max(100)).default({}),
    conversationResponses: z.array(z.object({
      runId: idSchema('run'),
      operationKey: OperationKeySchema,
      cardId: ConversationCardIdSchema,
      response: ConversationCardResponseSchema,
    }).strict()).max(100).default([]),
  })
  .strict();
type AutonomousControlState = z.infer<typeof AutonomousControlStateSchema>;

const EMPTY_CONTROL_STATE: AutonomousControlState = {
  seenOperationKeys: [],
  pauseRequested: false,
  resumeRequested: false,
  cancelRequested: false,
  creditBalanceExhausted: false,
  creditBalanceOperationKey: null,
  creditApprovalResolution: null,
  pendingRedirects: [],
  pendingRetries: [],
  pendingSkips: [],
  failedTaskIds: [],
  startedTaskIds: [],
  skippedPhaseIds: [],
  taskAttempts: {},
  conversationResponses: [],
};

export const AutonomousContinuationSchema = z
  .object({
    specificationVersionId: ArtifactReferenceSchema,
    specificationVersion: z.number().int().positive(),
    planArtifactId: idSchema('art'),
    plan: RuntimePlanSchema,
    nextPhaseIndex: z.number().int().nonnegative(),
    completedTaskIds: z.array(idSchema('task')).max(10_000),
    completedPhases: z.array(CompletedPhaseSchema).max(1_000),
    remainingCredits: z.number().int().nonnegative().max(1_000_000).default(0),
    control: AutonomousControlStateSchema.default(EMPTY_CONTROL_STATE),
  })
  .strict()
  .superRefine((continuation, context) => {
    if (
      continuation.nextPhaseIndex > continuation.plan.phases.length ||
      continuation.completedPhases.length + continuation.control.skippedPhaseIds.length !== continuation.nextPhaseIndex
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'autonomous_continuation_phase_mismatch',
        path: ['nextPhaseIndex'],
      });
    }
    if (new Set(continuation.completedTaskIds).size !== continuation.completedTaskIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'autonomous_continuation_duplicate_task',
        path: ['completedTaskIds'],
      });
    }
    const expectedPhases = [...continuation.plan.phases]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, continuation.nextPhaseIndex)
      .map(({ id }) => id);
    const recordedPhases = new Set([
      ...continuation.completedPhases.map(({ phaseId }) => phaseId),
      ...continuation.control.skippedPhaseIds,
    ]);
    if (expectedPhases.some((phaseId) => !recordedPhases.has(phaseId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'autonomous_continuation_completed_phase_mismatch',
        path: ['completedPhases'],
      });
    }
  });
export type AutonomousContinuation = z.infer<typeof AutonomousContinuationSchema>;

export const AutonomousWorkflowInputSchema = AutonomousWorkflowStartInputSchema.extend({
  continuation: AutonomousContinuationSchema.optional(),
}).strict();
export type AutonomousWorkflowInput = z.infer<typeof AutonomousWorkflowInputSchema>;

export const AutonomousApprovalResolutionSchema = z
  .object({
    runId: idSchema('run'),
    artifactId: ArtifactReferenceSchema,
    approvalId: idSchema('appr').optional(),
    approvalKind: z.enum(['specification', 'plan', 'plan_diff']).optional(),
    decision: z.enum(['approved', 'rejected']),
    operationKey: OperationKeySchema,
  })
  .strict();
export type AutonomousApprovalResolution = z.infer<
  typeof AutonomousApprovalResolutionSchema
>;

export const autonomousSpecificationApprovalSignal = defineSignal<[unknown]>(
  'autonomousSpecificationApproval',
);
export const autonomousPlanApprovalSignal = defineSignal<[unknown]>('autonomousPlanApproval');
export const conversationCardResponseSignal = defineSignal<[unknown]>('conversationCardResponse');
export const autonomousPauseSignal = defineSignal<[unknown]>('pause');
export const autonomousResumeSignal = defineSignal<[unknown]>('resume');
export const autonomousCancelSignal = defineSignal<[unknown]>('cancel');
export const autonomousRedirectSignal = defineSignal<[unknown]>('redirect');
export const autonomousCreditBalanceExhaustedSignal = defineSignal<[unknown]>(
  'creditBalanceExhausted',
);

const AutonomousControlSignalSchema = z
  .object({ runId: idSchema('run'), operationKey: OperationKeySchema })
  .strict();
const AutonomousRedirectSignalSchema = AutonomousControlSignalSchema.extend({
  instruction: z.string().trim().min(1).max(20_000),
}).strict();
const ConversationCardResponseSignalSchema = z.object({
  runId: idSchema('run'),
  operationKey: OperationKeySchema,
  cardId: ConversationCardIdSchema,
  response: ConversationCardResponseSchema,
}).strict().superRefine((value, context) => {
  if (value.cardId !== value.response.cardId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'conversation_card_response_mismatch',
      path: ['response', 'cardId'],
    });
  }
});

const ConductInterviewIdentity = {
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    idempotencyKey: ActivityKeySchema,
} as const;
export const ConductInterviewInputSchema = z.union([
  z.object({ ...ConductInterviewIdentity, prompt: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ ...ConductInterviewIdentity, interviewState: InterviewStateSchema }).strict(),
]);
export const ConductInterviewResultSchema = z
  .object({ interviewArtifactId: idSchema('art'), status: z.literal('executable') })
  .strict();

export const CreateSpecificationDraftInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    interviewArtifactId: idSchema('art'),
    idempotencyKey: ActivityKeySchema,
  })
  .strict();
export const CreateSpecificationDraftResultSchema = z
  .object({
    specificationVersionId: ArtifactReferenceSchema,
    version: z.number().int().positive(),
    contentEtag: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();

export const ApproveSpecificationInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    specificationVersionId: ArtifactReferenceSchema,
    version: z.number().int().positive(),
    contentEtag: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    approvalOperationKey: OperationKeySchema,
    idempotencyKey: ActivityKeySchema,
  })
  .strict();
export const ApproveSpecificationResultSchema = z
  .object({
    specificationVersionId: ArtifactReferenceSchema,
    version: z.number().int().positive(),
    status: z.literal('approved'),
  })
  .strict();

export const ProducePlanInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    specificationVersionId: ArtifactReferenceSchema,
    prompt: z.string().trim().min(1).max(20_000),
    idempotencyKey: ActivityKeySchema,
  })
  .strict();
export const ProducePlanResultSchema = z
  .object({ planArtifactId: idSchema('art'), plan: RuntimePlanSchema })
  .strict();

export const ApprovePlanInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    planArtifactId: idSchema('art'),
    approvalOperationKey: OperationKeySchema,
    idempotencyKey: ActivityKeySchema,
  })
  .strict();
export const ApprovePlanResultSchema = z
  .object({ planArtifactId: idSchema('art'), status: z.literal('approved') })
  .strict();

export const ResolveIntegrationHeadInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    phaseId: idSchema('phase'),
    integrationBranch: z.string().regex(/^run\/[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    completedTaskIds: z.array(idSchema('task')).min(1).max(10_000),
    idempotencyKey: ActivityKeySchema,
  })
  .strict();
export const ResolveIntegrationHeadResultSchema = z.object({ commitSha: CommitShaSchema }).strict();

export const RepairPhaseInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    phaseId: idSchema('phase'),
    verificationResultId: idSchema('vr'),
    failingCommitSha: CommitShaSchema,
    maxCredits: z.number().int().nonnegative().max(1_000_000),
    idempotencyKey: ActivityKeySchema,
  })
  .strict();
export const RepairPhaseResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.enum(['repaired', 'recovered']),
      commitSha: CommitShaSchema,
      evidenceArtifactIds: z.array(idSchema('art')).min(1).max(250),
      creditsConsumed: z.number().int().nonnegative().max(1_000_000),
    })
    .strict(),
  z
    .object({
      status: z.literal('escalated'),
      evidenceArtifactIds: z.array(idSchema('art')).min(1).max(250),
      creditsConsumed: z.number().int().nonnegative().max(1_000_000),
    })
    .strict(),
]);

export const TransitionPhaseTasksInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    phaseId: idSchema('phase'),
    taskIds: z.array(idSchema('task')).min(1).max(10_000),
    status: z.enum(['repairing', 'waiting_for_approval', 'passed', 'failed']),
    idempotencyKey: ActivityKeySchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.taskIds).size !== input.taskIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'autonomous_phase_task_transition_duplicate_task',
        path: ['taskIds'],
      });
    }
  });

export const CheckpointPhaseInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    phaseId: idSchema('phase'),
    commitSha: CommitShaSchema,
    verificationResultId: idSchema('vr'),
    completedTaskIds: z.array(idSchema('task')).min(1).max(10_000),
    idempotencyKey: ActivityKeySchema,
  })
  .strict();
export const CheckpointPhaseResultSchema = z
  .object({ checkpointRef: z.string().min(1).max(2_048) })
  .strict();

export const CreateFinalEvidenceInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    specificationVersionId: ArtifactReferenceSchema,
    specificationVersion: z.number().int().positive(),
    planArtifactId: idSchema('art'),
    commitSha: CommitShaSchema,
    completedPhases: z.array(CompletedPhaseSchema).min(1).max(1_000),
    idempotencyKey: ActivityKeySchema,
  })
  .strict();
export const CreateFinalEvidenceResultSchema = z
  .object({
    releaseId: idSchema('rel'),
    evidenceArtifactId: idSchema('art'),
    commitSha: CommitShaSchema,
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    specificationVersionId: ArtifactReferenceSchema,
    planArtifactId: idSchema('art'),
  })
  .strict();

export interface AutonomousActivities {
  /** Runs AR-16 and persists the completed interview transcript as an immutable artifact. */
  conductInterview(
    input: z.infer<typeof ConductInterviewInputSchema>,
  ): Promise<z.infer<typeof ConductInterviewResultSchema>>;
  /** Builds and persists the AR-16 specification from the durable interview artifact. */
  createSpecificationDraft(
    input: z.infer<typeof CreateSpecificationDraftInputSchema>,
  ): Promise<z.infer<typeof CreateSpecificationDraftResultSchema>>;
  approveSpecification(
    input: z.infer<typeof ApproveSpecificationInputSchema>,
  ): Promise<z.infer<typeof ApproveSpecificationResultSchema>>;
  /** Produces and persists an AR-11 PlanSchema artifact from the approved specification. */
  producePlan(
    input: z.infer<typeof ProducePlanInputSchema>,
  ): Promise<z.infer<typeof ProducePlanResultSchema>>;
  approvePlan(
    input: z.infer<typeof ApprovePlanInputSchema>,
  ): Promise<z.infer<typeof ApprovePlanResultSchema>>;
  resolveIntegrationHead(
    input: z.infer<typeof ResolveIntegrationHeadInputSchema>,
  ): Promise<z.infer<typeof ResolveIntegrationHeadResultSchema>>;
  /** Loads VF-10 evidence and executes one bounded VF-13 repair loop. */
  repairPhase(
    input: z.infer<typeof RepairPhaseInputSchema>,
  ): Promise<z.infer<typeof RepairPhaseResultSchema>>;
  transitionPhaseTasks(input: z.infer<typeof TransitionPhaseTasksInputSchema>): Promise<void>;
  checkpointPhase(
    input: z.infer<typeof CheckpointPhaseInputSchema>,
  ): Promise<z.infer<typeof CheckpointPhaseResultSchema>>;
  /** Creates the Plan 07 release candidate and persists its VF-15 evidence manifest. */
  createFinalEvidence(
    input: z.infer<typeof CreateFinalEvidenceInputSchema>,
  ): Promise<z.infer<typeof CreateFinalEvidenceResultSchema>>;
}

const PhaseVerificationResultSchema = z
  .object({
    verificationResultId: idSchema('vr'),
    decision: z.enum(['approved', 'rejected', 'needs_human']),
    criteriaResults: z.array(z.unknown()).min(1).max(1_000),
    risks: z.array(z.unknown()).max(1_000),
  })
  .strict();
interface PhaseVerificationActivities {
  verifyPhase(runId: string, phaseId: string, commitSha: string): Promise<unknown>;
}

export const AutonomousWorkflowResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('rejected'), gate: z.enum(['specification', 'plan']) }).strict(),
  z
    .object({
      status: z.literal('completed'),
      releaseId: idSchema('rel'),
      evidenceArtifactId: idSchema('art'),
      commitSha: CommitShaSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('cancelled'),
      checkpointRef: z.string().min(1).max(2_048),
    })
    .strict(),
]);
export type AutonomousWorkflowResult = z.infer<typeof AutonomousWorkflowResultSchema>;

const ACTIVITY_RETRY_POLICY: RetryPolicy = {
  initialInterval: '100 milliseconds',
  maximumAttempts: 3,
  nonRetryableErrorTypes: [
    'activity_idempotency_conflict',
    'activity_idempotency_key_required',
    'activity_idempotency_corrupt',
  ],
};
const autonomousActivities = proxyActivities<AutonomousActivities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  retry: ACTIVITY_RETRY_POLICY,
});
const verificationActivities = proxyActivities<PhaseVerificationActivities>({
  taskQueue: 'verification',
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  retry: ACTIVITY_RETRY_POLICY,
});
const eventActivities = proxyActivities<EventActivities>({
  startToCloseTimeout: '30 seconds',
  retry: ACTIVITY_RETRY_POLICY,
});
const approvalActivities = proxyActivities<ApprovalActivities>({
  startToCloseTimeout: '2 minutes',
  retry: ACTIVITY_RETRY_POLICY,
});
const runApprovalActivities = proxyActivities<RunApprovalActivities>({
  startToCloseTimeout: '2 minutes',
  retry: ACTIVITY_RETRY_POLICY,
});
const featureFlagActivities = proxyActivities<FeatureFlagActivities>({
  startToCloseTimeout: '30 seconds',
  retry: ACTIVITY_RETRY_POLICY,
});

function activityKey(input: AutonomousWorkflowInput, step: string): string {
  return `${input.runId}:autonomous:${step}`;
}

function event(
  input: AutonomousWorkflowInput,
  type: PendingAgentEvent['type'],
  eventKey: string,
  payload: Record<string, unknown>,
  options: { readonly agentId?: string; readonly phaseId?: string; readonly taskId?: string } = {},
): PendingAgentEvent {
  return {
    eventKey: activityKey(input, `event:${eventKey}`),
    organizationId: input.organizationId,
    projectId: input.projectId,
    runId: input.runId,
    ...(options.phaseId === undefined ? {} : { phaseId: options.phaseId }),
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    occurredAt: new Date().toISOString(),
    type,
    visibility: 'user',
    payload,
  };
}

async function emit(
  input: AutonomousWorkflowInput,
  ...events: PendingAgentEvent[]
): Promise<void> {
  for (let index = 0; index < events.length; index += 20) {
    await eventActivities.emitEvents({
      events: events.slice(index, index + 20),
      flushImmediately: true,
    });
  }
}

async function honorControlBoundary(
  input: AutonomousWorkflowInput,
  control: AutonomousControlState,
  boundary: string,
): Promise<AutonomousWorkflowResult | undefined> {
  const cancellationRequested = (): boolean => control.cancelRequested;
  const checkpointRef = `run:${input.runId}:${boundary}`;
  if (cancellationRequested()) {
    await eventActivities.transitionRunStatus({
      runId: input.runId,
      status: 'cancelled',
      idempotencyKey: activityKey(input, `status-cancelled:${boundary}`),
    });
    await emit(
      input,
      event(input, 'run.cancelled', `cancelled:${boundary}`, {
        reason: 'user_requested',
        checkpointRef: `run:${input.runId}:cancelled`,
      }),
    );
    return AutonomousWorkflowResultSchema.parse({
      status: 'cancelled',
      checkpointRef: `run:${input.runId}:cancelled`,
    });
  }
  while (control.creditBalanceExhausted) {
    const operationKey = OperationKeySchema.parse(control.creditBalanceOperationKey);
    const immutableCeiling = immutableRunCeiling(input);
    const requested = await approvalActivities.requestBudgetIncrease({
      runId: input.runId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      workspaceId: null,
      currentCeiling: immutableCeiling,
      absoluteCeiling: immutableCeiling,
      reason: 'organization_credit_exhausted',
      idempotencyKey: activityKey(input, `organization-credit:${operationKey.slice(-12)}`),
    });
    await eventActivities.transitionRunStatus({
      runId: input.runId,
      status: 'waiting_for_approval',
      idempotencyKey: activityKey(input, `status-organization-credit:${operationKey.slice(-12)}`),
    });
    await emit(
      input,
      event(input, 'conversation.card', `organization-credit-card:${operationKey.slice(-12)}`, {
        card: {
          version: 1,
          kind: 'approval',
          cardId: `card_${input.runId}:organization-credit:${operationKey.slice(-12)}`,
          approvalId: requested.approvalId,
          approvalKind: 'budget_increase',
        },
      }),
      event(input, 'approval.requested', `organization-credit:${operationKey.slice(-12)}`, {
        approvalId: requested.approvalId,
        type: 'budget_increase',
        reason: 'organization_credit_exhausted',
        absoluteCeiling: requested.absoluteCeiling,
      }),
    );
    await condition(
      () =>
        control.cancelRequested ||
        control.creditApprovalResolution?.approvalId === requested.approvalId,
    );
    if (control.cancelRequested) {
      return await honorControlBoundary(input, control, `${boundary}:credit-cancel`);
    }
    const resolution = control.creditApprovalResolution;
    if (
      resolution === null ||
      resolution.approvalId !== requested.approvalId ||
      resolution.reason !== 'organization_credit_exhausted'
    ) throw new Error('autonomous organization credit resolution does not match the request');
    await emit(
      input,
      event(input, 'approval.resolved', `organization-credit-resolution:${operationKey.slice(-12)}`, {
        approvalId: requested.approvalId,
        decision: resolution.decision,
        reason: resolution.reason,
      }),
    );
    if (resolution.decision === 'rejected') {
      const rejectedCheckpoint = `run:${input.runId}:organization-credit`;
      await eventActivities.transitionRunStatus({
        runId: input.runId,
        status: 'cancelled',
        idempotencyKey: activityKey(input, `status-organization-credit-rejected:${operationKey.slice(-12)}`),
      });
      await emit(
        input,
        event(input, 'run.cancelled', `organization-credit-rejected:${operationKey.slice(-12)}`, {
          reason: 'organization_credit_exhausted',
          checkpointRef: rejectedCheckpoint,
        }),
      );
      return AutonomousWorkflowResultSchema.parse({
        status: 'cancelled',
        checkpointRef: rejectedCheckpoint,
      });
    }
    if (resolution.absoluteCeiling !== immutableCeiling) {
      throw new Error('autonomous organization credit approval changed the immutable ceiling');
    }
    control.creditBalanceExhausted = false;
    control.creditBalanceOperationKey = null;
    control.creditApprovalResolution = null;
    await eventActivities.transitionRunStatus({
      runId: input.runId,
      status: 'running',
      idempotencyKey: activityKey(input, `status-organization-credit-approved:${operationKey.slice(-12)}`),
    });
  }
  if (control.pendingRedirects.length > 0) return undefined;
  if (!control.pauseRequested) return undefined;
  await eventActivities.transitionRunStatus({
    runId: input.runId,
    status: 'paused',
    idempotencyKey: activityKey(input, `status-paused:${boundary}`),
  });
  await emit(
    input,
    event(input, 'run.paused', `paused:${boundary}`, {
      checkpointRef,
      reason: control.pendingRedirects.length > 0 ? 'redirect_requested' : 'user_requested',
      pendingRedirectCount: control.pendingRedirects.length,
    }),
  );
  await condition(() => control.resumeRequested || cancellationRequested());
  if (cancellationRequested()) {
    return await honorControlBoundary(input, control, `${boundary}:cancel`);
  }
  control.pauseRequested = false;
  control.resumeRequested = false;
  await eventActivities.transitionRunStatus({
    runId: input.runId,
    status: 'running',
    idempotencyKey: activityKey(input, `status-resumed:${boundary}`),
  });
  await emit(
    input,
    event(input, 'run.resumed', `resumed:${boundary}`, {
      checkpointRef,
      pendingRedirectCount: control.pendingRedirects.length,
    }),
  );
  return await honorControlBoundary(input, control, boundary);
}

async function honorRiskFlagBoundary(
  input: AutonomousWorkflowInput,
  control: AutonomousControlState,
  flag: 'autonomous-mode' | 'browser-agent-enabled' | 'auto-repair-enabled',
  boundary: string,
): Promise<AutonomousWorkflowResult | undefined> {
  let paused = false;
  for (;;) {
    const result = await featureFlagActivities.evaluateFeatureFlag({
      organizationId: input.organizationId,
      distinctId: input.runId,
      flag,
    });
    if (result.enabled) {
      if (paused) {
        control.pauseRequested = false;
        control.resumeRequested = false;
        await eventActivities.transitionRunStatus({
          runId: input.runId,
          status: 'running',
          idempotencyKey: activityKey(input, `status-flag-resumed:${boundary}:${flag}`),
        });
        await emit(
          input,
          event(input, 'run.resumed', `flag-resumed:${boundary}:${flag}`, {
            checkpointRef: `run:${input.runId}:${boundary}`,
            reason: 'feature_flag_enabled',
            flag,
          }),
        );
      }
      return undefined;
    }

    paused = true;
    control.pauseRequested = true;
    control.resumeRequested = false;
    await eventActivities.transitionRunStatus({
      runId: input.runId,
      status: 'paused',
      idempotencyKey: activityKey(input, `status-flag-paused:${boundary}:${flag}`),
    });
    await emit(
      input,
      event(input, 'run.paused', `flag-paused:${boundary}:${flag}`, {
        checkpointRef: `run:${input.runId}:${boundary}`,
        reason: 'feature_flag_disabled',
        flag,
      }),
    );
    await condition(() => control.resumeRequested || control.cancelRequested);
    if (control.cancelRequested) {
      return await honorControlBoundary(input, control, `${boundary}:flag-cancel`);
    }
    // A resume is permission to re-check, never permission to bypass the
    // provider decision. The loop pauses again if the kill switch stays off.
    control.resumeRequested = false;
  }
}

function matchingResolution(
  resolutions: readonly AutonomousApprovalResolution[],
  runId: string,
  artifactId: string,
  approvalId?: string,
  approvalKind?: 'specification' | 'plan' | 'plan_diff',
): AutonomousApprovalResolution | undefined {
  return resolutions.find(
    (resolution) =>
      resolution.runId === runId &&
      resolution.artifactId === artifactId &&
      (approvalId === undefined || resolution.approvalId === undefined || resolution.approvalId === approvalId) &&
      (approvalKind === undefined || resolution.approvalKind === undefined || resolution.approvalKind === approvalKind),
  );
}

async function awaitApprovalResolution(
  input: AutonomousWorkflowInput,
  control: AutonomousControlState,
  resolutions: readonly AutonomousApprovalResolution[],
  artifactId: string,
  expectedApproval: {
    readonly approvalId: string;
    readonly approvalKind: 'specification' | 'plan' | 'plan_diff';
  } | undefined,
  boundary: string,
): Promise<AutonomousApprovalResolution | AutonomousWorkflowResult> {
  for (;;) {
    const resolution = matchingResolution(
      resolutions,
      input.runId,
      artifactId,
      expectedApproval?.approvalId,
      expectedApproval?.approvalKind,
    );
    if (resolution !== undefined) return resolution;
    const controlled = await honorControlBoundary(input, control, boundary);
    if (controlled !== undefined) return controlled;
    await condition(
      () =>
        matchingResolution(
          resolutions,
          input.runId,
          artifactId,
          expectedApproval?.approvalId,
          expectedApproval?.approvalKind,
        ) !== undefined ||
        control.pauseRequested ||
        control.creditBalanceExhausted ||
        control.cancelRequested,
    );
  }
}

function conversationCardId(input: AutonomousWorkflowInput, suffix: string): string {
  return ConversationCardIdSchema.parse(`card_${input.runId}:${suffix}`);
}

async function awaitConversationResponse(
  input: AutonomousWorkflowInput,
  control: AutonomousControlState,
  cardId: string,
): Promise<ConversationCardResponse | AutonomousWorkflowResult> {
  for (;;) {
    const matched = control.conversationResponses.find(
      (candidate) => candidate.runId === input.runId && candidate.cardId === cardId,
    );
    if (matched !== undefined) return matched.response;
    const controlled = await honorControlBoundary(input, control, `conversation:${cardId}`);
    if (controlled !== undefined) return controlled;
    await condition(
      () =>
        control.conversationResponses.some(
          (candidate) => candidate.runId === input.runId && candidate.cardId === cardId,
        ) ||
        control.pauseRequested ||
        control.creditBalanceExhausted ||
        control.cancelRequested,
    );
  }
}

type AgentProfile = 'frontend' | 'backend' | 'testing';

function agentProfile(task: PlanTask): AgentProfile {
  const expectedFiles = task.expectedFiles.join('\n');
  if (/(?:^|\/)(?:test|tests|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(expectedFiles) ||
      /\b(?:test|testing|qa|quality)\b/iu.test(task.title)) {
    return 'testing';
  }
  if (/\.(?:tsx|jsx|css|scss|sass|less|html)$/iu.test(expectedFiles) ||
      /\b(?:frontend|interface|ui)\b/iu.test(task.title)) {
    return 'frontend';
  }
  return 'backend';
}

function taskPrompt(
  input: AutonomousWorkflowInput,
  continuation: AutonomousContinuation,
  task: PlanTask,
  profile: AgentProfile,
  control: AutonomousControlState,
): string {
  const prompt = [
    `Agent profile: ${profile}`,
    `Approved specification version: ${continuation.specificationVersionId}`,
    `Approved plan artifact: ${continuation.planArtifactId}`,
    `Task: ${task.title}`,
    `Expected files: ${task.expectedFiles.join(', ') || 'none declared'}`,
    `Acceptance criteria: ${task.acceptanceCriteriaIds.join(', ')}`,
    `Required tests: ${task.requiredTests.join(', ') || 'none declared'}`,
    ...(control.pendingRedirects.length === 0
      ? []
      : [
          'Approved redirect instructions:',
          ...control.pendingRedirects.map(({ instruction }) => instruction),
        ]),
    'Work only on this task. Finish with a task-scoped commit and do not rely on raw chat history.',
  ].join('\n');
  if (prompt.length > 20_000) {
    throw ApplicationFailure.nonRetryable('Autonomous task context exceeds 20,000 characters', 'task_context_too_large');
  }
  return prompt;
}

function taskInput(
  input: AutonomousWorkflowInput,
  continuation: AutonomousContinuation,
  task: PlanTask,
  control: AutonomousControlState,
  attempt: number,
): TaskWorkflowInput {
  const profile = agentProfile(task);
  const estimatedCredits = Math.max(1, task.estimate.credits);
  return {
    runId: input.runId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    taskId: task.id,
    mode: 'autonomous',
    model: input.model,
    prompt: taskPrompt(input, continuation, task, profile, control),
    budget: {
      maxCredits: estimatedCredits,
    },
    attempt,
  };
}

async function prepareExecution(
  input: AutonomousWorkflowInput,
  specificationResolutions: readonly AutonomousApprovalResolution[],
  planResolutions: readonly AutonomousApprovalResolution[],
  control: AutonomousControlState,
): Promise<
  | { readonly kind: 'rejected'; readonly result: AutonomousWorkflowResult }
  | { readonly kind: 'terminal'; readonly result: AutonomousWorkflowResult }
  | { readonly kind: 'ready'; readonly continuation: AutonomousContinuation }
> {
  await emit(
    input,
    event(input, 'phase.created', 'interview-created', { stage: 'interview' }, { agentId: 'planner' }),
    event(input, 'phase.started', 'interview-started', { stage: 'interview' }, { agentId: 'planner' }),
  );
  const interviewControl = await honorControlBoundary(input, control, 'interview');
  if (interviewControl !== undefined) return { kind: 'terminal', result: interviewControl };
  let interviewInput: z.infer<typeof ConductInterviewInputSchema>;
  if (input.conversationCardsVersion === 1 && patched('ar24-conversation-cards-v1')) {
    const session = createInterviewSession();
    let turnIndex = 0;
    for (;;) {
      const turn = session.nextTurn();
      if (turn.status === 'complete') break;
      const cardId = conversationCardId(input, `interview:${String(turnIndex)}`);
      await emit(input, event(input, 'conversation.card', `interview-card:${String(turnIndex)}`, {
        card: {
          version: 1,
          kind: 'question',
          cardId,
          questions: turn.questions.map((question) => ({
            questionId: question.category,
            prompt: question.question,
            options: question.options,
          })),
        },
      }, { agentId: 'planner' }));
      const response = await awaitConversationResponse(input, control, cardId);
      if ('status' in response) return { kind: 'terminal', result: response };
      session.respond(response.answers.map((answer) => ({
        category: InterviewCategorySchema.parse(answer.questionId),
        answer: answer.answer,
      })));
      await emit(input, event(input, 'conversation.response', `interview-response:${String(turnIndex)}`, {
        response,
      }));
      turnIndex += 1;
    }
    interviewInput = ConductInterviewInputSchema.parse({
      runId: input.runId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      interviewState: session.state,
      idempotencyKey: activityKey(input, 'interview'),
    });
  } else {
    interviewInput = ConductInterviewInputSchema.parse({
      runId: input.runId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      prompt: input.prompt,
      idempotencyKey: activityKey(input, 'interview'),
    });
  }
  const interview = ConductInterviewResultSchema.parse(
    await autonomousActivities.conductInterview(interviewInput),
  );
  await emit(
    input,
    event(input, 'artifact.created', 'interview-artifact', {
      stage: 'interview', artifactId: interview.interviewArtifactId,
    }, { agentId: 'planner' }),
    event(input, 'phase.completed', 'interview-completed', { stage: 'interview' }, { agentId: 'planner' }),
  );

  const specificationControl = await honorControlBoundary(input, control, 'specification-draft');
  if (specificationControl !== undefined) {
    return { kind: 'terminal', result: specificationControl };
  }
  const specification = CreateSpecificationDraftResultSchema.parse(
    await autonomousActivities.createSpecificationDraft(
      CreateSpecificationDraftInputSchema.parse({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        interviewArtifactId: interview.interviewArtifactId,
        idempotencyKey: activityKey(input, 'specification-draft'),
      }),
    ),
  );
  const specificationApproval = input.conversationCardsVersion === 1
    ? await runApprovalActivities.requestRunApproval({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        kind: 'specification',
        artifactId: specification.specificationVersionId,
        artifactVersion: specification.version,
        idempotencyKey: activityKey(input, 'specification-approval-request'),
      })
    : undefined;
  const specificationCardId = conversationCardId(input, 'specification');
  await eventActivities.transitionRunStatus({
    runId: input.runId,
    status: 'waiting_for_approval',
    idempotencyKey: activityKey(input, 'status-waiting-specification'),
  });
  await emit(
    input,
    event(input, 'artifact.created', 'specification-draft', {
      artifactId: specification.specificationVersionId,
      artifactType: 'specification',
      version: specification.version,
    }, { agentId: 'planner' }),
    ...(specificationApproval === undefined ? [] : [
      event(input, 'conversation.card', 'specification-card', {
        card: {
          version: 1,
          kind: 'specification',
          cardId: specificationCardId,
          approvalId: specificationApproval.approvalId,
          artifactId: specification.specificationVersionId,
          artifactVersion: specification.version,
        },
      }, { agentId: 'planner' }),
    ]),
    event(input, 'approval.requested', 'specification-approval-requested', {
      gate: 'specification',
      ...(specificationApproval === undefined ? {} : {
        approvalId: specificationApproval.approvalId,
        type: 'specification',
        status: 'pending',
        request: {
          artifactId: specification.specificationVersionId,
          artifactVersion: specification.version,
        },
      }),
      artifactId: specification.specificationVersionId,
      version: specification.version,
    }, { agentId: 'planner' }),
  );
  const specificationResolution = await awaitApprovalResolution(
    input,
    control,
    specificationResolutions,
    specification.specificationVersionId,
    specificationApproval === undefined
      ? undefined
      : { approvalId: specificationApproval.approvalId, approvalKind: 'specification' },
    'specification-approval',
  );
  if ('status' in specificationResolution) {
    return { kind: 'terminal', result: specificationResolution };
  }
  await emit(
    input,
    event(input, 'approval.resolved', 'specification-approval-resolved', {
      gate: 'specification',
      ...(specificationApproval === undefined ? {} : {
        approvalId: specificationApproval.approvalId,
        approvalKind: 'specification',
      }),
      artifactId: specification.specificationVersionId,
      decision: specificationResolution.decision,
    }, { agentId: 'planner' }),
  );
  if (specificationResolution.decision === 'rejected') {
    await eventActivities.transitionRunStatus({
      runId: input.runId,
      status: 'cancelled',
      idempotencyKey: activityKey(input, 'status-specification-rejected'),
    });
    return { kind: 'rejected', result: { status: 'rejected', gate: 'specification' } };
  }
  const approvedSpecification = ApproveSpecificationResultSchema.parse(
    await autonomousActivities.approveSpecification(
      ApproveSpecificationInputSchema.parse({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        specificationVersionId: specification.specificationVersionId,
        version: specification.version,
        contentEtag: specification.contentEtag,
        approvalOperationKey: specificationResolution.operationKey,
        idempotencyKey: activityKey(input, 'specification-approve'),
      }),
    ),
  );
  if (
    approvedSpecification.specificationVersionId !== specification.specificationVersionId ||
    approvedSpecification.version !== specification.version
  ) {
    throw ApplicationFailure.nonRetryable('Specification approval identity mismatch', 'specification_approval_identity_mismatch');
  }
  await eventActivities.transitionRunStatus({
    runId: input.runId,
    status: 'running',
    idempotencyKey: activityKey(input, 'status-specification-approved'),
  });

  const planControl = await honorControlBoundary(input, control, 'plan-produce');
  if (planControl !== undefined) return { kind: 'terminal', result: planControl };
  const planned = ProducePlanResultSchema.parse(
    await autonomousActivities.producePlan(
      ProducePlanInputSchema.parse({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        specificationVersionId: approvedSpecification.specificationVersionId,
        prompt: input.prompt,
        idempotencyKey: activityKey(input, 'plan-produce'),
      }),
    ),
  );
  const planApproval = input.conversationCardsVersion === 1
    ? await runApprovalActivities.requestRunApproval({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        kind: 'plan',
        artifactId: planned.planArtifactId,
        artifactVersion: null,
        idempotencyKey: activityKey(input, 'plan-approval-request'),
      })
    : undefined;
  const planCardId = conversationCardId(input, 'plan');
  await eventActivities.transitionRunStatus({
    runId: input.runId,
    status: 'waiting_for_approval',
    idempotencyKey: activityKey(input, 'status-waiting-plan'),
  });
  await emit(
    input,
    event(input, 'artifact.created', 'plan-artifact', {
      artifactId: planned.planArtifactId,
      artifactType: 'implementation_plan',
      phases: planned.plan.phases.map((phase) => ({
        phaseId: phase.id,
        optional: phase.optional,
      })),
      phaseCount: planned.plan.phases.length,
      taskCount: planned.plan.tasks.length,
    }, { agentId: 'planner' }),
    ...(planApproval === undefined ? [] : [
      event(input, 'conversation.card', 'plan-card', {
        card: {
          version: 1,
          kind: 'plan',
          cardId: planCardId,
          approvalId: planApproval.approvalId,
          artifactId: planned.planArtifactId,
          approvalKind: 'plan',
        },
      }, { agentId: 'planner' }),
    ]),
    event(input, 'approval.requested', 'plan-approval-requested', {
      gate: 'plan',
      ...(planApproval === undefined ? {} : {
        approvalId: planApproval.approvalId,
        type: 'plan',
        status: 'pending',
        request: { artifactId: planned.planArtifactId },
      }),
      artifactId: planned.planArtifactId,
    }, { agentId: 'planner' }),
  );
  const planResolution = await awaitApprovalResolution(
    input,
    control,
    planResolutions,
    planned.planArtifactId,
    planApproval === undefined
      ? undefined
      : { approvalId: planApproval.approvalId, approvalKind: 'plan' },
    'plan-approval',
  );
  if ('status' in planResolution) return { kind: 'terminal', result: planResolution };
  await emit(
    input,
    event(input, 'approval.resolved', 'plan-approval-resolved', {
      gate: 'plan',
      ...(planApproval === undefined ? {} : {
        approvalId: planApproval.approvalId,
        approvalKind: 'plan',
      }),
      artifactId: planned.planArtifactId, decision: planResolution.decision,
    }, { agentId: 'planner' }),
  );
  if (planResolution.decision === 'rejected') {
    await eventActivities.transitionRunStatus({
      runId: input.runId,
      status: 'cancelled',
      idempotencyKey: activityKey(input, 'status-plan-rejected'),
    });
    return { kind: 'rejected', result: { status: 'rejected', gate: 'plan' } };
  }
  const approvedPlan = ApprovePlanResultSchema.parse(
    await autonomousActivities.approvePlan(
      ApprovePlanInputSchema.parse({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planArtifactId: planned.planArtifactId,
        approvalOperationKey: planResolution.operationKey,
        idempotencyKey: activityKey(input, 'plan-approve'),
      }),
    ),
  );
  if (approvedPlan.planArtifactId !== planned.planArtifactId) {
    throw ApplicationFailure.nonRetryable('Plan approval identity mismatch', 'plan_approval_identity_mismatch');
  }
  await eventActivities.transitionRunStatus({
    runId: input.runId,
    status: 'running',
    idempotencyKey: activityKey(input, 'status-plan-approved'),
  });
  const continuation = AutonomousContinuationSchema.parse({
      specificationVersionId: approvedSpecification.specificationVersionId,
      specificationVersion: approvedSpecification.version,
      planArtifactId: approvedPlan.planArtifactId,
      plan: planned.plan,
      nextPhaseIndex: 0,
      completedTaskIds: [],
      completedPhases: [],
      remainingCredits: Math.min(
        input.budget?.maxCredits ?? planned.plan.budget.credits,
        planned.plan.budget.credits,
      ),
      control,
    });
  // Zod returns a validated clone. Keep the live signal-handler state shared with
  // this first execution; continue-as-new serializes the same state afterward.
  continuation.control = control;
  return { kind: 'ready', continuation };
}

async function executePhase(
  input: AutonomousWorkflowInput,
  continuation: AutonomousContinuation,
  planResolutions: readonly AutonomousApprovalResolution[],
): Promise<AutonomousWorkflowResult> {
  const control = continuation.control;
  let remainingCredits = continuation.remainingCredits;
  const phases = [...continuation.plan.phases].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const phase = phases[continuation.nextPhaseIndex];
  const completedTaskIds = new Set(continuation.completedTaskIds);
  let phaseTasks =
    phase === undefined
      ? []
      : continuation.plan.tasks.filter(({ phaseId }) => phaseId === phase.id);
  let phaseCompletedTaskIds = phaseTasks
    .filter(({ id }) => completedTaskIds.has(id))
    .map(({ id }) => id);
  const processPendingRedirects = async (): Promise<AutonomousWorkflowResult | undefined> => {
    while (control.pendingRedirects.length > 0) {
      const controlled = await honorControlBoundary(
        input,
        control,
        `${phase?.id ?? 'final-evidence'}:redirect`,
      );
      if (controlled !== undefined) return controlled;
      const redirect = control.pendingRedirects[0];
      if (redirect === undefined) break;
      const directAffectedTaskIds = phaseTasks
        .filter(({ id }) => !completedTaskIds.has(id))
        .map(({ id }) => id);
      const hooks: RedirectPlanChangeHooks<AutonomousWorkflowResult> = {
        async emit(type, suffix, payload, taskId) {
          const phaseId = phase?.id;
          await emit(
            input,
            event(
              input,
              type,
              `redirect:${suffix}`,
              payload,
              taskId === undefined
                ? {
                    ...(phaseId === undefined ? {} : { phaseId }),
                    agentId: 'planner',
                  }
                : {
                    ...(phaseId === undefined ? {} : { phaseId }),
                    taskId,
                    agentId: 'planner',
                  },
            ),
          );
        },
        async transitionRunStatus(status, suffix) {
          await eventActivities.transitionRunStatus({
            runId: input.runId,
            status,
            idempotencyKey: activityKey(input, `redirect:${suffix}`),
          });
        },
        async beforePaidBoundary(boundary) {
          return await honorControlBoundary(
            input,
            control,
            `${phase?.id ?? 'final-evidence'}:redirect:${boundary}`,
          );
        },
        async requestApproval(artifactId) {
          return await runApprovalActivities.requestRunApproval({
            runId: input.runId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            kind: 'plan_diff',
            artifactId,
            artifactVersion: null,
            idempotencyKey: activityKey(
              input,
              `redirect-approval:${redirect.operationKey.slice(-12)}`,
            ),
          });
        },
        approvalFor(artifactId) {
          return matchingResolution(planResolutions, input.runId, artifactId);
        },
        cancellationRequested() {
          return control.cancelRequested;
        },
      };
      const result = await processRedirectPlanChange(
        {
          runId: input.runId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          currentPlanArtifactId: continuation.planArtifactId,
          currentPlan: continuation.plan,
          redirect,
          directAffectedTaskIds,
          completedTaskIds: [...completedTaskIds],
        },
        hooks,
      );
      if (result.status === 'controlled') return result.result;
      if (result.status === 'cancelled') {
        return await honorControlBoundary(
          input,
          control,
          `${phase?.id ?? 'final-evidence'}:redirect-cancelled`,
        );
      }
      control.pendingRedirects.shift();
      control.pauseRequested = control.pendingRedirects.length > 0;
      control.resumeRequested = false;
      if (result.status === 'applied') {
        continuation.planArtifactId = idSchema('art').parse(result.planArtifactId);
        continuation.plan = RuntimePlanSchema.parse(result.plan);
      }
      const activeTaskIds = new Set(continuation.plan.tasks.map(({ id }) => id));
      for (const taskId of completedTaskIds) {
        if (!activeTaskIds.has(taskId)) completedTaskIds.delete(taskId);
      }
      phaseCompletedTaskIds = phaseCompletedTaskIds.filter((taskId) =>
        activeTaskIds.has(taskId),
      );
      phaseTasks =
        phase === undefined
          ? []
          : continuation.plan.tasks.filter(({ phaseId }) => phaseId === phase.id);
    }
    return undefined;
  };
  const initialRedirect = await processPendingRedirects();
  if (initialRedirect !== undefined) return initialRedirect;
  if (phase === undefined) {
    const firstIncompleteTask = continuation.plan.tasks.find(
      ({ id, phaseId }) =>
        !completedTaskIds.has(id) && !control.skippedPhaseIds.includes(phaseId),
    );
    if (firstIncompleteTask !== undefined) {
      const nextPhaseIndex = phases.findIndex(({ id }) => id === firstIncompleteTask.phaseId);
      if (nextPhaseIndex < 0) {
        throw ApplicationFailure.nonRetryable(
          'Redirected task references an unknown execution phase',
          'autonomous_redirect_phase_missing',
        );
      }
      const retainedPhaseIds = new Set(phases.slice(0, nextPhaseIndex).map(({ id }) => id));
      const next = AutonomousContinuationSchema.parse({
        ...continuation,
        nextPhaseIndex,
        completedTaskIds: [...completedTaskIds],
        completedPhases: continuation.completedPhases.filter(({ phaseId }) =>
          retainedPhaseIds.has(phaseId),
        ),
        control,
      });
      return await continueAsNew<typeof autonomousWorkflow>({ ...input, continuation: next });
    }
    const controlled = await honorControlBoundary(input, control, 'final-evidence');
    if (controlled !== undefined) return controlled;
    const lastPhase = continuation.completedPhases.at(-1);
    if (
      lastPhase === undefined ||
      continuation.completedPhases.length + continuation.control.skippedPhaseIds.length !== phases.length
    ) {
      throw ApplicationFailure.nonRetryable(
        'Autonomous final evidence requires every approved phase checkpoint',
        'autonomous_final_evidence_incomplete',
      );
    }
    const evidence = CreateFinalEvidenceResultSchema.parse(
      await autonomousActivities.createFinalEvidence(
        CreateFinalEvidenceInputSchema.parse({
          runId: input.runId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          specificationVersionId: continuation.specificationVersionId,
          specificationVersion: continuation.specificationVersion,
          planArtifactId: continuation.planArtifactId,
          commitSha: lastPhase.commitSha,
          completedPhases: continuation.completedPhases,
          idempotencyKey: activityKey(input, 'final-evidence'),
        }),
      ),
    );
    if (
      evidence.commitSha !== lastPhase.commitSha ||
      evidence.runId !== input.runId ||
      evidence.organizationId !== input.organizationId ||
      evidence.projectId !== input.projectId ||
      evidence.specificationVersionId !== continuation.specificationVersionId ||
      evidence.planArtifactId !== continuation.planArtifactId
    ) {
      throw ApplicationFailure.nonRetryable(
        'Release evidence identity does not match the approved autonomous run',
        'autonomous_final_evidence_identity_mismatch',
      );
    }
    await emit(
      input,
      event(input, 'release.created', 'release-candidate-created', {
        releaseId: evidence.releaseId,
        commitSha: evidence.commitSha,
        planArtifactId: continuation.planArtifactId,
      }, { agentId: 'verifier' }),
      event(input, 'artifact.created', 'release-evidence-created', {
        artifactId: evidence.evidenceArtifactId,
        artifactType: 'release_evidence_manifest',
        releaseId: evidence.releaseId,
        commitSha: evidence.commitSha,
      }, { agentId: 'verifier' }),
      event(input, 'run.completed', 'autonomous-run-completed', {
        status: 'completed',
        releaseId: evidence.releaseId,
        evidenceArtifactId: evidence.evidenceArtifactId,
        commitSha: evidence.commitSha,
      }, { agentId: 'verifier' }),
    );
    await eventActivities.transitionRunStatus({
      runId: input.runId,
      status: 'completed',
      idempotencyKey: activityKey(input, 'status-completed'),
    });
    return AutonomousWorkflowResultSchema.parse({
      status: 'completed',
      releaseId: evidence.releaseId,
      evidenceArtifactId: evidence.evidenceArtifactId,
      commitSha: evidence.commitSha,
    });
  }
  if (phaseTasks.length === 0) {
    throw ApplicationFailure.nonRetryable('Autonomous phase has no tasks', 'autonomous_phase_empty');
  }
  const processPhaseSkip = async (): Promise<AutonomousWorkflowResult | undefined> => {
    const requestIndex = control.pendingSkips.findIndex(({ phaseId }) => phaseId === phase.id);
    if (requestIndex < 0) return undefined;
    const request = control.pendingSkips.splice(requestIndex, 1)[0];
    if (request === undefined) return undefined;
    const eligibility = skipOptionalPhaseEligibility(
      continuation.plan,
      phase.id,
      control.startedTaskIds,
      control.skippedPhaseIds,
    );
    await emit(
      input,
      event(input, 'task.updated', `${phase.id}:skip:${request.operationKey}`, {
        control: 'skip_optional_phase',
        outcome: eligibility.accepted ? 'accepted' : 'rejected',
        reason: eligibility.reason,
        operationKey: request.operationKey,
        phaseId: phase.id,
      }, { phaseId: phase.id, agentId: 'planner' }),
    );
    if (!eligibility.accepted) return undefined;
    control.skippedPhaseIds.push(phase.id);
    await emit(
      input,
      event(input, 'phase.completed', `${phase.id}:skipped:${request.operationKey}`, {
        phaseId: phase.id,
        status: 'skipped',
        operationKey: request.operationKey,
      }, { phaseId: phase.id, agentId: 'planner' }),
    );
    const next = AutonomousContinuationSchema.parse({
      ...continuation,
      nextPhaseIndex: continuation.nextPhaseIndex + 1,
      completedTaskIds: [...completedTaskIds],
      control,
    });
    return await continueAsNew<typeof autonomousWorkflow>({ ...input, continuation: next });
  };
  const initialSkip = await processPhaseSkip();
  if (initialSkip !== undefined) return initialSkip;
  for (const flag of ['autonomous-mode', 'browser-agent-enabled'] as const) {
    const gated = await honorRiskFlagBoundary(input, control, flag, `${phase.id}:start`);
    if (gated !== undefined) return gated;
  }
  await emit(
    input,
    event(input, 'phase.created', `${phase.id}:${continuation.planArtifactId}:created`, {
      phaseId: phase.id, sequence: phase.sequence, title: phase.title,
    }, { phaseId: phase.id, agentId: 'planner' }),
    event(input, 'phase.started', `${phase.id}:${continuation.planArtifactId}:started`, {
      phaseId: phase.id, sequence: phase.sequence, title: phase.title,
    }, { phaseId: phase.id, agentId: 'planner' }),
  );
  const initialControl = await honorControlBoundary(input, control, `${phase.id}:start`);
  if (initialControl !== undefined) return initialControl;

  const transitionPhaseTasks = async (
    status: z.infer<typeof TransitionPhaseTasksInputSchema>['status'],
  ): Promise<void> => {
    await autonomousActivities.transitionPhaseTasks(
      TransitionPhaseTasksInputSchema.parse({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        phaseId: phase.id,
        taskIds: phaseCompletedTaskIds,
        status,
        idempotencyKey: activityKey(
          input,
          `${phase.id}:${continuation.planArtifactId}:tasks:${status}`,
        ),
      }),
    );
  };
  let wave = 0;
  for (;;) {
    const redirected = await processPendingRedirects();
    if (redirected !== undefined) return redirected;
    const skipped = await processPhaseSkip();
    if (skipped !== undefined) return skipped;
    if (phaseTasks.every(({ id }) => completedTaskIds.has(id))) break;
    const ready = phaseTasks.filter(
      (task) =>
        !completedTaskIds.has(task.id) &&
        task.dependsOn.every((dependencyId) => completedTaskIds.has(dependencyId)),
    );
    if (ready.length === 0) {
      throw ApplicationFailure.nonRetryable('Autonomous phase task graph cannot make progress', 'autonomous_task_graph_blocked');
    }
    const waveCredits = ready.reduce(
      (total, task) => total + Math.max(1, task.estimate.credits),
      0,
    );
    if (waveCredits > remainingCredits) {
      throw ApplicationFailure.nonRetryable(
        'Autonomous task wave exceeds the remaining approved credit budget',
        'autonomous_task_budget_exhausted',
      );
    }
    await emit(
      input,
      ...ready.flatMap((task) => {
        const profile = agentProfile(task);
        return [
          event(input, 'task.created', `${phase.id}:${task.id}:created`, {
            phaseId: phase.id, taskId: task.id, title: task.title, profile,
          }, { phaseId: phase.id, taskId: task.id, agentId: profile }),
          event(input, 'agent.started', `${phase.id}:${task.id}:agent-started`, {
            phaseId: phase.id, taskId: task.id, profile,
          }, { phaseId: phase.id, taskId: task.id, agentId: profile }),
        ];
      }),
    );
    const controlled = await honorControlBoundary(input, control, `${phase.id}:wave:${String(wave)}`);
    if (controlled !== undefined) return controlled;
    for (const task of ready) {
      if (!control.startedTaskIds.includes(task.id)) control.startedTaskIds.push(task.id);
    }
    const results = await executeChild(runTaskBatchWorkflow, {
      workflowId: `${input.runId}:phase:${String(phase.sequence)}:${continuation.planArtifactId}:wave:${String(wave)}`,
      args: [{
        runId: input.runId,
        maxConcurrency: input.maxConcurrency,
        tasks: ready.map((task) =>
          taskInput(input, continuation, task, control, control.taskAttempts[task.id] ?? 0),
        ),
      }],
    });
    const parsedResults = results.map((result) => TaskWorkflowResultSchema.parse(result));
    const blocked = parsedResults.find(({ status }) => status === 'blocked');
    if (blocked !== undefined) {
      throw ApplicationFailure.nonRetryable(`Autonomous task ${blocked.taskId} is blocked`, 'autonomous_task_blocked');
    }
    remainingCredits -= waveCredits;
    for (const result of parsedResults) {
      if (result.status === 'failed') {
        if (!control.failedTaskIds.includes(result.taskId)) control.failedTaskIds.push(result.taskId);
        await emit(
          input,
          event(input, 'task.failed', `${phase.id}:${result.taskId}:failed:${String(control.taskAttempts[result.taskId] ?? 0)}`, {
            phaseId: phase.id,
            taskId: result.taskId,
            failureType: result.failureType,
          }, { phaseId: phase.id, taskId: result.taskId, agentId: 'builder' }),
        );
        for (;;) {
          const requestIndex = control.pendingRetries.findIndex(({ taskId }) => taskId === result.taskId);
          if (requestIndex < 0) {
            await condition(
              () => control.pendingRetries.some(({ taskId }) => taskId === result.taskId) || control.cancelRequested,
            );
            if (control.cancelRequested) {
              const cancelled = await honorControlBoundary(input, control, `${phase.id}:retry-cancel`);
              if (cancelled !== undefined) return cancelled;
            }
            continue;
          }
          const request = control.pendingRetries.splice(requestIndex, 1)[0];
          if (request === undefined) continue;
          const eligibility = retryFailedTaskEligibility(
            continuation.plan,
            result.taskId,
            control.failedTaskIds,
            [...completedTaskIds],
          );
          await emit(
            input,
            event(input, 'task.updated', `${phase.id}:${result.taskId}:retry:${request.operationKey}`, {
              control: 'retry_failed_task',
              outcome: eligibility.accepted ? 'accepted' : 'rejected',
              reason: eligibility.reason,
              operationKey: request.operationKey,
              taskId: result.taskId,
            }, { phaseId: phase.id, taskId: result.taskId, agentId: 'builder' }),
          );
          if (!eligibility.accepted) continue;
          control.failedTaskIds = control.failedTaskIds.filter((taskId) => taskId !== result.taskId);
          control.taskAttempts[result.taskId] = (control.taskAttempts[result.taskId] ?? 0) + 1;
          break;
        }
        continue;
      }
      completedTaskIds.add(result.taskId);
      phaseCompletedTaskIds.push(result.taskId);
      const task = ready.find(({ id }) => id === result.taskId);
      const profile = task === undefined ? 'backend' : agentProfile(task);
      await emit(
        input,
        event(input, 'agent.completed', `${phase.id}:${result.taskId}:agent-completed`, {
          phaseId: phase.id, taskId: result.taskId, profile, commitSha: result.commitSha,
        }, { phaseId: phase.id, taskId: result.taskId, agentId: profile }),
      );
    }
    wave += 1;
  }

  const postTaskCredit = await honorControlBoundary(
    input,
    control,
    `${phase.id}:post-tasks`,
  );
  if (postTaskCredit !== undefined) return postTaskCredit;

  const head = ResolveIntegrationHeadResultSchema.parse(
    await autonomousActivities.resolveIntegrationHead(
      ResolveIntegrationHeadInputSchema.parse({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        phaseId: phase.id,
        integrationBranch: `run/${input.runId}`,
        completedTaskIds: phaseCompletedTaskIds,
        idempotencyKey: activityKey(
          input,
          `${phase.id}:${continuation.planArtifactId}:resolve-head`,
        ),
      }),
    ),
  );
  const preVerificationRedirect = await processPendingRedirects();
  if (preVerificationRedirect !== undefined) return preVerificationRedirect;
  if (phaseTasks.some(({ id }) => !completedTaskIds.has(id))) {
    const next = AutonomousContinuationSchema.parse({
      ...continuation,
      remainingCredits,
      completedTaskIds: [...completedTaskIds],
      control,
    });
    return await continueAsNew<typeof autonomousWorkflow>({ ...input, continuation: next });
  }
  const verificationControl = await honorControlBoundary(input, control, `${phase.id}:verification`);
  if (verificationControl !== undefined) return verificationControl;
  let verifiedCommitSha = head.commitSha;
  let verification = PhaseVerificationResultSchema.parse(
    await verificationActivities.verifyPhase(input.runId, phase.id, verifiedCommitSha),
  );
  const postVerificationRedirect = await processPendingRedirects();
  if (postVerificationRedirect !== undefined) return postVerificationRedirect;
  if (phaseTasks.some(({ id }) => !completedTaskIds.has(id))) {
    const next = AutonomousContinuationSchema.parse({
      ...continuation,
      remainingCredits,
      completedTaskIds: [...completedTaskIds],
      control,
    });
    return await continueAsNew<typeof autonomousWorkflow>({ ...input, continuation: next });
  }
  if (verification.decision === 'rejected') {
    await transitionPhaseTasks('repairing');
    await emit(
      input,
      event(input, 'task.updated', `${phase.id}:repair-started`, {
        phaseId: phase.id, status: 'repairing', verificationResultId: verification.verificationResultId,
      }, { phaseId: phase.id, agentId: 'builder' }),
    );
    const preRepairControl = await honorControlBoundary(input, control, `${phase.id}:repair`);
    if (preRepairControl !== undefined) return preRepairControl;
    const repairFlag = await honorRiskFlagBoundary(
      input,
      control,
      'auto-repair-enabled',
      `${phase.id}:repair`,
    );
    if (repairFlag !== undefined) return repairFlag;
    const repair = RepairPhaseResultSchema.parse(
      await autonomousActivities.repairPhase(
        RepairPhaseInputSchema.parse({
          runId: input.runId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          phaseId: phase.id,
          verificationResultId: verification.verificationResultId,
          failingCommitSha: verifiedCommitSha,
          maxCredits: remainingCredits,
          idempotencyKey: activityKey(
            input,
            `${phase.id}:${continuation.planArtifactId}:repair`,
          ),
        }),
      ),
    );
    if (repair.creditsConsumed > remainingCredits) {
      throw ApplicationFailure.nonRetryable(
        'Autonomous repair reported credits above its approved allocation',
        'autonomous_repair_budget_exceeded',
      );
    }
    remainingCredits -= repair.creditsConsumed;
    if (repair.status === 'escalated') {
      await transitionPhaseTasks('failed');
      throw ApplicationFailure.nonRetryable('Autonomous phase repair exhausted its bounded budget', 'autonomous_phase_repair_exhausted');
    }
    if (repair.commitSha === verifiedCommitSha) {
      throw ApplicationFailure.nonRetryable('Autonomous repair did not produce a new commit', 'autonomous_repair_commit_unchanged');
    }
    verifiedCommitSha = repair.commitSha;
    const preReverifyControl = await honorControlBoundary(
      input,
      control,
      `${phase.id}:reverification`,
    );
    if (preReverifyControl !== undefined) return preReverifyControl;
    verification = PhaseVerificationResultSchema.parse(
      await verificationActivities.verifyPhase(input.runId, phase.id, verifiedCommitSha),
    );
  }
  const finalVerificationRedirect = await processPendingRedirects();
  if (finalVerificationRedirect !== undefined) return finalVerificationRedirect;
  if (phaseTasks.some(({ id }) => !completedTaskIds.has(id))) {
    const next = AutonomousContinuationSchema.parse({
      ...continuation,
      remainingCredits,
      completedTaskIds: [...completedTaskIds],
      control,
    });
    return await continueAsNew<typeof autonomousWorkflow>({ ...input, continuation: next });
  }
  if (verification.decision !== 'approved') {
    await transitionPhaseTasks(
      verification.decision === 'needs_human' ? 'waiting_for_approval' : 'failed',
    );
    if (verification.decision === 'needs_human') {
      await eventActivities.transitionRunStatus({
        runId: input.runId,
        status: 'waiting_for_approval',
        idempotencyKey: activityKey(
          input,
          `${phase.id}:${continuation.planArtifactId}:status-verification-needs-human`,
        ),
      });
    }
    throw ApplicationFailure.nonRetryable(
      verification.decision === 'needs_human'
        ? 'Autonomous verification requires a human decision'
        : 'Autonomous phase remains rejected after its bounded repair loop',
      verification.decision === 'needs_human'
        ? 'autonomous_verification_needs_human'
        : 'autonomous_phase_verification_failed',
    );
  }
  await transitionPhaseTasks('passed');
  await emit(
    input,
    ...phaseCompletedTaskIds.map((taskId) =>
      event(input, 'task.completed', `${phase.id}:${continuation.planArtifactId}:${taskId}:completed`, {
        phaseId: phase.id,
        taskId,
        verificationResultId: verification.verificationResultId,
        commitSha: verifiedCommitSha,
      }, { phaseId: phase.id, taskId, agentId: 'verifier' }),
    ),
  );

  const checkpointControl = await honorControlBoundary(input, control, `${phase.id}:checkpoint`);
  if (checkpointControl !== undefined) return checkpointControl;
  const checkpoint = CheckpointPhaseResultSchema.parse(
    await autonomousActivities.checkpointPhase(
      CheckpointPhaseInputSchema.parse({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        phaseId: phase.id,
        commitSha: verifiedCommitSha,
        verificationResultId: verification.verificationResultId,
        completedTaskIds: phaseCompletedTaskIds,
        idempotencyKey: activityKey(
          input,
          `${phase.id}:${continuation.planArtifactId}:checkpoint`,
        ),
      }),
    ),
  );
  await emit(
    input,
    event(input, 'phase.completed', `${phase.id}:${continuation.planArtifactId}:completed`, {
      phaseId: phase.id,
      commitSha: verifiedCommitSha,
      verificationResultId: verification.verificationResultId,
      checkpointRef: checkpoint.checkpointRef,
    }, { phaseId: phase.id, agentId: 'verifier' }),
  );
  const next = AutonomousContinuationSchema.parse({
    ...continuation,
    nextPhaseIndex: continuation.nextPhaseIndex + 1,
    remainingCredits,
    control,
    completedTaskIds: [...completedTaskIds],
    completedPhases: [
      ...continuation.completedPhases,
      {
        phaseId: phase.id,
        commitSha: verifiedCommitSha,
        verificationResultId: verification.verificationResultId,
        checkpointRef: checkpoint.checkpointRef,
      },
    ],
  });
  return await continueAsNew<typeof autonomousWorkflow>({ ...input, continuation: next });
}

export async function autonomousWorkflow(inputValue: unknown): Promise<AutonomousWorkflowResult> {
  const input = AutonomousWorkflowInputSchema.parse(inputValue);
  const continuedFromPriorExecution =
    workflowInfo().continuedFromExecutionRunId !== undefined;
  if ((input.continuation !== undefined) !== continuedFromPriorExecution) {
    throw ApplicationFailure.nonRetryable(
      'Autonomous continuation state is accepted only from Temporal continue-as-new',
      'autonomous_continuation_untrusted',
    );
  }
  const specificationResolutions: AutonomousApprovalResolution[] = [];
  const planResolutions: AutonomousApprovalResolution[] = [];
  const control = input.continuation?.control ?? AutonomousControlStateSchema.parse(EMPTY_CONTROL_STATE);
  const seenOperationKeys = new Set(control.seenOperationKeys);
  const rememberOperation = (operationKey: string): boolean => {
    if (seenOperationKeys.has(operationKey)) return false;
    if (control.seenOperationKeys.length >= 1_000) {
      throw ApplicationFailure.nonRetryable(
        'Autonomous control operation history is full',
        'autonomous_control_history_full',
      );
    }
    seenOperationKeys.add(operationKey);
    control.seenOperationKeys.push(operationKey);
    return true;
  };
  const capture = (value: unknown, target: AutonomousApprovalResolution[]): void => {
    const resolution = AutonomousApprovalResolutionSchema.parse(value);
    if (resolution.runId !== input.runId) {
      throw ApplicationFailure.nonRetryable(
        'Autonomous approval does not match the workflow run',
        'autonomous_approval_run_mismatch',
      );
    }
    if (!rememberOperation(resolution.operationKey)) return;
    target.push(resolution);
  };
  setHandler(autonomousSpecificationApprovalSignal, (value) => {
    capture(value, specificationResolutions);
  });
  setHandler(autonomousPlanApprovalSignal, (value) => {
    capture(value, planResolutions);
  });
  setHandler(conversationCardResponseSignal, (value) => {
    const signal = ConversationCardResponseSignalSchema.parse(value);
    if (signal.runId !== input.runId) {
      throw ApplicationFailure.nonRetryable(
        'Conversation response does not match the workflow run',
        'conversation_response_run_mismatch',
      );
    }
    if (!rememberOperation(signal.operationKey)) return;
    if (control.conversationResponses.length >= 100) {
      throw ApplicationFailure.nonRetryable(
        'Conversation response history is full',
        'conversation_response_history_full',
      );
    }
    control.conversationResponses.push(signal);
  });
  setHandler(autonomousPauseSignal, (value) => {
    const signal = AutonomousControlSignalSchema.parse(value);
    if (signal.runId !== input.runId) throw new Error('run pause does not match workflow');
    if (!rememberOperation(signal.operationKey) || control.cancelRequested) return;
    control.pauseRequested = true;
  });
  setHandler(autonomousCreditBalanceExhaustedSignal, (value) => {
    const signal = AutonomousControlSignalSchema.parse(value);
    if (signal.runId !== input.runId) throw new Error('credit signal does not match workflow');
    if (!rememberOperation(signal.operationKey) || control.cancelRequested) return;
    if (control.creditBalanceExhausted) return;
    control.creditBalanceExhausted = true;
    control.creditBalanceOperationKey = signal.operationKey;
  });
  setHandler(budgetApprovalResolvedSignal, (value) => {
    control.creditApprovalResolution = decodeBudgetApprovalResolution(value);
  });
  setHandler(autonomousResumeSignal, (value) => {
    const signal = AutonomousControlSignalSchema.parse(value);
    if (signal.runId !== input.runId) throw new Error('run resume does not match workflow');
    if (
      !rememberOperation(signal.operationKey) ||
      control.cancelRequested ||
      !control.pauseRequested
    ) return;
    control.resumeRequested = true;
  });
  setHandler(autonomousCancelSignal, (value) => {
    const signal = AutonomousControlSignalSchema.parse(value);
    if (signal.runId !== input.runId) throw new Error('run cancel does not match workflow');
    if (!rememberOperation(signal.operationKey)) return;
    control.cancelRequested = true;
  });
  setHandler(autonomousRedirectSignal, (value) => {
    const signal = AutonomousRedirectSignalSchema.parse(value);
    if (signal.runId !== input.runId) throw new Error('run redirect does not match workflow');
    if (!rememberOperation(signal.operationKey) || control.cancelRequested) return;
    if (control.pendingRedirects.length >= 100) {
      throw ApplicationFailure.nonRetryable(
        'Autonomous redirect queue is full',
        'autonomous_redirect_queue_full',
      );
    }
    control.pendingRedirects.push({
      instruction: signal.instruction,
      operationKey: signal.operationKey,
    });
    control.pauseRequested = true;
  });
  setHandler(retryFailedTaskSignal, (value) => {
    const signal = RetryFailedTaskSignalSchema.parse(value);
    if (signal.runId !== input.runId) throw new Error('task retry does not match workflow');
    if (!rememberOperation(signal.operationKey) || control.cancelRequested) return;
    control.pendingRetries.push(signal);
  });
  setHandler(skipOptionalPhaseSignal, (value) => {
    const signal = SkipOptionalPhaseSignalSchema.parse(value);
    if (signal.runId !== input.runId) throw new Error('phase skip does not match workflow');
    if (!rememberOperation(signal.operationKey) || control.cancelRequested) return;
    control.pendingSkips.push(signal);
  });

  try {
    await eventActivities.transitionRunStatus({
      runId: input.runId,
      status: 'running',
      idempotencyKey: activityKey(input, `status-running:${String(input.continuation?.nextPhaseIndex ?? 0)}`),
    });
    const initialControl = await honorControlBoundary(input, control, 'initial');
    if (initialControl !== undefined) return initialControl;
    if (input.continuation !== undefined) {
      return await executePhase(input, input.continuation, planResolutions);
    }
    const initialRollout = await honorRiskFlagBoundary(
      input,
      control,
      'autonomous-mode',
      'initial',
    );
    if (initialRollout !== undefined) return initialRollout;
    const preparation = await prepareExecution(
      input,
      specificationResolutions,
      planResolutions,
      control,
    );
    if (preparation.kind !== 'ready') return preparation.result;
    return await executePhase(input, preparation.continuation, planResolutions);
  } catch (error: unknown) {
    const failureType =
      error instanceof ApplicationFailure && error.type !== undefined
        ? error.type
        : 'autonomous_workflow_failed';
    if (failureType !== 'autonomous_verification_needs_human') {
      await eventActivities.transitionRunStatus({
        runId: input.runId,
        status: 'failed',
        idempotencyKey: activityKey(
          input,
          `status-failed:${String(input.continuation?.nextPhaseIndex ?? 0)}`,
        ),
      });
      await emit(
        input,
        event(input, 'task.failed', `run-failed:${String(input.continuation?.nextPhaseIndex ?? 0)}`, {
          scope: 'run',
          failureType,
        }),
      );
    }
    throw error;
  }
}
