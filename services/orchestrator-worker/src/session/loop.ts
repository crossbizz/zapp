import { createHash, randomUUID } from 'node:crypto';

import {
  evaluateToolCall,
  PolicyDecisionSchema,
  wrapUntrusted,
  type ContentProvenance,
} from '@zapp/agent-policies';
import { evaluateRunCreditBudget } from '@zapp/agent-policies/budgets';
import {
  ToolExecutionError,
  type ToolRegistry,
  type ToolExecutionWithAudit,
} from '@zapp/agent-tools';
import { RunModeSchema, TOOL_NAMES, type ToolName } from '@zapp/contracts';
import {
  GatewayStreamEventSchema,
  InputJsonSchema,
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

function requestFingerprint(request: CompleteRequest): string {
  return sha256(JSON.stringify(request));
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
    context: AssembledContextSchema,
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
    status: z.enum(['completed', 'needs_approval', 'budget_exhausted', 'failed', 'cancelled']),
    commits: z.array(z.string()),
    artifacts: z.array(z.string()),
    summary: z.string(),
    pendingApproval: ApprovalRequestSchema.optional(),
  })
  .strict();
export type SessionResult = z.infer<typeof SessionResultSchema>;

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
  .strict();
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
  constructor(readonly code: 'completion_leased' | 'completion_retryable') {
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

function initialMessages(input: SessionInput): {
  messages: ChatMessage[];
  provenance: ContentProvenance[];
} {
  const provenance: ContentProvenance[] = [];
  const sections = input.context.sections.map((section) => {
    if (!UNTRUSTED_CONTEXT_KINDS.has(section.kind)) return `[${section.kind}]\n${section.content}`;
    const wrapped = wrapUntrusted(section.content, `context:${section.kind}`);
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

function visibleToolOutput(
  output: unknown,
  tool: ToolName,
  redact: (value: string) => string,
): { wrapped: string; value: JsonValue } {
  const value = redactJson(output, redact);
  const wrapped = wrapUntrusted(JSON.stringify(value), `tool:${tool}`).content;
  return { wrapped, value };
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

function terminal(transcript: SessionTranscript, pendingApproval?: ApprovalRequest): SessionResult {
  return SessionResultSchema.parse({
    status: transcript.terminalStatus ?? 'needs_approval',
    commits: transcript.commits,
    artifacts: transcript.artifacts,
    summary: transcript.summary,
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
  });
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
        const initial = initialMessages(input);
        provenance = initial.provenance;
        initial.messages[0] = { role: 'system', content: dependencies.prompts[input.role] };
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
          pendingToolCalls: [],
          activeToolCallId: null,
          executionLease: null,
          nextFence: 1,
          eventOutbox: [],
          commits: [],
          artifacts: [],
          summary: '',
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
        status: Exclude<SessionResult['status'], 'needs_approval'>,
        summary: string,
        errorCode: string | null = null,
      ): Promise<SessionResult> => {
        transcript.summary = dependencies.redact(summary);
        transcript.terminalStatus = status;
        transcript.terminalErrorCode = errorCode;
        await save();
        await flushOutbox();
        return terminal(transcript);
      };
      const eventFor = (
        type: SessionEvent['type'],
        call: SessionToolCall,
        suffix: string,
        payload: Record<string, unknown>,
      ): SessionEvent =>
        SessionEventSchema.parse({
          eventKey: `${input.runId}:${taskId}:${call.toolCallId}:${suffix}`,
          runId: input.runId,
          taskId,
          type,
          occurredAt: new Date(now()).toISOString(),
          payload: redactJson(
            { toolCallId: call.toolCallId, tool: call.toolName, ...payload },
            dependencies.redact,
          ),
        });
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
        return terminal(transcript);
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
        return terminal(transcript);
      }

      try {
        for (;;) {
          if (isAborted(controller.signal)) {
            const wallClockExceeded = now() - startedAt >= input.budgets.maxWallClockMs;
            return await finish(
              wallClockExceeded ? 'budget_exhausted' : 'cancelled',
              transcript.summary,
            );
          }
          if (now() - startedAt >= input.budgets.maxWallClockMs) {
            controller.abort(new Error('session_wall_clock_budget'));
            return await finish('budget_exhausted', transcript.summary);
          }
          if (transcript.pendingToolCalls.length === 0) {
            if (
              transcript.turns >= input.budgets.maxTurns ||
              transcript.tokensUsed >= input.budgets.maxTokens
            ) {
              return await finish('budget_exhausted', transcript.summary);
            }
            const tools = input.tools.map((name) => {
              const definition = dependencies.tools.get(name);
              const converted = zodToJsonSchema(definition.inputSchema, { target: 'jsonSchema7' });
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
            const requestBase: CompleteRequest = {
              completionId,
              organizationId: input.context.scope.organizationId,
              projectId: input.context.scope.projectId,
              runId: input.runId,
              taskId,
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
                return await finish('failed', 'Request token counting failed.', 'token_count_failed');
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
              request = {
                ...requestBase,
                maxInputTokens: requestTokens,
                maxOutputTokens: outputTokenAllowance,
              };
              reservedTurnTokens = requestTokens + outputTokenAllowance;
              transcript.tokensUsed += reservedTurnTokens;
              transcript.inFlightCompletion = {
                completionId,
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
              if (requestFingerprint(request) !== transcript.inFlightCompletion.requestFingerprint) {
                throw new Error('Durable completion request fingerprint does not match');
              }
            }
            const text: string[] = [];
            const calls: SessionToolCall[] = [];
            let accountedTurnTokens = reservedTurnTokens;
            let pendingTokenCutoff = false;
            let streamCompleted = false;
            let iterator: AsyncIterator<GatewayStreamEvent> | undefined;
            try {
              iterator = dependencies.gateway
                .stream(request, controller.signal)
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
                  }
                }
                if (event.type === 'usage.recorded') {
                  if (event.completionId !== request.completionId) {
                    throw new Error('Recorded usage completion identity does not match the request');
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
                  if (
                    event.code === 'completion_leased' ||
                    event.code === 'completion_retryable'
                  ) {
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
                  return await finish(
                    'failed',
                    dependencies.redact(event.message),
                    event.code,
                  );
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
            continue;
          }
          const rawInput = rawInputs.get(call.toolCallId) ?? call.input;
          const decision = PolicyDecisionSchema.parse(
            evaluateToolCall(
              {
                mode: input.mode,
                provenance,
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
              return terminal(transcript, approval);
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
          let executionOutcome: ToolExecutionWithAudit | typeof ABORTED | undefined;
          let executionError: unknown;
          try {
            const execution = dependencies.tools.get(call.toolName).executeWithAudit(
              rawInput,
              {
                organizationId: input.context.scope.organizationId,
                projectId: input.context.scope.projectId,
                runId: input.runId,
                taskId,
                step: `tool:${call.toolCallId}`,
              },
              controller.signal,
            );
            executionOutcome = await raceWithAbort(execution, controller.signal);
          } catch (error: unknown) {
            executionError = error;
          } finally {
            clearInterval(renewalTimer);
            await renewal;
          }
          if (renewalError !== undefined) throw renewalError;
          if (executionOutcome === ABORTED) {
            enqueue(eventFor('tool.failed', call, 'failed', { code: 'tool_cancelled' }));
            await save();
            return await finish(
              now() - startedAt >= input.budgets.maxWallClockMs ? 'budget_exhausted' : 'cancelled',
              transcript.summary,
              'tool_cancelled',
            );
          }
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
          transcript.activeToolCallId = null;
          transcript.executionLease = null;
          provenance.push({ trust: 'untrusted', source: `tool:${call.toolName}` });
          transcript.provenance = [...provenance];
          appendUnique(transcript.commits, references.commits.map(dependencies.redact));
          appendUnique(transcript.artifacts, references.artifacts.map(dependencies.redact));
          enqueue(eventFor('tool.output', call, 'output', { output: visible.value }));
          enqueue(eventFor('tool.completed', call, 'completed', { audit: executed.auditPayload }));
          await save();
          await flushOutbox();
        }
      } finally {
        cleanup();
      }
    },
  };
}
