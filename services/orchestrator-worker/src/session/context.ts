import { createHash } from 'node:crypto';

import { z } from 'zod';

const IdentifierSchema = z.string().min(1).max(256);
const TextSchema = z.string().max(1_000_000);
const RequiredContentSchema = z.string().trim().min(1).max(100_000);
const RequiredTitleSchema = z.string().trim().min(1).max(512);
const AcceptanceCriterionSchema = z.string().trim().min(1).max(10_000);
const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const MAX_ACCEPTANCE_CRITERIA = 100;
const MAX_DECISIONS = 200;
const MAX_FILE_INDEX_ENTRIES = 1_000;
const MAX_DIFFSTAT_FILES = 1_000;
const MAX_RECENT_COMMITS = 100;
const MAX_TRANSCRIPT_EVENTS = 200;
const MAX_EVIDENCE_ARTIFACTS = 200;
const MAX_COMPACTION_RANGES = 1_000;
const MAX_EVENTS_PER_RANGE = 10_000;
const MAX_COMPACTION_ARTIFACTS = 1_000;
const MAX_VERSION_CONFLICT_ATTEMPTS = 3;
const MAX_OUTCOME_RECOVERY_ATTEMPTS = 3;
const SUMMARY_ARTIFACT_ID_NAMESPACE = 'zapp.context-summary.v1';

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function canonicalRepositoryPath(path: string): string {
  return path.normalize('NFC');
}

const AcceptanceCriteriaSchema = z
  .array(AcceptanceCriterionSchema)
  .min(1)
  .max(MAX_ACCEPTANCE_CRITERIA)
  .superRefine((criteria, context) => {
    if (hasDuplicates(criteria)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Criteria must be unique' });
    }
  });

export const RepositoryPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .superRefine((path, context) => {
    const segments = path.split('/');
    const hasUnsafeSegment = segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    );
    if (
      path !== canonicalRepositoryPath(path) ||
      path.startsWith('/') ||
      path.endsWith('/') ||
      path.includes('\\') ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      hasUnsafeSegment
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Path must be normalized' });
    }
  });
export type RepositoryPath = z.infer<typeof RepositoryPathSchema>;

export const CommitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
export type CommitSha = z.infer<typeof CommitShaSchema>;

export const OpaqueArtifactIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
export type OpaqueArtifactId = z.infer<typeof OpaqueArtifactIdSchema>;

export const SourceRevisionSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
export type SourceRevision = z.infer<typeof SourceRevisionSchema>;

export const CompactionOperationIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((operationId) => operationId.trim() === operationId);
export type CompactionOperationId = z.infer<typeof CompactionOperationIdSchema>;

export const ContextRoleSchema = z.enum(['planner', 'builder', 'verifier', 'summarizer']);
export type ContextRole = z.infer<typeof ContextRoleSchema>;

export const ContextScopeSchema = z
  .object({
    organizationId: IdentifierSchema,
    projectId: IdentifierSchema,
    runId: IdentifierSchema,
  })
  .strict();
export type ContextScope = z.infer<typeof ContextScopeSchema>;

export const RunContextRequestSchema = ContextScopeSchema.extend({
  tokenBudget: z.number(),
}).strict();
export type RunContextRequest = z.infer<typeof RunContextRequestSchema>;

export const TaskContextRequestSchema = z.object({ taskId: IdentifierSchema }).strict();
export type TaskContextRequest = z.infer<typeof TaskContextRequestSchema>;

export const ContextRepositoryRequestSchema = ContextScopeSchema.extend({
  taskId: IdentifierSchema,
}).strict();
export type ContextRepositoryRequest = z.infer<typeof ContextRepositoryRequestSchema>;

const ScopedArtifactBaseSchema = z
  .object({
    scope: ContextScopeSchema,
    artifactId: IdentifierSchema,
  })
  .strict();

export const SpecificationContextSourceSchema = ScopedArtifactBaseSchema.extend({
  version: z.number().int().positive().safe(),
  approved: z.literal(true),
  content: RequiredContentSchema,
  acceptanceCriteria: AcceptanceCriteriaSchema,
}).strict();
export type SpecificationContextSource = z.infer<typeof SpecificationContextSourceSchema>;

export const PlanContextSourceSchema = ScopedArtifactBaseSchema.extend({
  version: z.number().int().positive().safe(),
  content: RequiredContentSchema,
  task: z
    .object({
      taskId: IdentifierSchema,
      title: RequiredTitleSchema,
      acceptanceCriteria: AcceptanceCriteriaSchema,
    })
    .strict(),
}).strict();
export type PlanContextSource = z.infer<typeof PlanContextSourceSchema>;

export const DecisionLogContextSourceSchema = ScopedArtifactBaseSchema.extend({
  decisions: z
    .array(
      z
        .object({
          decisionId: IdentifierSchema,
          content: TextSchema,
        })
        .strict(),
    )
    .max(MAX_DECISIONS),
}).strict();
export type DecisionLogContextSource = z.infer<typeof DecisionLogContextSourceSchema>;

export const ArchitectureContextSourceSchema = ScopedArtifactBaseSchema.extend({
  content: TextSchema,
}).strict();
export type ArchitectureContextSource = z.infer<typeof ArchitectureContextSourceSchema>;

export const FileIndexContextSourceSchema = ScopedArtifactBaseSchema.extend({
  files: z
    .array(
      z
        .object({
          path: RepositoryPathSchema,
          sizeBytes: NonnegativeSafeIntegerSchema,
        })
        .strict(),
    )
    .max(MAX_FILE_INDEX_ENTRIES),
})
  .strict()
  .superRefine((source, context) => {
    if (hasDuplicates(source.files.map((file) => canonicalRepositoryPath(file.path)))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'File paths must be unique' });
    }
  });
export type FileIndexContextSource = z.infer<typeof FileIndexContextSourceSchema>;

export const DiffstatFileSchema = z
  .object({
    path: RepositoryPathSchema,
    additions: NonnegativeSafeIntegerSchema,
    deletions: NonnegativeSafeIntegerSchema,
  })
  .strict();
