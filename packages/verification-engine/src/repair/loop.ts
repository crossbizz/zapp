import { createHash } from 'node:crypto';

import { CommitShaSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import {
  classifyFailure,
  FailureClassificationResultSchema,
  FailureClassificationSchema,
  type FailureModelClassifier,
  ProtectedFailureSchema,
  RepairCriterionSchema,
  RepairEvidenceArtifactIdSchema,
  RepairFailureSchema,
  RepairRelatedFilesSchema,
} from './classify.js';
import { GateIdSchema } from '../policy-matrix.js';

export const TRANSIENT_RETRY_BUDGET = 3;
export const DETERMINISTIC_REPAIR_BUDGET = 2;

const OperationKeySchema = z.string().min(1).max(512);
const RepairTaskIdSchema = idSchema('task');
const EvidenceIdsSchema = z.array(RepairEvidenceArtifactIdSchema).min(1).max(50);
const CollectedEvidenceIdsSchema = z
  .array(RepairEvidenceArtifactIdSchema)
  .min(1)
  .max(250);
const RepairScopeSchema = z
  .object({
    runId: idSchema('run'),
    phaseId: idSchema('phase'),
    taskId: idSchema('task'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
  })
  .strict();

const RepairLoopInputBaseSchema = RepairScopeSchema.extend({
  idempotencyKey: OperationKeySchema,
  failingCommitSha: CommitShaSchema,
  affectedGateIds: z.array(GateIdSchema).min(1).max(100),
  failure: RepairFailureSchema,
}).strict();

function requireUniqueAffectedGates(
  input: {
    readonly affectedGateIds: readonly string[];
    readonly failure: { readonly gateId: string };
  },
  context: z.RefinementCtx,
): void {
  if (new Set(input.affectedGateIds).size !== input.affectedGateIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'repair_gate_ids_must_be_unique' });
  }
  if (!input.affectedGateIds.includes(input.failure.gateId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'repair_affected_gates_must_include_failed_gate',
    });
  }
}

export const RepairLoopInputSchema = RepairLoopInputBaseSchema.superRefine(
  requireUniqueAffectedGates,
);
export type RepairLoopInput = z.infer<typeof RepairLoopInputSchema>;

export const RepairBuilderContextSchema = z
  .object({
    criterion: RepairCriterionSchema,
    failingGate: z
      .object({
        gateId: GateIdSchema,
        output: z.string().max(1_000_000),
        evidenceArtifactIds: z.array(RepairEvidenceArtifactIdSchema).min(1).max(50),
      })
      .strict(),
    relatedFiles: RepairRelatedFilesSchema,
  })
  .strict();
export type RepairBuilderContext = z.infer<typeof RepairBuilderContextSchema>;

export const RepairTaskCreateInputSchema = RepairScopeSchema.extend({
  idempotencyKey: OperationKeySchema,
  failingCommitSha: CommitShaSchema,
  classification: FailureClassificationSchema,
  protectedFailure: ProtectedFailureSchema,
  context: RepairBuilderContextSchema,
}).strict();
export type RepairTaskCreateInput = z.infer<typeof RepairTaskCreateInputSchema>;

export const RepairTaskCreateResultSchema = z.object({ repairTaskId: RepairTaskIdSchema }).strict();
export type RepairTaskCreateResult = z.infer<typeof RepairTaskCreateResultSchema>;

export const RepairBuilderInputSchema = RepairScopeSchema.extend({
  idempotencyKey: OperationKeySchema,
  repairTaskId: RepairTaskIdSchema,
  iteration: z.number().int().min(1).max(DETERMINISTIC_REPAIR_BUDGET),
  classification: FailureClassificationSchema.extract(['product_code', 'test_code']),
  baseCommitSha: CommitShaSchema,
  workspaceId: z.string().min(1).max(512).nullable(),
  affectedGateIds: z.array(GateIdSchema).min(1).max(100),
  context: RepairBuilderContextSchema,
}).strict();
export type RepairBuilderInput = z.infer<typeof RepairBuilderInputSchema>;

