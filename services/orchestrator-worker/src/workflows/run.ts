import {
  ApplicationFailure,
  CancellationScope,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  executeChild,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
  type RetryPolicy,
} from '@temporalio/workflow';
import { RunWorkflowStartInputSchema } from '@zapp/contracts/temporal-run';
import { MessageAssistantPayloadSchema, MessageUserPayloadSchema } from '@zapp/contracts/events';
import { TOOL_GROUPS, TOOL_NAMES, type ToolName } from '@zapp/contracts/tools';
import { PlanSchema, type PlanTask } from '@zapp/planning-engine';
import { z } from 'zod';

import type { EventActivities, PendingAgentEvent } from '../activities/events.js';
import type { ApprovalActivities, RunApprovalActivities } from '../activities/approvals.js';
import type { SessionActivities } from '../activities/session.js';
import type { VerifyPhaseActivities } from '../activities/verify-phase.js';
import type { WorkspaceActivities } from '../activities/workspace.js';
import {
  ApprovePlanInputSchema,
  ApprovePlanResultSchema,
  AutonomousApprovalResolutionSchema,
  autonomousPlanApprovalSignal,
  ProducePlanInputSchema,
  ProducePlanResultSchema,
  ResolveIntegrationHeadInputSchema,
  ResolveIntegrationHeadResultSchema,
  TransitionPhaseTasksInputSchema,
  type AutonomousActivities,
} from './autonomous.js';
import { processRedirectPlanChange, type RedirectPlanChangeHooks } from './redirect.js';
import { runTaskBatchWorkflow, TaskWorkflowResultSchema } from './task.js';
import {
  BudgetApprovalResolutionSchema,
  budgetApprovalResolvedSignal,
  decodeBudgetApprovalResolution,
  immutableRunCeiling,
} from './budget-approval.js';
import {
  RetryFailedTaskSignalSchema,
  SkipOptionalPhaseSignalSchema,
  retryFailedTaskEligibility,
  retryFailedTaskSignal,
  skipOptionalPhaseEligibility,
  skipOptionalPhaseSignal,
} from './builder-control.js';

export { capabilityScanWorkflow } from './capability-scan.js';
export {
  autonomousWorkflow,
  autonomousPlanApprovalSignal,
  autonomousCreditBalanceExhaustedSignal,
  autonomousSpecificationApprovalSignal,
} from './autonomous.js';
export { fixCreditBalanceExhaustedSignal, fixWorkflow } from './fix.js';

const workflowIdSchema = (
  prefix: 'run' | 'org' | 'proj' | 'br' | 'art' | 'phase' | 'task' | 'vr',
): z.ZodString => z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));

export const RunWorkflowInputSchema = RunWorkflowStartInputSchema;
export type RunWorkflowInput = z.infer<typeof RunWorkflowInputSchema>;

export const BuildModePlanSchema = PlanSchema.superRefine((plan, context) => {
  if (plan.phases.length !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'build_plan_requires_exactly_one_phase',
      path: ['phases'],
    });
  }
  if (plan.tasks.length > 5) {
    context.addIssue({
      code: z.ZodIssueCode.too_big,
      type: 'array',
      maximum: 5,
      inclusive: true,
      message: 'build_plan_exceeds_five_tasks',
      path: ['tasks'],
    });
  }
  const phase = plan.phases[0];
  if (phase === undefined) return;
  if (phase.optional) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'build_phase_must_be_required',
      path: ['phases', 0, 'optional'],
    });
  }
  if (!workflowIdSchema('phase').safeParse(phase.id).success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'build_phase_id_invalid',
      path: ['phases', 0, 'id'],
    });
  }
  const criteria = new Set(phase.acceptanceCriteria);
  const taskIndexes = new Map(plan.tasks.map((task, index) => [task.id, index]));
  for (const [index, task] of plan.tasks.entries()) {
    if (!workflowIdSchema('task').safeParse(task.id).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'build_task_id_invalid',
        path: ['tasks', index, 'id'],
      });
    }
    if (task.phaseId !== phase.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'build_task_must_belong_to_the_single_phase',
        path: ['tasks', index, 'phaseId'],
      });
    }
    for (const [criterionIndex, criterionId] of task.acceptanceCriteriaIds.entries()) {
      if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u.test(criterionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'build_task_acceptance_criterion_id_invalid',
          path: ['tasks', index, 'acceptanceCriteriaIds', criterionIndex],
        });
      }
      if (!criteria.has(criterionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'build_task_acceptance_criterion_missing_from_phase',
          path: ['tasks', index, 'acceptanceCriteriaIds', criterionIndex],
        });
      }
    }
    for (const [dependencyIndex, dependencyId] of task.dependsOn.entries()) {
      const resolvedIndex = taskIndexes.get(dependencyId);
      if (resolvedIndex !== undefined && resolvedIndex >= index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'build_tasks_must_be_topologically_ordered',
          path: ['tasks', index, 'dependsOn', dependencyIndex],
        });
      }
    }
  }
});
export type BuildModePlan = z.infer<typeof BuildModePlanSchema>;

const BuildModeApprovalConfigSchema = z
  .object({
    maxAutoApprovedDiffFiles: z.number().int().nonnegative().max(10_000),
    maxAutoApprovedRisk: z.enum(['low', 'medium', 'high']),
  })
  .strict();
export type BuildModeApprovalConfig = z.infer<typeof BuildModeApprovalConfigSchema>;

export const BUILD_MODE_APPROVAL_CONFIG: BuildModeApprovalConfig = {
  maxAutoApprovedDiffFiles: 8,
  maxAutoApprovedRisk: 'low',
};

const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;

export const BuildModeApprovalAssessmentSchema = z
  .object({
    source: z.literal('policy_engine'),
    diffFiles: z.number().int().nonnegative().max(100_000),
    risk: z.enum(['low', 'medium', 'high']),
  })
  .strict();
export type BuildModeApprovalAssessment = z.infer<typeof BuildModeApprovalAssessmentSchema>;

const AssessBuildPlanApprovalInputSchema = z
  .object({
    runId: workflowIdSchema('run'),
    organizationId: workflowIdSchema('org'),
    projectId: workflowIdSchema('proj'),
    planArtifactId: workflowIdSchema('art'),
    config: BuildModeApprovalConfigSchema,
    idempotencyKey: z.string().min(1).max(512),
  })
  .strict();

export function shouldAutoApproveBuildPlan(
  assessmentValue: unknown,
  configValue: unknown,
): boolean {
  const assessment = BuildModeApprovalAssessmentSchema.parse(assessmentValue);
  const config = BuildModeApprovalConfigSchema.parse(configValue);
  return (
    assessment.diffFiles <= config.maxAutoApprovedDiffFiles &&
    RISK_RANK[assessment.risk] <= RISK_RANK[config.maxAutoApprovedRisk]
  );
}

export interface BuildModeActivities extends Pick<
  AutonomousActivities,
  'producePlan' | 'approvePlan' | 'resolveIntegrationHead' | 'transitionPhaseTasks'
> {
  /**
   * Loads the immutable plan artifact and derives diff size and risk in the
   * code-owned policy layer. It must fail closed when trusted classification
   * is unavailable; model-authored plan metadata is not approval authority.
   */
  assessBuildPlanApproval(
    input: z.infer<typeof AssessBuildPlanApprovalInputSchema>,
  ): Promise<BuildModeApprovalAssessment>;
}

const BuildPlanContinuationSchema = z
  .object({
    phase: z.literal('build_plan'),
    workspaceId: z.string().min(1).max(512),
  })
  .strict();
const BuildExecuteContinuationSchema = z
  .object({
    phase: z.literal('build_execute'),
    workspaceId: z.string().min(1).max(512),
    planArtifactId: workflowIdSchema('art'),
    plan: BuildModePlanSchema,
    taskCommits: z
      .array(
        z
          .object({
            taskId: workflowIdSchema('task'),
            commitSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
          })
          .strict(),
      )
      .max(5)
      .default([]),
  })
  .strict();
const BuildVerifyContinuationSchema = z
  .object({
    phase: z.literal('build_verify'),
    workspaceId: z.string().min(1).max(512),
    planArtifactId: workflowIdSchema('art'),
    plan: BuildModePlanSchema,
    commitSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
    taskCommits: z
      .array(
        z
          .object({
            taskId: workflowIdSchema('task'),
            commitSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();
const BuildPhaseVerificationResultSchema = z
  .object({
    verificationResultId: workflowIdSchema('vr'),
    decision: z.enum(['approved', 'rejected', 'needs_human']),
    criteriaResults: z.array(z.unknown()).min(1).max(1_000),
    risks: z.array(z.unknown()).max(1_000),
  })
  .strict();

const RunWorkflowContinuationSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('session'), workspaceId: z.string().min(1).max(512) }).strict(),
  z.object({ phase: z.literal('commit'), workspaceId: z.string().min(1).max(512) }).strict(),
  BuildPlanContinuationSchema,
  BuildExecuteContinuationSchema,
  BuildVerifyContinuationSchema,
]);
const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
const RunControlSignalSchema = z
  .object({
    runId: workflowIdSchema('run'),
    operationKey: OperationKeySchema,
  })
  .strict();
const RunRedirectSignalSchema = RunControlSignalSchema.extend({
  instruction: z.string().trim().min(1).max(20_000),
}).strict();
const RunMessageSignalSchema = RunControlSignalSchema.extend({
  message: MessageUserPayloadSchema,
}).strict();
const RunControlContinuationSchema = z
  .object({
    seenOperationKeys: z.array(OperationKeySchema).max(1_000),
    pauseRequested: z.boolean(),
    pauseOperationKey: OperationKeySchema.nullable(),
    creditBalanceExhausted: z.boolean(),
    creditBalanceOperationKey: OperationKeySchema.nullable(),
    resumeRequested: z.boolean(),
    resumeOperationKey: OperationKeySchema.nullable(),
    cancelRequested: z.boolean(),
    cancelOperationKey: OperationKeySchema.nullable(),
    cancelAcknowledgementDeadlineAt: z.string().datetime().nullable(),
    pendingRedirects: z.array(RunRedirectSignalSchema).max(100),
    pendingMessages: z.array(RunMessageSignalSchema).max(100).default([]),
    pendingRetries: z.array(RetryFailedTaskSignalSchema).max(100).optional(),
    pendingSkips: z.array(SkipOptionalPhaseSignalSchema).max(100).optional(),
    failedTaskIds: z.array(workflowIdSchema('task')).max(10_000).optional(),
    startedTaskIds: z.array(workflowIdSchema('task')).max(10_000).optional(),
    taskAttempts: z
      .record(workflowIdSchema('task'), z.number().int().nonnegative().max(100))
      .optional(),
  })
  .strict();
const RunWorkflowStateSchema = RunWorkflowInputSchema.extend({
  buildModeVersion: z.literal('lightweight-v1').optional(),
  continuation: RunWorkflowContinuationSchema.optional(),
  budgetAttempt: z.number().int().nonnegative().max(100).optional(),
  sessionStep: z.number().int().nonnegative().max(10_000).optional(),
  lastEmittedAssistantTurn: z.number().int().nonnegative().max(10_000).optional(),
  control: RunControlContinuationSchema.optional(),
})
  .strict()
  .superRefine((state, context) => {
    const lightweightBuild = state.buildModeVersion === 'lightweight-v1';
    const buildContinuation = state.continuation?.phase.startsWith('build_') ?? false;
    if (lightweightBuild && state.mode !== 'build') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'build_workflow_requires_build_mode',
        path: ['mode'],
      });
    }
    if (lightweightBuild !== buildContinuation && state.continuation !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'run_mode_continuation_mismatch',
        path: ['continuation', 'phase'],
      });
    }
  });