export type DiffstatFile = z.infer<typeof DiffstatFileSchema>;

export const StructuredDiffstatSchema = z
  .object({
    files: z.array(DiffstatFileSchema).max(MAX_DIFFSTAT_FILES),
    additions: NonnegativeSafeIntegerSchema,
    deletions: NonnegativeSafeIntegerSchema,
  })
  .strict()
  .superRefine((diffstat, context) => {
    const additions = diffstat.files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = diffstat.files.reduce((sum, file) => sum + file.deletions, 0);
    if (
      !Number.isSafeInteger(additions) ||
      !Number.isSafeInteger(deletions) ||
      additions !== diffstat.additions ||
      deletions !== diffstat.deletions
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Diffstat totals must match files' });
    }
    if (hasDuplicates(diffstat.files.map((file) => canonicalRepositoryPath(file.path)))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Diffstat paths must be unique' });
    }
  });
export type StructuredDiffstat = z.infer<typeof StructuredDiffstatSchema>;

export const RecentChangesContextSourceSchema = ScopedArtifactBaseSchema.extend({
  commits: z
    .array(
      z
        .object({
          sha: CommitShaSchema,
          message: z.string().trim().min(1).max(10_000),
          diffstat: StructuredDiffstatSchema,
        })
        .strict(),
    )
    .max(MAX_RECENT_COMMITS),
}).strict();
export type RecentChangesContextSource = z.infer<typeof RecentChangesContextSourceSchema>;

export const ContextEventSchema = z
  .object({
    scope: ContextScopeSchema,
    eventId: IdentifierSchema,
    sequence: z.number().int().nonnegative().safe(),
    taskId: IdentifierSchema,
    content: TextSchema,
  })
  .strict();
export type ContextEvent = z.infer<typeof ContextEventSchema>;

export const TranscriptContextSourceSchema = z
  .object({
    scope: ContextScopeSchema,
    taskId: IdentifierSchema,
    events: z.array(ContextEventSchema).max(MAX_TRANSCRIPT_EVENTS),
  })
  .strict()
  .superRefine((source, context) => {
    const eventIds = new Set<string>();
    let previousSequence: number | undefined;
    for (const event of source.events) {
      if (
        eventIds.has(event.eventId) ||
        (previousSequence !== undefined && event.sequence <= previousSequence)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Transcript events must be unique and strictly increasing',
        });
      }
      eventIds.add(event.eventId);
      previousSequence = event.sequence;
    }
  });
export type TranscriptContextSource = z.infer<typeof TranscriptContextSourceSchema>;

export const EvidenceArtifactSchema = ScopedArtifactBaseSchema.extend({
  taskId: IdentifierSchema,
  kind: IdentifierSchema,
  content: TextSchema,
}).strict();
export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

export const EvidenceContextSourceSchema = z
  .object({
    scope: ContextScopeSchema,
    taskId: IdentifierSchema,
    artifacts: z.array(EvidenceArtifactSchema).max(MAX_EVIDENCE_ARTIFACTS),
  })
  .strict();
export type EvidenceContextSource = z.infer<typeof EvidenceContextSourceSchema>;

export const ContextSourceBundleSchema = z
  .object({
    scope: ContextScopeSchema,
    specification: SpecificationContextSourceSchema,
    plan: PlanContextSourceSchema,
    decisionLog: DecisionLogContextSourceSchema,
    architectureSummary: ArchitectureContextSourceSchema,
    fileIndex: FileIndexContextSourceSchema,
    recentChanges: RecentChangesContextSourceSchema,
    transcript: TranscriptContextSourceSchema,
    evidence: EvidenceContextSourceSchema,
  })
  .strict();
export type ContextSourceBundle = z.infer<typeof ContextSourceBundleSchema>;

export const EventRangeLinkSchema = z
  .object({
    runId: IdentifierSchema,
    startEventId: IdentifierSchema,
    endEventId: IdentifierSchema,
    startSequence: z.number().int().nonnegative().safe(),
    endSequence: z.number().int().nonnegative().safe(),
  })
  .strict();
export type EventRangeLink = z.infer<typeof EventRangeLinkSchema>;

export const SourceArtifactLinkSchema = z
  .object({
    runId: IdentifierSchema,
    artifactId: IdentifierSchema,
  })
  .strict();
export type SourceArtifactLink = z.infer<typeof SourceArtifactLinkSchema>;

export const CompactionEventRangeSchema = z
  .object({
    link: EventRangeLinkSchema,
    events: z.array(ContextEventSchema).min(1).max(MAX_EVENTS_PER_RANGE),
  })
  .strict();
export type CompactionEventRange = z.infer<typeof CompactionEventRangeSchema>;

export const CompactionArtifactSchema = z
  .object({
    link: SourceArtifactLinkSchema,
    scope: ContextScopeSchema,
    kind: IdentifierSchema,
    content: TextSchema,
  })
  .strict();
export type CompactionArtifact = z.infer<typeof CompactionArtifactSchema>;

export const CompactionSourceBundleSchema = z
  .object({
    scope: ContextScopeSchema,
    eventRanges: z.array(CompactionEventRangeSchema).max(MAX_COMPACTION_RANGES),
    artifacts: z.array(CompactionArtifactSchema).max(MAX_COMPACTION_ARTIFACTS),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.eventRanges.length === 0 && source.artifacts.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provenance is required' });
    }

    const eventIds = new Set<string>();
    const eventSequences = new Set<number>();
    let previousEnd: number | undefined;
    for (const range of source.eventRanges) {
      const first = range.events[0];
      const last = range.events.at(-1);
      const isContiguous = range.events.every(
        (event, index) => event.sequence === range.link.startSequence + index,
      );
      const hasDuplicate = range.events.some((event) => {
        const duplicate = eventIds.has(event.eventId) || eventSequences.has(event.sequence);
        eventIds.add(event.eventId);
        eventSequences.add(event.sequence);
        return duplicate;
      });
      if (
        first === undefined ||
        last === undefined ||
        range.link.startSequence > range.link.endSequence ||
        first.eventId !== range.link.startEventId ||
        first.sequence !== range.link.startSequence ||
        last.eventId !== range.link.endEventId ||
        last.sequence !== range.link.endSequence ||
        !isContiguous ||
        hasDuplicate ||
        (previousEnd !== undefined && range.link.startSequence !== previousEnd + 1) ||
        range.link.runId !== source.scope.runId ||
        range.events.some((event) => !scopesMatch(event.scope, source.scope))
      ) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event provenance is invalid' });
      }
      previousEnd = range.link.endSequence;
    }

    const artifactLinks = source.artifacts.map(
      (artifact) => `${artifact.link.runId}\u0000${artifact.link.artifactId}`,
    );
    if (
      hasDuplicates(artifactLinks) ||
      source.artifacts.some(
        (artifact) =>
          artifact.link.runId !== source.scope.runId || !scopesMatch(artifact.scope, source.scope),
      )
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Artifact links must be unique' });
    }
  });
