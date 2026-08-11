import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  type RetryPolicy,
} from '@temporalio/workflow';
import { FixWorkflowStartInputSchema } from '@zapp/contracts/temporal-run';
import {
  FixEvidenceSchema,
  FixRequestSchema,
  ModelIdentifierSchema,
  type FixEvidence,
  type FixRequest,
} from '@zapp/contracts/run-intent';
import { z } from 'zod';

import type { EventActivities, PendingAgentEvent } from '../activities/events.js';
import type { ApprovalActivities } from '../activities/approvals.js';
import {
  BudgetApprovalResolutionSchema,
  budgetApprovalResolvedSignal,
  decodeBudgetApprovalResolution,
  immutableRunCeiling,
} from './budget-approval.js';

const workflowIdSchema = (
  prefix: 'run' | 'org' | 'proj' | 'br' | 'phase' | 'task' | 'art' | 'vr',
): z.ZodString => z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, 'u'));
const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
const ActivityKeySchema = z.string().min(1).max(512);
const RelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), {
    message: 'fix paths must remain repository-relative',
  });

export { FixEvidenceSchema, FixRequestSchema };
export type { FixEvidence, FixRequest };

export const FixWorkflowInputSchema = FixWorkflowStartInputSchema;
export type FixWorkflowInput = z.infer<typeof FixWorkflowInputSchema>;

const FixPhaseVerificationResultSchema = z
  .object({
    verificationResultId: workflowIdSchema('vr'),
    decision: z.enum(['approved', 'rejected', 'needs_human']),
    criteriaResults: z.array(z.unknown()).min(1).max(100_000),
    risks: z.array(z.unknown()).max(100_000),
  })
  .strict();

const FixCaseSchema = FixRequestSchema.extend({
  runId: workflowIdSchema('run'),
  organizationId: workflowIdSchema('org'),
  projectId: workflowIdSchema('proj'),
  phaseId: workflowIdSchema('phase'),
  taskId: workflowIdSchema('task'),
  relatedFiles: z.array(RelativePathSchema).min(1).max(1_000),
}).strict();
export type FixCase = z.infer<typeof FixCaseSchema>;

const FixScopeSchema = z
  .object({
    runId: workflowIdSchema('run'),
    organizationId: workflowIdSchema('org'),
    projectId: workflowIdSchema('proj'),
    phaseId: workflowIdSchema('phase'),
    taskId: workflowIdSchema('task'),
  })
  .strict();

const LoadFixCaseInputSchema = z
  .object({
    runId: workflowIdSchema('run'),
    organizationId: workflowIdSchema('org'),
    projectId: workflowIdSchema('proj'),
    prompt: z.string().trim().min(1).max(20_000),
    fixRequest: FixRequestSchema,
  })
  .strict();

const RestoreFixWorkspaceInputSchema = FixScopeSchema.extend({
  relevantCommitSha: CommitShaSchema,
  idempotencyKey: ActivityKeySchema,
}).strict();
const RestoreFixWorkspaceResultSchema = z
  .object({
    workspaceId: z.string().min(1).max(512),
    restoredCommitSha: CommitShaSchema,
  })
  .strict();

const ReproduceFixInputSchema = FixScopeSchema.extend({
  workspaceId: z.string().min(1).max(512),
  reproductionRef: z.string().trim().min(1).max(4_096),
  evidence: z.array(FixEvidenceSchema).min(1).max(100),
  idempotencyKey: ActivityKeySchema,
}).strict();
const ReproduceFixResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('reproduced'),
      failingCheck: z.string().trim().min(1).max(10_000),
      evidenceArtifactIds: z.array(workflowIdSchema('art')).min(1).max(100),
    })
    .strict(),
  z
    .object({
      status: z.literal('not_reproduced'),
      reason: z.string().trim().min(1).max(4_000),
      evidenceArtifactIds: z.array(workflowIdSchema('art')).min(1).max(100),
    })
    .strict(),
]);

const PrepareFixRegressionTestInputSchema = FixScopeSchema.extend({
  workspaceId: z.string().min(1).max(512),
  summary: z.string().trim().min(1).max(10_000),
  reproductionRef: z.string().trim().min(1).max(4_096),
  failingCheck: z.string().trim().min(1).max(10_000),
  relatedFiles: z.array(RelativePathSchema).min(1).max(1_000),
  idempotencyKey: ActivityKeySchema,
}).strict();
export const FixRegressionTestResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('written'),
      path: RelativePathSchema,
      observedFailure: z.literal(true),
      evidenceArtifactId: workflowIdSchema('art'),
    })
    .strict(),
  z
    .object({
      status: z.literal('skipped'),
      policyFlag: z.literal('regression_test_not_feasible'),
      reason: z.string().trim().min(1).max(4_000),
    })
    .strict(),
]);
export type FixRegressionTestResult = z.infer<typeof FixRegressionTestResultSchema>;

const ApplyFixPatchInputSchema = FixScopeSchema.extend({
  workspaceId: z.string().min(1).max(512),
  model: ModelIdentifierSchema.nullable(),
  summary: z.string().trim().min(1).max(10_000),
  failingCheck: z.string().trim().min(1).max(10_000),
  relatedFiles: z.array(RelativePathSchema).min(1).max(1_000),
  regressionTest: FixRegressionTestResultSchema,
  idempotencyKey: ActivityKeySchema,
}).strict();
const ApplyFixPatchResultSchema = z.object({ status: z.literal('patched') }).strict();

