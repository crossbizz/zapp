import {
  evaluateToolCall,
  PolicyDecisionSchema,
  wrapUntrusted,
  type ContentProvenance,
} from '@zapp/agent-policies';
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

const BudgetsSchema = z
  .object({
    maxTurns: z.number().int().positive().safe(),
    maxTokens: z.number().int().positive().safe(),
    maxWallClockMs: z.number().int().positive().safe(),
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
  readonly now?: () => number;
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
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactJson(entry, redact),
      ]),
    );
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

function terminal(
  status: SessionResult['status'],
  summary: string,
  pendingApproval?: ApprovalRequest,
): SessionResult {
  return SessionResultSchema.parse({
    status,
    commits: [],
    artifacts: [],
    summary,
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
  });
}

export function createSessionLoop(dependencies: SessionLoopDependencies) {
  const now = dependencies.now ?? Date.now;

  return {
    async run(inputValue: SessionInput, callerSignal?: AbortSignal): Promise<SessionResult> {
      const input = SessionInputSchema.parse(inputValue);
      const invokedAt = now();
      const taskId = input.taskId ?? input.context.taskId;
      const key = TranscriptKeySchema.parse({ runId: input.runId, taskId });
      const loaded = await dependencies.transcripts.load(key);
      let provenance: ContentProvenance[] = [];
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
          completedToolCallIds: [],
          pendingToolCalls: [],
          activeToolCallId: null,
          summary: '',
          terminalStatus: null,
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
        if (transcript.terminalStatus !== null) {
          return terminal(transcript.terminalStatus, transcript.summary);
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
      const remainingWallClockMs = Math.max(1, input.budgets.maxWallClockMs - (now() - startedAt));
      const timer = setTimeout(() => {
        controller.abort(new Error('session_wall_clock_budget'));
      }, remainingWallClockMs);

      const save = async (): Promise<void> => {
        transcript = await dependencies.transcripts.save(
          transcript.version,
          transcriptDraft(transcript),
        );
      };
      const finish = async (
        status: Exclude<SessionResult['status'], 'needs_approval'>,
        summary: string,
      ): Promise<SessionResult> => {
        transcript.summary = summary;
        transcript.terminalStatus = status;
        await save();
        return terminal(status, summary);
      };
      const emit = async (
        type: SessionEvent['type'],
        call: SessionToolCall,
        suffix: string,
        payload: Record<string, unknown>,
      ): Promise<void> => {
        await dependencies.events.emit(
          SessionEventSchema.parse({
            eventKey: `${input.runId}:${taskId}:${call.toolCallId}:${suffix}`,
            runId: input.runId,
            taskId,
            type,
            occurredAt: new Date(now()).toISOString(),
            payload: { toolCallId: call.toolCallId, tool: call.toolName, ...payload },
          }),
        );
      };

      if (transcript.activeToolCallId !== null) {
        const active = transcript.pendingToolCalls[0];
        if (active === undefined || active.toolCallId !== transcript.activeToolCallId) {
          throw new Error('Durable transcript has an invalid active tool call');
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
        transcript.pendingToolCalls.shift();
        transcript.activeToolCallId = null;
        await save();
        await emit('tool.failed', active, 'outcome-unknown', { code: 'tool_outcome_unknown' });
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
            const request: CompleteRequest = {
              organizationId: input.context.scope.organizationId,
              projectId: input.context.scope.projectId,
              runId: input.runId,
              taskId,
              agentRole: input.role,
              messages: structuredClone(transcript.messages),
              tools,
              maxOutputTokens: Math.max(1, input.budgets.maxTokens - transcript.tokensUsed),
            };
            const text: string[] = [];
            const calls: SessionToolCall[] = [];
            let turnTokens = 0;
            let streamCompleted = false;
            for await (const rawEvent of dependencies.gateway.stream(request, controller.signal)) {
              const event = GatewayStreamEventSchema.parse(rawEvent);
              if (event.type === 'text-delta') text.push(event.text);
              if (event.type === 'usage') turnTokens += usedBy(event);
              if (event.type === 'tool-call') {
                if (!isToolName(event.toolName)) {
                  return await finish('failed', 'The model requested an unknown tool.');
                }
                calls.push(
                  SessionToolCallSchema.parse({
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    input: event.input,
                  }),
                );
              }
              if (event.type === 'error') return await finish('failed', event.message);
              if (event.type === 'done') streamCompleted = true;
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
            transcript.tokensUsed += turnTokens;
            if (transcript.tokensUsed > input.budgets.maxTokens) {
              return await finish('budget_exhausted', transcript.summary);
            }
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
            transcript.summary = text.join('');
            await save();
            if (calls.length === 0) return await finish('completed', transcript.summary);
          }

          const call = transcript.pendingToolCalls[0];
          if (call === undefined) continue;
          if (!input.tools.includes(call.toolName)) {
            await emit('tool.started', call, 'started', {});
            await emit('tool.failed', call, 'failed', { code: 'tool_not_allowed' });
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
            continue;
          }
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
              call.input,
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
            const status = await dependencies.approvals.status(approval);
            if (status === 'pending') {
              await emit('approval.requested', call, 'approval-requested', {
                reason: approval.reason,
              });
              return terminal('needs_approval', transcript.summary, approval);
            }
            await emit('approval.resolved', call, 'approval-resolved', { decision: status });
            if (status === 'denied') {
              await emit('tool.started', call, 'started', {});
              await emit('tool.failed', call, 'failed', { code: 'approval_denied' });
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
              continue;
            }
          }
          if (decision.action === 'deny') {
            await emit('tool.started', call, 'started', {});
            await emit('tool.failed', call, 'failed', { code: decision.reason });
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
            continue;
          }
          transcript.activeToolCallId = call.toolCallId;
          await save();
          await emit('tool.started', call, 'started', {});
          try {
            const executed: ToolExecutionWithAudit = await dependencies.tools
              .get(call.toolName)
              .executeWithAudit(
                call.input,
                {
                  organizationId: input.context.scope.organizationId,
                  projectId: input.context.scope.projectId,
                  runId: input.runId,
                  taskId,
                  step: `tool:${call.toolCallId}`,
                },
                controller.signal,
              );
            const visible = visibleToolOutput(executed.output, call.toolName, dependencies.redact);
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
            provenance.push({ trust: 'untrusted', source: `tool:${call.toolName}` });
            transcript.provenance = [...provenance];
            await save();
            await emit('tool.output', call, 'output', { output: visible.value });
            await emit('tool.completed', call, 'completed', { audit: executed.auditPayload });
          } catch (error: unknown) {
            const code = error instanceof ToolExecutionError ? error.code : 'tool_failed';
            await emit('tool.failed', call, 'failed', { code });
            if (isAborted(controller.signal)) continue;
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
            await save();
          }
        }
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
      }
    },
  };
}
