import { RunModeSchema, TOOL_NAMES } from '@zapp/contracts';
import { ChatMessageSchema, JsonValueSchema } from '@zapp/model-gateway';
import { ContentProvenanceSchema } from '@zapp/agent-policies';
import { z } from 'zod';
import { ContextRoleSchema } from './context.js';

export const TranscriptKeySchema = z
  .object({ runId: z.string().min(1), taskId: z.string().min(1) })
  .strict();
export type TranscriptKey = z.infer<typeof TranscriptKeySchema>;

export const SessionToolCallSchema = z
  .object({
    toolCallId: z.string().min(1),
    toolName: z.enum(TOOL_NAMES),
    input: z.record(JsonValueSchema),
  })
  .strict();
export type SessionToolCall = z.infer<typeof SessionToolCallSchema>;

export const SessionEventRecordSchema = z
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
export type SessionEventRecord = z.infer<typeof SessionEventRecordSchema>;

const ExecutionLeaseSchema = z
  .object({
    toolCallId: z.string().min(1),
    ownerId: z.string().min(1),
    fence: z.number().int().positive().safe(),
    expiresAtMs: z.number().nonnegative().safe(),
  })
  .strict();

const SessionTranscriptBaseSchema = z
  .object({
    key: TranscriptKeySchema,
    version: z.number().int().nonnegative().safe(),
    role: ContextRoleSchema,
    mode: RunModeSchema,
    tools: z.array(z.enum(TOOL_NAMES)),
    budgets: z
      .object({
        maxTurns: z.number().int().positive().safe(),
        maxTokens: z.number().int().positive().safe(),
        maxWallClockMs: z.number().int().positive().safe(),
      })
      .strict(),
    startedAtMs: z.number().nonnegative().safe(),
    provenance: z.array(ContentProvenanceSchema),
    messages: z.array(ChatMessageSchema),
    turns: z.number().int().nonnegative().safe(),
    tokensUsed: z.number().int().nonnegative().safe(),
    completedToolCallIds: z.array(z.string().min(1)),
    pendingToolCalls: z.array(SessionToolCallSchema),
    activeToolCallId: z.string().min(1).nullable(),
    executionLease: ExecutionLeaseSchema.nullable(),
    nextFence: z.number().int().positive().safe(),
    eventOutbox: z.array(
      z.object({ event: SessionEventRecordSchema, delivered: z.boolean() }).strict(),
    ),
    commits: z.array(z.string()),
    artifacts: z.array(z.string()),
    summary: z.string(),
    terminalStatus: z.enum(['completed', 'budget_exhausted', 'failed', 'cancelled']).nullable(),
    terminalErrorCode: z.string().min(1).nullable(),
  })
  .strict();

function validateTranscriptQueue(
  transcript:
    | z.infer<typeof SessionTranscriptBaseSchema>
    | Omit<z.infer<typeof SessionTranscriptBaseSchema>, 'version'>,
  validation: z.RefinementCtx,
): void {
  if (
    transcript.activeToolCallId !== null &&
    transcript.pendingToolCalls[0]?.toolCallId !== transcript.activeToolCallId
  ) {
    validation.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Active tool call must be first in the pending queue',
    });
  }
  if (
    (transcript.activeToolCallId === null) !== (transcript.executionLease === null) ||
    (transcript.executionLease !== null &&
      transcript.executionLease.toolCallId !== transcript.activeToolCallId)
  ) {
    validation.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Active tool call and execution lease must match',
    });
  }
  const allIds = [
    ...transcript.completedToolCallIds,
    ...transcript.pendingToolCalls.map((call) => call.toolCallId),
  ];
  if (new Set(allIds).size !== allIds.length) {
    validation.addIssue({ code: z.ZodIssueCode.custom, message: 'Tool call ids must be unique' });
  }
  const eventKeys = transcript.eventOutbox.map((entry) => entry.event.eventKey);
  if (new Set(eventKeys).size !== eventKeys.length) {
    validation.addIssue({ code: z.ZodIssueCode.custom, message: 'Event keys must be unique' });
  }
}

export const SessionTranscriptSchema =
  SessionTranscriptBaseSchema.superRefine(validateTranscriptQueue);
const SessionTranscriptDraftSchema = SessionTranscriptBaseSchema.omit({
  version: true,
}).superRefine(validateTranscriptQueue);
export type SessionTranscript = z.infer<typeof SessionTranscriptSchema>;
export type SessionTranscriptDraft = Omit<SessionTranscript, 'version'>;

export interface TranscriptStore {
  load(key: unknown): Promise<SessionTranscript | undefined>;
  save(expectedVersion: number | null, transcript: unknown): Promise<SessionTranscript>;
}

export class TranscriptConflictError extends Error {
  constructor() {
    super('Session transcript changed concurrently');
    this.name = 'TranscriptConflictError';
  }
}

function transcriptMapKey(key: TranscriptKey): string {
  return JSON.stringify([key.runId, key.taskId]);
}

export class MemoryTranscriptStore implements TranscriptStore {
  private readonly transcripts = new Map<string, SessionTranscript>();

  load(keyInput: unknown): Promise<SessionTranscript | undefined> {
    const key = TranscriptKeySchema.parse(keyInput);
    const transcript = this.transcripts.get(transcriptMapKey(key));
    return Promise.resolve(
      transcript === undefined
        ? undefined
        : SessionTranscriptSchema.parse(structuredClone(transcript)),
    );
  }

  save(expectedVersion: number | null, transcriptInput: unknown): Promise<SessionTranscript> {
    const draft = SessionTranscriptDraftSchema.parse(transcriptInput);
    const mapKey = transcriptMapKey(draft.key);
    const current = this.transcripts.get(mapKey);
    const actualVersion = current?.version ?? null;
    if (actualVersion !== expectedVersion) return Promise.reject(new TranscriptConflictError());
    const saved = SessionTranscriptSchema.parse({
      ...structuredClone(draft),
      version: (actualVersion ?? -1) + 1,
    });
    this.transcripts.set(mapKey, saved);
    return Promise.resolve(SessionTranscriptSchema.parse(structuredClone(saved)));
  }
}