export const FixChangedFileSchema = z
  .object({
    path: RelativePathSchema,
    additions: z.number().int().nonnegative().max(10_000_000),
    deletions: z.number().int().nonnegative().max(10_000_000),
  })
  .strict();
export const FixDiffMeasurementSchema = z
  .object({
    changedFiles: z.array(FixChangedFileSchema).max(10_000),
    changedLines: z.number().int().nonnegative().max(10_000_000),
  })
  .strict()
  .superRefine((measurement, context) => {
    const measuredLines = measurement.changedFiles.reduce(
      (total, file) => total + file.additions + file.deletions,
      0,
    );
    if (measuredLines !== measurement.changedLines) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['changedLines'],
        message: 'fix diff line total does not match its files',
      });
    }
    if (
      new Set(measurement.changedFiles.map((file) => file.path)).size !==
      measurement.changedFiles.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['changedFiles'],
        message: 'fix diff contains duplicate paths',
      });
    }
  });
export type FixDiffMeasurement = z.infer<typeof FixDiffMeasurementSchema>;

const MeasureFixDiffInputSchema = FixScopeSchema.extend({
  baseCommitSha: CommitShaSchema,
  candidateCommitSha: CommitShaSchema,
  idempotencyKey: ActivityKeySchema,
}).strict();

const FixDiffLimitsSchema = z
  .object({
    maxChangedFiles: z.number().int().positive().max(10_000),
    maxChangedLines: z.number().int().positive().max(10_000_000),
  })
  .strict();
export const FIX_DIFF_LIMITS = FixDiffLimitsSchema.parse({
  maxChangedFiles: 8,
  maxChangedLines: 400,
});

export const FixDiffAssessmentSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('accepted'),
      source: z.literal('anti_slop_policy'),
    })
    .strict(),
  z
    .object({
      status: z.literal('oversized'),
      source: z.literal('anti_slop_policy'),
      reasons: z
        .array(z.enum(['changed_files', 'changed_lines']))
        .min(1)
        .max(2),
    })
    .strict(),
]);
export type FixDiffAssessment = z.infer<typeof FixDiffAssessmentSchema>;

export function assessFixDiff(
  measurementValue: unknown,
  limitsValue: unknown = FIX_DIFF_LIMITS,
): FixDiffAssessment {
  const measurement = FixDiffMeasurementSchema.parse(measurementValue);
  const limits = FixDiffLimitsSchema.parse(limitsValue);
  const reasons: ('changed_files' | 'changed_lines')[] = [];
  if (measurement.changedFiles.length > limits.maxChangedFiles) reasons.push('changed_files');
  if (measurement.changedLines > limits.maxChangedLines) reasons.push('changed_lines');
  return FixDiffAssessmentSchema.parse(
    reasons.length === 0
      ? { status: 'accepted', source: 'anti_slop_policy' }
      : { status: 'oversized', source: 'anti_slop_policy', reasons },
  );
}

const RunFixTargetedChecksInputSchema = FixScopeSchema.extend({
  workspaceId: z.string().min(1).max(512),
  candidateCommitSha: CommitShaSchema,
  failingCheck: z.string().trim().min(1).max(10_000),
  regressionTest: FixRegressionTestResultSchema,
  idempotencyKey: ActivityKeySchema,
}).strict();
const FixCheckResultSchema = z
  .object({
    status: z.enum(['passed', 'failed']),
    checks: z.array(z.string().trim().min(1).max(10_000)).min(1).max(1_000),
    evidenceArtifactIds: z.array(workflowIdSchema('art')).min(1).max(1_000),
  })
  .strict();

const CommitFixPatchInputSchema = FixScopeSchema.extend({
  workspaceId: z.string().min(1).max(512),
  message: z.string().trim().min(1).max(10_000),
  idempotencyKey: ActivityKeySchema,
}).strict();
const CommitFixPatchResultSchema = z.object({ commitSha: CommitShaSchema }).strict();

const CheckpointFixWorkspaceInputSchema = FixScopeSchema.extend({
  workspaceId: z.string().min(1).max(512),
  reason: z.enum(['pause', 'cancel', 'redirect']),
  idempotencyKey: ActivityKeySchema,
}).strict();
const CheckpointFixWorkspaceResultSchema = z
  .object({ checkpointRef: z.string().min(1).max(4_096) })
  .strict();

const VerifyOriginalFixSymptomInputSchema = FixScopeSchema.extend({
  workspaceId: z.string().min(1).max(512),
  reproductionRef: z.string().trim().min(1).max(4_096),
  originalFailingCheck: z.string().trim().min(1).max(10_000),
  verifiedCommitSha: CommitShaSchema,
  idempotencyKey: ActivityKeySchema,
}).strict();
const VerifyOriginalFixSymptomResultSchema = z
  .object({
    status: z.enum(['resolved', 'still_failing']),
    evidenceArtifactIds: z.array(workflowIdSchema('art')).min(1).max(1_000),
  })
  .strict();

