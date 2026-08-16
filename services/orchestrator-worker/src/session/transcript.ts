import { RunModeSchema, TOOL_NAMES } from '@zapp/contracts';
import {
  agentRuns,
  builderSessionTranscripts,
  type Database,
} from '@zapp/db';
import { ChatMessageSchema, CompleteRequestSchema, JsonValueSchema } from '@zapp/model-gateway';
import { ContentProvenanceSchema } from '@zapp/agent-policies';
import { and, eq } from 'drizzle-orm';
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
export type SessionEventRecord = z.infer<typeof SessionEventRecordSchema>;

const ExecutionLeaseSchema = z
  .object({
    toolCallId: z.string().min(1),
    ownerId: z.string().min(1),
    fence: z.number().int().positive().safe(),
    expiresAtMs: z.number().nonnegative().safe(),
  })
  .strict();

export const InFlightCompletionSchema = z
  .object({
    completionId: z.string().regex(/^cmp_[a-f0-9]{64}$/u),
    requestVersion: z.union([z.literal(1), z.literal(2)]).default(1),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    requestTokens: z.number().int().nonnegative().safe(),
    reservedTokens: z.number().int().positive().safe(),
    request: CompleteRequestSchema,
  })
  .strict()
  .superRefine((completion, validation) => {
    if (completion.request.completionId !== completion.completionId) {
      validation.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'In-flight completion identity must match its request',
      });
    }
    if (
      completion.reservedTokens !==
      completion.requestTokens + completion.request.maxOutputTokens
    ) {
      validation.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'In-flight completion reservation must match the request limit',
      });
    }
  });
export type InFlightCompletion = z.infer<typeof InFlightCompletionSchema>;

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
    inFlightCompletion: InFlightCompletionSchema.nullable().default(null),
    completedToolCallIds: z.array(z.string().min(1)),
    appliedRedirectOperationKeys: z
      .array(z.string().regex(/^op_[a-f0-9]{64}$/u))
      .max(100)
      .default([]),
    appliedMessageOperationKeys: z
      .array(z.string().regex(/^op_[a-f0-9]{64}$/u))
      .max(1_000)
      .default([]),
    completedToolNames: z.array(z.enum(TOOL_NAMES)).default([]),
    successfulToolNames: z.array(z.enum(TOOL_NAMES)).default([]),
    prototypeMocks: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(160),
            reason: z.string().trim().min(1).max(1_000),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    pendingToolCalls: z.array(SessionToolCallSchema),
    activeToolCallId: z.string().min(1).nullable(),
    executionLease: ExecutionLeaseSchema.nullable(),
    nextFence: z.number().int().positive().safe(),
    eventOutbox: z.array(
      z.object({ event: SessionEventRecordSchema, delivered: z.boolean() }).strict(),
    ),
    changedPaths: z.array(z.string().min(1).max(4_096)).max(10_000).default([]),
    commits: z.array(z.string()),
    artifacts: z.array(z.string()),
    summary: z.string(),
    model: z.string().min(1).max(160).nullable().default(null),
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

interface HydratableTranscriptStore extends TranscriptStore {
  hydrate(expectedVersion: number | null, transcript: unknown): Promise<SessionTranscript>;
}

export const MAX_TEMPORAL_TRANSCRIPT_BYTES = 1_500_000;

function assertCheckpointPayloadSize(
  transcript: SessionTranscript,
  maxSerializedBytes: number,
): void {
  const checkpoint = {
    runId: transcript.key.runId,
    taskId: transcript.key.taskId,
    transcript,
  };
  if (Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') > maxSerializedBytes) {
    throw new Error('Session checkpoint exceeds the Temporal payload size limit');
  }
}

function isHydratableTranscriptStore(store: TranscriptStore): store is HydratableTranscriptStore {
  return 'hydrate' in store && typeof store.hydrate === 'function';
}

export class CheckpointTranscriptStore implements HydratableTranscriptStore {
  private transcript: SessionTranscript | undefined;

