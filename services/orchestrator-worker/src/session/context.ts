import { z } from 'zod';

const IdentifierSchema = z.string().min(1).max(256);
const TextSchema = z.string().max(1_000_000);

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
  content: TextSchema,
  acceptanceCriteria: z.array(TextSchema),
}).strict();
export type SpecificationContextSource = z.infer<typeof SpecificationContextSourceSchema>;

export const PlanContextSourceSchema = ScopedArtifactBaseSchema.extend({
  version: z.number().int().positive().safe(),
  content: TextSchema,
  task: z
    .object({
      taskId: IdentifierSchema,
      title: TextSchema,
      acceptanceCriteria: z.array(TextSchema),
    })
    .strict(),
}).strict();
export type PlanContextSource = z.infer<typeof PlanContextSourceSchema>;

export const DecisionLogContextSourceSchema = ScopedArtifactBaseSchema.extend({
  decisions: z.array(
    z
      .object({
        decisionId: IdentifierSchema,
        content: TextSchema,
      })
      .strict(),
  ),
}).strict();
export type DecisionLogContextSource = z.infer<typeof DecisionLogContextSourceSchema>;

export const ArchitectureContextSourceSchema = ScopedArtifactBaseSchema.extend({
  content: TextSchema,
}).strict();
export type ArchitectureContextSource = z.infer<typeof ArchitectureContextSourceSchema>;

export const FileIndexContextSourceSchema = ScopedArtifactBaseSchema.extend({
  files: z.array(
    z
      .object({
        path: TextSchema,
        sizeBytes: z.number().int().nonnegative().safe(),
      })
      .strict(),
  ),
}).strict();
export type FileIndexContextSource = z.infer<typeof FileIndexContextSourceSchema>;

export const RecentChangesContextSourceSchema = ScopedArtifactBaseSchema.extend({
  commits: z.array(
    z
      .object({
        sha: IdentifierSchema,
        message: TextSchema,
        diffstat: TextSchema,
      })
      .strict(),
  ),
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
    events: z.array(ContextEventSchema),
  })
  .strict();
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
    artifacts: z.array(EvidenceArtifactSchema),
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
    events: z.array(ContextEventSchema).min(1),
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
    eventRanges: z.array(CompactionEventRangeSchema),
    artifacts: z.array(CompactionArtifactSchema),
  })
  .strict();
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

export const SummaryArtifactSchema = z
  .object({
    artifactId: IdentifierSchema,
    kind: z.literal('context-summary'),
    scope: ContextScopeSchema,
    version: z.number().int().positive().safe(),
    content: TextSchema,
    tokenCount: z.number().int().nonnegative().safe(),
    sourceEventRanges: z.array(EventRangeLinkSchema),
    sourceArtifacts: z.array(SourceArtifactLinkSchema),
  })
  .strict();
export type SummaryArtifact = z.infer<typeof SummaryArtifactSchema>;