const VerifyFixCandidateInputSchema = FixScopeSchema.extend({
  candidateCommitSha: CommitShaSchema,
  idempotencyKey: ActivityKeySchema,
}).strict();

const FinalizeFixTaskInputSchema = FixScopeSchema.extend({
  outcome: z.enum(['passed', 'not_reproduced', 'cancelled']),
  commitSha: CommitShaSchema.nullable(),
  verificationResultId: workflowIdSchema('vr').nullable(),
  idempotencyKey: ActivityKeySchema,
})
  .strict()
  .superRefine((input, context) => {
    const hasCompletionIdentity = input.commitSha !== null && input.verificationResultId !== null;
    const hasPartialIdentity = input.commitSha !== null || input.verificationResultId !== null;
    if (
      (input.outcome === 'passed' && !hasCompletionIdentity) ||
      (input.outcome !== 'passed' && hasPartialIdentity)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'passed Fix completion requires commit and verification identities',
      });
    }
  });

const FailFixTaskInputSchema = FixScopeSchema.extend({
  reason: z.string().trim().min(1).max(4_000),
  idempotencyKey: ActivityKeySchema,
}).strict();

export interface FixModeActivities extends Pick<
  EventActivities,
  'emitEvents' | 'transitionRunStatus'
> {
  loadFixCase(input: z.infer<typeof LoadFixCaseInputSchema>): Promise<FixCase>;
  restoreFixWorkspace(
    input: z.infer<typeof RestoreFixWorkspaceInputSchema>,
  ): Promise<z.infer<typeof RestoreFixWorkspaceResultSchema>>;
  reproduceFix(
    input: z.infer<typeof ReproduceFixInputSchema>,
  ): Promise<z.infer<typeof ReproduceFixResultSchema>>;
  prepareFixRegressionTest(
    input: z.infer<typeof PrepareFixRegressionTestInputSchema>,
  ): Promise<FixRegressionTestResult>;
  applyFixPatch(
    input: z.infer<typeof ApplyFixPatchInputSchema>,
  ): Promise<z.infer<typeof ApplyFixPatchResultSchema>>;
  measureFixDiff(input: z.infer<typeof MeasureFixDiffInputSchema>): Promise<FixDiffMeasurement>;
  runFixTargetedChecks(
    input: z.infer<typeof RunFixTargetedChecksInputSchema>,
  ): Promise<z.infer<typeof FixCheckResultSchema>>;
  commitFixPatch(
    input: z.infer<typeof CommitFixPatchInputSchema>,
  ): Promise<z.infer<typeof CommitFixPatchResultSchema>>;
  checkpointFixWorkspace(
    input: z.infer<typeof CheckpointFixWorkspaceInputSchema>,
  ): Promise<z.infer<typeof CheckpointFixWorkspaceResultSchema>>;
  verifyOriginalFixSymptom(
    input: z.infer<typeof VerifyOriginalFixSymptomInputSchema>,
  ): Promise<z.infer<typeof VerifyOriginalFixSymptomResultSchema>>;
  /** Atomically moves the Fix task to its terminal non-failure state. */
  finalizeFixTask(input: z.infer<typeof FinalizeFixTaskInputSchema>): Promise<void>;
  /** Atomically overrides any provisional state with terminal failure. */
  failFixTask(input: z.infer<typeof FailFixTaskInputSchema>): Promise<void>;
}

export interface FixVerificationActivities {
  /** Runs the full required gate set without mutating the task's terminal state. */
  verifyFixCandidate(
    input: z.infer<typeof VerifyFixCandidateInputSchema>,
  ): Promise<z.infer<typeof FixPhaseVerificationResultSchema>>;
}

export const FixWorkflowResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('completed'),
      commitSha: CommitShaSchema,
      regressionTestPath: RelativePathSchema.nullable(),
      verificationResultId: workflowIdSchema('vr'),
    })
    .strict(),
  z
    .object({
      status: z.literal('not_reproduced'),
      reason: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  z
    .object({
      status: z.literal('cancelled'),
      reason: z.enum(['user_requested', 'redirected', 'organization_credit_exhausted']),
      checkpointRef: z.string().min(1).max(4_096).nullable(),
    })
    .strict(),
]);
export type FixWorkflowResult = z.infer<typeof FixWorkflowResultSchema>;

const FIX_ACTIVITY_RETRY_POLICY: RetryPolicy = {
  initialInterval: '100 milliseconds',
  maximumAttempts: 3,
  nonRetryableErrorTypes: [
    'activity_idempotency_conflict',
    'activity_idempotency_key_required',
    'activity_idempotency_corrupt',
  ],
};
const FIX_CONTROL_RETRY_POLICY: RetryPolicy = {
  ...FIX_ACTIVITY_RETRY_POLICY,
  maximumAttempts: 1,
};

const fixActivities = proxyActivities<FixModeActivities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '1500 milliseconds',
  cancellationType: 'WAIT_CANCELLATION_COMPLETED',
  retry: FIX_ACTIVITY_RETRY_POLICY,
});
const fixVerification = proxyActivities<FixVerificationActivities>({
  taskQueue: 'verification',
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  retry: FIX_ACTIVITY_RETRY_POLICY,
});
const fixControlActivities = proxyActivities<FixModeActivities>({
  scheduleToCloseTimeout: '1 second',
  startToCloseTimeout: '1 second',
  retry: FIX_CONTROL_RETRY_POLICY,
});
const fixApprovalActivities = proxyActivities<ApprovalActivities>({
  startToCloseTimeout: '2 minutes',
  retry: FIX_ACTIVITY_RETRY_POLICY,
});