export type CompactionSourceBundle = z.infer<typeof CompactionSourceBundleSchema>;

export const ContextSectionKindSchema = z.enum([
  'sourceLinks',
  'specificationAcceptanceCriteria',
  'specification',
  'currentPlan',
  'currentTask',
  'taskAcceptanceCriteria',
  'decisionLog',
  'architectureSummary',
  'fileIndex',
  'recentChanges',
  'taskTranscript',
  'evidence',
]);
export type ContextSectionKind = z.infer<typeof ContextSectionKindSchema>;

export const AssembledContextSectionSchema = z
  .object({
    kind: ContextSectionKindSchema,
    content: TextSchema,
    tokenCount: z.number().int().nonnegative().safe(),
    sourceArtifactIds: z.array(IdentifierSchema),
    sourceEventIds: z.array(IdentifierSchema),
  })
  .strict();
export type AssembledContextSection = z.infer<typeof AssembledContextSectionSchema>;

export const AssembledContextSchema = z
  .object({
    role: ContextRoleSchema,
    scope: ContextScopeSchema,
    taskId: IdentifierSchema,
    tokenBudget: z.number().int().positive().safe(),
    tokenCount: z.number().int().nonnegative().safe(),
    sections: z.array(AssembledContextSectionSchema),
  })
  .strict();
export type AssembledContext = z.infer<typeof AssembledContextSchema>;

export const CompactContextRequestSchema = z
  .object({
    runId: IdentifierSchema,
    operationId: CompactionOperationIdSchema,
  })
  .strict();
export type CompactContextRequest = z.infer<typeof CompactContextRequestSchema>;

export const CompactionSnapshotRequestSchema = z.object({ runId: IdentifierSchema }).strict();
export type CompactionSnapshotRequest = z.infer<typeof CompactionSnapshotRequestSchema>;

export const CompactionSnapshotSchema = z
  .object({
    source: CompactionSourceBundleSchema,
    latestVersion: NonnegativeSafeIntegerSchema,
    sourceRevision: SourceRevisionSchema,
  })
  .strict();
export type CompactionSnapshot = z.infer<typeof CompactionSnapshotSchema>;

export const SummaryArtifactSchema = z
  .object({
    artifactId: OpaqueArtifactIdSchema,
    kind: z.literal('context-summary'),
    scope: ContextScopeSchema,
    version: z.number().int().positive().safe(),
    content: TextSchema,
    tokenCount: z.number().int().nonnegative().safe(),
    sourceEventRanges: z.array(EventRangeLinkSchema).max(MAX_COMPACTION_RANGES),
    sourceArtifacts: z.array(SourceArtifactLinkSchema).max(MAX_COMPACTION_ARTIFACTS),
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.sourceEventRanges.length === 0 && summary.sourceArtifacts.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provenance is required' });
    }

    let previousEnd: number | undefined;
    const eventIds = new Set<string>();
    for (const range of summary.sourceEventRanges) {
      const span = range.endSequence - range.startSequence + 1;
      const duplicateStart = eventIds.has(range.startEventId);
      eventIds.add(range.startEventId);
      const duplicateEnd =
        range.endEventId !== range.startEventId && eventIds.has(range.endEventId);
      eventIds.add(range.endEventId);
      const hasInvalidEndpoints =
        (span === 1 && range.startEventId !== range.endEventId) ||
        (span > 1 && range.startEventId === range.endEventId);
      if (
        range.startSequence > range.endSequence ||
        (previousEnd !== undefined && range.startSequence !== previousEnd + 1) ||
        range.runId !== summary.scope.runId ||
        duplicateStart ||
        duplicateEnd ||
        hasInvalidEndpoints ||
        !Number.isSafeInteger(span) ||
        span > MAX_EVENTS_PER_RANGE
      ) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event ranges are invalid' });
      }
      previousEnd = range.endSequence;
    }

    const artifactLinks = summary.sourceArtifacts.map(
      (artifact) => `${artifact.runId}\u0000${artifact.artifactId}`,
    );
    if (
      hasDuplicates(artifactLinks) ||
      summary.sourceArtifacts.some((artifact) => artifact.runId !== summary.scope.runId)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Artifact links must be unique' });
    }
  });
export type SummaryArtifact = z.infer<typeof SummaryArtifactSchema>;

export const AtomicCompactionRequestSchema = z
  .object({
    operationId: CompactionOperationIdSchema,
    artifactId: OpaqueArtifactIdSchema,
    expectedPreviousVersion: NonnegativeSafeIntegerSchema,
    sourceRevision: SourceRevisionSchema,
    scope: ContextScopeSchema,
    content: TextSchema,
    tokenCount: NonnegativeSafeIntegerSchema,
    sourceEventRanges: z.array(EventRangeLinkSchema).max(MAX_COMPACTION_RANGES),
    sourceArtifacts: z.array(SourceArtifactLinkSchema).max(MAX_COMPACTION_ARTIFACTS),
  })
  .strict()
  .superRefine((request, context) => {
    const summaryShape = {
      artifactId: request.artifactId,
      kind: 'context-summary' as const,
      scope: request.scope,
      version: request.expectedPreviousVersion + 1,
      content: request.content,
      tokenCount: request.tokenCount,
      sourceEventRanges: request.sourceEventRanges,
      sourceArtifacts: request.sourceArtifacts,
    };
    if (!SummaryArtifactSchema.safeParse(summaryShape).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Compaction summary payload is invalid',
      });
    }
  });