export const ContextErrorCodeSchema = z.enum([
  'MALFORMED_INPUT',
  'UNSAFE_BUDGET',
  'REPOSITORY_FAILURE',
  'REPOSITORY_RESULT',
  'CROSS_SCOPE',
  'UNRESOLVED_LINK',
  'SCRUBBER_FAILURE',
  'TOKEN_COUNTER_FAILURE',
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
  fetchCompactionSources(runId: string): Promise<unknown>;
  getLatestSummary(runId: string): Promise<unknown>;
  appendSummary(summary: SummaryArtifact): Promise<unknown>;
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
  compact(runId: unknown): Promise<SummaryArtifact>;
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

function scrubValue(value: unknown, scrub: ContextServiceDependencies['scrub']): unknown {
  if (typeof value === 'string') {
    return scrubText(value, scrub);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, scrub));
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

function joinLines(values: readonly string[]): string {
  return values.join('\n');
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
          (commit) => `${commit.sha} ${commit.message}\n${commit.diffstat}`,
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
      AssembledContextSectionSchema.parse({
        ...seed,
        tokenCount: countTokens(seed.content, counter),
      }),
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
    const first = range.events[0];
    const last = range.events.at(-1);
    const hasWrongScope = range.events.some((event) => !scopesMatch(event.scope, source.scope));
    let previousSequence: number | undefined;
    const isOutOfOrder = range.events.some((event) => {
      const outOfOrder = previousSequence !== undefined && event.sequence <= previousSequence;
      previousSequence = event.sequence;
      return outOfOrder;
    });
    if (
      range.link.runId !== runId ||
      first === undefined ||
      last === undefined ||
      first.eventId !== range.link.startEventId ||
      first.sequence !== range.link.startSequence ||
      last.eventId !== range.link.endEventId ||
      last.sequence !== range.link.endSequence ||
      hasWrongScope ||
      isOutOfOrder
    ) {
      throw new ContextError('UNRESOLVED_LINK');
    }
  }

  for (const artifact of source.artifacts) {
    if (artifact.link.runId !== runId || !scopesMatch(artifact.scope, source.scope)) {
      throw new ContextError('CROSS_SCOPE');
    }
  }
}

function valuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function assertResolvableEventRange(
  repository: ContextRepository,
  expected: CompactionEventRange,
): Promise<void> {
  const link = EventRangeLinkSchema.parse(expected.link);
  const result = await callRepository(() => repository.resolveEventRange(link));
  if (result === null) {
    throw new ContextError('UNRESOLVED_LINK');
  }
  const resolved = parseBoundary(CompactionEventRangeSchema, result, 'REPOSITORY_RESULT');
  if (!valuesMatch(resolved, expected)) {
    throw new ContextError('UNRESOLVED_LINK');
  }
}

async function assertResolvableArtifact(
  repository: ContextRepository,
  expected: CompactionArtifact,
): Promise<void> {
  const link = SourceArtifactLinkSchema.parse(expected.link);
  const result = await callRepository(() => repository.resolveArtifact(link));
  if (result === null) {
    throw new ContextError('UNRESOLVED_LINK');
  }
  const resolved = parseBoundary(CompactionArtifactSchema, result, 'REPOSITORY_RESULT');
  if (!valuesMatch(resolved, expected)) {
    throw new ContextError('UNRESOLVED_LINK');
  }
}

async function assertSummaryLinksResolvable(
  repository: ContextRepository,
  summary: SummaryArtifact,
): Promise<void> {
  for (const link of summary.sourceEventRanges) {
    const result = await callRepository(() => repository.resolveEventRange(link));
    if (result === null) {
      throw new ContextError('UNRESOLVED_LINK');
    }
    parseBoundary(CompactionEventRangeSchema, result, 'REPOSITORY_RESULT');
  }
  for (const link of summary.sourceArtifacts) {
    const result = await callRepository(() => repository.resolveArtifact(link));
    if (result === null) {
      throw new ContextError('UNRESOLVED_LINK');
    }
    parseBoundary(CompactionArtifactSchema, result, 'REPOSITORY_RESULT');
  }
}

type CompactionSeed = {
  content: string;
  priority: number;
  stableId: string;
  tokenCount: number;
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
        tokenCount: countTokens(content, counter),
      };
    }),
    ...source.eventRanges.map((range) => {
      const content = `[events ${String(range.link.startSequence)}-${String(range.link.endSequence)}]\n${joinLines(range.events.map((event) => event.content))}`;
      return {
        content,
        priority: 6,
        stableId: `${String(range.link.startSequence)}:${range.link.startEventId}`,
        tokenCount: countTokens(content, counter),
      };
    }),
  ].sort(
    (left, right) => left.priority - right.priority || left.stableId.localeCompare(right.stableId),
  );

  let total = seeds.reduce((sum, seed) => sum + seed.tokenCount, 0);
  while (total > budget) {
    const removed = seeds.pop();
    if (removed === undefined) {
      break;
    }
    total -= removed.tokenCount;
  }
  return { content: seeds.map((seed) => seed.content).join('\n\n'), tokenCount: total };
}