export const RepairCommitReceiptSchema = z
  .object({
    commitSha: CommitShaSchema,
    parentCommitSha: CommitShaSchema,
    repairTaskId: RepairTaskIdSchema,
    workspaceId: z.string().min(1).max(512),
    branchName: z.string().min(1).max(255),
  })
  .strict();
export type RepairCommitReceipt = z.infer<typeof RepairCommitReceiptSchema>;

const RepairBuilderResultSchema = z.object({ receipt: RepairCommitReceiptSchema }).strict();
export type RepairBuilderResult = z.infer<typeof RepairBuilderResultSchema>;

export const RepairCheckResultSchema = z
  .object({
    status: z.enum(['passed', 'failed', 'waived']),
    evidenceArtifactIds: EvidenceIdsSchema,
    output: z.string().max(1_000_000),
  })
  .strict();
export type RepairCheckResult = z.infer<typeof RepairCheckResultSchema>;

const TargetedRepairCheckInputSchema = RepairScopeSchema.extend({
  idempotencyKey: OperationKeySchema,
  repairTaskId: RepairTaskIdSchema,
  iteration: z.number().int().min(1).max(DETERMINISTIC_REPAIR_BUDGET),
  commitSha: CommitShaSchema,
  classification: FailureClassificationSchema.extract(['product_code', 'test_code']),
  criterion: RepairCriterionSchema,
  relatedFiles: RepairRelatedFilesSchema,
}).strict();
export type TargetedRepairCheckInput = z.infer<typeof TargetedRepairCheckInputSchema>;

const AffectedGateCheckInputSchema = RepairScopeSchema.extend({
  idempotencyKey: OperationKeySchema,
  repairTaskId: RepairTaskIdSchema,
  kind: z.enum(['repair_iteration', 'transient_retry']),
  attempt: z.number().int().min(1).max(TRANSIENT_RETRY_BUDGET),
  commitSha: CommitShaSchema,
  affectedGateIds: z.array(GateIdSchema).min(1).max(100),
  protectedFailure: ProtectedFailureSchema,
}).strict();
export type AffectedGateCheckInput = z.infer<typeof AffectedGateCheckInputSchema>;

export const VerifyRepairCommitInputSchema = RepairScopeSchema.extend({
  idempotencyKey: OperationKeySchema,
  receipt: RepairCommitReceiptSchema,
  expectedParentCommitSha: CommitShaSchema,
  expectedBranchName: z.string().min(1).max(255),
}).strict();
export type VerifyRepairCommitInput = z.infer<typeof VerifyRepairCommitInputSchema>;

export const VerifyRepairCommitResultSchema = z.object({ verified: z.literal(true) }).strict();
export type VerifyRepairCommitResult = z.infer<typeof VerifyRepairCommitResultSchema>;

export const RepairSuccessSchema = RepairScopeSchema.extend({
  idempotencyKey: OperationKeySchema,
  repairTaskId: RepairTaskIdSchema,
  status: z.enum(['repaired', 'recovered']),
  classification: FailureClassificationSchema,
  repairIterations: z.number().int().min(0).max(DETERMINISTIC_REPAIR_BUDGET),
  transientRetries: z.number().int().min(0).max(TRANSIENT_RETRY_BUDGET),
  commitShas: z.array(CommitShaSchema).max(DETERMINISTIC_REPAIR_BUDGET),
  evidenceArtifactIds: CollectedEvidenceIdsSchema,
}).strict();
export type RepairSuccess = z.infer<typeof RepairSuccessSchema>;

const RepairEscalationPayloadSchema = z
  .object({
    kind: z.literal('repair_exhausted'),
    classification: FailureClassificationSchema,
    repairIterations: z.number().int().min(0).max(DETERMINISTIC_REPAIR_BUDGET),
    transientRetries: z.number().int().min(0).max(TRANSIENT_RETRY_BUDGET),
    blockerSummary: z.string().min(1).max(2_000),
    evidenceArtifactIds: CollectedEvidenceIdsSchema,
  })
  .strict();