export type AtomicCompactionRequest = z.infer<typeof AtomicCompactionRequestSchema>;

const CommittedCompactionResultSchema = z
  .object({ status: z.literal('committed'), summary: SummaryArtifactSchema })
  .strict();
const IdempotentCompactionResultSchema = z
  .object({ status: z.literal('idempotent'), summary: SummaryArtifactSchema })
  .strict();
const VersionConflictCompactionResultSchema = z
  .object({
    status: z.literal('version-conflict'),
    currentVersion: NonnegativeSafeIntegerSchema,
  })
  .strict();
const ArtifactIdCollisionCompactionResultSchema = z
  .object({ status: z.literal('artifact-id-collision') })
  .strict();

export const CompactionCommitResultSchema = z.discriminatedUnion('status', [
  CommittedCompactionResultSchema,
  IdempotentCompactionResultSchema,
  VersionConflictCompactionResultSchema,
  ArtifactIdCollisionCompactionResultSchema,
]);
export type CompactionCommitResult = z.infer<typeof CompactionCommitResultSchema>;

export const ContextErrorCodeSchema = z.enum([
  'MALFORMED_INPUT',
  'UNSAFE_BUDGET',
  'REPOSITORY_FAILURE',
  'REPOSITORY_RESULT',
  'CROSS_SCOPE',
  'UNRESOLVED_LINK',
  'SCRUBBER_FAILURE',
  'TOKEN_COUNTER_FAILURE',
  'IDENTITY_SCRUBBED',
  'OUTCOME_UNKNOWN',
  'ARTIFACT_ID_COLLISION',
]);
export type ContextErrorCode = z.infer<typeof ContextErrorCodeSchema>;

export const ContextErrorRecordSchema = z
  .object({
    code: ContextErrorCodeSchema,
    message: z.string(),
  })
  .strict();
export type ContextErrorRecord = z.infer<typeof ContextErrorRecordSchema>;

const ERROR_MESSAGES: Readonly<Record<ContextErrorCode, string>> = {
  MALFORMED_INPUT: 'Context input is malformed',
  UNSAFE_BUDGET: 'Token budget must be a positive safe integer',
  REPOSITORY_FAILURE: 'Context repository operation failed',
  REPOSITORY_RESULT: 'Context repository returned malformed data',
  CROSS_SCOPE: 'Context source scope does not match the request',
  UNRESOLVED_LINK: 'Context source link cannot be resolved',
  SCRUBBER_FAILURE: 'Context secret scrubber failed',
  TOKEN_COUNTER_FAILURE: 'Context token counter failed',
  IDENTITY_SCRUBBED: 'Context identity changed during secret scrubbing',
  OUTCOME_UNKNOWN: 'Context compaction outcome is unknown',
  ARTIFACT_ID_COLLISION: 'Context summary artifact identity collision',
};

export class ContextError extends Error {
  readonly code: ContextErrorCode;

  constructor(code: ContextErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContextError';
    this.code = code;
  }

  toRecord(): ContextErrorRecord {
    return ContextErrorRecordSchema.parse({
      code: this.code,
      message: this.message,
    });
  }
}

export interface ContextRepository {
  fetchContext(request: ContextRepositoryRequest): Promise<unknown>;
  fetchCompactionSnapshot(request: CompactionSnapshotRequest): Promise<unknown>;
  commitCompaction(request: AtomicCompactionRequest): Promise<unknown>;
  resolveEventRange(link: EventRangeLink): Promise<unknown>;
  resolveArtifact(link: SourceArtifactLink): Promise<unknown>;
}

export interface ContextServiceDependencies {
  repository: ContextRepository;
  scrub: (value: string) => string;
  countTokens: (value: string) => number;
  compactionTokenBudget: number;
}

export interface ContextService {
  assembleContext(role: unknown, run: unknown, task: unknown): Promise<AssembledContext>;
  compact(request: unknown): Promise<SummaryArtifact>;
}

type SectionSeed = Omit<AssembledContextSection, 'tokenCount'>;

const ROLE_PRIORITIES: Readonly<Record<ContextRole, readonly ContextSectionKind[]>> = {
  verifier: [
    'taskAcceptanceCriteria',
    'evidence',
    'taskTranscript',
    'currentTask',
    'currentPlan',
    'fileIndex',
    'specificationAcceptanceCriteria',
    'specification',
    'decisionLog',
    'architectureSummary',
    'recentChanges',
    'sourceLinks',
  ],
  builder: [
    'taskAcceptanceCriteria',
    'currentTask',
    'fileIndex',
    'architectureSummary',
    'currentPlan',
    'decisionLog',
    'specificationAcceptanceCriteria',
    'specification',
    'recentChanges',
    'taskTranscript',
    'evidence',
    'sourceLinks',
  ],
  planner: [
    'specificationAcceptanceCriteria',
    'specification',
    'currentPlan',
    'decisionLog',
    'architectureSummary',
    'currentTask',
    'taskAcceptanceCriteria',
    'recentChanges',
    'fileIndex',
    'taskTranscript',
    'evidence',
    'sourceLinks',
  ],
  summarizer: [
    'sourceLinks',
    'specificationAcceptanceCriteria',
    'taskAcceptanceCriteria',
    'specification',
    'currentPlan',
    'decisionLog',
    'evidence',
    'currentTask',
    'architectureSummary',
    'fileIndex',
    'recentChanges',
    'taskTranscript',
  ],
};

function parseBoundary<T>(schema: z.ZodType<T>, value: unknown, code: ContextErrorCode): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ContextError(code);
  }
  return result.data;
}

function assertBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ContextError('UNSAFE_BUDGET');
  }
}