export function createContextService(dependencies: ContextServiceDependencies): ContextService {
  assertBudget(dependencies.compactionTokenBudget);

  return {
    async assembleContext(roleInput, runInput, taskInput) {
      const role = parseBoundary(ContextRoleSchema, roleInput, 'MALFORMED_INPUT');
      const run = parseBoundary(RunContextRequestSchema, runInput, 'MALFORMED_INPUT');
      const task = parseBoundary(TaskContextRequestSchema, taskInput, 'MALFORMED_INPUT');
      assertBudget(run.tokenBudget);

      const request = ContextRepositoryRequestSchema.parse({
        organizationId: run.organizationId,
        projectId: run.projectId,
        runId: run.runId,
        taskId: task.taskId,
      });
      const rawResult = await callRepository(() => dependencies.repository.fetchContext(request));
      const source = parseBoundary(ContextSourceBundleSchema, rawResult, 'REPOSITORY_RESULT');
      assertContextScope(source, run, task.taskId);

      const scrubbedRole = parseBoundary(
        ContextRoleSchema,
        scrubValue(role, dependencies.scrub),
        'SCRUBBER_FAILURE',
      );
      const scrubbedRun = parseBoundary(
        RunContextRequestSchema,
        scrubValue(run, dependencies.scrub),
        'SCRUBBER_FAILURE',
      );
      const scrubbedTask = parseBoundary(
        TaskContextRequestSchema,
        scrubValue(task, dependencies.scrub),
        'SCRUBBER_FAILURE',
      );
      const scrubbedSource = parseBoundary(
        ContextSourceBundleSchema,
        scrubValue(source, dependencies.scrub),
        'SCRUBBER_FAILURE',
      );
      assertContextScope(scrubbedSource, scrubbedRun, scrubbedTask.taskId);

      const sections = budgetSections(
        makeSectionSeeds(scrubbedSource),
        ROLE_PRIORITIES[scrubbedRole],
        scrubbedRun.tokenBudget,
        dependencies.countTokens,
      );
      return AssembledContextSchema.parse({
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
      });
    },
    async compact(runIdInput) {
      const runId = parseBoundary(IdentifierSchema, runIdInput, 'MALFORMED_INPUT');
      const [rawSourceResult, rawLatestResult] = await Promise.all([
        callRepository(() => dependencies.repository.fetchCompactionSources(runId)),
        callRepository(() => dependencies.repository.getLatestSummary(runId)),
      ]);
      const source = parseBoundary(
        CompactionSourceBundleSchema,
        rawSourceResult,
        'REPOSITORY_RESULT',
      );
      const latest = parseBoundary(
        SummaryArtifactSchema.nullable(),
        rawLatestResult,
        'REPOSITORY_RESULT',
      );
      assertCompactionScope(source, runId);
      if (
        latest !== null &&
        (!scopesMatch(latest.scope, source.scope) || latest.scope.runId !== runId)
      ) {
        throw new ContextError('CROSS_SCOPE');
      }

      for (const range of source.eventRanges) {
        await assertResolvableEventRange(dependencies.repository, range);
      }
      for (const artifact of source.artifacts) {
        await assertResolvableArtifact(dependencies.repository, artifact);
      }

      const scrubbedSource = parseBoundary(
        CompactionSourceBundleSchema,
        scrubValue(source, dependencies.scrub),
        'SCRUBBER_FAILURE',
      );
      const scrubbedRunId = parseBoundary(
        IdentifierSchema,
        scrubValue(runId, dependencies.scrub),
        'SCRUBBER_FAILURE',
      );
      assertCompactionScope(scrubbedSource, scrubbedRunId);

      const previousVersion = latest?.version ?? 0;
      if (!Number.isSafeInteger(previousVersion + 1)) {
        throw new ContextError('REPOSITORY_RESULT');
      }
      const version = previousVersion + 1;
      const compacted = buildCompactionContent(
        scrubbedSource,
        dependencies.compactionTokenBudget,
        dependencies.countTokens,
      );
      const summary = SummaryArtifactSchema.parse({
        artifactId: `context-summary:${scrubbedRunId}:v${String(version)}`,
        kind: 'context-summary',
        scope: scrubbedSource.scope,
        version,
        content: compacted.content,
        tokenCount: compacted.tokenCount,
        sourceEventRanges: scrubbedSource.eventRanges.map((range) => range.link),
        sourceArtifacts: scrubbedSource.artifacts.map((artifact) => artifact.link),
      });

      await assertSummaryLinksResolvable(dependencies.repository, summary);
      const rawSaved = await callRepository(() => dependencies.repository.appendSummary(summary));
      const saved = parseBoundary(SummaryArtifactSchema, rawSaved, 'REPOSITORY_RESULT');
      if (!valuesMatch(saved, summary)) {
        throw new ContextError('REPOSITORY_RESULT');
      }
      await assertSummaryLinksResolvable(dependencies.repository, saved);
      return saved;
    },
  };
}
