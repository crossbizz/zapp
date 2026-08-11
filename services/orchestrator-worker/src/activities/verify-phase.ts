import {
  AgentEventObjectSchema,
  CommitShaSchema,
  idSchema,
  newId,
  SupportLevelSchema,
  TaskStateSchema,
} from '@zapp/contracts';
import {
  agentEvents,
  agentPhases,
  agentRuns,
  agentTasks,
  nextEventSequence,
  verificationResults,
  type Database,
} from '@zapp/db';
import {
  assembleCriterionRecords,
  AntiSlopPolicyContextSchema,
  CriterionAssemblyInputSchema,
  CriterionIdSchema,
  CriterionRecordSchema,
  CriterionTestCaseSchema,
  decideVerification,
  GateResultSchema,
  ProjectPolicySchema,
  PolicySignalSchema,
  requiredGates,
  VerificationDecisionSchema,
  VerificationRiskSchema,
  runAntiSlopPolicySuite,
  type GateContext,
  type GateId,
  type GateRequirementClass,
  type GateWaiver,
} from '@zapp/verification-engine';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

const VerifyPhaseArgumentsSchema = z.tuple([
  idSchema('run'),
  idSchema('phase'),
  CommitShaSchema,
]);

const IndependentCriterionAssemblySchema = CriterionAssemblyInputSchema.refine(
  ({ testCases }) => testCases.length === 0,
  'verification_context_cannot_preload_test_cases',
);