function scrubText(value: string, scrub: ContextServiceDependencies['scrub']): string {
  try {
    const scrubbed: unknown = scrub(value);
    if (typeof scrubbed !== 'string') {
      throw new ContextError('SCRUBBER_FAILURE');
    }
    return scrubbed;
  } catch (error) {
    if (error instanceof ContextError) {
      throw error;
    }
    throw new ContextError('SCRUBBER_FAILURE');
  }
}

function scrubValue<T>(value: T, scrub: ContextServiceDependencies['scrub']): T;
function scrubValue(value: unknown, scrub: ContextServiceDependencies['scrub']): unknown {
  if (typeof value === 'string') {
    return scrubText(value, scrub);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => scrubValue(item, scrub));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubValue(item, scrub)]),
    );
  }
  return value;
}

function countTokens(value: string, counter: ContextServiceDependencies['countTokens']): number {
  try {
    const count: unknown = counter(value);
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new ContextError('TOKEN_COUNTER_FAILURE');
    }
    return count;
  } catch (error) {
    if (error instanceof ContextError) {
      throw error;
    }
    throw new ContextError('TOKEN_COUNTER_FAILURE');
  }
}

async function callRepository(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch {
    throw new ContextError('REPOSITORY_FAILURE');
  }
}

function scopesMatch(left: ContextScope, right: ContextScope): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.projectId === right.projectId &&
    left.runId === right.runId
  );
}

function assertContextScope(
  source: ContextSourceBundle,
  scope: ContextScope,
  taskId: string,
): void {
  const scopedValues = [
    source.scope,
    source.specification.scope,
    source.plan.scope,
    source.decisionLog.scope,
    source.architectureSummary.scope,
    source.fileIndex.scope,
    source.recentChanges.scope,
    source.transcript.scope,
    source.evidence.scope,
    ...source.transcript.events.map((event) => event.scope),
    ...source.evidence.artifacts.map((artifact) => artifact.scope),
  ];

  if (scopedValues.some((value) => !scopesMatch(value, scope))) {
    throw new ContextError('CROSS_SCOPE');
  }

  const sourceTaskIds = [
    source.plan.task.taskId,
    source.transcript.taskId,
    source.evidence.taskId,
    ...source.transcript.events.map((event) => event.taskId),
    ...source.evidence.artifacts.map((artifact) => artifact.taskId),
  ];
  if (sourceTaskIds.some((value) => value !== taskId)) {
    throw new ContextError('CROSS_SCOPE');
  }
}

function assemblyIdentity(
  role: ContextRole,
  run: RunContextRequest,
  task: TaskContextRequest,
  source: ContextSourceBundle,
): unknown {
  return {
    role,
    run,
    task,
    source: {
      scope: source.scope,
      specification: {
        scope: source.specification.scope,
        artifactId: source.specification.artifactId,
        version: source.specification.version,
        approved: source.specification.approved,
      },
      plan: {
        scope: source.plan.scope,
        artifactId: source.plan.artifactId,
        version: source.plan.version,
        taskId: source.plan.task.taskId,
      },
      decisionLog: {
        scope: source.decisionLog.scope,
        artifactId: source.decisionLog.artifactId,
        decisionIds: source.decisionLog.decisions.map((decision) => decision.decisionId),
      },
      architectureSummary: {
        scope: source.architectureSummary.scope,
        artifactId: source.architectureSummary.artifactId,
      },
      fileIndex: {
        scope: source.fileIndex.scope,
        artifactId: source.fileIndex.artifactId,
        files: source.fileIndex.files.map((file) => ({
          path: file.path,
          sizeBytes: file.sizeBytes,
        })),
      },
      recentChanges: {
        scope: source.recentChanges.scope,
        artifactId: source.recentChanges.artifactId,
        commits: source.recentChanges.commits.map((commit) => ({
          sha: commit.sha,
          diffstat: commit.diffstat,
        })),
      },
      transcript: {
        scope: source.transcript.scope,
        taskId: source.transcript.taskId,
        events: source.transcript.events.map((event) => ({
          scope: event.scope,
          eventId: event.eventId,
          sequence: event.sequence,
          taskId: event.taskId,
        })),
      },
      evidence: {
        scope: source.evidence.scope,
        taskId: source.evidence.taskId,
        artifacts: source.evidence.artifacts.map((artifact) => ({
          scope: artifact.scope,
          artifactId: artifact.artifactId,
          taskId: artifact.taskId,
          kind: artifact.kind,
        })),
      },
    },
  };
}

function assertScrubPreservesAssemblyIdentity(
  role: ContextRole,
  run: RunContextRequest,
  task: TaskContextRequest,
  source: ContextSourceBundle,
  scrubbedRole: ContextRole,
  scrubbedRun: RunContextRequest,
  scrubbedTask: TaskContextRequest,
  scrubbedSource: ContextSourceBundle,
): void {
  if (
    !valuesMatch(
      assemblyIdentity(role, run, task, source),
      assemblyIdentity(scrubbedRole, scrubbedRun, scrubbedTask, scrubbedSource),
    )
  ) {
    throw new ContextError('IDENTITY_SCRUBBED');
  }
}

function joinLines(values: readonly string[]): string {
  return values.join('\n');
}

function formatDiffstat(diffstat: StructuredDiffstat): string {
  const files = diffstat.files.map(
    (file) => `${file.path}\t+${String(file.additions)}\t-${String(file.deletions)}`,
  );
  return joinLines([
    ...files,
    `total\t+${String(diffstat.additions)}\t-${String(diffstat.deletions)}`,
  ]);
}