export const RepairEscalationSchema = RepairScopeSchema.extend({
  idempotencyKey: OperationKeySchema,
  repairTaskId: RepairTaskIdSchema,
  status: z.literal('failed'),
  event: z
    .object({
      type: z.literal('task.failed'),
      visibility: z.literal('user'),
      payload: RepairEscalationPayloadSchema,
    })
    .strict(),
}).strict();
export type RepairEscalation = z.infer<typeof RepairEscalationSchema>;

export const RepairLoopResultSchema = z
  .object({
    status: z.enum(['repaired', 'recovered', 'escalated']),
    classification: FailureClassificationSchema,
    classificationReason: z.string().min(1).max(2_000),
    repairIterations: z.number().int().min(0).max(DETERMINISTIC_REPAIR_BUDGET),
    transientRetries: z.number().int().min(0).max(TRANSIENT_RETRY_BUDGET),
    commitShas: z.array(CommitShaSchema).max(DETERMINISTIC_REPAIR_BUDGET),
    evidenceArtifactIds: CollectedEvidenceIdsSchema,
  })
  .strict();
export type RepairLoopResult = z.infer<typeof RepairLoopResultSchema>;

export interface RepairTaskPort {
  create(input: RepairTaskCreateInput): Promise<unknown>;
}

export interface RepairBuilderPort {
  repair(input: RepairBuilderInput): Promise<unknown>;
}

export interface RepairCheckPort {
  targeted(input: TargetedRepairCheckInput): Promise<unknown>;
  affected(input: AffectedGateCheckInput): Promise<unknown>;
}

export interface RepairCommitPort {
  verify(input: VerifyRepairCommitInput): Promise<unknown>;
}

export interface RepairOutcomePort {
  succeeded(input: RepairSuccess): Promise<void>;
  escalate(input: RepairEscalation): Promise<void>;
}

export interface RepairLoopDependencies {
  readonly modelClassifier: FailureModelClassifier;
  readonly repairTasks: RepairTaskPort;
  readonly builder: RepairBuilderPort;
  readonly commits: RepairCommitPort;
  readonly checks: RepairCheckPort;
  readonly outcomes: RepairOutcomePort;
}

const RepairLoopExecutionInputSchema = RepairLoopInputBaseSchema.extend({
  builderContext: RepairBuilderContextSchema,
})
  .strict()
  .superRefine(requireUniqueAffectedGates);
type RepairLoopExecutionInput = z.infer<typeof RepairLoopExecutionInputSchema>;