export const PhaseVerificationContextSchema = z
  .object({
    runId: idSchema('run'),
    phaseId: idSchema('phase'),
    taskId: idSchema('task'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    supportLevel: SupportLevelSchema,
    projectPolicy: ProjectPolicySchema,
    criticalCriterionIds: z.array(CriterionIdSchema).max(1_000),
    criterionAssembly: IndependentCriterionAssemblySchema,
    antiSlop: AntiSlopPolicyContextSchema.default({}),
  })
  .strict();
export type PhaseVerificationContext = z.infer<typeof PhaseVerificationContextSchema>;

export const OpenVerifierWorkspaceInputSchema = z
  .object({
    runId: idSchema('run'),
    phaseId: idSchema('phase'),
    commitSha: CommitShaSchema,
    networkProfile: z.literal('restricted_verification'),
  })
  .strict();
export type OpenVerifierWorkspaceInput = z.infer<typeof OpenVerifierWorkspaceInputSchema>;

export interface FreshVerifierWorkspace {
  readonly resolvedCommitSha: string;
  readonly gateContext: GateContext;
  close(): Promise<void>;
}

export const VerificationGateExecutionSchema = z
  .object({
    result: GateResultSchema,
    testCases: z.array(CriterionTestCaseSchema).max(100_000),
  })
  .strict();
export type VerificationGateExecution = z.infer<typeof VerificationGateExecutionSchema>;

const VerificationResultRowSchema = z
  .object({
    organizationId: idSchema('org'),
    runId: idSchema('run'),
    taskId: idSchema('task'),
    commitSha: CommitShaSchema,
    decision: VerificationDecisionSchema,
    criteriaResultsJson: z.array(CriterionRecordSchema).min(1),
    risksJson: z.array(VerificationRiskSchema),
  })
  .strict();

const VerificationTaskCompletionSchema = z
  .object({
    taskId: idSchema('task'),
    status: TaskStateSchema.extract(['passed', 'repairing', 'waiting_for_approval']),
  })
  .strict();

const VerificationCompletedEventSchema = AgentEventObjectSchema.omit({
  id: true,
  sequence: true,
  occurredAt: true,
  phaseId: true,
  taskId: true,
  agentId: true,
  type: true,
  visibility: true,
  payload: true,
})
  .extend({
    phaseId: idSchema('phase'),
    taskId: idSchema('task'),
    agentId: z.literal('verifier'),
    type: z.literal('verification.completed'),
    visibility: z.literal('user'),
    payload: z
      .object({
        decision: VerificationDecisionSchema,
        commitSha: CommitShaSchema,
        criteriaCount: z.number().int().positive(),
        riskCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const CompletePhaseVerificationInputSchema = z
  .object({
    operationKey: z.string().min(1).max(512),
    row: VerificationResultRowSchema,
    task: VerificationTaskCompletionSchema,
    event: VerificationCompletedEventSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const expectedTaskStatus = {
      approved: 'passed',
      rejected: 'repairing',
      needs_human: 'waiting_for_approval',
    }[input.row.decision];
    const mismatched =
      input.operationKey !==
        `verify-phase:${input.row.runId}:${input.event.phaseId}:${input.row.commitSha}` ||
      input.row.organizationId !== input.event.organizationId ||
      input.row.runId !== input.event.runId ||
      input.row.taskId !== input.task.taskId ||
      input.row.taskId !== input.event.taskId ||
      input.task.status !== expectedTaskStatus ||
      input.row.decision !== input.event.payload.decision ||
      input.row.commitSha !== input.event.payload.commitSha ||
      input.row.criteriaResultsJson.length !== input.event.payload.criteriaCount ||
      input.row.risksJson.length !== input.event.payload.riskCount;
    if (mismatched) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'verification_completion_scope_mismatch',
      });
    }
  });
export type CompletePhaseVerificationInput = z.infer<
  typeof CompletePhaseVerificationInputSchema
>;

export const CompletePhaseVerificationResultSchema = z
  .object({ verificationResultId: idSchema('vr') })
  .strict();
export type CompletePhaseVerificationResult = z.infer<
  typeof CompletePhaseVerificationResultSchema
>;

export const VerifyPhaseResultSchema = z
  .object({
    verificationResultId: idSchema('vr'),
    decision: VerificationDecisionSchema,
    criteriaResults: z.array(CriterionRecordSchema).min(1),
    risks: z.array(VerificationRiskSchema),
  })
  .strict();
export type VerifyPhaseResult = z.infer<typeof VerifyPhaseResultSchema>;

export interface PhaseVerificationContextPort {
  load(runId: string, phaseId: string): Promise<unknown>;
}

export interface VerifierWorkspacePort {
  open(input: OpenVerifierWorkspaceInput): Promise<FreshVerifierWorkspace>;
}

export interface VerificationGateRunner {
  run(gateId: GateId, context: GateContext): Promise<unknown>;
}

export interface VerificationPolicyRunner {
  run(input: {
    readonly supportLevel: z.infer<typeof SupportLevelSchema>;
    readonly context: z.infer<typeof AntiSlopPolicyContextSchema>;
    readonly gateContext: GateContext;
  }): Promise<unknown>;
}

export interface PhaseVerificationCompletionPort {
  /** Atomically inserts the result, transitions the task, and appends the event. */
  complete(input: CompletePhaseVerificationInput): Promise<CompletePhaseVerificationResult>;
}

export interface VerifyPhaseActivities {
  verifyPhase(runId: string, phaseId: string, commitSha: string): Promise<VerifyPhaseResult>;
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | {
  readonly [key: string]: CanonicalJson;
};

function canonicalize(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  throw new TypeError('verification completion contains non-JSON data');
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function completionConflict(): never {
  throw new Error('verification_completion_conflict');
}

/** One transaction owns verifier-result identity, time, task state, and event sequence. */
export function createPostgresPhaseVerificationCompletionPort(
  database: Database,
): PhaseVerificationCompletionPort {
  return {
    async complete(inputValue) {
      const input = CompletePhaseVerificationInputSchema.parse(inputValue);
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.operationKey}, 0))`,
        );
        const [existing] = await tx
          .select({
            id: verificationResults.id,
            decision: verificationResults.decision,
            criteriaResultsJson: verificationResults.criteriaResultsJson,
            risksJson: verificationResults.risksJson,
          })
          .from(verificationResults)
          .where(
            and(
              eq(verificationResults.organizationId, input.row.organizationId),
              eq(verificationResults.runId, input.row.runId),
              eq(verificationResults.taskId, input.row.taskId),
              eq(verificationResults.commitSha, input.row.commitSha),
            ),
          )
          .limit(1);
        if (existing !== undefined) {
          const [replayed] = await tx
            .select({
              taskStatus: agentTasks.status,
              organizationId: agentEvents.organizationId,
              projectId: agentEvents.projectId,
              runId: agentEvents.runId,
              phaseId: agentEvents.phaseId,
              taskId: agentEvents.taskId,
              agentId: agentEvents.agentId,
              type: agentEvents.type,
              visibility: agentEvents.visibility,
              payloadJson: agentEvents.payloadJson,
            })
            .from(agentTasks)
            .innerJoin(
              agentEvents,
              and(
                eq(agentEvents.taskId, agentTasks.id),
                eq(agentEvents.runId, input.row.runId),
                eq(agentEvents.type, 'verification.completed'),
                sql`${agentEvents.payloadJson}->>'verificationResultId' = ${existing.id}`,
              ),
            )
            .where(
              and(
                eq(agentTasks.id, input.task.taskId),
                eq(agentTasks.organizationId, input.row.organizationId),
              ),
            )
            .limit(1);
          const expectedPayload = {
            ...input.event.payload,
            verificationResultId: existing.id,
          };
          if (
            replayed === undefined ||
            existing.decision !== input.row.decision ||
            !sameJson(existing.criteriaResultsJson, input.row.criteriaResultsJson) ||
            !sameJson(existing.risksJson, input.row.risksJson) ||
            replayed.taskStatus !== input.task.status ||
            replayed.organizationId !== input.event.organizationId ||
            replayed.projectId !== input.event.projectId ||
            replayed.runId !== input.event.runId ||
            replayed.phaseId !== input.event.phaseId ||
            replayed.taskId !== input.event.taskId ||
            replayed.agentId !== input.event.agentId ||
            replayed.type !== input.event.type ||
            replayed.visibility !== input.event.visibility ||
            !sameJson(replayed.payloadJson, expectedPayload)
          ) {
            completionConflict();
          }
          return CompletePhaseVerificationResultSchema.parse({ verificationResultId: existing.id });
        }

        const [scopedTask] = await tx
          .select({ id: agentTasks.id })
          .from(agentTasks)
          .innerJoin(agentPhases, eq(agentPhases.id, agentTasks.phaseId))
          .innerJoin(agentRuns, eq(agentRuns.id, agentPhases.runId))
          .where(
            and(
              eq(agentTasks.id, input.task.taskId),
              eq(agentTasks.organizationId, input.row.organizationId),
              eq(agentTasks.phaseId, input.event.phaseId),
              eq(agentTasks.status, 'verifying'),
              eq(agentPhases.organizationId, input.row.organizationId),
              eq(agentPhases.runId, input.row.runId),
              eq(agentRuns.organizationId, input.row.organizationId),
              eq(agentRuns.projectId, input.event.projectId),
            ),
          )
          .limit(1);
        if (scopedTask === undefined) throw new Error('verification_task_not_verifying');

        const verificationResultId = newId('vr');
        await tx.insert(verificationResults).values({
          id: verificationResultId,
          ...input.row,
        });
        const [transitioned] = await tx
          .update(agentTasks)
          .set({ status: input.task.status })
          .where(
            and(
              eq(agentTasks.id, input.task.taskId),
              eq(agentTasks.organizationId, input.row.organizationId),
              eq(agentTasks.phaseId, input.event.phaseId),
              eq(agentTasks.status, 'verifying'),
            ),
          )
          .returning({ id: agentTasks.id });
        if (transitioned === undefined) throw new Error('verification_task_transition_conflict');

        const sequence = await nextEventSequence(tx, input.row.runId);
        await tx.insert(agentEvents).values({
          id: newId('evt'),
          organizationId: input.event.organizationId,
          projectId: input.event.projectId,
          runId: input.event.runId,
          sequence,
          occurredAt: new Date(),
          phaseId: input.event.phaseId,
          taskId: input.event.taskId,
          agentId: input.event.agentId,
          type: input.event.type,
          visibility: input.event.visibility,
          payloadJson: {
            ...input.event.payload,
            verificationResultId,
          },
        });
        return CompletePhaseVerificationResultSchema.parse({ verificationResultId });
      });
    },
  };
}

function shouldRunGate(
  gateId: GateId,
  requirementClass: GateRequirementClass,
  hasCriticalCriteria: boolean,
): boolean {
  if (gateId === 'browser_acceptance' && !hasCriticalCriteria) return false;
  if (requirementClass === 'no' || requirementClass === 'recommended') {
    return false;
  }
  if (requirementClass === 'optional') {
    return gateId === 'browser_acceptance' && hasCriticalCriteria;
  }
  return true;
}

function taskStatus(decision: z.infer<typeof VerificationDecisionSchema>) {
  switch (decision) {
    case 'approved':
      return 'passed' as const;
    case 'rejected':
      return 'repairing' as const;
    case 'needs_human':
      return 'waiting_for_approval' as const;
  }
}

export function createVerifyPhaseActivities(dependencies: {
  readonly phaseContext: PhaseVerificationContextPort;
  readonly workspaces: VerifierWorkspacePort;
  readonly gates: VerificationGateRunner;
  readonly antiSlop?: VerificationPolicyRunner;
  readonly completion: PhaseVerificationCompletionPort;
}): VerifyPhaseActivities {
  return {
    async verifyPhase(runIdValue, phaseIdValue, commitShaValue) {
      const [runId, phaseId, commitSha] = VerifyPhaseArgumentsSchema.parse([
        runIdValue,
        phaseIdValue,
        commitShaValue,
      ]);
      const phase = PhaseVerificationContextSchema.parse(
        await dependencies.phaseContext.load(runId, phaseId),
      );
      if (phase.runId !== runId || phase.phaseId !== phaseId) {
        throw new Error('verification_phase_scope_mismatch');
      }

      const workspace = await dependencies.workspaces.open(
        OpenVerifierWorkspaceInputSchema.parse({
          runId,
          phaseId,
          commitSha,
          networkProfile: 'restricted_verification',
        }),
      );
      const gateEvaluations: Array<{
        gateId: GateId;
        class: ReturnType<typeof requiredGates>[number]['class'];
        result: z.infer<typeof GateResultSchema>;
        waiver?: GateWaiver;
      }> = [];
      const observedTestCases: z.infer<typeof CriterionTestCaseSchema>[] = [];
      let policySignals: z.infer<typeof PolicySignalSchema>[] = [];
      try {
        if (
          CommitShaSchema.parse(workspace.resolvedCommitSha) !== commitSha ||
          CommitShaSchema.parse(workspace.gateContext.commit) !== commitSha
        ) {
          throw new Error('verification_workspace_commit_mismatch');
        }
        const requirements = requiredGates(phase.supportLevel, phase.projectPolicy);
        for (const requirement of requirements) {
          if (requirement.disposition === 'waived') {
            gateEvaluations.push({
              gateId: requirement.gateId,
              class: requirement.class,
              waiver: requirement.waiver,
              result: GateResultSchema.parse({
                status: 'waived',
                evidenceArtifactIds: [],
                details: { waiver: requirement.waiver },
              }),
            });
            continue;
          }
          if (
            !shouldRunGate(
              requirement.gateId,
              requirement.class,
              phase.criticalCriterionIds.length > 0,
            )
          ) {
            continue;
          }
          const execution = VerificationGateExecutionSchema.parse(
            await dependencies.gates.run(requirement.gateId, workspace.gateContext),
          );
          gateEvaluations.push({
            gateId: requirement.gateId,
            class: requirement.class,
            result: execution.result,
          });
          if (requirement.gateId === 'browser_acceptance') {
            observedTestCases.push(...execution.testCases);
          }
        }
        const policyRunner = dependencies.antiSlop ?? {
          run: (input: Parameters<VerificationPolicyRunner['run']>[0]) =>
            runAntiSlopPolicySuite({
              runtime: input.gateContext.runtime,
              workspaceRoot: input.gateContext.contract.workspace_root,
              supportLevel: input.supportLevel,
              context: input.context,
            }),
        };
        policySignals = z.array(PolicySignalSchema).max(9).parse(
          await policyRunner.run({
            supportLevel: phase.supportLevel,
            context: phase.antiSlop,
            gateContext: workspace.gateContext,
          }),
        );
      } finally {
        await workspace.close();
      }

      const criteriaResults = assembleCriterionRecords({
        ...phase.criterionAssembly,
        testCases: observedTestCases,
      });
      const decision = decideVerification({
        gateEvaluations,
        criteria: criteriaResults,
        criticalCriterionIds: phase.criticalCriterionIds,
        policySignals,
      });
      const operationKey = `verify-phase:${runId}:${phaseId}:${commitSha}`;
      const completed = CompletePhaseVerificationResultSchema.parse(
        await dependencies.completion.complete(
          CompletePhaseVerificationInputSchema.parse({
            operationKey,
            row: {
              organizationId: phase.organizationId,
              runId,
              taskId: phase.taskId,
              commitSha,
              decision: decision.decision,
              criteriaResultsJson: decision.criteriaResults,
              risksJson: decision.risks,
            },
            task: { taskId: phase.taskId, status: taskStatus(decision.decision) },
            event: {
              runId,
              organizationId: phase.organizationId,
              projectId: phase.projectId,
              phaseId,
              taskId: phase.taskId,
              agentId: 'verifier',
              type: 'verification.completed',
              visibility: 'user',
              payload: {
                decision: decision.decision,
                commitSha,
                criteriaCount: decision.criteriaResults.length,
                riskCount: decision.risks.length,
              },
            },
          }),
        ),
      );
      return VerifyPhaseResultSchema.parse({
        verificationResultId: completed.verificationResultId,
        decision: decision.decision,
        criteriaResults: decision.criteriaResults,
        risks: decision.risks,
      });
    },
  };
}
