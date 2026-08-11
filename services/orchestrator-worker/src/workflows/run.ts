import {
  ApplicationFailure,
  CancellationScope,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  type RetryPolicy,
} from '@temporalio/workflow';
import {
  MessageAssistantPayloadSchema,
  MessageUserPayloadSchema,
} from '@zapp/contracts/events';
import { TOOL_GROUPS, TOOL_NAMES, type ToolName } from '@zapp/contracts/tools';
import { z } from 'zod';

import type { EventActivities, PendingAgentEvent } from '../activities/events.js';
import type { ApprovalActivities } from '../activities/approvals.js';
import type { SessionActivities } from '../activities/session.js';
import type { WorkspaceActivities } from '../activities/workspace.js';

export { capabilityScanWorkflow } from './capability-scan.js';

const workflowIdSchema = (prefix: 'run' | 'org' | 'proj' | 'br' | 'art'): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));

export const RunWorkflowInputSchema = z
  .object({
    runId: workflowIdSchema('run'),
    workflowId: z.string().min(1).max(255),
    organizationId: workflowIdSchema('org'),
    projectId: workflowIdSchema('proj'),
    branchId: workflowIdSchema('br').nullable(),
    mode: z.enum(['ask', 'prototype', 'build', 'fix', 'autonomous']),
    appType: z.enum(['web', 'mobile']),
    model: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
      .nullable(),
    prompt: z.string().min(1).max(20_000),
    budget: z
      .object({ maxCredits: z.number().int().positive().max(1_000_000) })
      .strict()
      .nullable(),
    operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u),
  })
  .strict();
export type RunWorkflowInput = z.infer<typeof RunWorkflowInputSchema>;

const RunWorkflowContinuationSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('session'), workspaceId: z.string().min(1).max(512) }).strict(),
  z.object({ phase: z.literal('commit'), workspaceId: z.string().min(1).max(512) }).strict(),
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
    resumeRequested: z.boolean(),
    resumeOperationKey: OperationKeySchema.nullable(),
    cancelRequested: z.boolean(),
    cancelOperationKey: OperationKeySchema.nullable(),
    cancelAcknowledgementDeadlineAt: z.string().datetime().nullable(),
    pendingRedirects: z.array(RunRedirectSignalSchema).max(100),
    pendingMessages: z.array(RunMessageSignalSchema).max(100).default([]),
  })
  .strict();
const RunWorkflowStateSchema = RunWorkflowInputSchema.extend({
  continuation: RunWorkflowContinuationSchema.optional(),
  budgetAttempt: z.number().int().nonnegative().max(100).optional(),
  sessionStep: z.number().int().nonnegative().max(10_000).optional(),
  lastEmittedAssistantTurn: z.number().int().nonnegative().max(10_000).optional(),
  control: RunControlContinuationSchema.optional(),
}).strict();

export const RunWorkflowResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('completed'),
      commitSha: z.string().regex(/^[0-9a-f]{40,64}$/u).nullable(),
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

const workspace = proxyActivities<WorkspaceActivities>({
  startToCloseTimeout: '2 minutes',
  retry: ACTIVITY_RETRY_POLICY,
});
const session = proxyActivities<SessionActivities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '1500 milliseconds',
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

const BudgetApprovalResolutionSchema = z.discriminatedUnion('decision', [
  z
    .object({
      approvalId: z.string().regex(/^appr_[0-9A-HJKMNP-TV-Z]{26}$/u),
      decision: z.literal('approved'),
      absoluteCeiling: z.string().regex(/^\d+\.\d{4}$/u),
    })
    .strict(),
  z
    .object({
      approvalId: z.string().regex(/^appr_[0-9A-HJKMNP-TV-Z]{26}$/u),
      decision: z.literal('rejected'),
    })
    .strict(),
]);
export const budgetApprovalResolvedSignal = defineSignal<[unknown]>('budgetApprovalResolved');
export const pauseRunSignal = defineSignal<[unknown]>('pause');
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
const DEFAULT_MODE_INSTRUCTIONS = 'Follow the run mode and complete the requested verified work.';

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

function nextRunCreditCeiling(currentMaxCredits: number): string {
  if (currentMaxCredits >= 1_000_000) throw new Error('run credit ceiling cannot be increased');
  return `${String(Math.min(1_000_000, currentMaxCredits * 2))}.0000`;
}

function controlCheckpointApprovalId(input: RunWorkflowInput): string {
  return `appr_${input.runId.slice('run_'.length)}`;
}