function makeSectionSeeds(source: ContextSourceBundle): SectionSeed[] {
  const artifactIds = [
    source.specification.artifactId,
    source.plan.artifactId,
    source.decisionLog.artifactId,
    source.architectureSummary.artifactId,
    source.fileIndex.artifactId,
    source.recentChanges.artifactId,
    ...source.evidence.artifacts.map((artifact) => artifact.artifactId),
  ];
  const eventIds = source.transcript.events.map((event) => event.eventId);
  const seeds: SectionSeed[] = [
    {
      kind: 'sourceLinks',
      content: JSON.stringify({ artifactIds, eventIds }),
      sourceArtifactIds: artifactIds,
      sourceEventIds: eventIds,
    },
    {
      kind: 'specificationAcceptanceCriteria',
      content: joinLines(source.specification.acceptanceCriteria),
      sourceArtifactIds: [source.specification.artifactId],
      sourceEventIds: [],
    },
    {
      kind: 'specification',
      content: source.specification.content,
      sourceArtifactIds: [source.specification.artifactId],
      sourceEventIds: [],
    },
    {
      kind: 'currentPlan',
      content: source.plan.content,
      sourceArtifactIds: [source.plan.artifactId],
      sourceEventIds: [],
    },
    {
      kind: 'currentTask',
      content: `${source.plan.task.taskId}\n${source.plan.task.title}`,
      sourceArtifactIds: [source.plan.artifactId],
      sourceEventIds: [],
    },
    {
      kind: 'taskAcceptanceCriteria',
      content: joinLines(source.plan.task.acceptanceCriteria),
      sourceArtifactIds: [source.plan.artifactId],
      sourceEventIds: [],
    },
    {
      kind: 'decisionLog',
      content: joinLines(
        source.decisionLog.decisions.map(
          (decision) => `${decision.decisionId}: ${decision.content}`,
        ),
      ),
      sourceArtifactIds: [source.decisionLog.artifactId],
      sourceEventIds: [],
    },
    {
      kind: 'architectureSummary',
      content: source.architectureSummary.content,
      sourceArtifactIds: [source.architectureSummary.artifactId],
      sourceEventIds: [],
    },
    {
      kind: 'fileIndex',
      content: joinLines(
        source.fileIndex.files.map((file) => `${file.path}\t${String(file.sizeBytes)}`),
      ),
      sourceArtifactIds: [source.fileIndex.artifactId],
      sourceEventIds: [],
    },
    {
      kind: 'recentChanges',
      content: joinLines(
        source.recentChanges.commits.map(
          (commit) => `${commit.sha} ${commit.message}\n${formatDiffstat(commit.diffstat)}`,
        ),
      ),
      sourceArtifactIds: [source.recentChanges.artifactId],
      sourceEventIds: [],
    },
    {
      kind: 'taskTranscript',
      content: joinLines(
        source.transcript.events.map((event) => `[${String(event.sequence)}] ${event.content}`),
      ),
      sourceArtifactIds: [],
      sourceEventIds: eventIds,
    },
    {
      kind: 'evidence',
      content: joinLines(
        source.evidence.artifacts.map((artifact) => `[${artifact.kind}] ${artifact.content}`),
      ),
      sourceArtifactIds: source.evidence.artifacts.map((artifact) => artifact.artifactId),
      sourceEventIds: [],
    },
  ];

  return seeds.filter((seed) => seed.content.length > 0);
}

function budgetSections(
  seeds: readonly SectionSeed[],
  priority: readonly ContextSectionKind[],
  budget: number,
  counter: ContextServiceDependencies['countTokens'],
): AssembledContextSection[] {
  const byKind = new Map(seeds.map((seed) => [seed.kind, seed]));
  const sections = priority.flatMap((kind) => {
    const seed = byKind.get(kind);
    if (seed === undefined) {
      return [];
    }
    return [
      parseBoundary(
        AssembledContextSectionSchema,
        {
          ...seed,
          tokenCount: countTokens(seed.content, counter),
        },
        'REPOSITORY_RESULT',
      ),
    ];
  });

  let total = sections.reduce((sum, section) => sum + section.tokenCount, 0);
  while (total > budget) {
    const removed = sections.pop();
    if (removed === undefined) {
      break;
    }
    total -= removed.tokenCount;
  }
  return sections;
}

function assertCompactionScope(source: CompactionSourceBundle, runId: string): void {
  if (source.scope.runId !== runId) {
    throw new ContextError('CROSS_SCOPE');
  }

  for (const range of source.eventRanges) {
    if (range.link.runId !== runId) {
      throw new ContextError('UNRESOLVED_LINK');
    }
    if (range.events.some((event) => !scopesMatch(event.scope, source.scope))) {
      throw new ContextError('CROSS_SCOPE');
    }
  }

  for (const artifact of source.artifacts) {
    if (artifact.link.runId !== runId || !scopesMatch(artifact.scope, source.scope)) {
      throw new ContextError('CROSS_SCOPE');
    }
  }
}

function compactionIdentity(source: CompactionSourceBundle): unknown {
  return {
    scope: source.scope,
    eventRanges: source.eventRanges.map((range) => ({
      link: range.link,
      events: range.events.map((event) => ({
        scope: event.scope,
        eventId: event.eventId,
        sequence: event.sequence,
        taskId: event.taskId,
      })),
    })),
    artifacts: source.artifacts.map((artifact) => ({
      link: artifact.link,
      scope: artifact.scope,
      kind: artifact.kind,
    })),
  };
}

function assertScrubPreservesCompactionIdentity(
  source: CompactionSourceBundle,
  scrubbedSource: CompactionSourceBundle,
): void {
  if (!valuesMatch(compactionIdentity(source), compactionIdentity(scrubbedSource))) {
    throw new ContextError('IDENTITY_SCRUBBED');
  }
}

function deriveSummaryArtifactId(
  runId: string,
  operationId: CompactionOperationId,
  scrub: ContextServiceDependencies['scrub'],
): OpaqueArtifactId {
  const digest = createHash('sha256')
    .update(JSON.stringify([SUMMARY_ARTIFACT_ID_NAMESPACE, runId, operationId]))
    .digest('hex');
  const artifactId = `ctxsum_${digest}`;
  const scrubbedArtifactId = scrubText(artifactId, scrub);
  if (scrubbedArtifactId !== artifactId) {
    throw new ContextError('IDENTITY_SCRUBBED');
  }
  return parseBoundary(OpaqueArtifactIdSchema, scrubbedArtifactId, 'REPOSITORY_RESULT');
}