export const RunWorkflowResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('completed'),
      commitSha: z
        .string()
        .regex(/^[0-9a-f]{40,64}$/u)
        .nullable(),
    })
    .strict(),
  z.object({ status: z.literal('cancelled'), checkpointRef: z.string().min(1) }).strict(),
]);
export type RunWorkflowResult = z.infer<typeof RunWorkflowResultSchema>;

export const ACTIVITY_RETRY_POLICY: RetryPolicy = {
  initialInterval: '100 milliseconds',
  maximumAttempts: 3,
  nonRetryableErrorTypes: [
    'activity_idempotency_conflict',
    'activity_idempotency_key_required',
    'activity_idempotency_corrupt',
  ],
};

export const SESSION_ACTIVITY_HEARTBEAT_TIMEOUT = '30 seconds';

const workspace = proxyActivities<WorkspaceActivities>({
  startToCloseTimeout: '2 minutes',
  retry: ACTIVITY_RETRY_POLICY,
});
const session = proxyActivities<SessionActivities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: SESSION_ACTIVITY_HEARTBEAT_TIMEOUT,
  cancellationType: 'WAIT_CANCELLATION_COMPLETED',
  retry: ACTIVITY_RETRY_POLICY,
});
const events = proxyActivities<EventActivities>({
  startToCloseTimeout: '30 seconds',
  retry: ACTIVITY_RETRY_POLICY,
});
const assistantContent = proxyActivities<{
  storeAssistantContent(
    input: Parameters<EventActivities['storeAssistantContent']>[0],
  ): ReturnType<EventActivities['storeAssistantContent']>;
}>({
  startToCloseTimeout: '2 minutes',
  retry: ACTIVITY_RETRY_POLICY,
});
const approvals = proxyActivities<ApprovalActivities>({
  startToCloseTimeout: '2 minutes',
  retry: ACTIVITY_RETRY_POLICY,
});
const runApprovals = proxyActivities<RunApprovalActivities>({
  startToCloseTimeout: '2 minutes',
  retry: ACTIVITY_RETRY_POLICY,
});
const buildActivities = proxyActivities<BuildModeActivities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  retry: ACTIVITY_RETRY_POLICY,
});
const buildVerificationActivities = proxyActivities<VerifyPhaseActivities>({
  taskQueue: 'verification',
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  retry: ACTIVITY_RETRY_POLICY,
});
const CONTROL_ACTIVITY_RETRY_POLICY: RetryPolicy = {
  ...ACTIVITY_RETRY_POLICY,
  maximumAttempts: 1,
};
const CONTROL_ACKNOWLEDGEMENT_BUDGET_MS = 5_000;
const controlEvents = proxyActivities<EventActivities>({
  scheduleToCloseTimeout: '750 milliseconds',
  startToCloseTimeout: '750 milliseconds',
  retry: CONTROL_ACTIVITY_RETRY_POLICY,
});
const controlApprovals = proxyActivities<ApprovalActivities>({
  scheduleToCloseTimeout: '1 second',
  startToCloseTimeout: '1 second',
  retry: CONTROL_ACTIVITY_RETRY_POLICY,
});

export { budgetApprovalResolvedSignal } from './budget-approval.js';
export const pauseRunSignal = defineSignal<[unknown]>('pause');
/**
 * The credit reconciler signals a durable boundary only; it deliberately never
 * cancels an in-flight builder task. The workflow enters the existing AR-14
 * budget-increase approval loop after that task returns.
 */
export const creditBalanceExhaustedSignal = defineSignal<[unknown]>('creditBalanceExhausted');
export const resumeRunSignal = defineSignal<[unknown]>('resume');
export const cancelRunSignal = defineSignal<[unknown]>('cancel');
export const redirectRunSignal = defineSignal<[unknown]>('redirect');
export const messageRunSignal = defineSignal<[unknown]>('message');

export const RunControlStatusSchema = z
  .object({
    status: z.enum([
      'running',
      'pause_requested',
      'paused',
      'waiting_for_approval',
      'cancel_requested',
      'cancelled',
      'completed',
      'failed',
    ]),
    phase: z.enum(['preparing', 'session', 'paused', 'commit', 'terminal']),
    taskId: z.literal('task-m1'),
    workspaceId: z.string().min(1).max(512).nullable(),
    pendingRedirectCount: z.number().int().nonnegative().max(100),
    pendingMessageCount: z.number().int().nonnegative().max(100),
  })
  .strict();
export type RunControlStatus = z.infer<typeof RunControlStatusSchema>;
export const getRunStatusQuery = defineQuery<RunControlStatus>('getStatus');

const M1_COMMIT_MESSAGE = 'Complete M1 builder task';

const PrototypeMockSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

const ASK_MODE_INSTRUCTIONS =
  'Use only read-only tools. Cite every code claim with path:line, a commit ref, or test/runtime evidence.';
const PROTOTYPE_MODE_INSTRUCTIONS =
  'Optimize for a working preview. Start the dev server, run the preview smoke test, and label every mock or incomplete integration. Finish with exactly one strict JSON object and no other text: {"summary":"<user-facing summary>","mocks":[{"name":"<mock name>","reason":"<why it is mocked>"}]}.';
const DEFAULT_MODE_INSTRUCTIONS =
  'Implement the requested application directly. Prefer TypeScript. Inspect the execution contract and file tree once. If the repository is blank or scaffold-only, do not inspect git history, database schema, release state, empty logs, or unrelated integrations. Create runnable application files immediately, install dependencies, start the development server, run the preview smoke test, and fix any reported errors. Continue until the requested verification succeeds.';

function buildTaskPrompt(input: RunWorkflowInput, planArtifactId: string, task: PlanTask): string {
  return [
    `Build request: ${input.prompt}`,
    `Approved lightweight plan: ${planArtifactId}`,
    `Task: ${task.title}`,
    `Acceptance criteria: ${task.acceptanceCriteriaIds.join(', ')}`,
    `Expected files: ${task.expectedFiles.join(', ') || 'discover from the repository'}`,
    `Required tests: ${task.requiredTests.join(', ') || 'project-required VF gate set'}`,
    "Make only this task's change. Finish with a commit; verification runs independently afterward.",
  ].join('\n');
}

export interface RunModeGuardrails {
  readonly allowedTools: readonly ToolName[];
  readonly modeInstructions: string;
}

export function runModeGuardrails(mode: RunWorkflowInput['mode']): RunModeGuardrails {
  if (mode === 'ask') {
    return { allowedTools: TOOL_GROUPS.read, modeInstructions: ASK_MODE_INSTRUCTIONS };
  }
  if (mode === 'prototype') {
    const forbidden = new Set<ToolName>([
      'create_release_candidate',
      'deploy_release',
      'check_deployment_health',
      'rollback_release',
    ]);
    return {
      allowedTools: TOOL_NAMES.filter((tool) => !forbidden.has(tool)),
      modeInstructions: PROTOTYPE_MODE_INSTRUCTIONS,
    };
  }
  return { allowedTools: TOOL_NAMES, modeInstructions: DEFAULT_MODE_INSTRUCTIONS };
}

