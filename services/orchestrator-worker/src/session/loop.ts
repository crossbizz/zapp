import { createHash, randomUUID } from 'node:crypto';

import {
  evaluateToolCall,
  PolicyDecisionSchema,
  wrapUntrusted,
  type ContentProvenance,
  type ExecutionBoundary,
} from '@zapp/agent-policies';
import { evaluateRunCreditBudget } from '@zapp/agent-policies/budgets';
import {
  ToolExecutionError,
  type ToolRegistry,
  type ToolExecutionWithAudit,
} from '@zapp/agent-tools';
import { startObservabilitySpan, withObservabilitySpan } from '@zapp/config';
import {
  idSchema,
  MessageUserPayloadSchema,
  RunModeSchema,
  TOOL_NAMES,
  type ToolName,
} from '@zapp/contracts';
import {
  GatewayStreamEventSchema,
  InputJsonSchema,
  ChatMessageSchema,
  type ChatMessage,
  type CompleteRequest,
  type GatewayStreamEvent,
  type JsonValue,
} from '@zapp/model-gateway';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AssembledContextSchema,
  ContextRoleSchema,
  type AssembledContext,
  type ContextRole,
} from './context.js';
import {
  SessionToolCallSchema,
  TranscriptKeySchema,
  type SessionToolCall,
  type SessionTranscript,
  type SessionTranscriptDraft,
  type TranscriptStore,
} from './transcript.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function completionIdFor(runId: string, taskId: string, turn: number): string {
  return `cmp_${sha256(JSON.stringify([runId, taskId, turn]))}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function requestFingerprint(request: CompleteRequest): string {
  return sha256(canonicalJson(request));
}

const BudgetsSchema = z
  .object({
    maxTurns: z.number().int().positive().safe(),
    maxTokens: z.number().int().positive().safe(),
    maxWallClockMs: z.number().int().positive().max(2_147_483_647).safe(),
  })
  .strict();

export const SessionInputSchema = z
  .object({
    runId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    role: ContextRoleSchema,
    mode: RunModeSchema,
    modeInstructions: z.string().min(1).max(4_000).optional(),
    context: AssembledContextSchema,
    control: z
      .object({
        yieldAfterTool: z.boolean(),
        redirect: z
          .object({
            operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u),
            instruction: z.string().trim().min(1).max(20_000),
          })
          .strict()
          .nullable(),
        message: z
          .object({
            operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u),
            message: MessageUserPayloadSchema,
          })
          .strict()
          .nullable()
          .optional(),
      })
      .strict()
      .optional(),
    tools: z.array(z.enum(TOOL_NAMES)).superRefine((tools, validation) => {
      if (new Set(tools).size !== tools.length) {
        validation.addIssue({ code: z.ZodIssueCode.custom, message: 'Tools must be unique' });
      }
    }),
    budgets: BudgetsSchema,
  })
  .strict()
  .superRefine((input, validation) => {
    if (input.context.scope.runId !== input.runId) {
      validation.addIssue({ code: z.ZodIssueCode.custom, message: 'Context run does not match' });
    }
    if (input.context.role !== input.role) {
      validation.addIssue({ code: z.ZodIssueCode.custom, message: 'Context role does not match' });
    }
    if (input.taskId !== undefined && input.context.taskId !== input.taskId) {
      validation.addIssue({ code: z.ZodIssueCode.custom, message: 'Context task does not match' });
    }
  });

export type SessionInput = z.infer<typeof SessionInputSchema>;
export type AgentRole = ContextRole;

export const ApprovalRequestSchema = z
  .object({
    runId: z.string().min(1),
    taskId: z.string().min(1),
    toolCallId: z.string().min(1),
    tool: z.enum(TOOL_NAMES),
    input: z.record(z.unknown()),
    reason: z.enum(['destructive_migration', 'production_migration', 'release_approval_required']),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const SessionResultSchema = z
  .object({
    status: z.enum([
      'completed',
      'yielded',
      'needs_approval',
      'budget_exhausted',
      'failed',
      'cancelled',
    ]),
    commits: z.array(z.string()),
    artifacts: z.array(z.string()),
    summary: z.string(),
    errorCode: z.string().min(1).optional(),
    model: z.string().min(1).max(160).optional(),
    turn: z.number().int().nonnegative().safe().optional(),
    completedTools: z.array(z.enum(TOOL_NAMES)).optional(),
    mocks: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(160),
            reason: z.string().trim().min(1).max(1_000),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    redirectApplied: z.boolean().optional(),
    messageApplied: z.boolean().optional(),
    pendingApproval: ApprovalRequestSchema.optional(),
  })
  .strict();
export type SessionResult = z.infer<typeof SessionResultSchema>;

const PrototypeMockSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

const PrototypeCompletionSchema = z
  .object({
    summary: z.string().trim().min(1).max(1_000_000),
    mocks: z.array(PrototypeMockSchema).max(100),
  })
  .strict();

export const SessionEventSchema = z
  .object({
    eventKey: z.string().min(1),
    runId: z.string().min(1),
    taskId: z.string().min(1),
    type: z.enum([
      'tool.started',
      'tool.output',
      'tool.completed',
      'tool.failed',
      'approval.requested',
      'approval.resolved',
      'usage.recorded',
    ]),
    occurredAt: z.string().datetime(),
    payload: z.record(z.unknown()),
  })
  .strict()
  .superRefine((event, validation) => {
    if (
      (event.type === 'tool.started' ||
        event.type === 'tool.completed' ||
        event.type === 'tool.failed') &&
      (typeof event.payload['userSummary'] !== 'string' ||
        event.payload['userSummary'].trim().length === 0)
    ) {
      validation.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'userSummary'],
        message: 'Tool lifecycle events require a userSummary',
      });
    }
  });
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export interface SessionGateway {
  stream(request: CompleteRequest, signal: AbortSignal): AsyncIterable<GatewayStreamEvent>;
}

export interface SessionLoopDependencies {
  readonly gateway: SessionGateway;
  readonly tools: Pick<ToolRegistry, 'get'>;
  readonly transcripts: TranscriptStore;
  readonly events: { emit(event: SessionEvent): void | Promise<void> };
  readonly approvals: {
    status(
      request: ApprovalRequest,
    ): 'pending' | 'approved' | 'denied' | Promise<'pending' | 'approved' | 'denied'>;
  };
  readonly prompts: Readonly<Record<AgentRole, string>>;
  readonly redact: (value: string) => string;
  readonly countRequestTokens: (request: CompleteRequest) => number;
  readonly executionBoundary?: ExecutionBoundary;
  readonly results?: {
    collect(input: {
      tool: ToolName;
      input: Readonly<Record<string, JsonValue>>;
      output: unknown;
    }): unknown;
  };
  readonly workerId?: string;
  readonly executionLeaseMs?: number;
  readonly now?: () => number;
}

const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied']);
const ResultReferencesSchema = z
  .object({ commits: z.array(z.string()), artifacts: z.array(z.string()) })
  .strict();
const ArtifactResultSchema = z.object({ artifactId: z.string().min(1) }).passthrough();

export class SessionLeaseBusyError extends Error {
  constructor() {
    super('Session tool execution is owned by another live worker');
    this.name = 'SessionLeaseBusyError';
  }
}

export class SessionCompletionRetryableError extends Error {
  constructor(
    readonly code: 'completion_leased' | 'completion_retryable' | 'gateway_unavailable',
  ) {
    super('The durable model completion must be retried.');
    this.name = 'SessionCompletionRetryableError';
  }
}

const UNTRUSTED_CONTEXT_KINDS = new Set<AssembledContext['sections'][number]['kind']>([
  'fileIndex',
  'recentChanges',
  'taskTranscript',
  'evidence',
]);

export function assembleSessionInitialMessages(
  input: SessionInput,
  redact: (value: string) => string,
): {
  messages: ChatMessage[];
  provenance: ContentProvenance[];
} {
  const provenance: ContentProvenance[] = [];
  const sections = input.context.sections.map((section) => {
    const content = redact(section.content);
    if (!UNTRUSTED_CONTEXT_KINDS.has(section.kind)) return `[${section.kind}]\n${content}`;
    const wrapped = wrapUntrusted(content, `context:${section.kind}`);
    provenance.push(wrapped.provenance);
    return `[${section.kind}]\n${wrapped.content}`;
  });
  return {
    messages: [
      { role: 'system', content: '' },
      { role: 'user', content: sections.join('\n\n') },
    ],
    provenance,
  };
}

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function redactJson(value: unknown, redact: (value: string) => string): JsonValue {
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, redact));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => [redact(key), redactJson(entry, redact)] as const,
    );
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw new Error('Redaction produced duplicate object keys');
    }
    return Object.fromEntries(entries);
  }
  throw new Error('Tool output is not JSON serializable');
}

function redactOutboundRequest(
  request: CompleteRequest,
  redact: (value: string) => string,
): CompleteRequest {
  return {
    ...request,
    messages: request.messages.map((message) =>
      ChatMessageSchema.parse(redactJson(message, redact)),
    ),
  };
}

function visibleToolOutput(
  output: unknown,
  tool: ToolName,
  redact: (value: string) => string,
): { wrapped: string; value: JsonValue } {
  const value = redactJson(output, redact);
  const wrapped = wrapUntrusted(JSON.stringify(value), `tool:${tool}`).content;
  return { wrapped, value };
}

const MAX_INLINE_TIMELINE_PAYLOAD_BYTES = 48_000;
const OVERSIZED_TIMELINE_OUTPUT_MESSAGE =
  'Tool output exceeded the inline event limit and was omitted from the timeline.';

function boundedTimelinePayload(
  type: SessionEvent['type'],
  payload: JsonValue,
): JsonValue {
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (payloadBytes <= MAX_INLINE_TIMELINE_PAYLOAD_BYTES) return payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {
      type: 'truncated',
      byteSize: payloadBytes,
      message: OVERSIZED_TIMELINE_OUTPUT_MESSAGE,
    };
  }
  const source = payload as Record<string, JsonValue>;
  const oversizedField = type === 'tool.output' ? 'output' : type === 'tool.completed' ? 'audit' : null;
  const oversizedValue = oversizedField === null ? payload : source[oversizedField];
  const truncated = {
    type: 'truncated',
    byteSize: Buffer.byteLength(JSON.stringify(oversizedValue ?? payload), 'utf8'),
    message: OVERSIZED_TIMELINE_OUTPUT_MESSAGE,
  };
  return {
    ...(typeof source['toolCallId'] === 'string' ? { toolCallId: source['toolCallId'] } : {}),
    ...(typeof source['tool'] === 'string' ? { tool: source['tool'] } : {}),
    ...(typeof source['userSummary'] === 'string'
      ? { userSummary: source['userSummary'] }
      : {}),
    ...(oversizedField === null ? { details: truncated } : { [oversizedField]: truncated }),
  };
}

function transcriptDraft(transcript: SessionTranscript): SessionTranscriptDraft {
  const draft: Partial<SessionTranscript> = { ...transcript };
  delete draft.version;
  return draft as SessionTranscriptDraft;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function usedBy(event: Extract<GatewayStreamEvent, { type: 'usage' }>): number {
  return Math.max(event.totalTokens ?? 0, (event.inputTokens ?? 0) + (event.outputTokens ?? 0));
}

function toolOutcomeSucceeded(output: unknown): boolean {
  return (
    typeof output === 'object' &&
    output !== null &&
    'ok' in output &&
    (output as { readonly ok?: unknown }).ok === true
  );
}

function parsePrototypeCompletion(
  value: string,
  redact: (value: string) => string,
): z.infer<typeof PrototypeCompletionSchema> {
  const parsed = PrototypeCompletionSchema.parse(JSON.parse(value) as unknown);
  return PrototypeCompletionSchema.parse({
    summary: redact(parsed.summary),
    mocks: parsed.mocks.map((mock) => ({
      name: redact(mock.name),
      reason: redact(mock.reason),
    })),
  });
}

function terminal(
  transcript: SessionTranscript,
  pendingApproval?: ApprovalRequest,
  redirectApplied = false,
  messageApplied = false,
): SessionResult {
  return SessionResultSchema.parse({
    status: transcript.terminalStatus ?? 'needs_approval',
    commits: transcript.commits,
    artifacts: transcript.artifacts,
    summary: transcript.summary,
    ...(transcript.terminalErrorCode === null
      ? {}
      : { errorCode: transcript.terminalErrorCode }),
    ...(transcript.model === null ? {} : { model: transcript.model }),
    turn: transcript.turns,
    ...(transcript.mode === 'prototype'
      ? {
          completedTools: transcript.successfulToolNames,
          mocks: transcript.prototypeMocks,
        }
      : {}),
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
    ...(redirectApplied ? { redirectApplied: true } : {}),
    ...(messageApplied ? { messageApplied: true } : {}),
  });
}

function yielded(
  transcript: SessionTranscript,
  redirectApplied: boolean,
  messageApplied: boolean,
): SessionResult {
  return SessionResultSchema.parse({
    status: 'yielded',
    commits: transcript.commits,
    artifacts: transcript.artifacts,
    summary: transcript.summary,
    ...(transcript.model === null ? {} : { model: transcript.model }),
    turn: transcript.turns,
    ...(redirectApplied ? { redirectApplied: true } : {}),
    ...(messageApplied ? { messageApplied: true } : {}),
  });
}

function conversationMessageContent(message: z.infer<typeof MessageUserPayloadSchema>): string {
  if (message.attachments.length === 0) return message.content;
  const attachments = message.attachments.map(
    (attachment) =>
      `[image attachment: ${attachment.name}; ${attachment.contentType}; ${String(attachment.byteSize)} bytes; id=${attachment.attachmentId}]`,
  );
  return `${message.content}\n\n${attachments.join('\n')}`;
}

const ABORTED = Symbol('aborted');

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (value: T | typeof ABORTED): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => {
      settle(ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(settle, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error instanceof Error ? error : new Error('Operation failed'));
    });
    if (signal.aborted) onAbort();
  });
}

function closeIterator(iterator: AsyncIterator<unknown>): void {
  try {
    if (iterator.return !== undefined) {
      void Promise.resolve(iterator.return()).catch(() => undefined);
    }
  } catch {
    return;
  }
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function registryResultReferences(output: unknown): z.infer<typeof ResultReferencesSchema> {
  const artifact = ArtifactResultSchema.safeParse(output);
  return { commits: [], artifacts: artifact.success ? [artifact.data.artifactId] : [] };
}

export function createSessionLoop(dependencies: SessionLoopDependencies) {
  const now = dependencies.now ?? Date.now;
  const workerId = dependencies.workerId ?? randomUUID();
  const executionLeaseMs = z
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .parse(dependencies.executionLeaseMs ?? 30_000);

  return {
    async run(inputValue: SessionInput, callerSignal?: AbortSignal): Promise<SessionResult> {
      const input = SessionInputSchema.parse(inputValue);
      const invokedAt = now();
      const taskId = input.taskId ?? input.context.taskId;
      const key = TranscriptKeySchema.parse({ runId: input.runId, taskId });
      const loaded = await dependencies.transcripts.load(key);
      let provenance: ContentProvenance[] = [];
      const rawInputs = new Map<string, Readonly<Record<string, JsonValue>>>();
      let transcript: SessionTranscript;
      if (loaded === undefined) {
        const initial = assembleSessionInitialMessages(input, dependencies.redact);
        provenance = initial.provenance;
        initial.messages[0] = {
          role: 'system',
          content: dependencies.redact(
            [dependencies.prompts[input.role], input.modeInstructions]
              .filter((part): part is string => part !== undefined)
              .join('\n\n'),
          ),
        };
        transcript = await dependencies.transcripts.save(null, {
          key,
          role: input.role,
          mode: input.mode,
          tools: input.tools,
          budgets: input.budgets,
          startedAtMs: invokedAt,
          provenance,
          messages: initial.messages,
          turns: 0,
          tokensUsed: 0,
          inFlightCompletion: null,
          completedToolCallIds: [],
          appliedRedirectOperationKeys: [],
          appliedMessageOperationKeys: [],
          completedToolNames: [],
          successfulToolNames: [],
          prototypeMocks: [],
          pendingToolCalls: [],
          activeToolCallId: null,
          executionLease: null,
          nextFence: 1,
          eventOutbox: [],
          commits: [],
          artifacts: [],
          summary: '',
          model: null,
          terminalStatus: null,
          terminalErrorCode: null,
        });
      } else {
        transcript = loaded;
        if (
          transcript.role !== input.role ||
          transcript.mode !== input.mode ||
          JSON.stringify(transcript.tools) !== JSON.stringify(input.tools) ||
          JSON.stringify(transcript.budgets) !== JSON.stringify(input.budgets)
        ) {
          throw new Error('Session input does not match its durable transcript');
        }
        provenance = [...transcript.provenance];
      }

      let redirectApplied = false;
      const redirect = input.control?.redirect;
      if (redirect !== null && redirect !== undefined) {
        if (transcript.appliedRedirectOperationKeys.includes(redirect.operationKey)) {
          redirectApplied = true;
        } else if (
          transcript.pendingToolCalls.length === 0 &&
          transcript.activeToolCallId === null &&
          (transcript.terminalStatus === null || transcript.terminalStatus === 'completed')
        ) {
          transcript.messages.push({
            role: 'user',
            content: dependencies.redact(redirect.instruction),
          });
          transcript.appliedRedirectOperationKeys.push(redirect.operationKey);
          transcript.terminalStatus = null;
          transcript.terminalErrorCode = null;
          transcript.summary = '';
          transcript = await dependencies.transcripts.save(
            transcript.version,
            transcriptDraft(transcript),
          );
          redirectApplied = true;
        }
      }

      let messageApplied = false;
      const conversationMessage = input.control?.message;
      if (conversationMessage !== null && conversationMessage !== undefined) {
        if (transcript.appliedMessageOperationKeys.includes(conversationMessage.operationKey)) {
          messageApplied = true;
        } else if (
          transcript.pendingToolCalls.length === 0 &&
          transcript.activeToolCallId === null &&
          (transcript.terminalStatus === null || transcript.terminalStatus === 'completed')
        ) {
          transcript.messages.push({
            role: 'user',
            content: dependencies.redact(conversationMessageContent(conversationMessage.message)),
          });
          transcript.appliedMessageOperationKeys.push(conversationMessage.operationKey);
          transcript.terminalStatus = null;
          transcript.terminalErrorCode = null;
          transcript.summary = '';
          transcript = await dependencies.transcripts.save(
            transcript.version,
            transcriptDraft(transcript),
          );
          messageApplied = true;
        }
      }

      const controller = new AbortController();
      const onCallerAbort = (): void => {
        controller.abort(callerSignal?.reason);
      };
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
      if (callerSignal?.aborted === true) onCallerAbort();
      const startedAt = transcript.startedAtMs;
      const remainingWallClockMs = Math.min(
        2_147_483_647,
        Math.max(1, input.budgets.maxWallClockMs - (now() - startedAt)),
      );
      const timer = setTimeout(() => {
        controller.abort(new Error('session_wall_clock_budget'));
      }, remainingWallClockMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
      };

      const save = async (): Promise<void> => {
        transcript = await dependencies.transcripts.save(
          transcript.version,
          transcriptDraft(transcript),
        );
      };
      const finish = async (
        status: Exclude<SessionResult['status'], 'needs_approval' | 'yielded'>,
        summary: string,
        errorCode: string | null = null,
      ): Promise<SessionResult> => {
        if (transcript.mode === 'prototype' && status === 'completed') {
          const completion = parsePrototypeCompletion(summary, dependencies.redact);
          transcript.summary = completion.summary;
          transcript.prototypeMocks = completion.mocks;
        } else {
          transcript.summary = dependencies.redact(summary);
        }
        transcript.terminalStatus = status;
        transcript.terminalErrorCode = errorCode;
        await save();
        await flushOutbox();
        return terminal(transcript, undefined, redirectApplied, messageApplied);
      };
      const eventFor = (
        type: SessionEvent['type'],
        call: SessionToolCall,
        suffix: string,
        payload: Record<string, unknown>,
        rawOutput?: unknown,
      ): SessionEvent => {
        const lifecycle =
          type === 'tool.started'
            ? 'started'
            : type === 'tool.completed'
              ? 'completed'
              : type === 'tool.failed'
                ? 'failed'
                : undefined;
        const userSummary =
          lifecycle === undefined
            ? {}
            : {
                userSummary: dependencies.tools
                  .get(call.toolName)
                  .timelineSummary(
                    lifecycle,
                    rawInputs.get(call.toolCallId) ?? call.input,
                    rawOutput,
                  ),
              };
        const redactedPayload = redactJson(
          { toolCallId: call.toolCallId, tool: call.toolName, ...userSummary, ...payload },
          dependencies.redact,
        );
        return SessionEventSchema.parse({
          eventKey: `${input.runId}:${taskId}:${call.toolCallId}:${suffix}`,
          runId: input.runId,
          taskId,
          type,
          occurredAt: new Date(now()).toISOString(),
          payload: boundedTimelinePayload(type, redactedPayload),
        });
      };
      const enqueue = (event: SessionEvent): void => {
        if (!transcript.eventOutbox.some((entry) => entry.event.eventKey === event.eventKey)) {
          transcript.eventOutbox.push({ event, delivered: false });
        }
      };
      const flushOutbox = async (): Promise<void> => {
        for (;;) {
          const entry = transcript.eventOutbox.find((candidate) => !candidate.delivered);
          if (entry === undefined) return;
          await dependencies.events.emit(SessionEventSchema.parse(entry.event));
          entry.delivered = true;
          await save();
        }
      };

      try {
        await flushOutbox();
      } catch (error: unknown) {
        cleanup();
        throw error;
      }
      if (transcript.terminalStatus !== null) {
        cleanup();
        return terminal(transcript, undefined, redirectApplied, messageApplied);
      }

      if (transcript.activeToolCallId !== null) {
        const active = transcript.pendingToolCalls[0];
        const lease = transcript.executionLease;
        if (
          active === undefined ||
          active.toolCallId !== transcript.activeToolCallId ||
          lease === null
        ) {
          cleanup();
          throw new Error('Durable transcript has an invalid active tool call');
        }
        if (lease.expiresAtMs > now()) {
          cleanup();
          throw new SessionLeaseBusyError();
        }
        transcript.messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: active.toolCallId,
              toolName: active.toolName,
              output: {
                type: 'error-text',
                value: 'Tool outcome unknown; execution was not replayed.',
              },
            },
          ],
        });
        transcript.pendingToolCalls.splice(0);
        transcript.activeToolCallId = null;
        transcript.executionLease = null;
        transcript.summary = 'A tool outcome is unknown; the session stopped without replaying it.';
        transcript.terminalStatus = 'failed';
        transcript.terminalErrorCode = 'tool_outcome_unknown';
        enqueue(
          eventFor('tool.failed', active, 'outcome-unknown', { code: 'tool_outcome_unknown' }),
        );
        await save();
        await flushOutbox();
        cleanup();
        return terminal(transcript, undefined, redirectApplied, messageApplied);
      }

      try {
        for (;;) {
          if (isAborted(controller.signal)) {
            const wallClockExceeded = now() - startedAt >= input.budgets.maxWallClockMs;
            return await finish(
              wallClockExceeded ? 'budget_exhausted' : 'cancelled',
              transcript.summary,
              wallClockExceeded ? 'wall_clock_budget_exhausted' : 'cancelled',
            );
          }
          if (now() - startedAt >= input.budgets.maxWallClockMs) {
            controller.abort(new Error('session_wall_clock_budget'));
            return await finish(
              'budget_exhausted',
              transcript.summary,
              'wall_clock_budget_exhausted',
            );
          }
          if (transcript.pendingToolCalls.length === 0) {
            if (
              transcript.turns >= input.budgets.maxTurns ||
              transcript.tokensUsed >= input.budgets.maxTokens
            ) {
              return await finish(
                'budget_exhausted',
                transcript.summary,
                transcript.turns >= input.budgets.maxTurns
                  ? 'turn_budget_exhausted'
                  : 'token_budget_exhausted',
              );
            }
            const tools = input.tools.map((name) => {
              const definition = dependencies.tools.get(name);
              const converted = zodToJsonSchema(definition.inputSchema, {
                target: 'jsonSchema7',
                $refStrategy: 'none',
              });
              const inputJsonSchema: Record<string, unknown> = { ...converted };
              delete inputJsonSchema.$schema;
              delete inputJsonSchema.definitions;
              return {
                name,
                description: definition.description,
                inputJsonSchema: InputJsonSchema.parse(inputJsonSchema),
              };
            });
            const completionId = completionIdFor(input.runId, taskId, transcript.turns);
            const accountingTaskId = idSchema('task').safeParse(taskId);
            const requestBase: CompleteRequest = {
              completionId,
              organizationId: input.context.scope.organizationId,
              projectId: input.context.scope.projectId,
              runId: input.runId,
              ...(accountingTaskId.success ? { taskId: accountingTaskId.data } : {}),
              agentRole: input.role,
              messages: structuredClone(transcript.messages),
              tools,
              cacheBreakpointMessageIndexes: [0, 1],
              maxInputTokens: 0,
              maxOutputTokens: 1,
            };
            let request: CompleteRequest;
            let requestTokens: number;
            let reservedTurnTokens: number;
            if (transcript.inFlightCompletion === null) {
              try {
                requestTokens = z
                  .number()
                  .int()
                  .nonnegative()
                  .safe()
                  .parse(dependencies.countRequestTokens(requestBase));
              } catch {
                return await finish(
                  'failed',
                  'Request token counting failed.',
                  'token_count_failed',
                );
              }
              const remainingOutputBudget =
                input.budgets.maxTokens - transcript.tokensUsed - requestTokens;
              if (remainingOutputBudget <= 0) {
                return await finish(
                  'budget_exhausted',
                  transcript.summary,
                  'token_budget_exhausted',
                );
              }
              const remainingTurnSlots = input.budgets.maxTurns - transcript.turns;
              const outputTokenAllowance = Math.max(
                1,
                Math.floor(remainingOutputBudget / remainingTurnSlots),
              );
              request = redactOutboundRequest(
                {
                  ...requestBase,
                  maxInputTokens: requestTokens,
                  maxOutputTokens: outputTokenAllowance,
                },
                dependencies.redact,
              );
              reservedTurnTokens = requestTokens + outputTokenAllowance;
              transcript.tokensUsed += reservedTurnTokens;
              transcript.inFlightCompletion = {
                completionId,
                requestVersion: 3,
                requestFingerprint: requestFingerprint(request),
                requestTokens,
                reservedTokens: reservedTurnTokens,
                request: structuredClone(request),
              };
              await save();
            } else {
              if (transcript.inFlightCompletion.completionId !== completionId) {
                throw new Error('Durable completion identity does not match the transcript turn');
              }
              request = structuredClone(transcript.inFlightCompletion.request);
              requestTokens = transcript.inFlightCompletion.requestTokens;
              reservedTurnTokens = transcript.inFlightCompletion.reservedTokens;
              if (
                transcript.inFlightCompletion.requestVersion === 3 &&
                requestFingerprint(request) !== transcript.inFlightCompletion.requestFingerprint
              ) {
                throw new Error('Durable completion request fingerprint does not match');
              }
            }
            const text: string[] = [];
            const calls: SessionToolCall[] = [];
            let accountedTurnTokens = reservedTurnTokens;
            let pendingTokenCutoff = false;
            let streamCompleted = false;
            let iterator: AsyncIterator<GatewayStreamEvent> | undefined;
            const stepSpan = startObservabilitySpan('agent.step:model', {
              'zapp.organization.id': input.context.scope.organizationId,
              'zapp.project.id': input.context.scope.projectId,
              'zapp.run.id': input.runId,
              'zapp.task.id': taskId,
            });
            try {
              const outboundRequest =
                transcript.inFlightCompletion.requestVersion < 3
                  ? {
                      ...redactOutboundRequest(request, dependencies.redact),
                      accountingReplay: {
                        version: 1 as const,
                        requestFingerprint: transcript.inFlightCompletion.requestFingerprint,
                      },
                    }
                  : request;
              iterator = dependencies.gateway
                .stream(outboundRequest, controller.signal)
                [Symbol.asyncIterator]();
              for (;;) {
                const next = await raceWithAbort(iterator.next(), controller.signal);
                if (next === ABORTED) {
                  closeIterator(iterator);
                  const wallClockExceeded = now() - startedAt >= input.budgets.maxWallClockMs;
                  return await finish(
                    wallClockExceeded ? 'budget_exhausted' : 'cancelled',
                    transcript.summary,
                    wallClockExceeded ? 'wall_clock_budget_exhausted' : 'cancelled',
                  );
                }
                if (next.done) break;
                const event = GatewayStreamEventSchema.parse(next.value);
                if (event.type === 'text-delta') text.push(dependencies.redact(event.text));
                if (event.type === 'usage') {
                  const attributedModel = `${event.provider}/${event.model}`;
                  const modelChanged = transcript.model !== attributedModel;
                  transcript.model = attributedModel;
                  const observedTurnTokens = Math.max(
                    usedBy(event),
                    requestTokens + (event.outputTokens ?? 0),
                  );
                  if (observedTurnTokens > accountedTurnTokens) {
                    transcript.tokensUsed += observedTurnTokens - accountedTurnTokens;
                    accountedTurnTokens = observedTurnTokens;
                    await save();
                    if (transcript.tokensUsed > input.budgets.maxTokens) {
                      pendingTokenCutoff = true;
                    }
                  } else if (modelChanged) {
                    await save();
                  }
                }
                if (event.type === 'usage.recorded') {
                  if (event.completionId !== request.completionId) {
                    throw new Error(
                      'Recorded usage completion identity does not match the request',
                    );
                  }
                  const budget = evaluateRunCreditBudget(event.credits);
                  enqueue(
                    SessionEventSchema.parse({
                      eventKey: `${input.runId}:${taskId}:${event.completionId}:usage-recorded`,
                      runId: input.runId,
                      taskId,
                      type: 'usage.recorded',
                      occurredAt: new Date(now()).toISOString(),
                      payload: redactJson(
                        {
                          completionId: event.completionId,
                          usage: event.usage,
                          credits: event.credits,
                          budget,
                        },
                        dependencies.redact,
                      ),
                    }),
                  );
                  await save();
                  await flushOutbox();
                  if (budget.level === 'exhausted') {
                    closeIterator(iterator);
                    return await finish(
                      'budget_exhausted',
                      transcript.summary,
                      'credit_budget_exhausted',
                    );
                  }
                  if (pendingTokenCutoff) {
                    closeIterator(iterator);
                    return await finish(
                      'budget_exhausted',
                      transcript.summary,
                      'token_budget_exhausted',
                    );
                  }
                }
                if (event.type === 'error') {
                  closeIterator(iterator);
                  if (event.code === 'completion_leased' || event.code === 'completion_retryable') {
                    throw new SessionCompletionRetryableError(event.code);
                  }
                  if (event.code === 'budget_exceeded') {
                    return await finish(
                      'budget_exhausted',
                      dependencies.redact(event.message),
                      event.code,
                    );
                  }
                  if (event.code === 'output_limit_exceeded') {
                    return await finish(
                      'budget_exhausted',
                      dependencies.redact(event.message),
                      event.code,
                    );
                  }
                  return await finish('failed', dependencies.redact(event.message), event.code);
                }
                if (pendingTokenCutoff) continue;
                if (event.type === 'tool-call') {
                  if (!isToolName(event.toolName)) {
                    closeIterator(iterator);
                    return await finish(
                      'failed',
                      'The model requested an unknown tool.',
                      'unknown_tool',
                    );
                  }
                  const sanitizedId = dependencies.redact(event.toolCallId);
                  const sanitizedInput = redactJson(event.input, dependencies.redact);
                  if (
                    sanitizedInput === null ||
                    Array.isArray(sanitizedInput) ||
                    typeof sanitizedInput !== 'object'
                  ) {
                    closeIterator(iterator);
                    return await finish(
                      'failed',
                      'The model returned invalid tool input.',
                      'invalid_tool_input',
                    );
                  }
                  const call = SessionToolCallSchema.parse({
                    toolCallId: sanitizedId,
                    toolName: event.toolName,
                    input: sanitizedInput,
                  });
                  calls.push(call);
                  rawInputs.set(call.toolCallId, event.input);
                }
                if (event.type === 'done') {
                  streamCompleted = true;
                  closeIterator(iterator);
                  break;
                }
              }
            } catch (error: unknown) {
              if (iterator !== undefined) closeIterator(iterator);
              if (error instanceof SessionCompletionRetryableError) throw error;
              if (isAborted(controller.signal)) {
                const wallClockExceeded = now() - startedAt >= input.budgets.maxWallClockMs;
                return await finish(
                  wallClockExceeded ? 'budget_exhausted' : 'cancelled',
                  transcript.summary,
                  wallClockExceeded ? 'wall_clock_budget_exhausted' : 'cancelled',
                );
              }
              const message = error instanceof Error ? error.message : 'Gateway stream failed.';
              return await finish('failed', dependencies.redact(message), 'gateway_stream_failed');
            } finally {
              stepSpan.end(streamCompleted ? 'ok' : 'error');
            }
            if (isAborted(controller.signal)) {
              const wallClockExceeded = now() - startedAt >= input.budgets.maxWallClockMs;
              return await finish(
                wallClockExceeded ? 'budget_exhausted' : 'cancelled',
                transcript.summary,
              );
            }
            if (!streamCompleted) {
              return await finish('failed', 'The model gateway stream ended before completion.');
            }
            transcript.turns += 1;
            transcript.inFlightCompletion = null;
            const content: Array<
              | { type: 'text'; text: string }
              | {
                  type: 'tool-call';
                  toolCallId: string;
                  toolName: string;
                  input: Record<string, JsonValue>;
                }
            > = [];
            if (text.length > 0) content.push({ type: 'text', text: text.join('') });
            content.push(
              ...calls.map((call) => ({
                type: 'tool-call' as const,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
              })),
            );
            transcript.messages.push({ role: 'assistant', content });
            transcript.pendingToolCalls.push(...calls);
            transcript.summary = dependencies.redact(text.join(''));
            await save();
            if (calls.length === 0) return await finish('completed', transcript.summary);
          }

          const call = transcript.pendingToolCalls[0];
          if (call === undefined) continue;
          if (!input.tools.includes(call.toolName)) {
            enqueue(eventFor('tool.started', call, 'started', {}));
            enqueue(eventFor('tool.failed', call, 'failed', { code: 'tool_not_allowed' }));
            transcript.messages.push({
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  output: { type: 'execution-denied', reason: 'Tool is not allowed in this mode.' },
                },
              ],
            });
            transcript.pendingToolCalls.shift();
            await save();
            await flushOutbox();
            if (input.control?.yieldAfterTool === true) {
              return yielded(transcript, redirectApplied, messageApplied);
            }
            continue;
          }
          const rawInput = rawInputs.get(call.toolCallId) ?? call.input;
          const decision = PolicyDecisionSchema.parse(
            evaluateToolCall(
              {
                mode: input.mode,
                provenance,
                executionBoundary: dependencies.executionBoundary ?? 'uncontained',
                environmentScope: 'production',
                approvedReleaseId: null,
                approvedDeployment: null,
              },
              call.toolName,
              rawInput,
            ),
          );
          if (decision.action === 'require_approval') {
            const approval = ApprovalRequestSchema.parse({
              runId: input.runId,
              taskId,
              toolCallId: call.toolCallId,
              tool: call.toolName,
              input: call.input,
              reason: decision.reason,
            });
            const rawStatus = await dependencies.approvals.status(approval);
            const parsedStatus = ApprovalStatusSchema.safeParse(rawStatus);
            if (!parsedStatus.success) {
              return await finish(
                'failed',
                'Approval service returned an invalid response.',
                'invalid_approval_response',
              );
            }
            const status = parsedStatus.data;
            if (status === 'pending') {
              enqueue(
                eventFor('approval.requested', call, 'approval-requested', {
                  reason: approval.reason,
                }),
              );
              await save();
              await flushOutbox();
              return terminal(transcript, approval, redirectApplied, messageApplied);
            }
            enqueue(eventFor('approval.resolved', call, 'approval-resolved', { decision: status }));
            if (status === 'denied') {
              enqueue(eventFor('tool.started', call, 'started', {}));
              enqueue(eventFor('tool.failed', call, 'failed', { code: 'approval_denied' }));
              transcript.messages.push({
                role: 'tool',
                content: [
                  {
                    type: 'tool-result',
                    toolCallId: call.toolCallId,
                    toolName: call.toolName,
                    output: { type: 'execution-denied', reason: 'Approval was denied.' },
                  },
                ],
              });
              transcript.pendingToolCalls.shift();
              await save();
              await flushOutbox();
              if (input.control?.yieldAfterTool === true) {
                return yielded(transcript, redirectApplied, messageApplied);
              }
              continue;
            }
          }
          if (decision.action === 'deny') {
            enqueue(eventFor('tool.started', call, 'started', {}));
            enqueue(eventFor('tool.failed', call, 'failed', { code: decision.reason }));
            transcript.messages.push({
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  output: { type: 'execution-denied', reason: decision.reason },
                },
              ],
            });
            transcript.pendingToolCalls.shift();
            await save();
            await flushOutbox();
            if (input.control?.yieldAfterTool === true) {
              return yielded(transcript, redirectApplied, messageApplied);
            }
            continue;
          }
          enqueue(eventFor('tool.started', call, 'started', {}));
          await save();
          await flushOutbox();
          transcript.activeToolCallId = call.toolCallId;
          const fence = transcript.nextFence;
          transcript.nextFence += 1;
          transcript.executionLease = {
            toolCallId: call.toolCallId,
            ownerId: workerId,
            fence,
            expiresAtMs: now() + executionLeaseMs,
          };
          await save();
          let renewalError: Error | undefined;
          let renewal = Promise.resolve();
          const renewalTimer = setInterval(
            () => {
              renewal = renewal
                .then(async () => {
                  if (
                    transcript.executionLease?.ownerId !== workerId ||
                    transcript.executionLease.fence !== fence
                  ) {
                    throw new SessionLeaseBusyError();
                  }
                  transcript.executionLease.expiresAtMs = now() + executionLeaseMs;
                  await save();
                })
                .catch((error: unknown) => {
                  renewalError =
                    error instanceof Error ? error : new Error('Execution lease renewal failed');
                  controller.abort(renewalError);
                });
            },
            Math.max(1, Math.floor(executionLeaseMs / 3)),
          );
          let executionOutcome: ToolExecutionWithAudit | undefined;
          let executionError: unknown;
          try {
            const execution = withObservabilitySpan(
              `agent.tool:${call.toolName}`,
              {
                'zapp.organization.id': input.context.scope.organizationId,
                'zapp.project.id': input.context.scope.projectId,
                'zapp.run.id': input.runId,
                'zapp.task.id': taskId,
                'zapp.tool.name': call.toolName,
              },
              async () =>
                dependencies.tools.get(call.toolName).executeWithAudit(
                  rawInput,
                  {
                    organizationId: input.context.scope.organizationId,
                    projectId: input.context.scope.projectId,
                    runId: input.runId,
                    taskId,
                    step: `tool:${call.toolCallId}`,
                  },
                  controller.signal,
                ),
            );
            // ToolRegistry already races the underlying operation against the
            // caller signal and converts cancellation into ToolExecutionError.
            // Await it directly so a late cancellation rejection always has an
            // owning await instead of becoming an unhandled losing race.
            executionOutcome = await execution;
          } catch (error: unknown) {
            executionError = error;
          } finally {
            clearInterval(renewalTimer);
            await renewal;
          }
          if (renewalError !== undefined) throw renewalError;
          if (executionError !== undefined || executionOutcome === undefined) {
            const code =
              executionError instanceof ToolExecutionError ? executionError.code : 'tool_failed';
            enqueue(eventFor('tool.failed', call, 'failed', { code }));
            transcript.messages.push({
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  output: { type: 'error-text', value: `Tool failed: ${code}` },
                },
              ],
            });
            transcript.pendingToolCalls.shift();
            transcript.activeToolCallId = null;
            transcript.executionLease = null;
            await save();
            await flushOutbox();
            if (input.control?.yieldAfterTool === true) {
              return yielded(transcript, redirectApplied, messageApplied);
            }
            continue;
          }
          const executed = executionOutcome;

          const visible = visibleToolOutput(executed.output, call.toolName, dependencies.redact);
          const registryReferences = registryResultReferences(executed.output);
          const collectedReferences = ResultReferencesSchema.parse(
            dependencies.results?.collect({
              tool: call.toolName,
              input: call.input,
              output: executed.output,
            }) ?? { commits: [], artifacts: [] },
          );
          const references = {
            commits: [...registryReferences.commits, ...collectedReferences.commits],
            artifacts: [...registryReferences.artifacts, ...collectedReferences.artifacts],
          };
          transcript.messages.push({
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: { type: 'text', value: visible.wrapped },
              },
            ],
          });
          transcript.pendingToolCalls.shift();
          transcript.completedToolCallIds.push(call.toolCallId);
          if (!transcript.completedToolNames.includes(call.toolName)) {
            transcript.completedToolNames.push(call.toolName);
          }
          if (
            toolOutcomeSucceeded(executed.output) &&
            !transcript.successfulToolNames.includes(call.toolName)
          ) {
            transcript.successfulToolNames.push(call.toolName);
          }
          transcript.activeToolCallId = null;
          transcript.executionLease = null;
          provenance.push({ trust: 'untrusted', source: `tool:${call.toolName}` });
          transcript.provenance = [...provenance];
          appendUnique(transcript.commits, references.commits.map(dependencies.redact));
          appendUnique(transcript.artifacts, references.artifacts.map(dependencies.redact));
          appendUnique(transcript.changedPaths, executed.changedPaths);
          enqueue(eventFor('tool.output', call, 'output', { output: visible.value }));
          enqueue(
            eventFor(
              'tool.completed',
              call,
              'completed',
              { audit: executed.auditPayload },
              executed.output,
            ),
          );
          await save();
          await flushOutbox();
          if (input.control?.yieldAfterTool === true) {
            return yielded(transcript, redirectApplied, messageApplied);
          }
        }
      } finally {
        cleanup();
      }
    },
  };
}