async function assertCompactionSourcesResolvable(
  repository: ContextRepository,
  source: CompactionSourceBundle,
): Promise<void> {
  for (const range of source.eventRanges) {
    const rawResolved = await callRepository(() => repository.resolveEventRange(range.link));
    if (rawResolved === null) {
      throw new ContextError('UNRESOLVED_LINK');
    }
    const resolved = parseBoundary(
      CompactionEventRangeSchema,
      rawResolved,
      'REPOSITORY_RESULT',
    );
    if (!valuesMatch(resolved, range)) {
      throw new ContextError('UNRESOLVED_LINK');
    }
  }

  for (const artifact of source.artifacts) {
    const rawResolved = await callRepository(() => repository.resolveArtifact(artifact.link));
    if (rawResolved === null) {
      throw new ContextError('UNRESOLVED_LINK');
    }
    const resolved = parseBoundary(
      CompactionArtifactSchema,
      rawResolved,
      'REPOSITORY_RESULT',
    );
    if (!valuesMatch(resolved, artifact)) {
      throw new ContextError('UNRESOLVED_LINK');
    }
  }
}

function valuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type CompactionSeed = {
  content: string;
  priority: number;
  stableId: string;
};

function artifactPriority(kind: string): number {
  const priorities: Readonly<Record<string, number>> = {
    specification: 0,
    plan: 1,
    decision: 2,
    architecture: 3,
    evidence: 4,
    test: 4,
    runtime: 4,
  };
  return priorities[kind] ?? 5;
}

function buildCompactionContent(
  source: CompactionSourceBundle,
  budget: number,
  counter: ContextServiceDependencies['countTokens'],
): { content: string; tokenCount: number } {
  const seeds: CompactionSeed[] = [
    ...source.artifacts.map((artifact) => {
      const content = `[artifact ${artifact.kind}:${artifact.link.artifactId}]\n${artifact.content}`;
      return {
        content,
        priority: artifactPriority(artifact.kind),
        stableId: artifact.link.artifactId,
      };
    }),
    ...source.eventRanges.map((range) => {
      const content = `[events ${String(range.link.startSequence)}-${String(range.link.endSequence)}]\n${joinLines(range.events.map((event) => event.content))}`;
      return {
        content,
        priority: 6,
        stableId: `${String(range.link.startSequence)}:${range.link.startEventId}`,
      };
    }),
  ].sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    if (left.stableId < right.stableId) {
      return -1;
    }
    if (left.stableId > right.stableId) {
      return 1;
    }
    return 0;
  });

  let content = seeds.map((seed) => seed.content).join('\n\n');
  let tokenCount = countTokens(content, counter);
  while (tokenCount > budget && seeds.length > 0) {
    seeds.pop();
    content = seeds.map((seed) => seed.content).join('\n\n');
    tokenCount = countTokens(content, counter);
  }
  return { content, tokenCount };
}

function expectedSummaryFields(request: AtomicCompactionRequest): Omit<SummaryArtifact, 'version'> {
  return {
    artifactId: request.artifactId,
    kind: 'context-summary',
    scope: request.scope,
    content: request.content,
    tokenCount: request.tokenCount,
    sourceEventRanges: request.sourceEventRanges,
    sourceArtifacts: request.sourceArtifacts,
  };
}

function assertExactCompactionResult(
  request: AtomicCompactionRequest,
  result: Extract<CompactionCommitResult, { status: 'committed' | 'idempotent' }>,
): SummaryArtifact {
  const maximumResultVersion = request.expectedPreviousVersion + 1;
  // A commit creates exactly the next version; an idempotent replay may return its earlier
  // original version, but can never claim a version beyond the request's observed next slot.
  const hasInvalidVersion =
    result.status === 'committed'
      ? result.summary.version !== maximumResultVersion
      : result.summary.version > maximumResultVersion;
  if (
    !valuesMatch(
      {
        artifactId: result.summary.artifactId,
        kind: result.summary.kind,
        scope: result.summary.scope,
        content: result.summary.content,
        tokenCount: result.summary.tokenCount,
        sourceEventRanges: result.summary.sourceEventRanges,
        sourceArtifacts: result.summary.sourceArtifacts,
      },
      expectedSummaryFields(request),
    ) ||
    hasInvalidVersion
  ) {
    throw new ContextError('REPOSITORY_RESULT');
  }
  return result.summary;
}

async function commitWithOutcomeRecovery(
  repository: ContextRepository,
  request: AtomicCompactionRequest,
): Promise<Exclude<CompactionCommitResult, { status: 'artifact-id-collision' }>> {
  let outcomeWasUnknown = false;
  for (let attempt = 0; attempt < MAX_OUTCOME_RECOVERY_ATTEMPTS; attempt += 1) {
    let rawResult: unknown;
    try {
      rawResult = await repository.commitCompaction(request);
    } catch {
      outcomeWasUnknown = true;
      continue;
    }

    const parsed = CompactionCommitResultSchema.safeParse(rawResult);
    if (!parsed.success) {
      outcomeWasUnknown = true;
      continue;
    }
    if (parsed.data.status === 'artifact-id-collision') {
      throw new ContextError('ARTIFACT_ID_COLLISION');
    }
    if (parsed.data.status === 'version-conflict') {
      if (!outcomeWasUnknown) {
        return parsed.data;
      }
      continue;
    }
    try {
      assertExactCompactionResult(request, parsed.data);
      return parsed.data;
    } catch (error) {
      if (!(error instanceof ContextError) || error.code !== 'REPOSITORY_RESULT') {
        throw error;
      }
      outcomeWasUnknown = true;
    }
  }

  throw new ContextError('OUTCOME_UNKNOWN');
}