function askAnswerNeedsCitation(answer: string): boolean {
  const claimsAboutCode =
    /(?:\b(?:code|class|function|method|implemented|implementation|test|tests)\b|[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/iu.test(
      answer,
    );
  if (!claimsAboutCode) return false;
  const pathLine = /(?:^|\s)[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+(?=$|[\s,;)])/u.test(answer);
  const commitRef = /\b(?:commit\s+)?[0-9a-f]{7,64}\b/iu.test(answer);
  return !pathLine && !commitRef;
}

function operationKey(input: RunWorkflowInput, step: string): string {
  return `${input.runId}:task-m1:${step}`;
}

function nextRunCreditCeiling(currentMaxCredits: number, planMaxCredits?: number): string {
  if (currentMaxCredits >= 1_000_000) throw new Error('run credit ceiling cannot be increased');
  return `${String(Math.min(1_000_000, planMaxCredits ?? 1_000_000, currentMaxCredits * 2))}.0000`;
}

function controlCheckpointApprovalId(input: RunWorkflowInput): string {
  return `appr_${input.runId.slice('run_'.length)}`;
}

function event(
  input: RunWorkflowInput,
  type: PendingAgentEvent['type'],
  suffix: string,
  payload: Record<string, unknown>,
  scope: { readonly phaseId?: string; readonly taskId?: string; readonly agentId?: string } = {},
): PendingAgentEvent {
  return {
    eventKey: `${input.runId}:task-m1:${suffix}`,
    runId: input.runId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    ...(scope.phaseId === undefined ? {} : { phaseId: scope.phaseId }),
    ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }),
    ...(scope.agentId === undefined ? {} : { agentId: scope.agentId }),
    occurredAt: new Date().toISOString(),
    type,
    visibility: 'user',
    payload,
  };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function opaqueConversationId(
  prefix: 'msg' | 'turn' | 'art',
  input: RunWorkflowInput,
  ordinal: number,
): string {
  let value = z.number().int().nonnegative().max(0x3fffffff).parse(ordinal);
  let tail = '';
  for (let index = 0; index < 6; index += 1) {
    tail = `${CROCKFORD[value & 31] ?? '0'}${tail}`;
    value >>>= 5;
  }
  return `${prefix}_${input.runId.slice('run_'.length, -6)}${tail}`;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

async function emitAssistantMessage(
  input: RunWorkflowInput,
  assistantTurn: number,
  content: string,
  model: string,
): Promise<void> {
  if (content.length === 0) return;
  const ordinal = assistantTurn;
  const messageId = opaqueConversationId('msg', input, 1_000 + ordinal);
  const turnId = opaqueConversationId('turn', input, ordinal);
  const common = { messageId, turnId, model };
  if (utf8ByteLength(content) <= 48 * 1024) {
    await events.emitEvents({
      events: [
        event(
          input,
          'message.assistant',
          `message-assistant-${String(assistantTurn)}`,
          MessageAssistantPayloadSchema.parse({ ...common, content }),
        ),
      ],
    });
    return;
  }
  const artifactId = workflowIdSchema('art').parse(
    opaqueConversationId('art', input, 1_000 + ordinal),
  );
  const stored = await assistantContent.storeAssistantContent({
    artifactId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    runId: input.runId,
    content,
    idempotencyKey: operationKey(input, `assistant-content-${String(assistantTurn)}`),
  });
  await events.emitEvents({
    events: [
      event(input, 'artifact.created', `assistant-content-${String(assistantTurn)}`, {
        artifactId: stored.artifactId,
        type: 'assistant_message',
        contentHash: stored.contentHash,
      }),
      event(
        input,
        'message.assistant',
        `message-assistant-${String(assistantTurn)}`,
        MessageAssistantPayloadSchema.parse({
          ...common,
          contentArtifactId: stored.artifactId,
        }),
      ),
    ],
  });
}

async function executeRunWorkflow(
  input: z.infer<typeof RunWorkflowStateSchema>,
): Promise<RunWorkflowResult> {
  const lightweightBuild = input.buildModeVersion === 'lightweight-v1';
  const budgetResolutions = new Map<string, z.infer<typeof BudgetApprovalResolutionSchema>>();
  const buildPlanResolutions = new Map<
    string,
    z.infer<typeof AutonomousApprovalResolutionSchema>
  >();
  const seenOperationKeys = new Set(input.control?.seenOperationKeys ?? []);
  let pauseRequested = input.control?.pauseRequested ?? false;
  let pauseOperationKey = input.control?.pauseOperationKey ?? null;
  let creditBalanceExhausted = input.control?.creditBalanceExhausted ?? false;
  let creditBalanceOperationKey = input.control?.creditBalanceOperationKey ?? null;
  let resumeRequested = input.control?.resumeRequested ?? false;
  let resumeOperationKey = input.control?.resumeOperationKey ?? null;
  let cancelRequested = input.control?.cancelRequested ?? false;
  let cancelOperationKey = input.control?.cancelOperationKey ?? null;
  let cancelAcknowledgementDeadlineAt = input.control?.cancelAcknowledgementDeadlineAt ?? null;
  const pendingRedirects = [...(input.control?.pendingRedirects ?? [])];
  const pendingMessages = [...(input.control?.pendingMessages ?? [])];
  const pendingRetries = [...(input.control?.pendingRetries ?? [])];
  const pendingSkips = [...(input.control?.pendingSkips ?? [])];
  let failedTaskIds = [...(input.control?.failedTaskIds ?? [])];
  const startedTaskIds = [...(input.control?.startedTaskIds ?? [])];
  const taskAttempts = { ...(input.control?.taskAttempts ?? {}) };
  let currentStatus: RunControlStatus['status'] = cancelRequested
    ? 'cancel_requested'
    : pauseRequested
      ? 'pause_requested'
      : 'running';
  let currentPhase: RunControlStatus['phase'] =
    input.continuation?.phase === 'commit' || input.continuation?.phase === 'build_verify'
      ? 'commit'
      : input.continuation?.phase === 'session' ||
          input.continuation?.phase === 'build_plan' ||
          input.continuation?.phase === 'build_execute'
        ? 'session'
        : 'preparing';
  let currentWorkspaceId = input.continuation?.workspaceId ?? null;
  let activeScope: CancellationScope | undefined;

  const acceptControlSignal = (value: unknown): z.infer<typeof RunControlSignalSchema> => {
    const parsed = RunControlSignalSchema.parse(value);
    if (parsed.runId !== input.runId) throw new Error('run control signal does not match workflow');
    return parsed;
  };
  const rememberOperation = (operationKeyValue: string): boolean => {
    if (seenOperationKeys.has(operationKeyValue)) return false;
    if (seenOperationKeys.size >= 1_000) throw new Error('run control operation history is full');
    seenOperationKeys.add(operationKeyValue);
    return true;
  };
  const controlContinuation = (): z.infer<typeof RunControlContinuationSchema> =>
    RunControlContinuationSchema.parse({
      seenOperationKeys: [...seenOperationKeys],
      pauseRequested,
      pauseOperationKey,
      creditBalanceExhausted,
      creditBalanceOperationKey,
      resumeRequested,
      resumeOperationKey,
      cancelRequested,
      cancelOperationKey,
      cancelAcknowledgementDeadlineAt,
      pendingRedirects,
      pendingMessages,
      pendingRetries,
      pendingSkips,
      failedTaskIds,
      startedTaskIds,
      taskAttempts,
    });

  setHandler(budgetApprovalResolvedSignal, (value) => {
    const resolution = decodeBudgetApprovalResolution(value);
    budgetResolutions.set(resolution.approvalId, resolution);
  });
  setHandler(autonomousPlanApprovalSignal, (value) => {
    const resolution = AutonomousApprovalResolutionSchema.parse(value);
    if (resolution.runId !== input.runId) {
      throw ApplicationFailure.nonRetryable(
        'Build plan approval does not match the workflow run',
        'build_plan_approval_run_mismatch',
      );
    }
    if (!rememberOperation(resolution.operationKey)) return;
    buildPlanResolutions.set(resolution.artifactId, resolution);
  });
  setHandler(pauseRunSignal, (value) => {
    const signal = acceptControlSignal(value);
    if (!rememberOperation(signal.operationKey) || cancelRequested || pauseRequested) return;
    pauseRequested = true;
    pauseOperationKey = signal.operationKey;
    currentStatus = 'pause_requested';
  });
  setHandler(creditBalanceExhaustedSignal, (value) => {
    const signal = acceptControlSignal(value);
    if (!rememberOperation(signal.operationKey) || cancelRequested || creditBalanceExhausted)
      return;
    creditBalanceExhausted = true;
    creditBalanceOperationKey = signal.operationKey;
  });
  setHandler(resumeRunSignal, (value) => {
    const signal = acceptControlSignal(value);
    if (!rememberOperation(signal.operationKey) || cancelRequested) return;
    if (pauseRequested && !resumeRequested) {
      resumeRequested = true;
      resumeOperationKey = signal.operationKey;
    }
  });
  setHandler(cancelRunSignal, (value) => {
    const signal = acceptControlSignal(value);
    if (cancelRequested || !rememberOperation(signal.operationKey)) return;
    cancelRequested = true;
    cancelOperationKey = signal.operationKey;
    cancelAcknowledgementDeadlineAt = new Date(
      Date.now() + CONTROL_ACKNOWLEDGEMENT_BUDGET_MS,
    ).toISOString();
    currentStatus = 'cancel_requested';
    activeScope?.cancel();
  });
  setHandler(redirectRunSignal, (value) => {
    const signal = RunRedirectSignalSchema.parse(value);
    if (signal.runId !== input.runId) throw new Error('run redirect does not match workflow');
    if (!rememberOperation(signal.operationKey) || cancelRequested) return;
    if (pendingRedirects.length >= 100) throw new Error('run redirect queue is full');
    pendingRedirects.push(signal);
  });
  setHandler(messageRunSignal, (value) => {
    const signal = RunMessageSignalSchema.parse(value);
    if (signal.runId !== input.runId) throw new Error('run message does not match workflow');
    if (!rememberOperation(signal.operationKey) || cancelRequested) return;
    if (pendingMessages.length >= 100) throw new Error('run message queue is full');
    pendingMessages.push(signal);
  });
  setHandler(retryFailedTaskSignal, (value) => {
    const signal = RetryFailedTaskSignalSchema.parse(value);
    if (signal.runId !== input.runId) throw new Error('task retry does not match workflow');
    if (!rememberOperation(signal.operationKey) || cancelRequested) return;
    pendingRetries.push(signal);
  });
  setHandler(skipOptionalPhaseSignal, (value) => {
    const signal = SkipOptionalPhaseSignalSchema.parse(value);
    if (signal.runId !== input.runId) throw new Error('phase skip does not match workflow');
    if (!rememberOperation(signal.operationKey) || cancelRequested) return;
    pendingSkips.push(signal);
  });
  setHandler(getRunStatusQuery, () =>
    RunControlStatusSchema.parse({
      status: currentStatus,
      phase: currentPhase,
      taskId: 'task-m1',
      workspaceId: currentWorkspaceId,
      pendingRedirectCount: pendingRedirects.length,
      pendingMessageCount: pendingMessages.length,
    }),
  );

  const checkpointControlBoundary = async (
    workspaceId: string,
    purpose: 'pause' | 'cancel',
    signalOperationKey: string | null,
  ): Promise<string> => {
    const checkpoint = await controlApprovals.checkpointBudgetStop({
      runId: input.runId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      workspaceId,
      approvalId: controlCheckpointApprovalId(input),
      idempotencyKey: operationKey(
        input,
        `control-${purpose}-${signalOperationKey?.slice(-12) ?? 'unkeyed'}`,
      ),
    });
    return checkpoint.checkpointRef;
  };

  const completeCancellation = async (
    workspaceId: string,
    existingCheckpointRef?: string,
  ): Promise<RunWorkflowResult> => {
    const checkpointRef =
      existingCheckpointRef ??
      (await checkpointControlBoundary(workspaceId, 'cancel', cancelOperationKey));
    const operation = OperationKeySchema.parse(cancelOperationKey);
    const acknowledgementDeadlineAt = z.string().datetime().parse(cancelAcknowledgementDeadlineAt);
    await controlEvents.emitEvents({
      flushImmediately: true,
      events: [
        event(input, 'artifact.created', 'control-cancel-checkpoint', {
          checkpointRef,
          kind: 'run_control_checkpoint',
        }),
        event(input, 'run.cancelled', 'control-cancelled', {
          reason: 'user_requested',
          checkpointRef,
          control: { operationKey: operation, acknowledgementDeadlineAt },
        }),
      ],
    });
    currentStatus = 'cancelled';
    currentPhase = 'terminal';
    return RunWorkflowResultSchema.parse({ status: 'cancelled', checkpointRef });
  };

  const honorControlBoundary = async (
    workspaceId: string,
    resumedPhase: Exclude<RunControlStatus['phase'], 'paused' | 'terminal'>,
  ): Promise<RunWorkflowResult | undefined> => {
    if (cancelRequested) return await completeCancellation(workspaceId);
    if (!pauseRequested) return undefined;
    const checkpointRef = await checkpointControlBoundary(workspaceId, 'pause', pauseOperationKey);
    const pauseOperation = OperationKeySchema.parse(pauseOperationKey);
    const pauseAcknowledgementDeadlineAt = new Date(
      Date.now() + CONTROL_ACKNOWLEDGEMENT_BUDGET_MS,
    ).toISOString();
    await controlEvents.emitEvents({
      flushImmediately: true,
      events: [
        event(
          input,
          'artifact.created',
          `control-pause-checkpoint-${pauseOperationKey?.slice(-12) ?? 'unkeyed'}`,
          {
            checkpointRef,
            kind: 'run_control_checkpoint',
          },
        ),
        event(input, 'run.paused', `control-paused-${pauseOperationKey?.slice(-12) ?? 'unkeyed'}`, {
          checkpointRef,
          control: {
            operationKey: pauseOperation,
            acknowledgementDeadlineAt: pauseAcknowledgementDeadlineAt,
          },
        }),
      ],
    });
    currentStatus = 'paused';
    currentPhase = 'paused';
    await condition(() => resumeRequested || cancelRequested);
    if (controlContinuation().cancelRequested) {
      return await completeCancellation(workspaceId, checkpointRef);
    }
    pauseRequested = false;
    pauseOperationKey = null;
    resumeRequested = false;
    const completedResumeOperationKey = resumeOperationKey;
    resumeOperationKey = null;
    const resumeOperation = OperationKeySchema.parse(completedResumeOperationKey);
    const resumeAcknowledgementDeadlineAt = new Date(
      Date.now() + CONTROL_ACKNOWLEDGEMENT_BUDGET_MS,
    ).toISOString();
    await controlEvents.emitEvents({
      flushImmediately: true,
      events: [
        event(
          input,
          'run.resumed',
          `control-resumed-${completedResumeOperationKey?.slice(-12) ?? 'unkeyed'}`,
          {
            checkpointRef,
            control: {
              operationKey: resumeOperation,
              acknowledgementDeadlineAt: resumeAcknowledgementDeadlineAt,
            },
          },
        ),
      ],
    });
    currentStatus = 'running';
    currentPhase = resumedPhase;
    return undefined;
  };

  const honorOrganizationCreditBoundary = async (
    workspaceId: string | null,
    resumedPhase: Exclude<RunControlStatus['phase'], 'paused' | 'terminal'>,
  ): Promise<RunWorkflowResult | undefined> => {
    if (!creditBalanceExhausted) return undefined;
    const episodeOperationKey = OperationKeySchema.parse(creditBalanceOperationKey);
    const immutableCeiling = immutableRunCeiling(input);
    const requested = await approvals.requestBudgetIncrease({
      runId: input.runId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      workspaceId,
      currentCeiling: immutableCeiling,
      absoluteCeiling: immutableCeiling,
      reason: 'organization_credit_exhausted',
      idempotencyKey: operationKey(input, `organization-credit-${episodeOperationKey.slice(-12)}`),
    });
    currentStatus = 'waiting_for_approval';
    await events.transitionRunStatus({
      runId: input.runId,
      status: 'waiting_for_approval',
      idempotencyKey: operationKey(
        input,
        `status-organization-credit-${episodeOperationKey.slice(-12)}`,
      ),
    });
    await events.emitEvents({
      events: [
        event(
          input,
          'conversation.card',
          `organization-credit-card-${episodeOperationKey.slice(-12)}`,
          {
            card: {
              version: 1,
              kind: 'approval',
              cardId: `card_${input.runId}:organization-credit:${episodeOperationKey.slice(-12)}`,
              approvalId: requested.approvalId,
              approvalKind: 'budget_increase',
            },
          },
        ),
        event(
          input,
          'approval.requested',
          `organization-credit-${episodeOperationKey.slice(-12)}`,
          {
            approvalId: requested.approvalId,
            type: 'budget_increase',
            reason: 'organization_credit_exhausted',
            absoluteCeiling: requested.absoluteCeiling,
          },
        ),
      ],
    });
    await condition(() => budgetResolutions.has(requested.approvalId) || cancelRequested);
    if (cancelRequested) {
      if (workspaceId !== null) return await completeCancellation(workspaceId);
      currentStatus = 'cancelled';
      currentPhase = 'terminal';
      const checkpointRef = `run:${input.runId}:organization-credit`;
      await events.transitionRunStatus({
        runId: input.runId,
        status: 'cancelled',
        idempotencyKey: operationKey(input, 'status-cancelled-before-workspace'),
      });
      return RunWorkflowResultSchema.parse({ status: 'cancelled', checkpointRef });
    }
    const resolution = budgetResolutions.get(requested.approvalId);
    if (resolution === undefined || resolution.reason !== 'organization_credit_exhausted')
      throw new Error('organization credit approval resolution does not match the request');
    await events.emitEvents({
      events: [
        event(
          input,
          'approval.resolved',
          `organization-credit-resolution-${episodeOperationKey.slice(-12)}`,
          {
            approvalId: requested.approvalId,
            decision: resolution.decision,
            reason: resolution.reason,
          },
        ),
      ],
    });
    if (resolution.decision === 'rejected') {
      const checkpointRef =
        workspaceId === null
          ? `run:${input.runId}:organization-credit`
          : (
              await approvals.checkpointBudgetStop({
                runId: input.runId,
                organizationId: input.organizationId,
                projectId: input.projectId,
                workspaceId,
                approvalId: requested.approvalId,
                idempotencyKey: operationKey(
                  input,
                  `organization-credit-stop-${episodeOperationKey.slice(-12)}`,
                ),
              })
            ).checkpointRef;
      await events.transitionRunStatus({
        runId: input.runId,
        status: 'cancelled',
        idempotencyKey: operationKey(
          input,
          `status-organization-credit-rejected-${episodeOperationKey.slice(-12)}`,
        ),
      });
      await events.emitEvents({
        events: [
          event(
            input,
            'run.cancelled',
            `organization-credit-rejected-${episodeOperationKey.slice(-12)}`,
            {
              reason: 'organization_credit_exhausted',
              checkpointRef,
            },
          ),
        ],
      });
      currentStatus = 'cancelled';
      currentPhase = 'terminal';
      return RunWorkflowResultSchema.parse({ status: 'cancelled', checkpointRef });
    }
    if (resolution.absoluteCeiling !== immutableCeiling) {
      throw new Error('organization credit approval changed the immutable run ceiling');
    }
    creditBalanceExhausted = false;
    creditBalanceOperationKey = null;
    currentStatus = 'running';
    currentPhase = resumedPhase;
    await events.transitionRunStatus({
      runId: input.runId,
      status: 'running',
      idempotencyKey: operationKey(
        input,
        `status-organization-credit-approved-${episodeOperationKey.slice(-12)}`,
      ),
    });
    return await honorOrganizationCreditBoundary(workspaceId, resumedPhase);
  };

  const honorNewWorkBoundary = async (
    workspaceId: string,
    resumedPhase: Exclude<RunControlStatus['phase'], 'paused' | 'terminal'>,
  ): Promise<RunWorkflowResult | undefined> => {
    const controlled = await honorControlBoundary(workspaceId, resumedPhase);
    if (controlled !== undefined) return controlled;
    return await honorOrganizationCreditBoundary(workspaceId, resumedPhase);
  };

  const budgetAttempt = input.budgetAttempt ?? 0;
  const sessionStep = input.sessionStep ?? 0;
  let lastEmittedAssistantTurn = input.lastEmittedAssistantTurn ?? 0;
  if (input.continuation === undefined) {
    const initialCreditResult = await honorOrganizationCreditBoundary(null, 'preparing');
    if (initialCreditResult !== undefined) return initialCreditResult;
    let workspaceId: string;
    try {
      const estimate =
        input.budget === null
          ? undefined
          : await approvals.estimateRunCost({
              runId: input.runId,
              organizationId: input.organizationId,
              projectId: input.projectId,
              mode: input.mode,
              prompt: input.prompt,
              maxCredits: input.budget.maxCredits,
              idempotencyKey: operationKey(input, 'estimate-run-cost'),
            });
      await events.transitionRunStatus({
        runId: input.runId,
        status: 'running',
        idempotencyKey: operationKey(input, 'status-running'),
      });
      const startingEvents: PendingAgentEvent[] = [
        event(input, 'run.started', 'run-started', {
          mode: input.mode,
          appType: input.appType,
          model: input.model,
          ...(estimate === undefined
            ? {}
            : {
                estimatedCredits: estimate.estimatedCredits,
                maxCredits: input.budget?.maxCredits,
              }),
        }),
      ];
      if (!lightweightBuild) {
        startingEvents.push(
          event(input, 'phase.created', 'phase-created', {
            phase: 'm1-chat',
            name: 'Conversation',
          }),
          event(input, 'phase.started', 'phase-started', {
            phase: 'm1-chat',
          }),
        );
      }
      startingEvents.push(
        event(
          input,
          'message.user',
          'message-user-initial',
          MessageUserPayloadSchema.parse({
            messageId: opaqueConversationId('msg', input, 1),
            content: input.prompt,
            attachments: [],
            source: 'api',
          }),
        ),
      );
      await events.emitEvents({ events: startingEvents });

      const workspaceCreditResult = await honorOrganizationCreditBoundary(null, 'preparing');
      if (workspaceCreditResult !== undefined) return workspaceCreditResult;
      const ensured = await workspace.ensureWorkspace({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        branchId: input.branchId,
        appType: input.appType,
        idempotencyKey: operationKey(input, 'ensure-workspace'),
      });
      workspaceId = ensured.workspaceId;
      currentWorkspaceId = workspaceId;
    } catch (error: unknown) {
      await events.transitionRunStatus({
        runId: input.runId,
        status: 'failed',
        idempotencyKey: operationKey(input, 'status-failed'),
      });
      throw error;
    }
    const controlResult = await honorNewWorkBoundary(workspaceId, 'session');
    if (controlResult !== undefined) return controlResult;
    return continueAsNew<typeof runWorkflow>({
      ...input,
      continuation: lightweightBuild
        ? { phase: 'build_plan', workspaceId }
        : { phase: 'session', workspaceId },
      budgetAttempt,
      sessionStep,
      lastEmittedAssistantTurn,
      control: controlContinuation(),
    });
  }

  if (input.continuation.phase === 'build_plan') {
    const { workspaceId } = input.continuation;
    currentPhase = 'session';
    const prePlanControlResult = await honorNewWorkBoundary(workspaceId, 'session');
    if (prePlanControlResult !== undefined) return prePlanControlResult;
    try {
      const planScope = new CancellationScope();
      activeScope = planScope;
      let produced: z.infer<typeof ProducePlanResultSchema>;
      try {
        produced = ProducePlanResultSchema.parse(
          await planScope.run(
            async () =>
              await buildActivities.producePlan(
                ProducePlanInputSchema.parse({
                  runId: input.runId,
                  organizationId: input.organizationId,
                  projectId: input.projectId,
                  specificationVersionId: `run-intent:${input.runId}`,
                  prompt: input.prompt,
                  idempotencyKey: operationKey(input, 'build-plan-produce'),
                }),
              ),
          ),
        );
      } catch (error: unknown) {
        if (cancelRequested && isCancellation(error)) {
          return await CancellationScope.nonCancellable(
            async () => await completeCancellation(workspaceId),
          );
        }
        throw error;
      } finally {
        activeScope = undefined;
      }
      const plan = BuildModePlanSchema.parse(produced.plan);
      const postProduceControlResult = await honorNewWorkBoundary(workspaceId, 'session');
      if (postProduceControlResult !== undefined) return postProduceControlResult;
      const phase = plan.phases[0];
      if (phase === undefined) throw new Error('build_plan_phase_missing');
      const allocatedCredits = plan.tasks.reduce(
        (sum, task) => sum + Math.max(1, task.estimate.credits),
        0,
      );
      const availableCredits = Math.min(
        plan.budget.credits,
        input.budget?.maxCredits ?? plan.budget.credits,
      );
      if (allocatedCredits > availableCredits) {
        throw ApplicationFailure.nonRetryable(
          'Build plan task budgets exceed the available run budget',
          'build_plan_budget_exceeded',
        );
      }
      const assessmentScope = new CancellationScope();
      activeScope = assessmentScope;
      let assessment: BuildModeApprovalAssessment;
      try {
        assessment = BuildModeApprovalAssessmentSchema.parse(
          await assessmentScope.run(
            async () =>
              await buildActivities.assessBuildPlanApproval(
                AssessBuildPlanApprovalInputSchema.parse({
                  runId: input.runId,
                  organizationId: input.organizationId,
                  projectId: input.projectId,
                  planArtifactId: produced.planArtifactId,
                  config: BUILD_MODE_APPROVAL_CONFIG,
                  idempotencyKey: operationKey(input, 'build-plan-assess-approval'),
                }),
              ),
          ),
        );
      } catch (error: unknown) {
        if (cancelRequested && isCancellation(error)) {
          return await CancellationScope.nonCancellable(
            async () => await completeCancellation(workspaceId),
          );
        }
        throw error;
      } finally {
        activeScope = undefined;
      }
      const autoApproved = shouldAutoApproveBuildPlan(assessment, BUILD_MODE_APPROVAL_CONFIG);
      await events.emitEvents({
        events: [
          event(
            input,
            'phase.created',
            'build-phase-created',
            {
              phaseId: phase.id,
              name: phase.title,
            },
            { phaseId: phase.id },
          ),
          event(
            input,
            'phase.started',
            'build-phase-started',
            { phaseId: phase.id },
            { phaseId: phase.id },
          ),
          event(input, 'artifact.created', 'build-plan-created', {
            artifactId: produced.planArtifactId,
            artifactType: 'implementation_plan',
            phases: plan.phases.map((planPhase) => ({
              phaseId: planPhase.id,
              optional: planPhase.optional,
            })),
            phaseCount: 1,
            taskCount: plan.tasks.length,
            plannedDiffFiles: assessment.diffFiles,
            risk: assessment.risk,
            approvalAssessmentSource: assessment.source,
          }),
        ],
      });

      let approvalOperationKey = input.operationKey;
      if (!autoApproved) {
        const requestedApproval = await runApprovals.requestRunApproval({
          runId: input.runId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          kind: 'plan',
          artifactId: produced.planArtifactId,
          artifactVersion: null,
          idempotencyKey: operationKey(input, 'build-plan-approval-request'),
        });
        currentStatus = 'waiting_for_approval';
        await events.transitionRunStatus({
          runId: input.runId,
          status: 'waiting_for_approval',
          idempotencyKey: operationKey(input, 'status-waiting-build-plan'),
        });
        await events.emitEvents({
          events: [
            event(input, 'conversation.card', 'build-plan-card', {
              card: {
                version: 1,
                kind: 'plan',
                cardId: `card_${input.runId}:build-plan`,
                approvalId: requestedApproval.approvalId,
                artifactId: produced.planArtifactId,
                approvalKind: 'plan',
              },
            }),
            event(input, 'approval.requested', 'build-plan-approval-requested', {
              gate: 'build_plan',
              approvalId: requestedApproval.approvalId,
              type: 'plan',
              status: 'pending',
              request: { artifactId: produced.planArtifactId },
              artifactId: produced.planArtifactId,
              plannedDiffFiles: assessment.diffFiles,
              risk: assessment.risk,
              approvalAssessmentSource: assessment.source,
              threshold: BUILD_MODE_APPROVAL_CONFIG,
            }),
          ],
        });
        await condition(() => {
          const resolution = buildPlanResolutions.get(produced.planArtifactId);
          return (
            (resolution !== undefined &&
              (resolution.approvalId === undefined ||
                resolution.approvalId === requestedApproval.approvalId) &&
              (resolution.approvalKind === undefined || resolution.approvalKind === 'plan')) ||
            cancelRequested
          );
        });
        if (cancelRequested) return await completeCancellation(workspaceId);
        const resolution = buildPlanResolutions.get(produced.planArtifactId);
        if (
          resolution === undefined ||
          (resolution.approvalId !== undefined &&
            resolution.approvalId !== requestedApproval.approvalId) ||
          (resolution.approvalKind !== undefined && resolution.approvalKind !== 'plan')
        )
          throw new Error('build_plan_approval_disappeared');
        await events.emitEvents({
          events: [
            event(input, 'approval.resolved', 'build-plan-approval-resolved', {
              gate: 'build_plan',
              approvalId: requestedApproval.approvalId,
              approvalKind: 'plan',
              artifactId: produced.planArtifactId,
              decision: resolution.decision,
              resolution: 'human',
            }),
          ],
        });
        if (resolution.decision === 'rejected') {
          currentStatus = 'cancelled';
          currentPhase = 'terminal';
          await events.transitionRunStatus({
            runId: input.runId,
            status: 'cancelled',
            idempotencyKey: operationKey(input, 'status-build-plan-rejected'),
          });
          await events.emitEvents({
            events: [
              event(input, 'run.cancelled', 'build-plan-rejected', {
                reason: 'build_plan_rejected',
                artifactId: produced.planArtifactId,
              }),
            ],
          });
          return RunWorkflowResultSchema.parse({
            status: 'cancelled',
            checkpointRef: `plan:${produced.planArtifactId}`,
          });
        }
        approvalOperationKey = resolution.operationKey;
        currentStatus = 'running';
        await events.transitionRunStatus({
          runId: input.runId,
          status: 'running',
          idempotencyKey: operationKey(input, 'status-build-plan-approved'),
        });
      } else {
        await events.emitEvents({
          events: [
            event(input, 'approval.resolved', 'build-plan-auto-approved', {
              gate: 'build_plan',
              artifactId: produced.planArtifactId,
              decision: 'approved',
              resolution: 'policy_auto',
              threshold: BUILD_MODE_APPROVAL_CONFIG,
            }),
          ],
        });
      }

      const approvalScope = new CancellationScope();
      activeScope = approvalScope;
      let approved: z.infer<typeof ApprovePlanResultSchema>;
      try {
        approved = ApprovePlanResultSchema.parse(
          await approvalScope.run(
            async () =>
              await buildActivities.approvePlan(
                ApprovePlanInputSchema.parse({
                  runId: input.runId,
                  organizationId: input.organizationId,
                  projectId: input.projectId,
                  planArtifactId: produced.planArtifactId,
                  approvalOperationKey,
                  idempotencyKey: operationKey(input, 'build-plan-approve'),
                }),
              ),
          ),
        );
      } catch (error: unknown) {
        if (cancelRequested && isCancellation(error)) {
          return await CancellationScope.nonCancellable(
            async () => await completeCancellation(workspaceId),
          );
        }
        throw error;
      } finally {
        activeScope = undefined;
      }
      if (approved.planArtifactId !== produced.planArtifactId) {
        throw ApplicationFailure.nonRetryable(
          'Build plan approval identity mismatch',
          'build_plan_approval_identity_mismatch',
        );
      }
      const postPlanControlResult = await honorNewWorkBoundary(workspaceId, 'session');
      if (postPlanControlResult !== undefined) return postPlanControlResult;
      return await continueAsNew<typeof runWorkflow>({
        ...input,
        continuation: {
          phase: 'build_execute',
          workspaceId,
          planArtifactId: approved.planArtifactId,
          plan,
        },
        budgetAttempt,
        sessionStep,
        lastEmittedAssistantTurn,
        control: controlContinuation(),
      });
    } catch (error: unknown) {
      currentStatus = 'failed';
      currentPhase = 'terminal';
      await events.transitionRunStatus({
        runId: input.runId,
        status: 'failed',
        idempotencyKey: operationKey(input, 'status-failed'),
      });
      throw error;
    }
  }

  if (input.continuation.phase === 'build_execute') {
    const { workspaceId } = input.continuation;
    let { planArtifactId, plan } = input.continuation;
    let taskCommits = [...input.continuation.taskCommits];
    currentPhase = 'session';
    let phase = plan.phases[0];
    if (phase === undefined) throw new Error('build_plan_phase_missing');
    try {
      while (pendingRedirects.length > 0) {
        const redirectCreditResult = await honorOrganizationCreditBoundary(workspaceId, 'session');
        if (redirectCreditResult !== undefined) return redirectCreditResult;
        const pending = pendingRedirects[0];
        if (pending === undefined) break;
        const redirectPhaseId = phase.id;
        const completedTaskIds = new Set(taskCommits.map(({ taskId }) => taskId));
        const hooks: RedirectPlanChangeHooks<RunWorkflowResult> = {
          async emit(type, suffix, payload, taskId) {
            await events.emitEvents({
              events: [
                event(
                  input,
                  type,
                  `build-redirect:${suffix}`,
                  payload,
                  taskId === undefined
                    ? { phaseId: redirectPhaseId }
                    : { phaseId: redirectPhaseId, taskId },
                ),
              ],
            });
          },
          async transitionRunStatus(status, suffix) {
            currentStatus = status;
            await events.transitionRunStatus({
              runId: input.runId,
              status,
              idempotencyKey: operationKey(input, `build-redirect:${suffix}`),
            });
          },
          async beforePaidBoundary() {
            return await honorOrganizationCreditBoundary(workspaceId, 'session');
          },
          async requestApproval(artifactId) {
            return await runApprovals.requestRunApproval({
              runId: input.runId,
              organizationId: input.organizationId,
              projectId: input.projectId,
              kind: 'plan_diff',
              artifactId,
              artifactVersion: null,
              idempotencyKey: operationKey(
                input,
                `build-redirect-approval:${pending.operationKey.slice(-12)}`,
              ),
            });
          },
          approvalFor(artifactId) {
            return buildPlanResolutions.get(artifactId);
          },
          cancellationRequested() {
            return cancelRequested;
          },
        };
        const redirected = await processRedirectPlanChange(
          {
            runId: input.runId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            currentPlanArtifactId: planArtifactId,
            currentPlan: plan,
            redirect: {
              instruction: pending.instruction,
              operationKey: pending.operationKey,
            },
            directAffectedTaskIds: plan.tasks
              .filter(({ id }) => !completedTaskIds.has(id))
              .map(({ id }) => id),
            completedTaskIds: [...completedTaskIds],
          },
          hooks,
        );
        if (redirected.status === 'controlled') return redirected.result;
        if (redirected.status === 'cancelled') {
          return await completeCancellation(workspaceId);
        }
        pendingRedirects.shift();
        if (redirected.status === 'applied') {
          planArtifactId = workflowIdSchema('art').parse(redirected.planArtifactId);
          plan = BuildModePlanSchema.parse(redirected.plan);
          const activeTaskIds = new Set(plan.tasks.map(({ id }) => id));
          taskCommits = taskCommits.filter(({ taskId }) => activeTaskIds.has(taskId));
          const allocatedCredits = plan.tasks.reduce(
            (sum, task) => sum + Math.max(1, task.estimate.credits),
            0,
          );
          const availableCredits = Math.min(
            plan.budget.credits,
            input.budget?.maxCredits ?? plan.budget.credits,
          );
          if (allocatedCredits > availableCredits) {
            throw ApplicationFailure.nonRetryable(
              'Redirected Build plan exceeds the approved run budget',
              'build_redirect_budget_exceeded',
            );
          }
          phase = plan.phases[0];
          if (phase === undefined) throw new Error('build_plan_phase_missing');
        }
      }

      while (pendingSkips.length > 0) {
        const request = pendingSkips.shift();
        if (request === undefined) break;
        const eligibility = skipOptionalPhaseEligibility(plan, request.phaseId, startedTaskIds, []);
        await events.emitEvents({
          events: [
            event(
              input,
              'task.updated',
              `build-skip:${request.operationKey}`,
              {
                control: 'skip_optional_phase',
                outcome: 'rejected',
                reason: eligibility.reason,
                operationKey: request.operationKey,
                phaseId: request.phaseId,
              },
              { phaseId: phase.id },
            ),
          ],
        });
      }

      const preExecuteControlResult = await honorNewWorkBoundary(workspaceId, 'session');
      if (preExecuteControlResult !== undefined) return preExecuteControlResult;
      const taskCommitById = new Map(
        taskCommits.map(({ taskId, commitSha }) => [taskId, commitSha]),
      );
      if (taskCommitById.size !== taskCommits.length) {
        throw ApplicationFailure.nonRetryable(
          'Build execution continuation contains duplicate task commits',
          'build_task_commit_duplicate',
        );
      }
      const incomplete = plan.tasks.filter(({ id }) => !taskCommitById.has(id));
      if (incomplete.length === 0) {
        const completedTaskIds = plan.tasks.map(({ id }) => id);
        const head = ResolveIntegrationHeadResultSchema.parse(
          await buildActivities.resolveIntegrationHead(
            ResolveIntegrationHeadInputSchema.parse({
              runId: input.runId,
              organizationId: input.organizationId,
              projectId: input.projectId,
              phaseId: phase.id,
              integrationBranch: `run/${input.runId}`,
              completedTaskIds,
              idempotencyKey: operationKey(input, 'build-integration-head'),
            }),
          ),
        );
        if (pendingRedirects.length > 0) {
          return await continueAsNew<typeof runWorkflow>({
            ...input,
            continuation: {
              phase: 'build_execute',
              workspaceId,
              planArtifactId,
              plan,
              taskCommits,
            },
            budgetAttempt,
            sessionStep,
            lastEmittedAssistantTurn,
            control: controlContinuation(),
          });
        }
        const postExecuteControlResult = await honorNewWorkBoundary(workspaceId, 'commit');
        if (postExecuteControlResult !== undefined) return postExecuteControlResult;
        return await continueAsNew<typeof runWorkflow>({
          ...input,
          continuation: {
            phase: 'build_verify',
            workspaceId,
            planArtifactId,
            plan,
            commitSha: head.commitSha,
            taskCommits,
          },
          budgetAttempt,
          sessionStep,
          lastEmittedAssistantTurn,
          control: controlContinuation(),
        });
      }
      const nextTask = incomplete.find((task) =>
        task.dependsOn.every((dependencyId) => taskCommitById.has(dependencyId)),
      );
      if (nextTask === undefined) {
        throw ApplicationFailure.nonRetryable(
          'Redirected Build task graph cannot make progress',
          'build_redirect_task_graph_blocked',
        );
      }
      await events.emitEvents({
        events: [
          event(
            input,
            'task.created',
            `build-task-${nextTask.id}-created`,
            {
              phaseId: phase.id,
              taskId: nextTask.id,
              title: nextTask.title,
              acceptanceCriteriaIds: nextTask.acceptanceCriteriaIds,
            },
            { phaseId: phase.id, taskId: nextTask.id },
          ),
        ],
      });
      const preChildCreditResult = await honorNewWorkBoundary(workspaceId, 'session');
      if (preChildCreditResult !== undefined) return preChildCreditResult;
      if (!startedTaskIds.includes(nextTask.id)) startedTaskIds.push(nextTask.id);
      const attempt = taskAttempts[nextTask.id] ?? 0;
      const taskScope = new CancellationScope();
      activeScope = taskScope;
      let result: z.infer<typeof TaskWorkflowResultSchema>;
      try {
        const results = z
          .array(TaskWorkflowResultSchema)
          .length(1)
          .parse(
            await taskScope.run(
              async () =>
                await executeChild(runTaskBatchWorkflow, {
                  workflowId: `build:${input.runId}:${planArtifactId}:${nextTask.id}:attempt:${String(attempt)}`,
                  args: [
                    {
                      runId: input.runId,
                      maxConcurrency: 1,
                      tasks: [
                        {
                          runId: input.runId,
                          organizationId: input.organizationId,
                          projectId: input.projectId,
                          taskId: nextTask.id,
                          mode: 'build' as const,
                          model: input.model,
                          prompt: buildTaskPrompt(input, planArtifactId, nextTask),
                          budget: { maxCredits: Math.max(1, nextTask.estimate.credits) },
                          attempt,
                        },
                      ],
                    },
                  ],
                }),
            ),
          );
        const onlyResult = results[0];
        if (onlyResult === undefined) throw new Error('build_task_result_missing');
        result = onlyResult;
      } catch (error: unknown) {
        if (cancelRequested && isCancellation(error)) {
          return await CancellationScope.nonCancellable(
            async () => await completeCancellation(workspaceId),
          );
        }
        throw error;
      } finally {
        activeScope = undefined;
      }
      if (result.status === 'blocked') {
        await buildActivities.transitionPhaseTasks(
          TransitionPhaseTasksInputSchema.parse({
            runId: input.runId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            phaseId: phase.id,
            taskIds: plan.tasks.map(({ id }) => id),
            status: 'failed',
            idempotencyKey: operationKey(input, `build-task-blocked:${result.taskId}`),
          }),
        );
        throw ApplicationFailure.nonRetryable(
          `Build task blocked by merge conflict: ${result.taskId}`,
          'build_task_blocked',
        );
      }
      if (result.status === 'failed') {
        if (!failedTaskIds.includes(result.taskId)) failedTaskIds.push(result.taskId);
        for (;;) {
          const requestIndex = pendingRetries.findIndex(({ taskId }) => taskId === result.taskId);
          if (requestIndex < 0) {
            await condition(
              () =>
                pendingRetries.some(({ taskId }) => taskId === result.taskId) || cancelRequested,
            );
            if (cancelRequested) return await completeCancellation(workspaceId);
            continue;
          }
          const request = pendingRetries.splice(requestIndex, 1)[0];
          if (request === undefined) continue;
          const eligibility = retryFailedTaskEligibility(
            plan,
            result.taskId,
            failedTaskIds,
            taskCommits.map(({ taskId }) => taskId),
          );
          await events.emitEvents({
            events: [
              event(
                input,
                'task.updated',
                `build-retry:${request.operationKey}`,
                {
                  control: 'retry_failed_task',
                  outcome: eligibility.accepted ? 'accepted' : 'rejected',
                  reason: eligibility.reason,
                  operationKey: request.operationKey,
                  taskId: result.taskId,
                },
                { phaseId: phase.id, taskId: result.taskId },
              ),
            ],
          });
          if (!eligibility.accepted) continue;
          failedTaskIds = failedTaskIds.filter((taskId) => taskId !== result.taskId);
          taskAttempts[result.taskId] = attempt + 1;
          return await continueAsNew<typeof runWorkflow>({
            ...input,
            continuation: {
              phase: 'build_execute',
              workspaceId,
              planArtifactId,
              plan,
              taskCommits,
            },
            budgetAttempt,
            sessionStep,
            lastEmittedAssistantTurn,
            control: controlContinuation(),
          });
        }
      }
      taskCommits.push({ taskId: result.taskId, commitSha: result.commitSha });
      return await continueAsNew<typeof runWorkflow>({
        ...input,
        continuation: {
          phase: 'build_execute',
          workspaceId,
          planArtifactId,
          plan,
          taskCommits,
        },
        budgetAttempt,
        sessionStep,
        lastEmittedAssistantTurn,
        control: controlContinuation(),
      });
    } catch (error: unknown) {
      currentStatus = 'failed';
      currentPhase = 'terminal';
      await events.transitionRunStatus({
        runId: input.runId,
        status: 'failed',
        idempotencyKey: operationKey(input, 'status-failed'),
      });
      throw error;
    }
  }

  if (input.continuation.phase === 'build_verify') {
    const { workspaceId, plan, commitSha, taskCommits } = input.continuation;
    if (pendingRedirects.length > 0) {
      return await continueAsNew<typeof runWorkflow>({
        ...input,
        continuation: {
          phase: 'build_execute',
          workspaceId,
          planArtifactId: input.continuation.planArtifactId,
          plan,
          taskCommits,
        },
        budgetAttempt,
        sessionStep,
        lastEmittedAssistantTurn,
        control: controlContinuation(),
      });
    }
    currentPhase = 'commit';
    const phase = plan.phases[0];
    if (phase === undefined) throw new Error('build_plan_phase_missing');
    const taskIds = plan.tasks.map(({ id }) => id);
    const taskCommitById = new Map(taskCommits.map(({ taskId, commitSha }) => [taskId, commitSha]));
    if (
      taskCommitById.size !== taskCommits.length ||
      taskIds.some((taskId) => taskCommitById.get(taskId) === undefined) ||
      taskCommitById.size !== taskIds.length
    ) {
      throw ApplicationFailure.nonRetryable(
        'Build verification continuation does not match the approved task set',
        'build_task_commit_provenance_mismatch',
      );
    }
    const preVerifyControlResult = await honorNewWorkBoundary(workspaceId, 'commit');
    if (preVerifyControlResult !== undefined) return preVerifyControlResult;
    try {
      const verificationScope = new CancellationScope();
      activeScope = verificationScope;
      let verification: z.infer<typeof BuildPhaseVerificationResultSchema>;
      try {
        verification = BuildPhaseVerificationResultSchema.parse(
          await verificationScope.run(
            async () =>
              await buildVerificationActivities.verifyPhase(input.runId, phase.id, commitSha),
          ),
        );
      } catch (error: unknown) {
        if (cancelRequested && isCancellation(error)) {
          return await CancellationScope.nonCancellable(
            async () => await completeCancellation(workspaceId),
          );
        }
        throw error;
      } finally {
        activeScope = undefined;
      }
      if (pendingRedirects.length > 0) {
        return await continueAsNew<typeof runWorkflow>({
          ...input,
          continuation: {
            phase: 'build_execute',
            workspaceId,
            planArtifactId: input.continuation.planArtifactId,
            plan,
            taskCommits,
          },
          budgetAttempt,
          sessionStep,
          lastEmittedAssistantTurn,
          control: controlContinuation(),
        });
      }
      await events.emitEvents({
        events: [
          event(
            input,
            'verification.completed',
            'build-verification-completed',
            {
              phaseId: phase.id,
              commitSha,
              verificationResultId: verification.verificationResultId,
              decision: verification.decision,
            },
            { phaseId: phase.id },
          ),
        ],
      });
      if (verification.decision !== 'approved') {
        await buildActivities.transitionPhaseTasks(
          TransitionPhaseTasksInputSchema.parse({
            runId: input.runId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            phaseId: phase.id,
            taskIds,
            status: 'failed',
            idempotencyKey: operationKey(input, 'build-tasks-verification-failed'),
          }),
        );
        throw ApplicationFailure.nonRetryable(
          `Build verification did not approve the commit: ${verification.decision}`,
          'build_verification_not_approved',
        );
      }
      await buildActivities.transitionPhaseTasks(
        TransitionPhaseTasksInputSchema.parse({
          runId: input.runId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          phaseId: phase.id,
          taskIds,
          status: 'passed',
          idempotencyKey: operationKey(input, 'build-tasks-passed'),
        }),
      );
      await events.emitEvents({
        events: [
          ...plan.tasks.map((task) =>
            event(
              input,
              'task.completed',
              `build-task-${task.id}-completed`,
              {
                phaseId: phase.id,
                taskId: task.id,
                commitSha: taskCommitById.get(task.id),
                verificationResultId: verification.verificationResultId,
              },
              { phaseId: phase.id, taskId: task.id },
            ),
          ),
          event(
            input,
            'phase.completed',
            'build-phase-completed',
            {
              phaseId: phase.id,
              commitSha,
            },
            { phaseId: phase.id },
          ),
          event(input, 'run.completed', 'run-completed', { status: 'completed', commitSha }),
        ],
      });
      await events.transitionRunStatus({
        runId: input.runId,
        status: 'completed',
        idempotencyKey: operationKey(input, 'status-completed'),
      });
      currentStatus = 'completed';
      currentPhase = 'terminal';
      return RunWorkflowResultSchema.parse({ status: 'completed', commitSha });
    } catch (error: unknown) {
      currentStatus = 'failed';
      currentPhase = 'terminal';
      await events.transitionRunStatus({
        runId: input.runId,
        status: 'failed',
        idempotencyKey: operationKey(input, 'status-failed'),
      });
      throw error;
    }
  }

  if (input.continuation.phase === 'session') {
    const sessionWorkspaceId = input.continuation.workspaceId;
    let approvedMaxCredits: number | undefined;
    let continueSession = false;
    try {
      const guardrails = runModeGuardrails(input.mode);
      await events.emitEvents({
        events: [
          event(input, 'agent.started', `agent-started-${String(sessionStep)}`, {
            agent: 'builder',
          }),
        ],
      });
      const preSessionControlResult = await honorNewWorkBoundary(sessionWorkspaceId, 'session');
      if (preSessionControlResult !== undefined) return preSessionControlResult;
      const sessionScope = new CancellationScope();
      activeScope = sessionScope;
      let sessionResult: Awaited<ReturnType<SessionActivities['runBuilderSession']>>;
      try {
        sessionResult = await sessionScope.run(
          async () =>
            await session.runBuilderSession({
              runId: input.runId,
              organizationId: input.organizationId,
              projectId: input.projectId,
              workspaceId: sessionWorkspaceId,
              mode: input.mode,
              model: input.model,
              prompt: input.prompt,
              allowedTools: [...guardrails.allowedTools],
              modeInstructions: guardrails.modeInstructions,
              budget: input.budget,
              control: {
                // The Temporal activity heartbeat owns the durable transcript for the
                // lifetime of this session. Starting a new activity after every tool
                // would discard that checkpoint and replay the first model turn.
                yieldAfterTool: false,
                redirect:
                  pendingRedirects[0] === undefined
                    ? null
                    : {
                        operationKey: pendingRedirects[0].operationKey,
                        instruction: pendingRedirects[0].instruction,
                      },
                ...(pendingMessages[0] === undefined
                  ? {}
                  : {
                      message: {
                        operationKey: pendingMessages[0].operationKey,
                        ...pendingMessages[0].message,
                      },
                    }),
              },
              idempotencyKey: operationKey(
                input,
                `builder-session-${String(budgetAttempt)}-${String(sessionStep)}`,
              ),
            }),
        );
      } catch (error: unknown) {
        if (cancelRequested && isCancellation(error)) {
          return await CancellationScope.nonCancellable(
            async () => await completeCancellation(sessionWorkspaceId),
          );
        }
        throw error;
      } finally {
        activeScope = undefined;
      }
      const controlResult = await honorNewWorkBoundary(sessionWorkspaceId, 'session');
      if (controlResult !== undefined) return controlResult;
      if (sessionResult.redirectApplied === true) pendingRedirects.shift();
      if (sessionResult.messageApplied === true) pendingMessages.shift();
      const assistantTurn = sessionResult.turn ?? sessionStep + 1;
      if (
        (sessionResult.status === 'completed' ||
          sessionResult.status === 'yielded' ||
          sessionResult.status === 'failed' ||
          sessionResult.status === 'budget_exhausted') &&
        assistantTurn > lastEmittedAssistantTurn
      ) {
        const model = sessionResult.model ?? input.model ?? 'policy/default';
        await emitAssistantMessage(input, assistantTurn, sessionResult.summary, model);
        lastEmittedAssistantTurn = assistantTurn;
      }
      switch (sessionResult.status) {
        case 'completed':
          break;
        case 'yielded':
          continueSession = true;
          break;
        case 'budget_exhausted': {
          if (
            sessionResult.errorCode !== undefined &&
            sessionResult.errorCode !== 'credit_budget_exhausted' &&
            sessionResult.errorCode !== 'budget_exceeded'
          ) {
            throw ApplicationFailure.nonRetryable(
              `Builder session exhausted its ${sessionResult.errorCode} limit`,
              `builder_session_${sessionResult.errorCode}`,
            );
          }
          if (input.budget === null) throw new Error('builder_session_budget_exhausted');
          const currentCeiling = `${String(input.budget.maxCredits)}.0000`;
          const requested = await approvals.requestBudgetIncrease({
            runId: input.runId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            workspaceId: input.continuation.workspaceId,
            currentCeiling,
            absoluteCeiling: nextRunCreditCeiling(input.budget.maxCredits, input.planMaxCredits),
            reason: 'run_budget_exhausted',
            idempotencyKey: operationKey(input, `budget-increase-${String(budgetAttempt)}`),
          });
          currentStatus = 'waiting_for_approval';
          await events.transitionRunStatus({
            runId: input.runId,
            status: 'waiting_for_approval',
            idempotencyKey: operationKey(
              input,
              `status-waiting-for-approval-${String(budgetAttempt)}`,
            ),
          });
          await events.emitEvents({
            events: [
              event(input, 'conversation.card', `budget-card-${String(budgetAttempt)}`, {
                card: {
                  version: 1,
                  kind: 'approval',
                  cardId: `card_${input.runId}:budget:${String(budgetAttempt)}`,
                  approvalId: requested.approvalId,
                  approvalKind: 'budget_increase',
                },
              }),
              event(input, 'approval.requested', `budget-approval-${String(budgetAttempt)}`, {
                approvalId: requested.approvalId,
                type: 'budget_increase',
                absoluteCeiling: requested.absoluteCeiling,
              }),
            ],
          });
          await condition(() => budgetResolutions.has(requested.approvalId) || cancelRequested);
          if (cancelRequested) return await completeCancellation(sessionWorkspaceId);
          const resolution = budgetResolutions.get(requested.approvalId);
          if (resolution === undefined) throw new Error('budget approval resolution disappeared');
          if (resolution.reason !== 'run_budget_exhausted') {
            throw new Error('budget approval resolution reason does not match the request');
          }
          await events.emitEvents({
            events: [
              event(input, 'approval.resolved', `budget-resolution-${String(budgetAttempt)}`, {
                approvalId: requested.approvalId,
                decision: resolution.decision,
              }),
            ],
          });
          if (resolution.decision === 'rejected') {
            const checkpoint = await approvals.checkpointBudgetStop({
              runId: input.runId,
              organizationId: input.organizationId,
              projectId: input.projectId,
              workspaceId: input.continuation.workspaceId,
              approvalId: requested.approvalId,
              idempotencyKey: operationKey(
                input,
                `budget-stop-checkpoint-${String(budgetAttempt)}`,
              ),
            });
            await events.emitEvents({
              events: [
                event(input, 'artifact.created', `budget-checkpoint-${String(budgetAttempt)}`, {
                  checkpointRef: checkpoint.checkpointRef,
                }),
                event(input, 'run.cancelled', `budget-cancelled-${String(budgetAttempt)}`, {
                  reason: 'budget_increase_rejected',
                }),
              ],
            });
            await events.transitionRunStatus({
              runId: input.runId,
              status: 'cancelled',
              idempotencyKey: operationKey(input, 'status-cancelled'),
            });
            return RunWorkflowResultSchema.parse({
              status: 'cancelled',
              checkpointRef: checkpoint.checkpointRef,
            });
          }
          if (resolution.absoluteCeiling !== requested.absoluteCeiling) {
            throw new Error('approved budget ceiling does not match the requested ceiling');
          }
          approvedMaxCredits = Number.parseInt(resolution.absoluteCeiling, 10);
          currentStatus = 'running';
          await events.transitionRunStatus({
            runId: input.runId,
            status: 'running',
            idempotencyKey: operationKey(input, `status-budget-resumed-${String(budgetAttempt)}`),
          });
          break;
        }
        case 'needs_approval':
        case 'failed':
        case 'cancelled':
          throw ApplicationFailure.nonRetryable(
            `Builder session ended with terminal status: ${sessionResult.status}`,
            `builder_session_${sessionResult.status}`,
          );
      }
      if (pendingRedirects.length > 0) {
        continueSession = true;
      }
      if (pendingMessages.length > 0) {
        continueSession = true;
      }
      if (!continueSession && input.mode === 'ask') {
        const completedEvents: PendingAgentEvent[] = [
          event(input, 'agent.completed', 'agent-completed', { agent: 'builder' }),
        ];
        if (askAnswerNeedsCitation(sessionResult.summary)) {
          completedEvents.push(
            event(input, 'verification.completed', 'ask-citation-warning', {
              code: 'ask_citation_required',
              severity: 'warning',
            }),
          );
        }
        completedEvents.push(
          event(input, 'phase.completed', 'phase-completed', { phase: 'm1-chat' }),
        );
        completedEvents.push(
          event(input, 'run.completed', 'run-completed', { status: 'completed' }),
        );
        await events.emitEvents({ events: completedEvents });
        await events.transitionRunStatus({
          runId: input.runId,
          status: 'completed',
          idempotencyKey: operationKey(input, 'status-completed'),
        });
        return RunWorkflowResultSchema.parse({ status: 'completed', commitSha: null });
      }
      if (!continueSession && input.mode === 'prototype') {
        const completedTools = new Set(sessionResult.completedTools ?? []);
        if (
          !completedTools.has('run_dev_server') ||
          !completedTools.has('run_preview_smoke_test')
        ) {
          throw ApplicationFailure.nonRetryable(
            'prototype_preview_gate_incomplete',
            'prototype_preview_gate_incomplete',
          );
        }
        const mocks = z
          .array(PrototypeMockSchema)
          .max(100)
          .parse(sessionResult.mocks ?? []);
        if (mocks.length > 0) {
          await events.emitEvents({
            events: [
              event(input, 'artifact.created', 'prototype-assumptions', {
                kind: 'prototype_assumptions',
                mocks,
              }),
            ],
          });
        }
      }
    } catch (error: unknown) {
      await events.transitionRunStatus({
        runId: input.runId,
        status: 'failed',
        idempotencyKey: operationKey(input, 'status-failed'),
      });
      throw error;
    }
    if (continueSession) {
      return continueAsNew<typeof runWorkflow>({
        ...input,
        ...(approvedMaxCredits === undefined
          ? {}
          : { budget: { maxCredits: approvedMaxCredits }, budgetAttempt: budgetAttempt + 1 }),
        sessionStep: sessionStep + 1,
        lastEmittedAssistantTurn,
        continuation: {
          phase: 'session',
          workspaceId: input.continuation.workspaceId,
        },
        control: controlContinuation(),
      });
    }
    if (approvedMaxCredits !== undefined) {
      return continueAsNew<typeof runWorkflow>({
        ...input,
        budget: { maxCredits: approvedMaxCredits },
        budgetAttempt: budgetAttempt + 1,
        sessionStep: sessionStep + 1,
        lastEmittedAssistantTurn,
        continuation: {
          phase: 'session',
          workspaceId: input.continuation.workspaceId,
        },
        control: controlContinuation(),
      });
    }
    return continueAsNew<typeof runWorkflow>({
      ...input,
      continuation: { phase: 'commit', workspaceId: input.continuation.workspaceId },
      budgetAttempt,
      sessionStep,
      lastEmittedAssistantTurn,
      control: controlContinuation(),
    });
  }

  const commitWorkspaceId = input.continuation.workspaceId;
  currentPhase = 'commit';
  const commitControlResult = await honorNewWorkBoundary(commitWorkspaceId, 'commit');
  if (commitControlResult !== undefined) return commitControlResult;
  try {
    const commitScope = new CancellationScope();
    activeScope = commitScope;
    let committed: Awaited<ReturnType<WorkspaceActivities['commitAndPush']>>;
    try {
      committed = await commitScope.run(
        async () =>
          await workspace.commitAndPush({
            runId: input.runId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            workspaceId: commitWorkspaceId,
            message: M1_COMMIT_MESSAGE,
            idempotencyKey: operationKey(input, `commit-and-push-${String(sessionStep)}`),
          }),
      );
    } catch (error: unknown) {
      if (cancelRequested && isCancellation(error)) {
        return await CancellationScope.nonCancellable(
          async () => await completeCancellation(commitWorkspaceId),
        );
      }
      throw error;
    } finally {
      activeScope = undefined;
    }
    if (cancelRequested) return await completeCancellation(commitWorkspaceId);
    const postCommitControlResult = await honorNewWorkBoundary(commitWorkspaceId, 'commit');
    if (postCommitControlResult !== undefined) return postCommitControlResult;
    const commitCreated = event(input, 'commit.created', `commit-created-${String(sessionStep)}`, {
      commitSha: committed.commitSha,
      message: M1_COMMIT_MESSAGE,
      diffstat: committed.diffstat,
      mode: input.mode,
    });
    if (pendingRedirects.length > 0 || pendingMessages.length > 0) {
      await events.emitEvents({ events: [commitCreated] });
      return await continueAsNew<typeof runWorkflow>({
        ...input,
        continuation: { phase: 'session', workspaceId: commitWorkspaceId },
        budgetAttempt,
        sessionStep: sessionStep + 1,
        lastEmittedAssistantTurn,
        control: controlContinuation(),
      });
    }
    await events.emitEvents({
      events: [
        event(input, 'phase.completed', 'phase-completed', { phase: 'm1-chat' }),
        commitCreated,
        event(input, 'run.completed', 'run-completed', { status: 'completed' }),
      ],
    });
    await events.transitionRunStatus({
      runId: input.runId,
      status: 'completed',
      idempotencyKey: operationKey(input, 'status-completed'),
    });
    currentStatus = 'completed';
    currentPhase = 'terminal';
    return RunWorkflowResultSchema.parse({
      status: 'completed',
      commitSha: committed.commitSha,
    });
  } catch (error: unknown) {
    currentStatus = 'failed';
    currentPhase = 'terminal';
    await events.transitionRunStatus({
      runId: input.runId,
      status: 'failed',
      idempotencyKey: operationKey(input, 'status-failed'),
    });
    throw error;
  }
}

function rejectExternallyStartedContinuation(): never {
  throw ApplicationFailure.nonRetryable(
    'Workflow continuation state requires Temporal continue-as-new provenance',
    'workflow_continuation_provenance_required',
  );
}

/** Entry point for Ask, Prototype, and the legacy single-session modes. */
export async function runWorkflow(inputValue: unknown): Promise<RunWorkflowResult> {
  const input = RunWorkflowStateSchema.parse(inputValue);
  if (
    input.continuation !== undefined &&
    workflowInfo().continuedFromExecutionRunId === undefined
  ) {
    rejectExternallyStartedContinuation();
  }
  if (input.buildModeVersion !== undefined) {
    throw ApplicationFailure.nonRetryable(
      'Lightweight Build state requires the dedicated Build workflow',
      'build_workflow_entrypoint_required',
    );
  }
  return await executeRunWorkflow(input);
}

/** Production Build entry point with provenance-protected internal continuations. */
export async function buildWorkflow(inputValue: unknown): Promise<RunWorkflowResult> {
  const continuedFromExecutionRunId = workflowInfo().continuedFromExecutionRunId;
  if (continuedFromExecutionRunId === undefined) {
    const possibleContinuation = RunWorkflowStateSchema.safeParse(inputValue);
    if (possibleContinuation.success && possibleContinuation.data.continuation !== undefined) {
      rejectExternallyStartedContinuation();
    }
    const input = RunWorkflowInputSchema.parse(inputValue);
    if (input.mode !== 'build') {
      throw ApplicationFailure.nonRetryable(
        'Build workflow requires Build mode',
        'build_workflow_mode_required',
      );
    }
    return await executeRunWorkflow({ ...input, buildModeVersion: 'lightweight-v1' });
  }

  const input = RunWorkflowStateSchema.parse(inputValue);
  if (
    input.mode !== 'build' ||
    input.buildModeVersion !== 'lightweight-v1' ||
    input.continuation === undefined ||
    !input.continuation.phase.startsWith('build_')
  ) {
    throw ApplicationFailure.nonRetryable(
      'Build continuation state does not match the dedicated Build workflow',
      'build_workflow_continuation_invalid',
    );
  }
  return await executeRunWorkflow(input);
}

export { runTaskBatchWorkflow, taskWorkflow } from './task.js';