  constructor(
    seed: SessionTranscript | null | undefined,
    private readonly persist: (transcript: SessionTranscript) => void | Promise<void>,
    private readonly maxSerializedBytes = MAX_TEMPORAL_TRANSCRIPT_BYTES,
  ) {
    this.transcript =
      seed === null || seed === undefined
        ? undefined
        : SessionTranscriptSchema.parse(structuredClone(seed));
  }

  load(keyInput: unknown): Promise<SessionTranscript | undefined> {
    const key = TranscriptKeySchema.parse(keyInput);
    if (this.transcript === undefined) return Promise.resolve(undefined);
    if (transcriptMapKey(this.transcript.key) !== transcriptMapKey(key)) {
      return Promise.reject(new Error('Checkpoint transcript key does not match the activity'));
    }
    return Promise.resolve(SessionTranscriptSchema.parse(structuredClone(this.transcript)));
  }

  async save(expectedVersion: number | null, transcriptInput: unknown): Promise<SessionTranscript> {
    const draft = SessionTranscriptDraftSchema.parse(transcriptInput);
    const actualVersion = this.transcript?.version ?? null;
    if (actualVersion !== expectedVersion) throw new TranscriptConflictError();
    if (
      this.transcript !== undefined &&
      transcriptMapKey(this.transcript.key) !== transcriptMapKey(draft.key)
    ) {
      throw new Error('Checkpoint transcript key cannot change');
    }
    const saved = SessionTranscriptSchema.parse({
      ...structuredClone(draft),
      version: (actualVersion ?? -1) + 1,
    });
    assertCheckpointPayloadSize(saved, this.maxSerializedBytes);
    await this.persist(saved);
    this.transcript = saved;
    return SessionTranscriptSchema.parse(structuredClone(saved));
  }