function event(
  input: RunWorkflowInput,
  type: PendingAgentEvent['type'],
  suffix: string,
  payload: Record<string, unknown>,
): PendingAgentEvent {
  return {
    eventKey: `${input.runId}:task-m1:${suffix}`,
    runId: input.runId,
    organizationId: input.organizationId,
    projectId: input.projectId,
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

export async function runWorkflow(inputValue: unknown): Promise<RunWorkflowResult> {
  const input = RunWorkflowStateSchema.parse(inputValue);
  const budgetResolutions = new Map<string, z.infer<typeof BudgetApprovalResolutionSchema>>();
  const seenOperationKeys = new Set(input.control?.seenOperationKeys ?? []);
  let pauseRequested = input.control?.pauseRequested ?? false;
  let pauseOperationKey = input.control?.pauseOperationKey ?? null;
  let resumeRequested = input.control?.resumeRequested ?? false;
  let resumeOperationKey = input.control?.resumeOperationKey ?? null;
  let cancelRequested = input.control?.cancelRequested ?? false;
  let cancelOperationKey = input.control?.cancelOperationKey ?? null;
  let cancelAcknowledgementDeadlineAt =
    input.control?.cancelAcknowledgementDeadlineAt ?? null;
  const pendingRedirects = [...(input.control?.pendingRedirects ?? [])];
  const pendingMessages = [...(input.control?.pendingMessages ?? [])];
  let currentStatus: RunControlStatus['status'] = cancelRequested
    ? 'cancel_requested'
    : pauseRequested
      ? 'pause_requested'
      : 'running';
  let currentPhase: RunControlStatus['phase'] =
    input.continuation?.phase === 'commit'
      ? 'commit'
      : input.continuation?.phase === 'session'
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
      resumeRequested,
      resumeOperationKey,
      cancelRequested,
      cancelOperationKey,
      cancelAcknowledgementDeadlineAt,
      pendingRedirects,
      pendingMessages,
    });

  setHandler(budgetApprovalResolvedSignal, (value) => {
    const resolution = BudgetApprovalResolutionSchema.parse(value);
    budgetResolutions.set(resolution.approvalId, resolution);
  });
  setHandler(pauseRunSignal, (value) => {
    const signal = acceptControlSignal(value);
    if (!rememberOperation(signal.operationKey) || cancelRequested || pauseRequested) return;
    pauseRequested = true;
    pauseOperationKey = signal.operationKey;
    currentStatus = 'pause_requested';
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
    const acknowledgementDeadlineAt = z
      .string()
      .datetime()
      .parse(cancelAcknowledgementDeadlineAt);
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
    const checkpointRef = await checkpointControlBoundary(
      workspaceId,
      'pause',
      pauseOperationKey,
    );
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
        event(
          input,
          'run.paused',
          `control-paused-${pauseOperationKey?.slice(-12) ?? 'unkeyed'}`,
          {
            checkpointRef,
            control: {
              operationKey: pauseOperation,
              acknowledgementDeadlineAt: pauseAcknowledgementDeadlineAt,
            },
          },
        ),
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

  const budgetAttempt = input.budgetAttempt ?? 0;
  const sessionStep = input.sessionStep ?? 0;
  let lastEmittedAssistantTurn = input.lastEmittedAssistantTurn ?? 0;
  if (input.continuation === undefined) {
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
      await events.emitEvents({
        events: [
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
          event(input, 'phase.created', 'phase-created', {
            phase: 'm1-chat',
            name: 'Conversation',
          }),
          event(input, 'phase.started', 'phase-started', {
            phase: 'm1-chat',
          }),
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
        ],
      });

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
    const controlResult = await honorControlBoundary(workspaceId, 'session');
    if (controlResult !== undefined) return controlResult;
    return continueAsNew<typeof runWorkflow>({
      ...input,
      continuation: { phase: 'session', workspaceId },
      budgetAttempt,
      sessionStep,
      lastEmittedAssistantTurn,
      control: controlContinuation(),
    });
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
      const preSessionControlResult = await honorControlBoundary(
        sessionWorkspaceId,
        'session',
      );
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
                yieldAfterTool: true,
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
      const controlResult = await honorControlBoundary(
        sessionWorkspaceId,
        'session',
      );
      if (controlResult !== undefined) return controlResult;
      if (sessionResult.redirectApplied === true) pendingRedirects.shift();
      if (sessionResult.messageApplied === true) pendingMessages.shift();
      const assistantTurn = sessionResult.turn ?? sessionStep + 1;
      if (
        (sessionResult.status === 'completed' || sessionResult.status === 'yielded') &&
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
          if (input.budget === null) throw new Error('builder_session_budget_exhausted');
          const currentCeiling = `${String(input.budget.maxCredits)}.0000`;
          const requested = await approvals.requestBudgetIncrease({
            runId: input.runId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            workspaceId: input.continuation.workspaceId,
            currentCeiling,
            absoluteCeiling: nextRunCreditCeiling(input.budget.maxCredits),
            idempotencyKey: operationKey(
              input,
              `budget-increase-${String(budgetAttempt)}`,
            ),
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
              event(input, 'approval.requested', `budget-approval-${String(budgetAttempt)}`, {
                approvalId: requested.approvalId,
                type: 'budget_increase',
                absoluteCeiling: requested.absoluteCeiling,
              }),
            ],
          });
          await condition(
            () => budgetResolutions.has(requested.approvalId) || cancelRequested,
          );
          if (cancelRequested) return await completeCancellation(sessionWorkspaceId);
          const resolution = budgetResolutions.get(requested.approvalId);
          if (resolution === undefined) throw new Error('budget approval resolution disappeared');
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
            idempotencyKey: operationKey(
              input,
              `status-budget-resumed-${String(budgetAttempt)}`,
            ),
          });
          break;
        }
        case 'needs_approval':
        case 'failed':
        case 'cancelled':
          throw new Error(`builder_session_${sessionResult.status}`);
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
        const mocks = z.array(PrototypeMockSchema).max(100).parse(sessionResult.mocks ?? []);
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
  const commitControlResult = await honorControlBoundary(commitWorkspaceId, 'commit');
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
    const postCommitControlResult = await honorControlBoundary(commitWorkspaceId, 'commit');
    if (postCommitControlResult !== undefined) return postCommitControlResult;
    const commitCreated = event(
      input,
      'commit.created',
      `commit-created-${String(sessionStep)}`,
      {
        commitSha: committed.commitSha,
        message: M1_COMMIT_MESSAGE,
        diffstat: committed.diffstat,
        mode: input.mode,
      },
    );
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

export { runTaskBatchWorkflow, taskWorkflow } from './task.js';