export function createContextService(dependencies: ContextServiceDependencies): ContextService {
  assertBudget(dependencies.compactionTokenBudget);

  return {
    async assembleContext(roleInput, runInput, taskInput) {
      const role = parseBoundary(ContextRoleSchema, roleInput, 'MALFORMED_INPUT');
      const run = parseBoundary(RunContextRequestSchema, runInput, 'MALFORMED_INPUT');
      const task = parseBoundary(TaskContextRequestSchema, taskInput, 'MALFORMED_INPUT');
      assertBudget(run.tokenBudget);

      const request = parseBoundary(
        ContextRepositoryRequestSchema,
        {
          organizationId: run.organizationId,
          projectId: run.projectId,
          runId: run.runId,
          taskId: task.taskId,
        },
        'MALFORMED_INPUT',
      );
      const rawResult = await callRepository(() => dependencies.repository.fetchContext(request));
      const source = parseBoundary(ContextSourceBundleSchema, rawResult, 'REPOSITORY_RESULT');
      assertContextScope(source, run, task.taskId);

      const scrubbedRoleValue = scrubValue(role, dependencies.scrub);
      const scrubbedRunValue = scrubValue(run, dependencies.scrub);
      const scrubbedTaskValue = scrubValue(task, dependencies.scrub);
      const scrubbedSourceValue = scrubValue(source, dependencies.scrub);
      assertScrubPreservesAssemblyIdentity(
        role,
        run,
        task,
        source,
        scrubbedRoleValue,
        scrubbedRunValue,
        scrubbedTaskValue,
        scrubbedSourceValue,
      );

      const scrubbedRole = parseBoundary(
        ContextRoleSchema,
        scrubbedRoleValue,
        'SCRUBBER_FAILURE',
      );
      const scrubbedRun = parseBoundary(
        RunContextRequestSchema,
        scrubbedRunValue,
        'SCRUBBER_FAILURE',
      );
      const scrubbedTask = parseBoundary(
        TaskContextRequestSchema,
        scrubbedTaskValue,
        'SCRUBBER_FAILURE',
      );
      const scrubbedSource = parseBoundary(
        ContextSourceBundleSchema,
        scrubbedSourceValue,
        'SCRUBBER_FAILURE',
      );
      assertContextScope(scrubbedSource, scrubbedRun, scrubbedTask.taskId);

      const sections = budgetSections(
        makeSectionSeeds(scrubbedSource),
        ROLE_PRIORITIES[scrubbedRole],
        scrubbedRun.tokenBudget,
        dependencies.countTokens,
      );
      return parseBoundary(
        AssembledContextSchema,
        {
          role: scrubbedRole,
          scope: {
            organizationId: scrubbedRun.organizationId,
            projectId: scrubbedRun.projectId,
            runId: scrubbedRun.runId,
          },
          taskId: scrubbedTask.taskId,
          tokenBudget: scrubbedRun.tokenBudget,
          tokenCount: sections.reduce((sum, section) => sum + section.tokenCount, 0),
          sections,
        },
        'REPOSITORY_RESULT',
      );
    },
    async compact(requestInput) {
      const request = parseBoundary(
        CompactContextRequestSchema,
        requestInput,
        'MALFORMED_INPUT',
      );
      const scrubbedRequest = parseBoundary(
        CompactContextRequestSchema,
        scrubValue(request, dependencies.scrub),
        'SCRUBBER_FAILURE',
      );
      if (!valuesMatch(scrubbedRequest, request)) {
        throw new ContextError('IDENTITY_SCRUBBED');
      }
      const artifactId = deriveSummaryArtifactId(
        scrubbedRequest.runId,
        scrubbedRequest.operationId,
        dependencies.scrub,
      );
      const snapshotRequest = parseBoundary(
        CompactionSnapshotRequestSchema,
        { runId: scrubbedRequest.runId },
        'MALFORMED_INPUT',
      );
      for (let attempt = 0; attempt < MAX_VERSION_CONFLICT_ATTEMPTS; attempt += 1) {
        const rawSnapshot = await callRepository(() =>
          dependencies.repository.fetchCompactionSnapshot(snapshotRequest),
        );
        const snapshot = parseBoundary(
          CompactionSnapshotSchema,
          rawSnapshot,
          'REPOSITORY_RESULT',
        );
        assertCompactionScope(snapshot.source, scrubbedRequest.runId);
        if (!Number.isSafeInteger(snapshot.latestVersion + 1)) {
          throw new ContextError('REPOSITORY_RESULT');
        }
        const scrubbedSourceRevision = scrubText(
          snapshot.sourceRevision,
          dependencies.scrub,
        );
        if (scrubbedSourceRevision !== snapshot.sourceRevision) {
          throw new ContextError('IDENTITY_SCRUBBED');
        }
        await assertCompactionSourcesResolvable(dependencies.repository, snapshot.source);

        const scrubbedSourceValue = scrubValue(snapshot.source, dependencies.scrub);
        assertScrubPreservesCompactionIdentity(snapshot.source, scrubbedSourceValue);
        const scrubbedSource = parseBoundary(
          CompactionSourceBundleSchema,
          scrubbedSourceValue,
          'SCRUBBER_FAILURE',
        );
        assertCompactionScope(scrubbedSource, scrubbedRequest.runId);
        const compacted = buildCompactionContent(
          scrubbedSource,
          dependencies.compactionTokenBudget,
          dependencies.countTokens,
        );
        const atomicRequest = parseBoundary(
          AtomicCompactionRequestSchema,
          {
            operationId: scrubbedRequest.operationId,
            artifactId,
            expectedPreviousVersion: snapshot.latestVersion,
            sourceRevision: snapshot.sourceRevision,
            scope: scrubbedSource.scope,
            content: compacted.content,
            tokenCount: compacted.tokenCount,
            sourceEventRanges: scrubbedSource.eventRanges.map((range) => range.link),
            sourceArtifacts: scrubbedSource.artifacts.map((artifact) => artifact.link),
          },
          'REPOSITORY_RESULT',
        );
        const result = await commitWithOutcomeRecovery(
          dependencies.repository,
          atomicRequest,
        );
        if (result.status === 'version-conflict') {
          continue;
        }
        return result.summary;
      }

      throw new ContextError('REPOSITORY_FAILURE');
    },
  };
}