  async hydrate(
    expectedVersion: number | null,
    transcriptInput: unknown,
  ): Promise<SessionTranscript> {
    const saved = SessionTranscriptSchema.parse(structuredClone(transcriptInput));
    const actualVersion = this.transcript?.version ?? null;
    if (actualVersion !== expectedVersion || saved.version <= (actualVersion ?? -1)) {
      throw new TranscriptConflictError();
    }
    if (
      this.transcript !== undefined &&
      transcriptMapKey(this.transcript.key) !== transcriptMapKey(saved.key)
    ) {
      throw new Error('Checkpoint transcript key cannot change');
    }
    assertCheckpointPayloadSize(saved, this.maxSerializedBytes);
    await this.persist(saved);
    this.transcript = saved;
    return SessionTranscriptSchema.parse(structuredClone(saved));
  }
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

function transcriptDraft(transcript: SessionTranscript): SessionTranscriptDraft {
  const { version, ...draft } = transcript;
  void version;
  return draft;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function transcriptsMatch(left: SessionTranscript, right: SessionTranscript): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertTranscriptScope(
  key: TranscriptKey,
  scope: { readonly runId: string; readonly taskId: string },
): void {
  if (key.runId !== scope.runId || key.taskId !== scope.taskId) {
    throw new Error('Session transcript key is outside the configured run and task scope');
  }
}

/** PostgreSQL-backed transcript CAS, scoped to one tenant run and Builder task. */
export class DatabaseTranscriptStore implements HydratableTranscriptStore {
  private readonly scope: {
    readonly organizationId: string;
    readonly runId: string;
    readonly taskId: string;
  };

  constructor(
    private readonly database: Database,
    scope: { readonly organizationId: string; readonly runId: string; readonly taskId: string },
    private readonly maxSerializedBytes = MAX_TEMPORAL_TRANSCRIPT_BYTES,
  ) {
    this.scope = z
      .object({
        organizationId: z.string().min(1),
        runId: z.string().min(1),
        taskId: z.string().min(1),
      })
      .strict()
      .parse(scope);
  }

  async load(keyInput: unknown): Promise<SessionTranscript | undefined> {
    const key = TranscriptKeySchema.parse(keyInput);
    assertTranscriptScope(key, this.scope);
    const [row] = await this.database
      .select({
        version: builderSessionTranscripts.version,
        transcriptJson: builderSessionTranscripts.transcriptJson,
      })
      .from(builderSessionTranscripts)
      .innerJoin(agentRuns, eq(agentRuns.id, builderSessionTranscripts.runId))
      .where(
        and(
          eq(builderSessionTranscripts.organizationId, this.scope.organizationId),
          eq(builderSessionTranscripts.runId, this.scope.runId),
          eq(builderSessionTranscripts.taskId, this.scope.taskId),
          eq(agentRuns.organizationId, this.scope.organizationId),
        ),
      )
      .limit(1);
    if (row === undefined) return undefined;
    const transcript = SessionTranscriptSchema.parse(row.transcriptJson);
    assertTranscriptScope(transcript.key, this.scope);
    if (transcript.version !== row.version) {
      throw new Error('Stored session transcript version does not match its row version');
    }
    return SessionTranscriptSchema.parse(structuredClone(transcript));
  }

  async save(expectedVersion: number | null, transcriptInput: unknown): Promise<SessionTranscript> {
    const expected = z.number().int().nonnegative().safe().nullable().parse(expectedVersion);
    const draft = SessionTranscriptDraftSchema.parse(transcriptInput);
    assertTranscriptScope(draft.key, this.scope);
    const saved = SessionTranscriptSchema.parse({
      ...structuredClone(draft),
      version: (expected ?? -1) + 1,
    });
    assertCheckpointPayloadSize(saved, this.maxSerializedBytes);
    return await this.persist(expected, saved);
  }

  async hydrate(
    expectedVersion: number | null,
    transcriptInput: unknown,
  ): Promise<SessionTranscript> {
    const expected = z.number().int().nonnegative().safe().nullable().parse(expectedVersion);
    const saved = SessionTranscriptSchema.parse(structuredClone(transcriptInput));
    assertTranscriptScope(saved.key, this.scope);
    if (saved.version <= (expected ?? -1)) throw new TranscriptConflictError();
    assertCheckpointPayloadSize(saved, this.maxSerializedBytes);
    return await this.persist(expected, saved);
  }

  private async persist(
    expected: number | null,
    saved: SessionTranscript,
  ): Promise<SessionTranscript> {
    return await this.database.transaction(async (transaction) => {
      const [run] = await transaction
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, this.scope.runId),
            eq(agentRuns.organizationId, this.scope.organizationId),
          ),
        )
        .limit(1);
      if (run === undefined) {
        throw new Error('Session transcript run was not found in the configured tenant scope');
      }

      const rows =
        expected === null
          ? await transaction
              .insert(builderSessionTranscripts)
              .values({
                organizationId: this.scope.organizationId,
                runId: this.scope.runId,
                taskId: this.scope.taskId,
                version: saved.version,
                transcriptJson: saved,
                updatedAt: new Date(),
              })
              .onConflictDoNothing({
                target: [builderSessionTranscripts.runId, builderSessionTranscripts.taskId],
              })
              .returning({ version: builderSessionTranscripts.version })
          : await transaction
              .update(builderSessionTranscripts)
              .set({
                version: saved.version,
                transcriptJson: saved,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(builderSessionTranscripts.organizationId, this.scope.organizationId),
                  eq(builderSessionTranscripts.runId, this.scope.runId),
                  eq(builderSessionTranscripts.taskId, this.scope.taskId),
                  eq(builderSessionTranscripts.version, expected),
                ),
              )
              .returning({ version: builderSessionTranscripts.version });
      if (rows[0]?.version !== saved.version) throw new TranscriptConflictError();
      return SessionTranscriptSchema.parse(structuredClone(saved));
    });
  }
}

/**
 * Writes PostgreSQL before the Temporal checkpoint. If acknowledgement fails after
 * the durable write, the next activity heals the lagging checkpoint before resuming.
 */
export class ReplicatedTranscriptStore implements TranscriptStore {
  private constructor(
    private readonly durable: TranscriptStore,
    private readonly checkpoint: TranscriptStore,
    private transcript: SessionTranscript | undefined,
  ) {}