function activityKey(fixCase: FixCase, step: string): string {
  return `${fixCase.runId}:${fixCase.taskId}:${step}`;
}

function fixEvent(
  input: FixWorkflowInput,
  type: PendingAgentEvent['type'],
  suffix: string,
  payload: Record<string, unknown>,
  fixCase?: FixCase,
): PendingAgentEvent {
  return {
    eventKey: `${input.runId}:${fixCase?.taskId ?? 'fix'}:${suffix}`,
    runId: input.runId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    ...(fixCase === undefined ? {} : { phaseId: fixCase.phaseId, taskId: fixCase.taskId }),
    occurredAt: new Date().toISOString(),
    type,
    visibility: 'user',
    payload,
  };
}

async function emitStep(
  input: FixWorkflowInput,
  fixCase: FixCase,
  step: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await fixActivities.emitEvents({
    events: [fixEvent(input, 'task.updated', `step-${step}`, { step, ...payload }, fixCase)],
  });
}

function fail(type: string, message: string): never {
  throw ApplicationFailure.nonRetryable(`${type}: ${message}`, type);
}

const FixControlSignalSchema = z
  .object({
    runId: workflowIdSchema('run'),
    operationKey: OperationKeySchema,
  })
  .strict();
const FixRedirectSignalSchema = FixControlSignalSchema.extend({
  instruction: z.string().trim().min(1).max(20_000),
}).strict();
export const fixPauseSignal = defineSignal<[unknown]>('pause');
export const fixResumeSignal = defineSignal<[unknown]>('resume');
export const fixCancelSignal = defineSignal<[unknown]>('cancel');
export const fixRedirectSignal = defineSignal<[unknown]>('redirect');
export const fixCreditBalanceExhaustedSignal = defineSignal<[unknown]>('creditBalanceExhausted');