function uniqueEvidence(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function operationKey(root: string, stage: string): string {
  return `repair:${createHash('sha256').update(`${root}\u0000${stage}`).digest('hex')}`;
}

function resultFrom(
  input: RepairLoopExecutionInput,
  classification: z.infer<typeof FailureClassificationResultSchema>,
  result: {
    readonly status: 'repaired' | 'recovered' | 'escalated';
    readonly repairIterations: number;
    readonly transientRetries: number;
    readonly commitShas: readonly string[];
    readonly evidenceArtifactIds: readonly string[];
  },
): RepairLoopResult {
  return RepairLoopResultSchema.parse({
    status: result.status,
    classification: classification.classification,
    classificationReason: classification.reason,
    repairIterations: result.repairIterations,
    transientRetries: result.transientRetries,
    commitShas: result.commitShas,
    evidenceArtifactIds: uniqueEvidence(result.evidenceArtifactIds),
  });
}

async function escalate(
  input: RepairLoopExecutionInput,
  dependencies: RepairLoopDependencies,
  repairTaskId: string,
  classification: z.infer<typeof FailureClassificationResultSchema>,
  result: {
    readonly repairIterations: number;
    readonly transientRetries: number;
    readonly commitShas: readonly string[];
    readonly evidenceArtifactIds: readonly string[];
    readonly blockerSummary: string;
  },
): Promise<RepairLoopResult> {
  const evidenceArtifactIds = uniqueEvidence(result.evidenceArtifactIds);
  const escalation = RepairEscalationSchema.parse({
    runId: input.runId,
    phaseId: input.phaseId,
    taskId: input.taskId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    repairTaskId,
    idempotencyKey: operationKey(input.idempotencyKey, 'outcome:escalated'),
    status: 'failed',
    event: {
      type: 'task.failed',
      visibility: 'user',
      payload: {
        kind: 'repair_exhausted',
        classification: classification.classification,
        repairIterations: result.repairIterations,
        transientRetries: result.transientRetries,
        blockerSummary: result.blockerSummary,
        evidenceArtifactIds,
      },
    },
  });
  await dependencies.outcomes.escalate(escalation);
  return resultFrom(input, classification, {
    status: 'escalated',
    repairIterations: result.repairIterations,
    transientRetries: result.transientRetries,
    commitShas: result.commitShas,
    evidenceArtifactIds,
  });
}

function isPassing(result: RepairCheckResult): boolean {
  return result.status === 'passed';
}

export async function runRepairLoop(
  inputValue: unknown,
  dependencies: RepairLoopDependencies,
): Promise<RepairLoopResult> {
  const input = RepairLoopExecutionInputSchema.parse(inputValue);
  const classification = await classifyFailure(input.failure, dependencies.modelClassifier, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    runId: input.runId,
    taskId: input.taskId,
  });
  const created = RepairTaskCreateResultSchema.parse(
    await dependencies.repairTasks.create(
      RepairTaskCreateInputSchema.parse({
        runId: input.runId,
        phaseId: input.phaseId,
        taskId: input.taskId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        idempotencyKey: operationKey(input.idempotencyKey, 'task:create'),
        failingCommitSha: input.failingCommitSha,
        classification: classification.classification,
        protectedFailure: input.failure.protectedFailure,
        context: input.builderContext,
      }),
    ),
  );
  const evidenceArtifactIds = [...input.failure.evidenceArtifactIds];

  if (
    classification.classification === 'infrastructure' ||
    classification.classification === 'flaky_dependency'
  ) {
    for (let attempt = 1; attempt <= TRANSIENT_RETRY_BUDGET; attempt += 1) {
      const check = RepairCheckResultSchema.parse(
        await dependencies.checks.affected(
          AffectedGateCheckInputSchema.parse({
            runId: input.runId,
            phaseId: input.phaseId,
            taskId: input.taskId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            repairTaskId: created.repairTaskId,
            idempotencyKey: operationKey(input.idempotencyKey, `affected:transient:${String(attempt)}`),
            kind: 'transient_retry',
            attempt,
            commitSha: input.failingCommitSha,
            affectedGateIds: input.affectedGateIds,
            protectedFailure: input.failure.protectedFailure,
          }),
        ),
      );
      evidenceArtifactIds.push(...check.evidenceArtifactIds);
      if (isPassing(check)) {
        const success = RepairSuccessSchema.parse({
          runId: input.runId,
          phaseId: input.phaseId,
          taskId: input.taskId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          repairTaskId: created.repairTaskId,
          idempotencyKey: operationKey(input.idempotencyKey, 'outcome:recovered'),
          status: 'recovered',
          classification: classification.classification,
          repairIterations: 0,
          transientRetries: attempt,
          commitShas: [],
          evidenceArtifactIds: uniqueEvidence(evidenceArtifactIds),
        });
        await dependencies.outcomes.succeeded(success);
        return resultFrom(input, classification, {
          ...success,
          status: 'recovered',
        });
      }
    }
    return escalate(input, dependencies, created.repairTaskId, classification, {
      repairIterations: 0,
      transientRetries: TRANSIENT_RETRY_BUDGET,
      commitShas: [],
      evidenceArtifactIds,
      blockerSummary: `Failure remained after ${String(TRANSIENT_RETRY_BUDGET)} transient retries.`,
    });
  }

  if (classification.classification === 'environment') {
    return escalate(input, dependencies, created.repairTaskId, classification, {
      repairIterations: 0,
      transientRetries: 0,
      commitShas: [],
      evidenceArtifactIds,
      blockerSummary: 'Environment failure requires human correction before verification can continue.',
    });
  }

  const commitShas: string[] = [];
  let baseCommitSha = input.failingCommitSha;
  let workspaceId: string | null = null;
  for (let iteration = 1; iteration <= DETERMINISTIC_REPAIR_BUDGET; iteration += 1) {
    const built = RepairBuilderResultSchema.parse(
      await dependencies.builder.repair(
        RepairBuilderInputSchema.parse({
          runId: input.runId,
          phaseId: input.phaseId,
          taskId: input.taskId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          repairTaskId: created.repairTaskId,
          idempotencyKey: operationKey(input.idempotencyKey, `builder:${String(iteration)}`),
          iteration,
          classification: classification.classification,
          baseCommitSha,
          workspaceId,
          affectedGateIds: input.affectedGateIds,
          context: input.builderContext,
        }),
      ),
    );
    const expectedBranchName = `task/${created.repairTaskId}`;
    if (
      built.receipt.commitSha === baseCommitSha ||
      commitShas.includes(built.receipt.commitSha) ||
      built.receipt.parentCommitSha !== baseCommitSha ||
      built.receipt.repairTaskId !== created.repairTaskId ||
      built.receipt.branchName !== expectedBranchName
    ) {
      throw new Error('repair_iteration_requires_new_commit');
    }
    VerifyRepairCommitResultSchema.parse(
      await dependencies.commits.verify(
        VerifyRepairCommitInputSchema.parse({
          runId: input.runId,
          phaseId: input.phaseId,
          taskId: input.taskId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          idempotencyKey: operationKey(input.idempotencyKey, `commit:verify:${String(iteration)}`),
          receipt: built.receipt,
          expectedParentCommitSha: baseCommitSha,
          expectedBranchName,
        }),
      ),
    );
    commitShas.push(built.receipt.commitSha);
    baseCommitSha = built.receipt.commitSha;
    workspaceId = built.receipt.workspaceId;

    const targeted = RepairCheckResultSchema.parse(
      await dependencies.checks.targeted(
        TargetedRepairCheckInputSchema.parse({
          runId: input.runId,
          phaseId: input.phaseId,
          taskId: input.taskId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          repairTaskId: created.repairTaskId,
          idempotencyKey: operationKey(input.idempotencyKey, `targeted:${String(iteration)}`),
          iteration,
          commitSha: built.receipt.commitSha,
          classification: classification.classification,
          criterion: input.failure.criterion,
          relatedFiles: input.failure.relatedFiles,
        }),
      ),
    );
    evidenceArtifactIds.push(...targeted.evidenceArtifactIds);
    const affected = RepairCheckResultSchema.parse(
      await dependencies.checks.affected(
        AffectedGateCheckInputSchema.parse({
          runId: input.runId,
          phaseId: input.phaseId,
          taskId: input.taskId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          repairTaskId: created.repairTaskId,
          idempotencyKey: operationKey(input.idempotencyKey, `affected:repair:${String(iteration)}`),
          kind: 'repair_iteration',
          attempt: iteration,
          commitSha: built.receipt.commitSha,
          affectedGateIds: input.affectedGateIds,
          protectedFailure: input.failure.protectedFailure,
        }),
      ),
    );
    evidenceArtifactIds.push(...affected.evidenceArtifactIds);

    if (isPassing(targeted) && isPassing(affected)) {
      const success = RepairSuccessSchema.parse({
        runId: input.runId,
        phaseId: input.phaseId,
        taskId: input.taskId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        repairTaskId: created.repairTaskId,
        idempotencyKey: operationKey(input.idempotencyKey, 'outcome:repaired'),
        status: 'repaired',
        classification: classification.classification,
        repairIterations: iteration,
        transientRetries: 0,
        commitShas,
        evidenceArtifactIds: uniqueEvidence(evidenceArtifactIds),
      });
      await dependencies.outcomes.succeeded(success);
      return resultFrom(input, classification, success);
    }
  }

  return escalate(input, dependencies, created.repairTaskId, classification, {
    repairIterations: DETERMINISTIC_REPAIR_BUDGET,
    transientRetries: 0,
    commitShas,
    evidenceArtifactIds,
    blockerSummary: `Failure remained after ${String(DETERMINISTIC_REPAIR_BUDGET)} repair iterations.`,
  });
}