  static async open(
    keyInput: unknown,
    durable: TranscriptStore,
    checkpoint: TranscriptStore,
  ): Promise<ReplicatedTranscriptStore> {
    const key = TranscriptKeySchema.parse(keyInput);
    let [durableTranscript, checkpointTranscript] = await Promise.all([
      durable.load(key),
      checkpoint.load(key),
    ]);
    if (
      durableTranscript !== undefined &&
      checkpointTranscript !== undefined &&
      durableTranscript.version === checkpointTranscript.version &&
      !transcriptsMatch(durableTranscript, checkpointTranscript)
    ) {
      throw new TranscriptConflictError();
    }
    const selected =
      durableTranscript === undefined
        ? checkpointTranscript
        : checkpointTranscript === undefined || durableTranscript.version >= checkpointTranscript.version
          ? durableTranscript
          : checkpointTranscript;
    if (selected !== undefined) {
      durableTranscript = await ReplicatedTranscriptStore.advanceTo(
        durable,
        durableTranscript,
        selected,
      );
      checkpointTranscript = await ReplicatedTranscriptStore.advanceTo(
        checkpoint,
        checkpointTranscript,
        selected,
      );
      if (
        durableTranscript.version !== checkpointTranscript.version ||
        !transcriptsMatch(durableTranscript, checkpointTranscript)
      ) {
        throw new TranscriptConflictError();
      }
    }
    return new ReplicatedTranscriptStore(durable, checkpoint, selected);
  }

  private static async advanceTo(
    store: TranscriptStore,
    current: SessionTranscript | undefined,
    selected: SessionTranscript,
  ): Promise<SessionTranscript> {
    if (current !== undefined && current.version === selected.version) {
      if (!transcriptsMatch(current, selected)) throw new TranscriptConflictError();
      return current;
    }
    if ((current?.version ?? -1) > selected.version) throw new TranscriptConflictError();
    const expectedVersion = current?.version ?? null;
    const synchronized = isHydratableTranscriptStore(store)
      ? await store.hydrate(expectedVersion, selected)
      : selected.version === (expectedVersion ?? -1) + 1
        ? await store.save(expectedVersion, transcriptDraft(selected))
        : undefined;
    if (synchronized === undefined || !transcriptsMatch(synchronized, selected)) {
      throw new TranscriptConflictError();
    }
    return synchronized;
  }

  load(keyInput: unknown): Promise<SessionTranscript | undefined> {
    const key = TranscriptKeySchema.parse(keyInput);
    if (this.transcript === undefined) return Promise.resolve(undefined);
    if (transcriptMapKey(this.transcript.key) !== transcriptMapKey(key)) {
      return Promise.reject(new Error('Replicated transcript key does not match the activity'));
    }
    return Promise.resolve(SessionTranscriptSchema.parse(structuredClone(this.transcript)));
  }

  async save(expectedVersion: number | null, transcriptInput: unknown): Promise<SessionTranscript> {
    const actualVersion = this.transcript?.version ?? null;
    if (actualVersion !== expectedVersion) throw new TranscriptConflictError();
    const durableSaved = await this.durable.save(expectedVersion, transcriptInput);
    const checkpointSaved = await this.checkpoint.save(expectedVersion, transcriptInput);
    if (
      durableSaved.version !== checkpointSaved.version ||
      !transcriptsMatch(durableSaved, checkpointSaved)
    ) {
      throw new TranscriptConflictError();
    }
    this.transcript = durableSaved;
    return SessionTranscriptSchema.parse(structuredClone(durableSaved));
  }
}

export class MemoryTranscriptStore implements HydratableTranscriptStore {
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

  hydrate(expectedVersion: number | null, transcriptInput: unknown): Promise<SessionTranscript> {
    const saved = SessionTranscriptSchema.parse(structuredClone(transcriptInput));
    const mapKey = transcriptMapKey(saved.key);
    const current = this.transcripts.get(mapKey);
    const actualVersion = current?.version ?? null;
    if (actualVersion !== expectedVersion || saved.version <= (actualVersion ?? -1)) {
      return Promise.reject(new TranscriptConflictError());
    }
    this.transcripts.set(mapKey, saved);
    return Promise.resolve(SessionTranscriptSchema.parse(structuredClone(saved)));
  }
}