/** PRD §11.4: an isolated reproduce-first repair with code-owned verification gates. */
export async function fixWorkflow(inputValue: unknown): Promise<FixWorkflowResult> {
  const input = FixWorkflowInputSchema.parse(inputValue);
  let fixCase: FixCase | undefined;
  let workspaceId: string | undefined;
  let activeScope: CancellationScope | undefined;
  let pauseRequested = false;
  let resumeRequested = false;
  let controlReason: 'user_requested' | 'redirected' | undefined;
  let controlOperationKey: string | undefined;
  let pauseOperationKey: string | undefined;
  let creditBalanceExhausted = false;
  let creditBalanceOperationKey: string | undefined;
  let creditApprovalResolution: z.infer<typeof BudgetApprovalResolutionSchema> | undefined;
  const seenControlOperations = new Set<string>();
  const pendingControlReason = (): 'user_requested' | 'redirected' | undefined => controlReason;

  const controlSignal = (value: unknown): z.infer<typeof FixControlSignalSchema> => {
    const signal = FixControlSignalSchema.parse(value);
    if (signal.runId !== input.runId) {
      fail('fix_control_scope_mismatch', 'control signal targets a different run');
    }
    return signal;
  };
  setHandler(fixPauseSignal, (value) => {
    const signal = controlSignal(value);
    if (seenControlOperations.has(signal.operationKey)) return;
    seenControlOperations.add(signal.operationKey);
    pauseRequested = true;
    pauseOperationKey = signal.operationKey;
  });
  setHandler(fixCreditBalanceExhaustedSignal, (value) => {
    const signal = controlSignal(value);
    if (seenControlOperations.has(signal.operationKey)) return;
    seenControlOperations.add(signal.operationKey);
    if (creditBalanceExhausted) return;
    creditBalanceExhausted = true;
    creditBalanceOperationKey = signal.operationKey;
  });
  setHandler(budgetApprovalResolvedSignal, (value) => {
    creditApprovalResolution = decodeBudgetApprovalResolution(value);
  });
  setHandler(fixResumeSignal, (value) => {
    const signal = controlSignal(value);
    if (seenControlOperations.has(signal.operationKey)) return;
    seenControlOperations.add(signal.operationKey);
    resumeRequested = true;
  });
  setHandler(fixCancelSignal, (value) => {
    const signal = controlSignal(value);
    if (seenControlOperations.has(signal.operationKey)) return;
    seenControlOperations.add(signal.operationKey);
    controlReason = 'user_requested';
    controlOperationKey = signal.operationKey;
    activeScope?.cancel();
  });
  setHandler(fixRedirectSignal, (value) => {
    const signal = FixRedirectSignalSchema.parse(value);
    if (signal.runId !== input.runId) {
      fail('fix_control_scope_mismatch', 'redirect signal targets a different run');
    }
    if (seenControlOperations.has(signal.operationKey)) return;
    seenControlOperations.add(signal.operationKey);
    controlReason = 'redirected';
    controlOperationKey = signal.operationKey;
    activeScope?.cancel();
  });

  const completeControl = async (): Promise<FixWorkflowResult> => {
    const reason = controlReason ?? 'user_requested';
    let checkpointRef: string | null = null;
    if (fixCase !== undefined && workspaceId !== undefined) {
      const checkpoint = CheckpointFixWorkspaceResultSchema.parse(
        await fixControlActivities.checkpointFixWorkspace(
          CheckpointFixWorkspaceInputSchema.parse({
            runId: fixCase.runId,
            organizationId: fixCase.organizationId,
            projectId: fixCase.projectId,
            phaseId: fixCase.phaseId,
            taskId: fixCase.taskId,
            workspaceId,
            reason: reason === 'redirected' ? 'redirect' : 'cancel',
            idempotencyKey: activityKey(fixCase, `control-${controlOperationKey ?? reason}`),
          }),
        ),
      );
      checkpointRef = checkpoint.checkpointRef;
      await fixControlActivities.finalizeFixTask(
        FinalizeFixTaskInputSchema.parse({
          runId: fixCase.runId,
          organizationId: fixCase.organizationId,
          projectId: fixCase.projectId,
          phaseId: fixCase.phaseId,
          taskId: fixCase.taskId,
          outcome: 'cancelled',
          commitSha: null,
          verificationResultId: null,
          idempotencyKey: activityKey(fixCase, `finalize-${reason}`),
        }),
      );
    }
    await fixControlActivities.transitionRunStatus({
      runId: input.runId,
      status: 'cancelled',
      idempotencyKey: `${input.runId}:fix:status-${reason}`,
    });
    await fixControlActivities.emitEvents({
      flushImmediately: true,
      events: [
        fixEvent(input, 'run.cancelled', `run-${reason}`, {
          reason,
          checkpointRef,
          operationKey: controlOperationKey,
        }),
      ],
    });
    return FixWorkflowResultSchema.parse({ status: 'cancelled', reason, checkpointRef });
  };

  const honorControlBoundary = async (): Promise<FixWorkflowResult | undefined> => {
    if (controlReason !== undefined) return await completeControl();
    if (creditBalanceExhausted && fixCase !== undefined && workspaceId !== undefined) {
      const episodeOperationKey = OperationKeySchema.parse(creditBalanceOperationKey);
      const immutableCeiling = immutableRunCeiling(input);
      const requested = await fixApprovalActivities.requestBudgetIncrease({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        workspaceId,
        currentCeiling: immutableCeiling,
        absoluteCeiling: immutableCeiling,
        reason: 'organization_credit_exhausted',
        idempotencyKey: activityKey(fixCase, `organization-credit-${episodeOperationKey.slice(-12)}`),
      });
      await fixActivities.transitionRunStatus({
        runId: input.runId,
        status: 'waiting_for_approval',
        idempotencyKey: activityKey(fixCase, `status-organization-credit-${episodeOperationKey.slice(-12)}`),
      });
      await fixActivities.emitEvents({
        events: [
          fixEvent(input, 'approval.requested', `organization-credit-${episodeOperationKey.slice(-12)}`, {
            approvalId: requested.approvalId,
            type: 'budget_increase',
            reason: 'organization_credit_exhausted',
            absoluteCeiling: requested.absoluteCeiling,
          }, fixCase),
        ],
      });
      await condition(
        () =>
          pendingControlReason() !== undefined ||
          creditApprovalResolution?.approvalId === requested.approvalId,
      );
      if (pendingControlReason() !== undefined) return await completeControl();
      const resolution = creditApprovalResolution;
      if (
        resolution === undefined ||
        resolution.approvalId !== requested.approvalId ||
        resolution.reason !== 'organization_credit_exhausted'
      ) throw new Error('Fix organization credit resolution does not match the request');
      await fixActivities.emitEvents({
        events: [
          fixEvent(input, 'approval.resolved', `organization-credit-resolution-${episodeOperationKey.slice(-12)}`, {
            approvalId: requested.approvalId,
            decision: resolution.decision,
            reason: resolution.reason,
          }, fixCase),
        ],
      });
      if (resolution.decision === 'rejected') {
        const checkpoint = await fixApprovalActivities.checkpointBudgetStop({
          runId: input.runId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          workspaceId,
          approvalId: requested.approvalId,
          idempotencyKey: activityKey(fixCase, `organization-credit-stop-${episodeOperationKey.slice(-12)}`),
        });
        await fixActivities.finalizeFixTask(
          FinalizeFixTaskInputSchema.parse({
            runId: fixCase.runId,
            organizationId: fixCase.organizationId,
            projectId: fixCase.projectId,
            phaseId: fixCase.phaseId,
            taskId: fixCase.taskId,
            outcome: 'cancelled',
            commitSha: null,
            verificationResultId: null,
            idempotencyKey: activityKey(fixCase, 'finalize-organization-credit-rejected'),
          }),
        );
        await fixActivities.transitionRunStatus({
          runId: input.runId,
          status: 'cancelled',
          idempotencyKey: activityKey(fixCase, 'status-organization-credit-rejected'),
        });
        await fixActivities.emitEvents({
          events: [fixEvent(input, 'run.cancelled', 'organization-credit-rejected', {
            reason: 'organization_credit_exhausted',
            checkpointRef: checkpoint.checkpointRef,
          }, fixCase)],
        });
        return FixWorkflowResultSchema.parse({
          status: 'cancelled',
          reason: 'organization_credit_exhausted',
          checkpointRef: checkpoint.checkpointRef,
        });
      }
      if (resolution.absoluteCeiling !== immutableCeiling) {
        throw new Error('Fix organization credit approval changed the immutable ceiling');
      }
      creditBalanceExhausted = false;
      creditBalanceOperationKey = undefined;
      creditApprovalResolution = undefined;
      await fixActivities.transitionRunStatus({
        runId: input.runId,
        status: 'running',
        idempotencyKey: activityKey(fixCase, `status-organization-credit-approved-${episodeOperationKey.slice(-12)}`),
      });
    }
    if (!pauseRequested || fixCase === undefined || workspaceId === undefined) return undefined;
    const checkpoint = CheckpointFixWorkspaceResultSchema.parse(
      await fixControlActivities.checkpointFixWorkspace(
        CheckpointFixWorkspaceInputSchema.parse({
          runId: fixCase.runId,
          organizationId: fixCase.organizationId,
          projectId: fixCase.projectId,
          phaseId: fixCase.phaseId,
          taskId: fixCase.taskId,
          workspaceId,
          reason: 'pause',
          idempotencyKey: activityKey(fixCase, `control-${pauseOperationKey ?? 'pause'}`),
        }),
      ),
    );
    await fixControlActivities.transitionRunStatus({
      runId: input.runId,
      status: 'paused',
      idempotencyKey: activityKey(fixCase, `status-${pauseOperationKey ?? 'pause'}`),
    });
    await fixControlActivities.emitEvents({
      flushImmediately: true,
      events: [
        fixEvent(
          input,
          'run.paused',
          `run-paused-${pauseOperationKey ?? 'pause'}`,
          { checkpointRef: checkpoint.checkpointRef, operationKey: pauseOperationKey },
          fixCase,
        ),
      ],
    });
    await condition(() => resumeRequested || pendingControlReason() !== undefined);
    if (pendingControlReason() !== undefined) return await completeControl();
    pauseRequested = false;
    resumeRequested = false;
    const completedPauseOperation = pauseOperationKey;
    pauseOperationKey = undefined;
    await fixControlActivities.transitionRunStatus({
      runId: input.runId,
      status: 'running',
      idempotencyKey: activityKey(fixCase, `status-resumed-${completedPauseOperation ?? 'pause'}`),
    });
    await fixControlActivities.emitEvents({
      flushImmediately: true,
      events: [
        fixEvent(
          input,
          'run.resumed',
          `run-resumed-${completedPauseOperation ?? 'pause'}`,
          { checkpointRef: checkpoint.checkpointRef },
          fixCase,
        ),
      ],
    });
    return undefined;
  };

  const workflowScope = new CancellationScope();
  activeScope = workflowScope;
  try {
    return await workflowScope.run(async () => {
      await fixActivities.transitionRunStatus({
        runId: input.runId,
        status: 'running',
        idempotencyKey: `${input.runId}:fix:status-running`,
      });
      await fixActivities.emitEvents({
        events: [
          fixEvent(input, 'run.started', 'run-started', {
            mode: 'fix',
            source: input.fixRequest.source,
            capturedEvidenceCount: input.fixRequest.evidence.length,
          }),
        ],
      });

      fixCase = FixCaseSchema.parse(
        await fixActivities.loadFixCase(
          LoadFixCaseInputSchema.parse({
            runId: input.runId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            prompt: input.prompt,
            fixRequest: input.fixRequest,
          }),
        ),
      );
      if (
        fixCase.runId !== input.runId ||
        fixCase.organizationId !== input.organizationId ||
        fixCase.projectId !== input.projectId ||
        fixCase.relevantCommitSha !== input.fixRequest.relevantCommitSha
      ) {
        fail('fix_case_scope_mismatch', 'loaded fix case does not match the requested run scope');
      }
      await fixActivities.emitEvents({
        events: [
          fixEvent(
            input,
            'phase.created',
            'phase-created',
            { name: 'Reproduce and repair' },
            fixCase,
          ),
          fixEvent(input, 'phase.started', 'phase-started', { mode: 'fix' }, fixCase),
          fixEvent(input, 'task.started', 'task-started', { source: fixCase.source }, fixCase),
        ],
      });

      const scope = {
        runId: fixCase.runId,
        organizationId: fixCase.organizationId,
        projectId: fixCase.projectId,
        phaseId: fixCase.phaseId,
        taskId: fixCase.taskId,
      };
      const restored = RestoreFixWorkspaceResultSchema.parse(
        await fixActivities.restoreFixWorkspace(
          RestoreFixWorkspaceInputSchema.parse({
            ...scope,
            relevantCommitSha: fixCase.relevantCommitSha,
            idempotencyKey: activityKey(fixCase, 'restore'),
          }),
        ),
      );
      if (restored.restoredCommitSha !== fixCase.relevantCommitSha) {
        fail('fix_restore_commit_mismatch', 'isolated workspace restored a different commit');
      }
      workspaceId = restored.workspaceId;
      await emitStep(input, fixCase, 'restore', {
        status: 'completed',
        commitSha: restored.restoredCommitSha,
      });
      const restoreControl = await honorControlBoundary();
      if (restoreControl !== undefined) return restoreControl;

      const reproduction = ReproduceFixResultSchema.parse(
        await fixActivities.reproduceFix(
          ReproduceFixInputSchema.parse({
            ...scope,
            workspaceId: restored.workspaceId,
            reproductionRef: fixCase.reproductionRef,
            evidence: fixCase.evidence,
            idempotencyKey: activityKey(fixCase, 'reproduce'),
          }),
        ),
      );
      await emitStep(input, fixCase, 'reproduce', {
        status: reproduction.status,
        evidenceArtifactIds: reproduction.evidenceArtifactIds,
        ...(reproduction.status === 'not_reproduced' ? { reason: reproduction.reason } : {}),
      });
      const reproduceControl = await honorControlBoundary();
      if (reproduceControl !== undefined) return reproduceControl;
      if (reproduction.status === 'not_reproduced') {
        await fixActivities.finalizeFixTask(
          FinalizeFixTaskInputSchema.parse({
            ...scope,
            outcome: 'not_reproduced',
            commitSha: null,
            verificationResultId: null,
            idempotencyKey: activityKey(fixCase, 'finalize-not-reproduced'),
          }),
        );
        await fixActivities.emitEvents({
          events: [
            fixEvent(
              input,
              'task.completed',
              'task-not-reproduced',
              { outcome: 'not_reproduced', reason: reproduction.reason },
              fixCase,
            ),
            fixEvent(
              input,
              'phase.completed',
              'phase-not-reproduced',
              { outcome: 'not_reproduced' },
              fixCase,
            ),
            fixEvent(input, 'run.completed', 'run-not-reproduced', { outcome: 'not_reproduced' }),
          ],
        });
        await fixActivities.transitionRunStatus({
          runId: input.runId,
          status: 'completed',
          idempotencyKey: activityKey(fixCase, 'status-not-reproduced'),
        });
        return FixWorkflowResultSchema.parse({
          status: 'not_reproduced',
          reason: reproduction.reason,
        });
      }

      const regressionTest = FixRegressionTestResultSchema.parse(
        await fixActivities.prepareFixRegressionTest(
          PrepareFixRegressionTestInputSchema.parse({
            ...scope,
            workspaceId: restored.workspaceId,
            summary: fixCase.summary,
            reproductionRef: fixCase.reproductionRef,
            failingCheck: reproduction.failingCheck,
            relatedFiles: fixCase.relatedFiles,
            idempotencyKey: activityKey(fixCase, 'regression-test'),
          }),
        ),
      );
      await emitStep(input, fixCase, 'regression_test', {
        status: regressionTest.status,
        ...(regressionTest.status === 'written'
          ? {
              path: regressionTest.path,
              observedFailure: regressionTest.observedFailure,
              evidenceArtifactId: regressionTest.evidenceArtifactId,
            }
          : { policyFlag: regressionTest.policyFlag, reason: regressionTest.reason }),
      });
      const regressionControl = await honorControlBoundary();
      if (regressionControl !== undefined) return regressionControl;

      ApplyFixPatchResultSchema.parse(
        await fixActivities.applyFixPatch(
          ApplyFixPatchInputSchema.parse({
            ...scope,
            workspaceId: restored.workspaceId,
            model: input.model,
            summary: fixCase.summary,
            failingCheck: reproduction.failingCheck,
            relatedFiles: fixCase.relatedFiles,
            regressionTest,
            idempotencyKey: activityKey(fixCase, 'patch'),
          }),
        ),
      );
      await emitStep(input, fixCase, 'patch', { status: 'completed' });

      const commit = CommitFixPatchResultSchema.parse(
        await fixActivities.commitFixPatch(
          CommitFixPatchInputSchema.parse({
            ...scope,
            workspaceId: restored.workspaceId,
            message: `Fix: ${fixCase.summary}`,
            idempotencyKey: activityKey(fixCase, 'commit'),
          }),
        ),
      );
      await fixActivities.emitEvents({
        events: [
          fixEvent(
            input,
            'commit.created',
            'commit-created',
            { commitSha: commit.commitSha, mode: 'fix' },
            fixCase,
          ),
        ],
      });
      const patchControl = await honorControlBoundary();
      if (patchControl !== undefined) return patchControl;

      const measurement = FixDiffMeasurementSchema.parse(
        await fixActivities.measureFixDiff(
          MeasureFixDiffInputSchema.parse({
            ...scope,
            baseCommitSha: fixCase.relevantCommitSha,
            candidateCommitSha: commit.commitSha,
            idempotencyKey: activityKey(fixCase, 'measure-diff'),
          }),
        ),
      );
      if (measurement.changedFiles.length === 0) {
        fail('fix_patch_empty', 'patch activity did not change the isolated workspace');
      }
      const diffAssessment = assessFixDiff(measurement);
      await emitStep(input, fixCase, 'diff_guard', {
        status: diffAssessment.status,
        source: diffAssessment.source,
        changedFiles: measurement.changedFiles.length,
        changedLines: measurement.changedLines,
        limits: FIX_DIFF_LIMITS,
        ...(diffAssessment.status === 'oversized' ? { reasons: diffAssessment.reasons } : {}),
      });
      if (diffAssessment.status === 'oversized') {
        fail('fix_diff_too_large', 'measured patch exceeds the Fix anti-slop limits');
      }
      const diffControl = await honorControlBoundary();
      if (diffControl !== undefined) return diffControl;

      const targeted = FixCheckResultSchema.parse(
        await fixActivities.runFixTargetedChecks(
          RunFixTargetedChecksInputSchema.parse({
            ...scope,
            workspaceId: restored.workspaceId,
            candidateCommitSha: commit.commitSha,
            failingCheck: reproduction.failingCheck,
            regressionTest,
            idempotencyKey: activityKey(fixCase, 'targeted-checks'),
          }),
        ),
      );
      await emitStep(input, fixCase, 'targeted_checks', {
        status: targeted.status,
        checks: targeted.checks,
        evidenceArtifactIds: targeted.evidenceArtifactIds,
      });
      if (targeted.status !== 'passed') {
        fail('fix_targeted_checks_failed', 'the targeted Fix checks did not pass');
      }
      const targetedControl = await honorControlBoundary();
      if (targetedControl !== undefined) return targetedControl;

      const verification = FixPhaseVerificationResultSchema.parse(
        await fixVerification.verifyFixCandidate(
          VerifyFixCandidateInputSchema.parse({
            ...scope,
            candidateCommitSha: commit.commitSha,
            idempotencyKey: activityKey(fixCase, 'full-verification'),
          }),
        ),
      );
      await emitStep(input, fixCase, 'full_verification', {
        status: verification.decision,
        verificationResultId: verification.verificationResultId,
        riskCount: verification.risks.length,
      });
      if (verification.decision !== 'approved') {
        fail(
          'fix_verification_rejected',
          'the independent full gate set did not approve the patch',
        );
      }
      const verificationControl = await honorControlBoundary();
      if (verificationControl !== undefined) return verificationControl;

      const symptom = VerifyOriginalFixSymptomResultSchema.parse(
        await fixActivities.verifyOriginalFixSymptom(
          VerifyOriginalFixSymptomInputSchema.parse({
            ...scope,
            workspaceId: restored.workspaceId,
            reproductionRef: fixCase.reproductionRef,
            originalFailingCheck: reproduction.failingCheck,
            verifiedCommitSha: commit.commitSha,
            idempotencyKey: activityKey(fixCase, 'verify-symptom'),
          }),
        ),
      );
      await emitStep(input, fixCase, 'symptom_check', {
        status: symptom.status,
        evidenceArtifactIds: symptom.evidenceArtifactIds,
      });
      if (symptom.status !== 'resolved') {
        fail(
          'fix_symptom_still_present',
          'the original reproduction still fails after verification',
        );
      }
      const symptomControl = await honorControlBoundary();
      if (symptomControl !== undefined) return symptomControl;

      await fixActivities.finalizeFixTask(
        FinalizeFixTaskInputSchema.parse({
          ...scope,
          outcome: 'passed',
          commitSha: commit.commitSha,
          verificationResultId: verification.verificationResultId,
          idempotencyKey: activityKey(fixCase, 'finalize-passed'),
        }),
      );

      await fixActivities.emitEvents({
        events: [
          fixEvent(
            input,
            'task.completed',
            'task-completed',
            { commitSha: commit.commitSha },
            fixCase,
          ),
          fixEvent(
            input,
            'phase.completed',
            'phase-completed',
            { verificationResultId: verification.verificationResultId },
            fixCase,
          ),
          fixEvent(input, 'run.completed', 'run-completed', { status: 'completed' }),
        ],
      });
      await fixActivities.transitionRunStatus({
        runId: input.runId,
        status: 'completed',
        idempotencyKey: activityKey(fixCase, 'status-completed'),
      });
      return FixWorkflowResultSchema.parse({
        status: 'completed',
        commitSha: commit.commitSha,
        regressionTestPath: regressionTest.status === 'written' ? regressionTest.path : null,
        verificationResultId: verification.verificationResultId,
      });
    });
  } catch (error: unknown) {
    activeScope = undefined;
    if (controlReason !== undefined && isCancellation(error)) {
      return await CancellationScope.nonCancellable(completeControl);
    }
    if (fixCase !== undefined) {
      await fixActivities.failFixTask(
        FailFixTaskInputSchema.parse({
          runId: fixCase.runId,
          organizationId: fixCase.organizationId,
          projectId: fixCase.projectId,
          phaseId: fixCase.phaseId,
          taskId: fixCase.taskId,
          reason: error instanceof Error ? error.message : 'fix_workflow_failed',
          idempotencyKey: activityKey(fixCase, 'finalize-failed'),
        }),
      );
    }
    await fixActivities.transitionRunStatus({
      runId: input.runId,
      status: 'failed',
      idempotencyKey:
        fixCase === undefined
          ? `${input.runId}:fix:status-failed`
          : activityKey(fixCase, 'status-failed'),
    });
    if (fixCase !== undefined) {
      await fixActivities.emitEvents({
        events: [
          fixEvent(
            input,
            'task.failed',
            'task-failed',
            { reason: error instanceof Error ? error.message : 'fix_workflow_failed' },
            fixCase,
          ),
        ],
      });
    }
    throw error;
  }
}
