import { describe, expect, it, vi } from 'vitest';

import {
  CompactionCommitResultSchema,
  CompactionSourceBundleSchema,
  ContextError,
  ContextSourceBundleSchema,
  OpaqueArtifactIdSchema,
  SummaryArtifactSchema,
  createContextService,
  type AtomicCompactionRequest,
  type CompactionSourceBundle,
  type ContextRepository,
  type ContextSourceBundle,
  type SummaryArtifact,
} from '../src/session/context.js';

const SCOPE = {
  organizationId: 'organization-1',
  projectId: 'project-1',
  runId: 'run-1',
} as const;

const TASK = { taskId: 'task-1' } as const;
const OTHER_TASK_ID = 'task-2';
const SENSITIVE_VALUE = 'sensitive-fixture-value';

function makeContextSource(): ContextSourceBundle {
  return ContextSourceBundleSchema.parse({
    scope: SCOPE,
    specification: {
      scope: SCOPE,
      artifactId: 'specification-2',
      version: 2,
      approved: true,
      content: 'approved specification',
      acceptanceCriteria: ['spec criterion alpha', 'spec criterion beta'],
    },
    plan: {
      scope: SCOPE,
      artifactId: 'plan-3',
      version: 3,
      content: 'current implementation plan',
      task: {
        taskId: TASK.taskId,
        title: 'Build context assembly',
        acceptanceCriteria: ['task criterion alpha', 'task criterion beta'],
      },
    },
    decisionLog: {
      scope: SCOPE,
      artifactId: 'decision-log-1',
      decisions: [{ decisionId: 'decision-1', content: 'Use durable artifacts' }],
    },
    architectureSummary: {
      scope: SCOPE,
      artifactId: 'architecture-1',
      content: 'Pure context service with an injected repository',
    },
    fileIndex: {
      scope: SCOPE,
      artifactId: 'file-index-4',
      files: [
        { path: 'src/index.ts', sizeBytes: 42 },
        { path: 'src/session/context.ts', sizeBytes: 700 },
      ],
    },
    recentChanges: {
      scope: SCOPE,
      artifactId: 'recent-changes-1',
      commits: [
        {
          sha: '0123456789abcdef0123456789abcdef01234567',
          message: 'Add context tests',
          diffstat: {
            files: [
              { path: 'src/index.ts', additions: 4, deletions: 0 },
              { path: 'src/session/context.ts', additions: 16, deletions: 0 },
            ],
            additions: 20,
            deletions: 0,
          },
        },
      ],
    },
    transcript: {
      scope: SCOPE,
      taskId: TASK.taskId,
      events: [
        {
          scope: SCOPE,
          eventId: 'event-11',
          sequence: 11,
          taskId: TASK.taskId,
          content: 'task one transcript',
        },
      ],
    },
    evidence: {
      scope: SCOPE,
      taskId: TASK.taskId,
      artifacts: [
        {
          scope: SCOPE,
          artifactId: 'evidence-1',
          taskId: TASK.taskId,
          kind: 'test',
          content: 'task one evidence passed',
        },
      ],
    },
  });
}

function makeCompactionSource(): CompactionSourceBundle {
  return CompactionSourceBundleSchema.parse({
    scope: SCOPE,
    eventRanges: [
      {
        link: {
          runId: SCOPE.runId,
          startEventId: 'event-1',
          endEventId: 'event-2',
          startSequence: 1,
          endSequence: 2,
        },
        events: [
          {
            scope: SCOPE,
            eventId: 'event-1',
            sequence: 1,
            taskId: TASK.taskId,
            content: 'first durable event',
          },
          {
            scope: SCOPE,
            eventId: 'event-2',
            sequence: 2,
            taskId: TASK.taskId,
            content: 'second durable event',
          },
        ],
      },
    ],
    artifacts: [
      {
        link: { runId: SCOPE.runId, artifactId: 'specification-2' },
        scope: SCOPE,
        kind: 'specification',
        content: 'approved specification source',
      },
      {
        link: { runId: SCOPE.runId, artifactId: 'evidence-1' },
        scope: SCOPE,
        kind: 'evidence',
        content: 'verification evidence source',
      },
    ],
  });
}

function setCompactionScopeIdentity(
  source: CompactionSourceBundle,
  field: 'organizationId' | 'projectId' | 'runId',
  value: string,
): void {
  source.scope[field] = value;
  for (const range of source.eventRanges) {
    if (field === 'runId') {
      range.link.runId = value;
    }
    for (const event of range.events) {
      event.scope[field] = value;
    }
  }
  for (const artifact of source.artifacts) {
    if (field === 'runId') {
      artifact.link.runId = value;
    }
    artifact.scope[field] = value;
  }
}

function setContextScopeIdentity(
  source: ContextSourceBundle,
  field: 'organizationId' | 'projectId' | 'runId',
  value: string,
): void {
  const scopes = [
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
  for (const scope of scopes) {
    scope[field] = value;
  }
}

function setContextTaskIdentity(source: ContextSourceBundle, taskId: string): void {
  source.plan.task.taskId = taskId;
  source.transcript.taskId = taskId;
  source.evidence.taskId = taskId;
  for (const event of source.transcript.events) {
    event.taskId = taskId;
  }
  for (const artifact of source.evidence.artifacts) {
    artifact.taskId = taskId;
  }
}

type RepositoryState = {
  context: unknown;
  compaction: unknown;
  sourceRevision: string;
  summaries: SummaryArtifact[];
  sourceEvents: CompactionSourceBundle['eventRanges'];
  sourceArtifacts: CompactionSourceBundle['artifacts'];
  operations: Map<string, { request: AtomicCompactionRequest; summary: SummaryArtifact }>;
  artifactBindings: Map<string, string>;
  commitAttempts: number;
  commitRequests: AtomicCompactionRequest[];
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function firstItem<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) {
    throw new Error('Expected a populated test fixture');
  }
  return value;
}

function makeRepository(options?: {
  context?: unknown;
  compaction?: unknown;
  filterTaskSources?: boolean;
  failContextWith?: Error;
  appendResult?: (saved: SummaryArtifact) => unknown;
  mutateStoreAfterSnapshot?: 'links' | 'scope';
  alwaysConflict?: boolean;
  bindArtifactToDifferentOperationBeforeCommit?: boolean;
  failResolvers?: boolean;
  failResolversAfterCommit?: boolean;
  persistThen?: 'throw-once' | 'malform-once';
  alwaysUnknown?: 'throw' | 'malform';
  resolvedEvent?: 'null' | 'wrong-link' | 'wrong-scope' | 'wrong-content';
  resolvedArtifact?: 'null' | 'wrong-link' | 'wrong-scope' | 'wrong-content';
  resolvedArtifactId?: string;
}): { repository: ContextRepository; state: RepositoryState } {
  const compaction = options?.compaction ?? makeCompactionSource();
  const parsedCompaction = CompactionSourceBundleSchema.safeParse(compaction);
  const state: RepositoryState = {
    context: options?.context ?? makeContextSource(),
    compaction,
    sourceRevision: 'source_revision_00000001',
    summaries: [],
    sourceEvents: parsedCompaction.success ? clone(parsedCompaction.data.eventRanges) : [],
    sourceArtifacts: parsedCompaction.success ? clone(parsedCompaction.data.artifacts) : [],
    operations: new Map(),
    artifactBindings: new Map(),
    commitAttempts: 0,
    commitRequests: [],
  };

  const repository: ContextRepository = {
    fetchContext(request) {
      if (options?.failContextWith !== undefined) {
        return Promise.reject(options.failContextWith);
      }

      const value = state.context;
      if (!options?.filterTaskSources) {
        return Promise.resolve(value);
      }

      const parsed = ContextSourceBundleSchema.parse(value);
      return Promise.resolve({
        ...parsed,
        transcript: {
          ...parsed.transcript,
          taskId: request.taskId,
          events: parsed.transcript.events.filter((event) => event.taskId === request.taskId),
        },
        evidence: {
          ...parsed.evidence,
          taskId: request.taskId,
          artifacts: parsed.evidence.artifacts.filter(
            (artifact) => artifact.taskId === request.taskId,
          ),
        },
      });
    },
    fetchCompactionSnapshot() {
      const snapshot = {
        source: clone(state.compaction),
        latestVersion: state.summaries.at(-1)?.version ?? 0,
        sourceRevision: state.sourceRevision,
      };
      if (options?.mutateStoreAfterSnapshot !== undefined) {
        const stored = CompactionSourceBundleSchema.parse(state.compaction);
        if (options.mutateStoreAfterSnapshot === 'links') {
          const storedRange = firstItem(stored.eventRanges);
          storedRange.link.startEventId = 'schema-valid-wrong-event';
          firstItem(storedRange.events).eventId = 'schema-valid-wrong-event';
        } else {
          stored.scope.projectId = 'schema-valid-wrong-project';
          for (const storedRange of stored.eventRanges) {
            for (const storedEvent of storedRange.events) {
              storedEvent.scope.projectId = 'schema-valid-wrong-project';
            }
          }
          for (const storedArtifact of stored.artifacts) {
            storedArtifact.scope.projectId = 'schema-valid-wrong-project';
          }
        }
        state.compaction = stored;
        state.sourceRevision = 'source_revision_00000002';
        state.sourceEvents = clone(stored.eventRanges);
        state.sourceArtifacts = clone(stored.artifacts);
      }
      return Promise.resolve(snapshot);
    },
    commitCompaction(request) {
      state.commitAttempts += 1;
      state.commitRequests.push(clone(request));
      const existing = state.operations.get(request.operationId);
      if (existing !== undefined) {
        const replayRequest = {
          ...request,
          expectedPreviousVersion: existing.request.expectedPreviousVersion,
        };
        if (JSON.stringify(replayRequest) !== JSON.stringify(existing.request)) {
          return Promise.reject(new Error('Operation payload mismatch'));
        }
        return Promise.resolve({ status: 'idempotent', summary: clone(existing.summary) });
      }

      if (
        options?.bindArtifactToDifferentOperationBeforeCommit === true &&
        !state.artifactBindings.has(request.artifactId)
      ) {
        state.artifactBindings.set(request.artifactId, 'different-durable-operation');
      }
      const boundOperation = state.artifactBindings.get(request.artifactId);
      if (boundOperation !== undefined && boundOperation !== request.operationId) {
        return Promise.resolve({ status: 'artifact-id-collision' });
      }

      if (options?.alwaysUnknown === 'throw') {
        return Promise.reject(new Error(`Ambiguous commit ${SENSITIVE_VALUE}`));
      }
      if (options?.alwaysUnknown === 'malform') {
        return Promise.resolve({ status: 'committed', malformed: true });
      }

      const currentVersion = state.summaries.at(-1)?.version ?? 0;
      if (options?.alwaysConflict === true) {
        return Promise.resolve({ status: 'version-conflict', currentVersion });
      }
      if (request.expectedPreviousVersion !== currentVersion) {
        return Promise.resolve({ status: 'version-conflict', currentVersion });
      }
      if (request.sourceRevision !== state.sourceRevision) {
        return Promise.resolve({ status: 'version-conflict', currentVersion });
      }
      const storedSource = CompactionSourceBundleSchema.parse(state.compaction);
      if (
        JSON.stringify(request.scope) !== JSON.stringify(storedSource.scope) ||
        JSON.stringify(request.sourceEventRanges) !==
          JSON.stringify(storedSource.eventRanges.map((range) => range.link)) ||
        JSON.stringify(request.sourceArtifacts) !==
          JSON.stringify(storedSource.artifacts.map((artifact) => artifact.link))
      ) {
        return Promise.reject(new Error('Atomic source validation failed'));
      }

      const candidate = SummaryArtifactSchema.safeParse({
        artifactId: request.artifactId,
        kind: 'context-summary',
        scope: request.scope,
        version: currentVersion + 1,
        content: request.content,
        tokenCount: request.tokenCount,
        sourceEventRanges: request.sourceEventRanges,
        sourceArtifacts: request.sourceArtifacts,
      });
      if (!candidate.success) {
        return Promise.reject(new Error('Generated summary is invalid'));
      }
      const transformed = options?.appendResult?.(candidate.data);
      if (transformed !== undefined) {
        if (
          typeof transformed === 'object' &&
          transformed !== null &&
          'summary' in transformed &&
          SummaryArtifactSchema.safeParse(transformed.summary).success &&
          JSON.stringify(transformed.summary) !== JSON.stringify(candidate.data)
        ) {
          return Promise.reject(new Error('Atomic store-return validation failed'));
        }
        return Promise.resolve(clone(transformed));
      }

      const saved = clone(candidate.data);
      state.summaries.push(saved);
      state.operations.set(request.operationId, { request: clone(request), summary: clone(saved) });
      state.artifactBindings.set(request.artifactId, request.operationId);
      if (options?.persistThen === 'throw-once' && state.commitAttempts === 1) {
        return Promise.reject(new Error(`Response lost ${SENSITIVE_VALUE}`));
      }
      if (options?.persistThen === 'malform-once' && state.commitAttempts === 1) {
        return Promise.resolve({
          status: 'committed',
          summary: { ...clone(saved), unexpected: true },
        });
      }
      return Promise.resolve({ status: 'committed', summary: clone(saved) });
    },
    resolveEventRange(link) {
      if (
        options?.failResolvers === true ||
        (options?.failResolversAfterCommit === true && state.summaries.length > 0)
      ) {
        return Promise.reject(new Error('Resolver unavailable'));
      }
      const range = state.sourceEvents.find(
        (candidate) =>
          candidate.link.runId === link.runId &&
          candidate.link.startEventId === link.startEventId &&
          candidate.link.endEventId === link.endEventId &&
          candidate.link.startSequence === link.startSequence &&
          candidate.link.endSequence === link.endSequence,
      );
      if (range === undefined || options?.resolvedEvent === 'null') {
        return Promise.resolve(null);
      }
      if (options?.resolvedEvent === 'wrong-link') {
        return Promise.resolve(
          clone({ ...range, link: { ...range.link, startEventId: 'wrong-event-link' } }),
        );
      }
      if (options?.resolvedEvent === 'wrong-scope') {
        return Promise.resolve(
          clone({
            ...range,
            events: range.events.map((event) => ({
              ...event,
              scope: { ...event.scope, projectId: 'wrong-project' },
            })),
          }),
        );
      }
      if (options?.resolvedEvent === 'wrong-content') {
        return Promise.resolve(
          clone({
            ...range,
            events: range.events.map((event, index) =>
              index === 0 ? { ...event, content: 'wrong event content' } : event,
            ),
          }),
        );
      }
      return Promise.resolve(clone(range));
    },
    resolveArtifact(link) {
      if (
        options?.failResolvers === true ||
        (options?.failResolversAfterCommit === true && state.summaries.length > 0)
      ) {
        return Promise.reject(new Error('Resolver unavailable'));
      }
      const artifact = state.sourceArtifacts.find(
        (candidate) =>
          candidate.link.runId === link.runId && candidate.link.artifactId === link.artifactId,
      );
      const resolvedArtifact =
        options?.resolvedArtifactId === undefined || options.resolvedArtifactId === link.artifactId
          ? options?.resolvedArtifact
          : undefined;
      if (artifact === undefined || resolvedArtifact === 'null') {
        return Promise.resolve(null);
      }
      if (resolvedArtifact === 'wrong-link') {
        return Promise.resolve(
          clone({ ...artifact, link: { ...artifact.link, artifactId: 'wrong-artifact-link' } }),
        );
      }
      if (resolvedArtifact === 'wrong-scope') {
        return Promise.resolve(
          clone({
            ...artifact,
            scope: { ...artifact.scope, projectId: 'wrong-project' },
          }),
        );
      }
      if (resolvedArtifact === 'wrong-content') {
        return Promise.resolve(clone({ ...artifact, content: 'wrong artifact content' }));
      }
      return Promise.resolve(clone(artifact));
    },
  };

  return { repository, state };
}

async function compactWithOperation(
  service: ReturnType<typeof makeService>,
  operationId: string,
  runId: string = SCOPE.runId,
): Promise<SummaryArtifact> {
  return service.compact({ runId, operationId });
}

function makeService(
  repository: ContextRepository,
  options?: {
    scrub?: (value: string) => string;
    countTokens?: (value: string) => number;
    compactionTokenBudget?: number;
  },
) {
  return createContextService({
    repository,
    scrub: options?.scrub ?? ((value) => value),
    countTokens: options?.countTokens ?? (() => 1),
    compactionTokenBudget: options?.compactionTokenBudget ?? 100,
  });
}

function expectContextError(error: unknown, code: ContextError['code']): void {
  expect(error).toBeInstanceOf(ContextError);
  expect(error).toMatchObject({ code });
}

describe('assembleContext role priorities and token budgets', () => {
  it('keeps verifier acceptance criteria and evidence before lower-priority sections', async () => {
    const { repository } = makeRepository();
    const context = await makeService(repository).assembleContext(
      'verifier',
      { ...SCOPE, tokenBudget: 2 },
      TASK,
    );

    expect(context.tokenCount).toBe(2);
    expect(context.sections.map((section) => section.kind)).toEqual([
      'taskAcceptanceCriteria',
      'evidence',
    ]);
  });

  it('keeps builder acceptance criteria, current task, and then file index', async () => {
    const { repository } = makeRepository();
    const context = await makeService(repository).assembleContext(
      'builder',
      { ...SCOPE, tokenBudget: 3 },
      TASK,
    );

    expect(context.sections.map((section) => section.kind)).toEqual([
      'taskAcceptanceCriteria',
      'currentTask',
      'fileIndex',
    ]);
  });

  it('keeps planner specification, plan, and decisions in deterministic order', async () => {
    const { repository } = makeRepository();
    const context = await makeService(repository).assembleContext(
      'planner',
      { ...SCOPE, tokenBudget: 4 },
      TASK,
    );

    expect(context.sections.map((section) => section.kind)).toEqual([
      'specificationAcceptanceCriteria',
      'specification',
      'currentPlan',
      'decisionLog',
    ]);
  });

  it('rejects zero, fractional, and unsafe token budgets', async () => {
    const { repository } = makeRepository();
    const service = makeService(repository);

    for (const tokenBudget of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        service.assembleContext('builder', { ...SCOPE, tokenBudget }, TASK),
      ).rejects.toSatisfy((error: unknown) => {
        expectContextError(error, 'UNSAFE_BUDGET');
        return true;
      });
    }
  });
});

describe('assembleContext atomic content and scrubbing', () => {
  it('includes specification acceptance criteria whole or drops the whole section', async () => {
    const source = makeContextSource();
    const expected = source.specification.acceptanceCriteria.join('\n');
    const { repository } = makeRepository({ context: source });
    const service = makeService(repository, {
      countTokens: (value) => value.length,
    });

    const exact = await service.assembleContext(
      'planner',
      { ...SCOPE, tokenBudget: expected.length },
      TASK,
    );
    const tooSmall = await service.assembleContext(
      'planner',
      { ...SCOPE, tokenBudget: expected.length - 1 },
      TASK,
    );

    expect(exact.sections).toHaveLength(1);
    expect(exact.sections[0]).toMatchObject({
      kind: 'specificationAcceptanceCriteria',
      content: expected,
    });
    expect(tooSmall.sections).toEqual([]);
  });

  it('includes task acceptance criteria whole or drops the whole section', async () => {
    const source = makeContextSource();
    const expected = source.plan.task.acceptanceCriteria.join('\n');
    const { repository } = makeRepository({ context: source });
    const service = makeService(repository, {
      countTokens: (value) => value.length,
    });

    const exact = await service.assembleContext(
      'builder',
      { ...SCOPE, tokenBudget: expected.length },
      TASK,
    );
    const tooSmall = await service.assembleContext(
      'builder',
      { ...SCOPE, tokenBudget: expected.length - 1 },
      TASK,
    );

    expect(exact.sections).toHaveLength(1);
    expect(exact.sections[0]?.content).toBe(expected);
    expect(tooSmall.sections).toEqual([]);
  });

  it('scrubs assembled content before token counting and output', async () => {
    const source = makeContextSource();
    source.specification.content += ` ${SENSITIVE_VALUE}`;
    source.specification.acceptanceCriteria[0] = `${firstItem(source.specification.acceptanceCriteria)} ${SENSITIVE_VALUE}`;
    source.plan.content += ` ${SENSITIVE_VALUE}`;
    source.plan.task.title += ` ${SENSITIVE_VALUE}`;
    source.plan.task.acceptanceCriteria[0] = `${firstItem(source.plan.task.acceptanceCriteria)} ${SENSITIVE_VALUE}`;
    firstItem(source.decisionLog.decisions).content += ` ${SENSITIVE_VALUE}`;
    source.architectureSummary.content += ` ${SENSITIVE_VALUE}`;
    firstItem(source.recentChanges.commits).message += ` ${SENSITIVE_VALUE}`;
    firstItem(source.transcript.events).content += ` ${SENSITIVE_VALUE}`;
    firstItem(source.evidence.artifacts).content += ` ${SENSITIVE_VALUE}`;
    const countedValues: string[] = [];
    const { repository } = makeRepository({ context: source });
    const service = makeService(repository, {
      scrub: (value) => value.replaceAll(SENSITIVE_VALUE, '[REDACTED]'),
      countTokens: (value) => {
        countedValues.push(value);
        return 1;
      },
    });

    for (const role of ['planner', 'builder', 'verifier', 'summarizer'] as const) {
      const context = await service.assembleContext(role, { ...SCOPE, tokenBudget: 100 }, TASK);
      expect(JSON.stringify(context)).not.toContain(SENSITIVE_VALUE);
    }
    expect(JSON.stringify(countedValues)).not.toContain(SENSITIVE_VALUE);
    expect(JSON.stringify(countedValues)).toContain('[REDACTED]');
  });
});

describe('assembleContext task and tenant isolation', () => {
  it('returns no transcript or evidence from another task', async () => {
    const source = makeContextSource();
    source.transcript.events.push({
      scope: SCOPE,
      eventId: 'event-12',
      sequence: 12,
      taskId: OTHER_TASK_ID,
      content: 'other task transcript marker',
    });
    source.evidence.artifacts.push({
      scope: SCOPE,
      artifactId: 'evidence-2',
      taskId: OTHER_TASK_ID,
      kind: 'runtime',
      content: 'other task evidence marker',
    });
    const { repository } = makeRepository({
      context: source,
      filterTaskSources: true,
    });

    const context = await makeService(repository).assembleContext(
      'verifier',
      { ...SCOPE, tokenBudget: 100 },
      TASK,
    );

    expect(JSON.stringify(context)).not.toContain('other task');
    expect(JSON.stringify(context)).toContain('task one transcript');
    expect(JSON.stringify(context)).toContain('task one evidence');
  });

  it('fails closed when a repository returns another task source', async () => {
    const source = makeContextSource();
    source.transcript.events.push({
      scope: SCOPE,
      eventId: 'event-12',
      sequence: 12,
      taskId: OTHER_TASK_ID,
      content: 'other task transcript marker',
    });
    const { repository } = makeRepository({ context: source });

    await expect(
      makeService(repository).assembleContext('builder', { ...SCOPE, tokenBudget: 100 }, TASK),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'CROSS_SCOPE');
      return true;
    });
  });

  it('fails closed on mixed project scope without returning partial context', async () => {
    const source = makeContextSource();
    source.architectureSummary.scope.projectId = 'project-2';
    const { repository } = makeRepository({ context: source });

    await expect(
      makeService(repository).assembleContext('planner', { ...SCOPE, tokenBudget: 100 }, TASK),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'CROSS_SCOPE');
      return true;
    });
  });
});

describe('assembleContext identity-aware secret scrubbing', () => {
  type AssemblyFixture = {
    role: 'planner' | 'builder' | 'verifier' | 'summarizer';
    run: { organizationId: string; projectId: string; runId: string; tokenBudget: number };
    task: { taskId: string };
    source: ContextSourceBundle;
    scrub: (value: string) => string;
  };

  const identityCases: ReadonlyArray<readonly [string, (fixture: AssemblyFixture) => void]> = [
    [
      'role',
      (fixture) => {
        fixture.scrub = (value) => (value === 'builder' ? 'planner' : value);
      },
    ],
    [
      'organization scope',
      (fixture) => {
        const value = `organization-${SENSITIVE_VALUE}`;
        fixture.run.organizationId = value;
        setContextScopeIdentity(fixture.source, 'organizationId', value);
      },
    ],
    [
      'project scope',
      (fixture) => {
        const value = `project-${SENSITIVE_VALUE}`;
        fixture.run.projectId = value;
        setContextScopeIdentity(fixture.source, 'projectId', value);
      },
    ],
    [
      'run scope',
      (fixture) => {
        const value = `run-${SENSITIVE_VALUE}`;
        fixture.run.runId = value;
        setContextScopeIdentity(fixture.source, 'runId', value);
      },
    ],
    [
      'task identity',
      (fixture) => {
        const value = `task-${SENSITIVE_VALUE}`;
        fixture.task.taskId = value;
        setContextTaskIdentity(fixture.source, value);
      },
    ],
    [
      'event identity',
      (fixture) => {
        firstItem(fixture.source.transcript.events).eventId = `event-${SENSITIVE_VALUE}`;
      },
    ],
    [
      'artifact identity',
      (fixture) => {
        fixture.source.specification.artifactId = `artifact-${SENSITIVE_VALUE}`;
      },
    ],
    [
      'artifact kind',
      (fixture) => {
        firstItem(fixture.source.evidence.artifacts).kind = `kind-${SENSITIVE_VALUE}`;
      },
    ],
    [
      'commit SHA',
      (fixture) => {
        const sha = 'a'.repeat(40);
        firstItem(fixture.source.recentChanges.commits).sha = sha;
        fixture.scrub = (value) => (value === sha ? 'b'.repeat(40) : value);
      },
    ],
    [
      'repository path',
      (fixture) => {
        firstItem(fixture.source.fileIndex.files).path = `src/${SENSITIVE_VALUE}.ts`;
      },
    ],
    [
      'decision identity',
      (fixture) => {
        firstItem(fixture.source.decisionLog.decisions).decisionId =
          `decision-${SENSITIVE_VALUE}`;
      },
    ],
  ];

  it.each(identityCases)(
    'fails closed before output when scrubbing changes %s',
    async (_label, mutate) => {
      const fixture: AssemblyFixture = {
        role: 'builder',
        run: { ...SCOPE, tokenBudget: 100 },
        task: { ...TASK },
        source: makeContextSource(),
        scrub: (value) => value.replaceAll(SENSITIVE_VALUE, 'redacted'),
      };
      mutate(fixture);
      const { repository } = makeRepository({ context: fixture.source });
      let returned: unknown;
      let caught: unknown;

      try {
        returned = await makeService(repository, { scrub: fixture.scrub }).assembleContext(
          fixture.role,
          fixture.run,
          fixture.task,
        );
      } catch (error) {
        caught = error;
      }

      expect(returned).toBeUndefined();
      expectContextError(caught, 'IDENTITY_SCRUBBED');
      expect(JSON.stringify(caught instanceof ContextError ? caught.toRecord() : caught)).not.toContain(
        SENSITIVE_VALUE,
      );
    },
  );
});

describe('compact', () => {
  it('appends v1 then v2 while original events, artifacts, and exact links remain resolvable', async () => {
    const { repository, state } = makeRepository();
    const originalCompaction = clone(state.compaction);
    const originalEvents = clone(state.sourceEvents);
    const originalArtifacts = clone(state.sourceArtifacts);
    const service = makeService(repository);

    const first = await compactWithOperation(service, 'sequential-compaction-1');
    const second = await compactWithOperation(service, 'sequential-compaction-2');

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(first.artifactId).not.toBe(second.artifactId);
    expect(first.sourceEventRanges).toEqual(originalEvents.map((range) => range.link));
    expect(first.sourceArtifacts).toEqual(originalArtifacts.map((artifact) => artifact.link));
    expect(state.sourceEvents).toEqual(originalEvents);
    expect(state.sourceArtifacts).toEqual(originalArtifacts);
    expect(state.compaction).toEqual(originalCompaction);
    expect(state.summaries).toEqual([first, second]);
    expect(SummaryArtifactSchema.parse(first)).toEqual(first);
    expect(SummaryArtifactSchema.parse(second)).toEqual(second);

    for (const link of second.sourceEventRanges) {
      await expect(repository.resolveEventRange(link)).resolves.not.toBeNull();
    }
    for (const link of second.sourceArtifacts) {
      await expect(repository.resolveArtifact(link)).resolves.not.toBeNull();
    }
  });

  it('scrubs summary content before counting and saving', async () => {
    const source = makeCompactionSource();
    firstItem(firstItem(source.eventRanges).events).content += ` ${SENSITIVE_VALUE}`;
    firstItem(source.artifacts).content += ` ${SENSITIVE_VALUE}`;
    const countedValues: string[] = [];
    const scrub = (value: string): string => value.replaceAll(SENSITIVE_VALUE, '[REDACTED]');
    const { repository, state } = makeRepository({ compaction: source });
    const service = makeService(repository, {
      scrub,
      countTokens: (value) => {
        countedValues.push(value);
        return 1;
      },
    });

    const summary = await compactWithOperation(service, 'scrubbed-compaction');

    expect(JSON.stringify(summary)).not.toContain(SENSITIVE_VALUE);
    expect(JSON.stringify(state.summaries)).not.toContain(SENSITIVE_VALUE);
    expect(JSON.stringify([...state.operations.entries()])).not.toContain(SENSITIVE_VALUE);
    expect(JSON.stringify(state.commitRequests)).not.toContain(SENSITIVE_VALUE);
    expect(JSON.stringify(countedValues)).not.toContain(SENSITIVE_VALUE);
    expect(summary.content).toContain('[REDACTED]');
  });

  it('fails before appending when an exact source link cannot be resolved', async () => {
    const source = makeCompactionSource();
    firstItem(source.eventRanges).link.endEventId = 'missing-event';
    const { repository, state } = makeRepository({ compaction: source });

    await expect(
      compactWithOperation(makeService(repository), 'unresolved-compaction'),
    ).rejects.toSatisfy(
      (error: unknown) => {
        expectContextError(error, 'REPOSITORY_RESULT');
        return true;
      },
    );
    expect(state.summaries).toEqual([]);
  });
});

describe('compact identity-aware secret scrubbing', () => {
  type IdentityFixture = {
    source: CompactionSourceBundle;
    runId: string;
    operationId: string;
  };

  const identityCases: ReadonlyArray<
    readonly [string, (fixture: IdentityFixture) => void]
  > = [
    [
      'organization IDs',
      (fixture) => {
        setCompactionScopeIdentity(
          fixture.source,
          'organizationId',
          `organization-${SENSITIVE_VALUE}`,
        );
      },
    ],
    [
      'project IDs',
      (fixture) => {
        setCompactionScopeIdentity(
          fixture.source,
          'projectId',
          `project-${SENSITIVE_VALUE}`,
        );
      },
    ],
    [
      'run and source-link IDs',
      (fixture) => {
        fixture.runId = `run-${SENSITIVE_VALUE}`;
        setCompactionScopeIdentity(fixture.source, 'runId', fixture.runId);
      },
    ],
    [
      'task IDs',
      (fixture) => {
        for (const range of fixture.source.eventRanges) {
          for (const event of range.events) {
            event.taskId = `task-${SENSITIVE_VALUE}`;
          }
        }
      },
    ],
    [
      'event and event-link IDs',
      (fixture) => {
        const range = firstItem(fixture.source.eventRanges);
        const event = firstItem(range.events);
        event.eventId = `event-${SENSITIVE_VALUE}`;
        range.link.startEventId = event.eventId;
      },
    ],
    [
      'artifact and artifact-link IDs',
      (fixture) => {
        firstItem(fixture.source.artifacts).link.artifactId =
          `artifact-${SENSITIVE_VALUE}`;
      },
    ],
    [
      'artifact kinds',
      (fixture) => {
        firstItem(fixture.source.artifacts).kind = `kind-${SENSITIVE_VALUE}`;
      },
    ],
    [
      'operation-visible IDs',
      (fixture) => {
        fixture.operationId = `operation-${SENSITIVE_VALUE}`;
      },
    ],
  ];

  it.each(identityCases)(
    'fails closed before mutation when scrubbing changes %s',
    async (_label, mutate) => {
      const fixture: IdentityFixture = {
        source: makeCompactionSource(),
        runId: SCOPE.runId,
        operationId: 'identity-scrub-operation',
      };
      mutate(fixture);
      const { repository, state } = makeRepository({ compaction: fixture.source });
      const service = makeService(repository, {
        scrub: (value) => value.replaceAll(SENSITIVE_VALUE, '[REDACTED]'),
      });

      let returned: SummaryArtifact | undefined;
      let caught: unknown;
      try {
        returned = await compactWithOperation(service, fixture.operationId, fixture.runId);
      } catch (error) {
        caught = error;
      }

      const observable = JSON.stringify({
        returned,
        summaries: state.summaries,
        operations: [...state.operations.entries()],
        error:
          caught instanceof ContextError
            ? caught.toRecord()
            : caught instanceof Error
              ? { name: caught.name, message: caught.message }
              : caught,
      });
      expect(observable).not.toContain(SENSITIVE_VALUE);
      expect(caught).toBeInstanceOf(ContextError);
      expect(caught).toMatchObject({ code: 'IDENTITY_SCRUBBED' });
      expect(state.commitAttempts).toBe(0);
      expect(state.summaries).toEqual([]);
    },
  );
});

describe('compact pre-commit source resolution', () => {
  it.each(['null', 'wrong-link', 'wrong-scope', 'wrong-content'] as const)(
    'rejects an event range resolver result with %s before committing',
    async (resolvedEvent) => {
      const { repository, state } = makeRepository({ resolvedEvent });

      await expect(
        compactWithOperation(makeService(repository), `event-resolution-${resolvedEvent}`),
      ).rejects.toSatisfy((error: unknown) => {
        expectContextError(error, 'UNRESOLVED_LINK');
        return true;
      });
      expect(state.commitAttempts).toBe(0);
      expect(state.summaries).toEqual([]);
    },
  );

  it.each(['null', 'wrong-link', 'wrong-scope', 'wrong-content'] as const)(
    'rejects a later artifact resolver result with %s before committing',
    async (resolvedArtifact) => {
      const { repository, state } = makeRepository({
        resolvedArtifact,
        resolvedArtifactId: 'evidence-1',
      });

      await expect(
        compactWithOperation(makeService(repository), `artifact-resolution-${resolvedArtifact}`),
      ).rejects.toSatisfy((error: unknown) => {
        expectContextError(error, 'UNRESOLVED_LINK');
        return true;
      });
      expect(state.commitAttempts).toBe(0);
      expect(state.summaries).toEqual([]);
    },
  );
});

describe('compact raw snapshot revision CAS', () => {
  it('rejects a secret-bearing source revision before commit', async () => {
    const { repository: baseRepository, state } = makeRepository();
    const repository: ContextRepository = {
      ...baseRepository,
      async fetchCompactionSnapshot(request) {
        const snapshot = await baseRepository.fetchCompactionSnapshot(request);
        return {
          ...(snapshot as object),
          sourceRevision: `source_revision_${SENSITIVE_VALUE}`,
        };
      },
    };

    await expect(
      compactWithOperation(
        makeService(repository, {
          scrub: (value) => value.replaceAll(SENSITIVE_VALUE, '[REDACTED]'),
        }),
        'secret-source-revision-operation',
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'IDENTITY_SCRUBBED');
      expect(String(error)).not.toContain(SENSITIVE_VALUE);
      return true;
    });
    expect(state.commitAttempts).toBe(0);
    expect(state.summaries).toEqual([]);
  });

  it('conflicts and rebuilds when distinct raw snapshots have identical redaction', async () => {
    type RevisionRequest = {
      operationId: string;
      artifactId: string;
      expectedPreviousVersion: number;
      sourceRevision: string;
      scope: typeof SCOPE;
      content: string;
      tokenCount: number;
      sourceEventRanges: CompactionSourceBundle['eventRanges'][number]['link'][];
      sourceArtifacts: CompactionSourceBundle['artifacts'][number]['link'][];
    };

    const source = makeCompactionSource();
    firstItem(source.artifacts).content = 'raw-secret-alpha';
    const durableSource = clone(source);
    let sourceRevision = 'source_revision_00000001';
    let changed = false;
    const summaries: SummaryArtifact[] = [];
    const commitRequests: RevisionRequest[] = [];

    const repository: ContextRepository = {
      fetchContext() {
        return Promise.resolve(makeContextSource());
      },
      fetchCompactionSnapshot() {
        return Promise.resolve({
          source: clone(durableSource),
          latestVersion: summaries.at(-1)?.version ?? 0,
          sourceRevision,
        });
      },
      commitCompaction(request) {
        const atomic = clone(request) as unknown as RevisionRequest;
        commitRequests.push(atomic);
        if (!changed) {
          changed = true;
          firstItem(durableSource.artifacts).content = 'raw-secret-beta';
          sourceRevision = 'source_revision_00000002';
        }
        if (atomic.sourceRevision !== sourceRevision) {
          return Promise.resolve({ status: 'version-conflict', currentVersion: 0 });
        }

        const summary = SummaryArtifactSchema.parse({
          artifactId: atomic.artifactId,
          kind: 'context-summary',
          scope: atomic.scope,
          version: 1,
          content: atomic.content,
          tokenCount: atomic.tokenCount,
          sourceEventRanges: atomic.sourceEventRanges,
          sourceArtifacts: atomic.sourceArtifacts,
        });
        summaries.push(summary);
        return Promise.resolve({ status: 'committed', summary: clone(summary) });
      },
      resolveEventRange(link) {
        const range = durableSource.eventRanges.find(
          (candidate) => JSON.stringify(candidate.link) === JSON.stringify(link),
        );
        return Promise.resolve(range === undefined ? null : clone(range));
      },
      resolveArtifact(link) {
        const artifact = durableSource.artifacts.find(
          (candidate) => JSON.stringify(candidate.link) === JSON.stringify(link),
        );
        return Promise.resolve(artifact === undefined ? null : clone(artifact));
      },
    };
    const scrub = (value: string): string =>
      value.replace(/raw-secret-(?:alpha|beta)/gu, '[REDACTED]');

    const summary = await compactWithOperation(
      makeService(repository, {
        scrub,
      }),
      'raw-revision-operation',
    );

    expect(summary.version).toBe(1);
    expect(summaries).toEqual([summary]);
    expect(commitRequests).toHaveLength(2);
    expect(commitRequests.map((request) => request.sourceRevision)).toEqual([
      'source_revision_00000001',
      'source_revision_00000002',
    ]);
    expect(commitRequests[1]?.content).toBe(commitRequests[0]?.content);
    expect(commitRequests.every((request) => !('source' in request))).toBe(true);
    expect(JSON.stringify(commitRequests)).not.toContain('raw-secret-alpha');
    expect(JSON.stringify(commitRequests)).not.toContain('raw-secret-beta');
  });
});

describe('compact atomic mutation regressions', () => {
  it('rejects an otherwise exact idempotent result newer than the observed next version', async () => {
    const { repository: baseRepository, state } = makeRepository();
    const repository: ContextRepository = {
      ...baseRepository,
      commitCompaction(request) {
        state.commitAttempts += 1;
        state.commitRequests.push(clone(request));
        return Promise.resolve({
          status: 'idempotent',
          summary: SummaryArtifactSchema.parse({
            artifactId: request.artifactId,
            kind: 'context-summary',
            scope: request.scope,
            version: 999,
            content: request.content,
            tokenCount: request.tokenCount,
            sourceEventRanges: request.sourceEventRanges,
            sourceArtifacts: request.sourceArtifacts,
          }),
        });
      },
    };
    let caught: unknown;

    try {
      await compactWithOperation(makeService(repository), 'future-idempotent-version');
    } catch (error) {
      caught = error;
    }

    expectContextError(caught, 'OUTCOME_UNKNOWN');
    expect(state.commitAttempts).toBe(3);
    expect(state.commitRequests[1]).toEqual(state.commitRequests[0]);
    expect(state.commitRequests[2]).toEqual(state.commitRequests[0]);
    expect(state.summaries).toEqual([]);
  });

  it('derives the same artifact ID across fresh services and recovers the original operation', async () => {
    const { repository: baseRepository, state } = makeRepository();
    const first = await compactWithOperation(
      makeService(baseRepository),
      'durable-operation-across-processes',
    );
    let rejectNextSnapshot = true;
    const restartedRepository: ContextRepository = {
      ...baseRepository,
      fetchCompactionSnapshot(request) {
        if (rejectNextSnapshot) {
          rejectNextSnapshot = false;
          return Promise.resolve({ malformed: true });
        }
        return baseRepository.fetchCompactionSnapshot(request);
      },
    };
    const restartedService = makeService(restartedRepository);

    await expect(
      compactWithOperation(restartedService, 'unrelated-failed-operation'),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'REPOSITORY_RESULT');
      return true;
    });
    const replay = await compactWithOperation(
      restartedService,
      'durable-operation-across-processes',
    );

    expect(replay).toEqual(first);
    expect(state.summaries).toEqual([first]);
    expect(state.commitRequests.at(-1)?.artifactId).toBe(first.artifactId);
  });

  it('derives distinct opaque IDs for different operations across fresh services', async () => {
    const { repository, state } = makeRepository();

    const summaries = await Promise.all([
      compactWithOperation(makeService(repository), 'fresh-operation-alpha'),
      compactWithOperation(makeService(repository), 'fresh-operation-beta'),
    ]);

    expect(summaries.map((summary) => summary.version).sort()).toEqual([1, 2]);
    expect(new Set(summaries.map((summary) => summary.artifactId)).size).toBe(2);
    expect(
      summaries.every((summary) => OpaqueArtifactIdSchema.safeParse(summary.artifactId).success),
    ).toBe(true);
    expect(state.summaries).toHaveLength(2);
  });

  it('derives distinct opaque IDs for the same operation in different runs', async () => {
    const otherRunId = 'run-2';
    const otherRunSource = makeCompactionSource();
    setCompactionScopeIdentity(otherRunSource, 'runId', otherRunId);
    const firstRepository = makeRepository();
    const secondRepository = makeRepository({ compaction: otherRunSource });

    const [first, second] = await Promise.all([
      compactWithOperation(
        makeService(firstRepository.repository),
        'same-operation-different-run',
      ),
      compactWithOperation(
        makeService(secondRepository.repository),
        'same-operation-different-run',
        otherRunId,
      ),
    ]);

    expect(first.artifactId).not.toBe(second.artifactId);
    expect(OpaqueArtifactIdSchema.safeParse(first.artifactId).success).toBe(true);
    expect(OpaqueArtifactIdSchema.safeParse(second.artifactId).success).toBe(true);
  });

  it('maps an atomic concurrent artifact-ID binding collision to a fixed error', async () => {
    const { repository, state } = makeRepository({
      bindArtifactToDifferentOperationBeforeCommit: true,
    });
    let caught: unknown;

    try {
      await compactWithOperation(
        makeService(repository),
        `collision-operation-${SENSITIVE_VALUE}`,
      );
    } catch (error) {
      caught = error;
    }

    expectContextError(caught, 'ARTIFACT_ID_COLLISION');
    expect(String(caught)).not.toContain(SENSITIVE_VALUE);
    expect(JSON.stringify(caught instanceof ContextError ? caught.toRecord() : caught)).not.toContain(
      SENSITIVE_VALUE,
    );
    expect(state.commitAttempts).toBe(1);
    expect(state.summaries).toEqual([]);
  });

  it('defines artifact-ID collision as a strict payload-free repository result', () => {
    expect(
      CompactionCommitResultSchema.safeParse({ status: 'artifact-id-collision' }).success,
    ).toBe(true);
    const malformed = CompactionCommitResultSchema.safeParse({
      status: 'artifact-id-collision',
      operationId: SENSITIVE_VALUE,
    });

    expect(malformed.success).toBe(false);
    if (!malformed.success) {
      expect(JSON.stringify(malformed.error.issues)).not.toContain(SENSITIVE_VALUE);
    }
  });

  it('derives, validates, and commits the exact summary artifact ID before mutation', async () => {
    const { repository, state } = makeRepository();

    const summary = await compactWithOperation(makeService(repository), 'derived-id-operation');

    expect(OpaqueArtifactIdSchema.safeParse(summary.artifactId).success).toBe(true);
    expect(firstItem(state.commitRequests)).toMatchObject({ artifactId: summary.artifactId });
    expect(firstItem(state.summaries).artifactId).toBe(summary.artifactId);
  });

  it('rejects a mismatched result ID and recovers the exact persisted ID idempotently', async () => {
    const { repository: baseRepository, state } = makeRepository();
    let corruptFirstResult = true;
    const repository: ContextRepository = {
      ...baseRepository,
      async commitCompaction(request) {
        const result = await baseRepository.commitCompaction(request);
        if (
          corruptFirstResult &&
          typeof result === 'object' &&
          result !== null &&
          'status' in result &&
          result.status === 'committed' &&
          'summary' in result
        ) {
          corruptFirstResult = false;
          return {
            status: 'committed',
            summary: {
              ...(result.summary as SummaryArtifact),
              artifactId: 'ctxsum_wrong_result_0001',
            },
          };
        }
        return result;
      },
    };

    const summary = await compactWithOperation(makeService(repository), 'exact-result-id-operation');

    expect(state.summaries).toHaveLength(1);
    expect(firstItem(state.summaries).artifactId).toBe(summary.artifactId);
    expect(state.commitAttempts).toBe(2);
    expect(state.commitRequests[1]).toEqual(state.commitRequests[0]);
  });

  it('keeps the derived summary ID stable while rebuilding version conflicts', async () => {
    const { repository, state } = makeRepository({ alwaysConflict: true });

    await expect(
      compactWithOperation(
        makeService(repository),
        'single-allocation-conflict-operation',
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'REPOSITORY_FAILURE');
      return true;
    });

    expect(state.commitAttempts).toBe(3);
    expect(new Set(state.commitRequests.map((request) => request.artifactId)).size).toBe(1);
  });

  it('requires a caller-stable operation identifier at the public boundary', async () => {
    const { repository } = makeRepository();

    await expect(
      makeService(repository).compact({
        runId: SCOPE.runId,
        operationId: 'public-operation-1',
      }),
    ).resolves.toMatchObject({ version: 1 });
  });

  it('commits concurrent distinct operations as consecutive versions', async () => {
    const { repository, state } = makeRepository();
    const service = makeService(repository);

    const summaries = await Promise.all([
      compactWithOperation(service, 'concurrent-operation-a'),
      compactWithOperation(service, 'concurrent-operation-b'),
    ]);

    expect(summaries.map((summary) => summary.version).sort()).toEqual([1, 2]);
    expect(new Set(summaries.map((summary) => summary.artifactId)).size).toBe(2);
    expect(state.summaries).toHaveLength(2);
  });

  it('returns an earlier original version when its operation is retried after a later commit', async () => {
    const { repository, state } = makeRepository();
    const service = makeService(repository);

    const first = await compactWithOperation(service, 'stable-operation');
    const later = await compactWithOperation(service, 'later-operation');
    const retried = await compactWithOperation(service, 'stable-operation');

    expect(retried).toEqual(first);
    expect(first.version).toBe(1);
    expect(later.version).toBe(2);
    expect(state.commitRequests[2]?.artifactId).toBe(first.artifactId);
    expect(state.summaries).toEqual([first, later]);
  });

  it.each(['throw-once', 'malform-once'] as const)(
    'recovers the original commit after the repository persists then returns %s',
    async (persistThen) => {
      const { repository, state } = makeRepository({ persistThen });

      const summary = await compactWithOperation(
        makeService(repository),
        `ambiguous-${persistThen}-operation`,
      );

      expect(summary).toEqual(firstItem(state.summaries));
      expect(summary.version).toBe(1);
      expect(state.summaries).toHaveLength(1);
      expect(state.commitAttempts).toBe(2);
      expect(state.commitRequests).toHaveLength(2);
      expect(state.commitRequests[1]).toEqual(state.commitRequests[0]);
    },
  );

  it.each(['throw', 'malform'] as const)(
    'reports a distinct fixed outcome-unknown error after bounded %s ambiguity',
    async (alwaysUnknown) => {
      const { repository, state } = makeRepository({ alwaysUnknown });
      let caught: unknown;

      try {
        await compactWithOperation(
          makeService(repository),
          `exhausted-${alwaysUnknown}-${SENSITIVE_VALUE}`,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ContextError);
      expect(caught).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      expect(String(caught)).not.toContain(SENSITIVE_VALUE);
      expect(state.commitAttempts).toBe(3);
      expect(state.summaries).toEqual([]);
      expect(state.commitRequests).toHaveLength(3);
      expect(state.commitRequests[1]).toEqual(state.commitRequests[0]);
      expect(state.commitRequests[2]).toEqual(state.commitRequests[0]);
    },
  );

  it('does not persist when the repository would return a malformed result', async () => {
    const { repository, state } = makeRepository({
      appendResult: (saved) => ({
        status: 'committed',
        summary: { ...saved, unexpected: true },
      }),
    });

    await expect(
      compactWithOperation(makeService(repository), 'malformed-result-operation'),
    ).rejects.toBeInstanceOf(ContextError);
    expect(state.summaries).toEqual([]);
  });

  it('does not persist a schema-valid store-return mismatch', async () => {
    const { repository, state } = makeRepository({
      appendResult: (saved) => ({
        status: 'committed',
        summary: { ...saved, artifactId: 'schema-valid-wrong-artifact' },
      }),
    });

    await expect(
      compactWithOperation(makeService(repository), 'mismatched-result-operation'),
    ).rejects.toBeInstanceOf(ContextError);
    expect(state.summaries).toEqual([]);
  });

  it.each(['links', 'scope'] as const)(
    'rejects a schema-valid atomic %s mismatch without committing',
    async (mismatch) => {
      const { repository, state } = makeRepository({ mutateStoreAfterSnapshot: mismatch });

      await expect(
        compactWithOperation(makeService(repository), `wrong-${mismatch}-operation`),
      ).rejects.toBeInstanceOf(ContextError);
      expect(state.summaries).toEqual([]);
    },
  );

  it('bounds version-conflict refetch and rebuild attempts', async () => {
    const { repository, state } = makeRepository({ alwaysConflict: true });

    await expect(
      compactWithOperation(makeService(repository), 'persistently-conflicted-operation'),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'REPOSITORY_FAILURE');
      return true;
    });
    expect(state.commitAttempts).toBe(3);
    expect(state.summaries).toEqual([]);
  });

  it('does not perform fallible resolver calls after an atomic commit', async () => {
    const { repository, state } = makeRepository({ failResolversAfterCommit: true });

    await expect(
      compactWithOperation(makeService(repository), 'no-post-commit-resolver-operation'),
    ).resolves.toMatchObject({ version: 1 });
    expect(state.summaries).toHaveLength(1);
  });
});

describe('compact exact token accounting', () => {
  it('counts the exact final joined content including separators at the boundary', async () => {
    const source = makeCompactionSource();
    source.eventRanges = [];
    source.artifacts = [
      {
        link: { runId: SCOPE.runId, artifactId: 'specification-source' },
        scope: SCOPE,
        kind: 'specification',
        content: 'required specification',
      },
      {
        link: { runId: SCOPE.runId, artifactId: 'runtime-source' },
        scope: SCOPE,
        kind: 'runtime',
        content: 'lower priority runtime',
      },
    ];
    const expected =
      '[artifact specification:specification-source]\nrequired specification\n\n' +
      '[artifact runtime:runtime-source]\nlower priority runtime';
    const { repository } = makeRepository({ compaction: source });

    const summary = await compactWithOperation(
      makeService(repository, {
        countTokens: (value) => value.length,
        compactionTokenBudget: expected.length,
      }),
      'exact-budget-operation',
    );

    expect(summary.content).toBe(expected);
    expect(summary.tokenCount).toBe(summary.content.length);
    expect(summary.tokenCount).toBeLessThanOrEqual(expected.length);
  });

  it('drops one whole lowest-priority seed and recounts at one token below the boundary', async () => {
    const source = makeCompactionSource();
    source.eventRanges = [];
    source.artifacts = [
      {
        link: { runId: SCOPE.runId, artifactId: 'specification-source' },
        scope: SCOPE,
        kind: 'specification',
        content: 'required specification',
      },
      {
        link: { runId: SCOPE.runId, artifactId: 'runtime-source' },
        scope: SCOPE,
        kind: 'runtime',
        content: 'lower priority runtime',
      },
    ];
    const retained = '[artifact specification:specification-source]\nrequired specification';
    const complete = `${retained}\n\n[artifact runtime:runtime-source]\nlower priority runtime`;
    const budget = complete.length - 1;
    const { repository } = makeRepository({ compaction: source });

    const summary = await compactWithOperation(
      makeService(repository, {
        countTokens: (value) => value.length,
        compactionTokenBudget: budget,
      }),
      'one-smaller-budget-operation',
    );

    expect(summary.content).toBe(retained);
    expect(summary.tokenCount).toBe(summary.content.length);
    expect(summary.tokenCount).toBeLessThanOrEqual(budget);
  });
});

describe('compact provenance integrity', () => {
  function event(sequence: number, eventId = `event-${String(sequence)}`) {
    return {
      scope: SCOPE,
      eventId,
      sequence,
      taskId: TASK.taskId,
      content: `event ${String(sequence)}`,
    };
  }

  function range(start: number, end: number, events: ReturnType<typeof event>[]) {
    return {
      link: {
        runId: SCOPE.runId,
        startEventId: firstItem(events).eventId,
        endEventId: events.at(-1)?.eventId ?? firstItem(events).eventId,
        startSequence: start,
        endSequence: end,
      },
      events,
    };
  }

  it('accepts a single event provenance range', async () => {
    const source = makeCompactionSource();
    source.eventRanges = [range(1, 1, [event(1)])];
    source.artifacts = [];
    const { repository } = makeRepository({ compaction: source });

    await expect(
      compactWithOperation(makeService(repository), 'single-event-operation'),
    ).resolves.toMatchObject({ version: 1 });
  });

  it('accepts adjacent ordered event ranges', async () => {
    const source = makeCompactionSource();
    source.eventRanges = [range(1, 1, [event(1)]), range(2, 2, [event(2)])];
    source.artifacts = [];
    const { repository } = makeRepository({ compaction: source });

    await expect(
      compactWithOperation(makeService(repository), 'adjacent-range-operation'),
    ).resolves.toMatchObject({ version: 1 });
  });

  it.each([
    [
      'empty provenance',
      () => ({ ...makeCompactionSource(), eventRanges: [], artifacts: [] }),
    ],
    [
      'a gap within a range',
      () => ({ ...makeCompactionSource(), eventRanges: [range(1, 3, [event(1), event(3)])], artifacts: [] }),
    ],
    [
      'a gap across ranges',
      () => ({ ...makeCompactionSource(), eventRanges: [range(1, 1, [event(1)]), range(3, 3, [event(3)])], artifacts: [] }),
    ],
    [
      'overlapping ranges',
      () => ({ ...makeCompactionSource(), eventRanges: [range(1, 2, [event(1), event(2)]), range(2, 3, [event(2), event(3)])], artifacts: [] }),
    ],
    [
      'duplicate event identifiers',
      () => ({ ...makeCompactionSource(), eventRanges: [range(1, 2, [event(1, 'duplicate-event'), event(2, 'duplicate-event')])], artifacts: [] }),
    ],
    [
      'duplicate event sequences',
      () => ({ ...makeCompactionSource(), eventRanges: [range(1, 1, [event(1, 'event-a'), event(1, 'event-b')])], artifacts: [] }),
    ],
    [
      'duplicate artifact links',
      () => {
        const source = makeCompactionSource();
        source.eventRanges = [];
        source.artifacts = [firstItem(source.artifacts), clone(firstItem(source.artifacts))];
        return source;
      },
    ],
    [
      'a reversed range',
      () => ({ ...makeCompactionSource(), eventRanges: [range(2, 1, [event(1), event(2)])], artifacts: [] }),
    ],
  ])('rejects %s before committing', async (_label, makeSource) => {
    const { repository, state } = makeRepository({ compaction: makeSource() });

    await expect(
      compactWithOperation(makeService(repository), `invalid-provenance-${_label}`),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'REPOSITORY_RESULT');
      return true;
    });
    expect(state.summaries).toEqual([]);
  });
});

describe('saved summary provenance bounds', () => {
  function summaryWithRange(
    startSequence: number,
    endSequence: number,
    startEventId = 'range-start',
    endEventId = 'range-end',
  ): unknown {
    return {
      artifactId: 'ctxsum_0000000000000001',
      kind: 'context-summary',
      scope: SCOPE,
      version: 1,
      content: 'bounded summary',
      tokenCount: 1,
      sourceEventRanges: [
        {
          runId: SCOPE.runId,
          startEventId,
          endEventId,
          startSequence,
          endSequence,
        },
      ],
      sourceArtifacts: [],
    };
  }

  it('accepts the maximum event span and rejects one larger or arithmetically unsafe', () => {
    expect(SummaryArtifactSchema.safeParse(summaryWithRange(1, 10_000)).success).toBe(true);
    expect(SummaryArtifactSchema.safeParse(summaryWithRange(1, 10_001)).success).toBe(false);
    expect(
      SummaryArtifactSchema.safeParse(summaryWithRange(0, Number.MAX_SAFE_INTEGER)).success,
    ).toBe(false);
  });

  it('requires endpoint IDs to match exactly for one event and differ for multiple events', () => {
    expect(SummaryArtifactSchema.safeParse(summaryWithRange(7, 7, 'event-7', 'event-7')).success)
      .toBe(true);
    expect(SummaryArtifactSchema.safeParse(summaryWithRange(7, 7, 'event-7', 'event-8')).success)
      .toBe(false);
    expect(SummaryArtifactSchema.safeParse(summaryWithRange(7, 8, 'event-7', 'event-8')).success)
      .toBe(true);
    expect(SummaryArtifactSchema.safeParse(summaryWithRange(7, 8, 'event-7', 'event-7')).success)
      .toBe(false);
  });
});

describe('required context semantics', () => {
  const malformedCases: ReadonlyArray<
    readonly [string, (source: ContextSourceBundle) => void]
  > = [
    ['missing specification', (source) => void Reflect.deleteProperty(source, 'specification')],
    ['blank specification content', (source) => void (source.specification.content = '   ')],
    ['empty specification criteria', (source) => void (source.specification.acceptanceCriteria = [])],
    [
      'duplicate specification criteria',
      (source) => void (source.specification.acceptanceCriteria = ['criterion', ' criterion ']),
    ],
    ['blank plan content', (source) => void (source.plan.content = '\t')],
    ['blank task title', (source) => void (source.plan.task.title = '\n')],
    ['empty task criteria', (source) => void (source.plan.task.acceptanceCriteria = [])],
    [
      'duplicate task criteria',
      (source) => void (source.plan.task.acceptanceCriteria = ['criterion', 'criterion']),
    ],
    [
      'over-bounded specification content',
      (source) => void (source.specification.content = 'x'.repeat(100_001)),
    ],
    ['over-bounded task title', (source) => void (source.plan.task.title = 'x'.repeat(513))],
  ];

  it.each(malformedCases)('rejects %s before returning partial context', async (_label, mutate) => {
    const source = makeContextSource();
    mutate(source);
    const { repository } = makeRepository({ context: source });

    await expect(
      makeService(repository).assembleContext('builder', { ...SCOPE, tokenBudget: 100 }, TASK),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'REPOSITORY_RESULT');
      return true;
    });
  });
});

describe('transcript chronology semantics', () => {
  function transcriptEvent(sequence: number, eventId: string) {
    return {
      scope: SCOPE,
      eventId,
      sequence,
      taskId: TASK.taskId,
      content: `event ${String(sequence)}`,
    };
  }

  it('accepts strictly increasing task-local transcript sequences with gaps', async () => {
    const source = makeContextSource();
    source.transcript.events = [
      transcriptEvent(11, 'event-11'),
      transcriptEvent(15, 'event-15'),
    ];
    const { repository } = makeRepository({ context: source });

    const context = await makeService(repository).assembleContext(
      'verifier',
      { ...SCOPE, tokenBudget: 100 },
      TASK,
    );

    expect(context.sections.find((section) => section.kind === 'taskTranscript')).toMatchObject({
      content: '[11] event 11\n[15] event 15',
      sourceEventIds: ['event-11', 'event-15'],
    });
  });

  it.each([
    [
      'a duplicate event ID',
      [transcriptEvent(11, 'duplicate-event'), transcriptEvent(15, 'duplicate-event')],
    ],
    [
      'a duplicate sequence',
      [transcriptEvent(11, 'event-11'), transcriptEvent(11, 'event-12')],
    ],
    [
      'reversed sequences',
      [transcriptEvent(15, 'event-15'), transcriptEvent(11, 'event-11')],
    ],
  ] as const)('rejects %s before partial assembly', async (_label, events) => {
    const source = makeContextSource();
    source.transcript.events = events.map((event) => clone(event));
    const { repository } = makeRepository({ context: source });

    await expect(
      makeService(repository).assembleContext('verifier', { ...SCOPE, tokenBudget: 100 }, TASK),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'REPOSITORY_RESULT');
      return true;
    });
  });
});

describe('semantic repository source schemas', () => {
  it.each(['../secret.ts', '/absolute/path.ts', 'src//unnormalized.ts', 'src/file.ts\n@@ patch']) (
    'rejects unsafe repository path %s',
    async (path) => {
      const source = makeContextSource();
      firstItem(source.fileIndex.files).path = path;
      const { repository } = makeRepository({ context: source });

      await expect(
        makeService(repository).assembleContext('builder', { ...SCOPE, tokenBudget: 100 }, TASK),
      ).rejects.toSatisfy((error: unknown) => {
        expectContextError(error, 'REPOSITORY_RESULT');
        return true;
      });
    },
  );

  it('rejects a non-commit SHA and free-form patch body', async () => {
    const source = makeContextSource();
    const commit = firstItem(source.recentChanges.commits) as unknown as Record<string, unknown>;
    commit.sha = 'not-a-commit';
    commit.diffstat = '@@ -1 +1 @@\n-secret\n+body';
    const { repository } = makeRepository({ context: source });

    await expect(
      makeService(repository).assembleContext('summarizer', { ...SCOPE, tokenBudget: 100 }, TASK),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'REPOSITORY_RESULT');
      return true;
    });
  });

  it('rejects unsafe structured diffstat numbers', async () => {
    const source = makeContextSource();
    const commit = firstItem(source.recentChanges.commits) as unknown as Record<string, unknown>;
    commit.sha = '0123456789abcdef0123456789abcdef01234567';
    commit.diffstat = {
      files: [{ path: 'src/index.ts', additions: -1, deletions: 0 }],
      additions: -1,
      deletions: 0,
    };
    const { repository } = makeRepository({ context: source });

    await expect(
      makeService(repository).assembleContext('summarizer', { ...SCOPE, tokenBudget: 100 }, TASK),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'REPOSITORY_RESULT');
      return true;
    });
  });

  it('rejects a non-NFC repository path before output', async () => {
    const source = makeContextSource();
    firstItem(source.fileIndex.files).path = 'src/cafe\u0301.ts';
    const { repository } = makeRepository({ context: source });

    await expect(
      makeService(repository).assembleContext('builder', { ...SCOPE, tokenBudget: 100 }, TASK),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'REPOSITORY_RESULT');
      return true;
    });
  });

  it.each([
    ['equal metadata', 42],
    ['conflicting metadata', 43],
  ] as const)(
    'rejects canonically equivalent file-index paths with %s',
    async (_label, sizeBytes) => {
      const source = makeContextSource();
      source.fileIndex.files = [
        { path: 'src/café.ts', sizeBytes: 42 },
        { path: 'src/cafe\u0301.ts', sizeBytes },
      ];
      const { repository } = makeRepository({ context: source });

      await expect(
        makeService(repository).assembleContext(
          'builder',
          { ...SCOPE, tokenBudget: 100 },
          TASK,
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expectContextError(error, 'REPOSITORY_RESULT');
        return true;
      });
    },
  );

  it.each([
    ['equal metadata', 4, 8],
    ['conflicting metadata', 5, 9],
  ] as const)(
    'rejects canonically equivalent diffstat paths with %s and exact totals',
    async (_label, secondAdditions, totalAdditions) => {
      const source = makeContextSource();
      firstItem(source.recentChanges.commits).diffstat = {
        files: [
          { path: 'src/café.ts', additions: 4, deletions: 0 },
          { path: 'src/cafe\u0301.ts', additions: secondAdditions, deletions: 0 },
        ],
        additions: totalAdditions,
        deletions: 0,
      };
      const { repository } = makeRepository({ context: source });

      await expect(
        makeService(repository).assembleContext(
          'summarizer',
          { ...SCOPE, tokenBudget: 100 },
          TASK,
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expectContextError(error, 'REPOSITORY_RESULT');
        return true;
      });
    },
  );

  it.each([
    ['equal metadata', 42],
    ['conflicting metadata', 43],
  ] as const)('rejects duplicate normalized file-index paths with %s', async (_label, sizeBytes) => {
    const source = makeContextSource();
    source.fileIndex.files = [
      { path: 'src/index.ts', sizeBytes: 42 },
      { path: 'src/index.ts', sizeBytes },
    ];
    const { repository } = makeRepository({ context: source });

    await expect(
      makeService(repository).assembleContext('builder', { ...SCOPE, tokenBudget: 100 }, TASK),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'REPOSITORY_RESULT');
      return true;
    });
  });

  it.each([
    ['equal metadata', 4, 8],
    ['conflicting metadata', 5, 9],
  ] as const)(
    'rejects duplicate normalized diffstat paths with %s while totals remain exact',
    async (_label, secondAdditions, totalAdditions) => {
      const source = makeContextSource();
      firstItem(source.recentChanges.commits).diffstat = {
        files: [
          { path: 'src/index.ts', additions: 4, deletions: 0 },
          { path: 'src/index.ts', additions: secondAdditions, deletions: 0 },
        ],
        additions: totalAdditions,
        deletions: 0,
      };
      const { repository } = makeRepository({ context: source });

      await expect(
        makeService(repository).assembleContext(
          'summarizer',
          { ...SCOPE, tokenBudget: 100 },
          TASK,
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expectContextError(error, 'REPOSITORY_RESULT');
        return true;
      });
    },
  );

  const overCapCases: ReadonlyArray<
    readonly [string, (source: ContextSourceBundle) => void]
  > = [
    [
      'file index',
      (source) => {
        source.fileIndex.files = Array.from({ length: 1_001 }, (_value, index) => ({
          path: `src/file-${String(index)}.ts`,
          sizeBytes: index,
        }));
      },
    ],
    [
      'recent commits',
      (source) => {
        source.recentChanges.commits = Array.from({ length: 101 }, (_value, index) => ({
          sha: index.toString(16).padStart(40, '0'),
          message: `commit ${String(index)}`,
          diffstat: { files: [], additions: 0, deletions: 0 },
        }));
      },
    ],
    [
      'transcript tail',
      (source) => {
        source.transcript.events = Array.from({ length: 201 }, (_value, index) => ({
          scope: SCOPE,
          eventId: `event-${String(index)}`,
          sequence: index,
          taskId: TASK.taskId,
          content: `event ${String(index)}`,
        }));
      },
    ],
  ];

  it.each(overCapCases)('enforces the explicit %s cap', async (_label, mutate) => {
    const source = makeContextSource();
    mutate(source);
    const { repository } = makeRepository({ context: source });

    await expect(
      makeService(repository).assembleContext('builder', { ...SCOPE, tokenBudget: 100 }, TASK),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'REPOSITORY_RESULT');
      return true;
    });
  });
});

describe('opaque identifiers and locale-independent ordering', () => {
  it('accepts the opaque artifact identifier maximum and rejects overflow', () => {
    const maximumId = `a${'b'.repeat(127)}`;

    expect(OpaqueArtifactIdSchema.safeParse(maximumId).success).toBe(true);
    expect(OpaqueArtifactIdSchema.safeParse(`${maximumId}c`).success).toBe(false);
  });

  it('accepts a maximum-length run identifier without exposing it in the artifact identifier', async () => {
    const runId = 'r'.repeat(256);
    const source = makeCompactionSource();
    source.scope.runId = runId;
    for (const range of source.eventRanges) {
      range.link.runId = runId;
      for (const sourceEvent of range.events) {
        sourceEvent.scope.runId = runId;
      }
    }
    for (const artifact of source.artifacts) {
      artifact.link.runId = runId;
      artifact.scope.runId = runId;
    }
    const { repository } = makeRepository({ compaction: source });

    const summary = await compactWithOperation(
      makeService(repository),
      'maximum-run-id-operation',
      runId,
    );

    expect(summary.artifactId.length).toBeLessThanOrEqual(128);
    expect(summary.artifactId).not.toContain(runId);
  });

  it('orders non-ASCII equal-priority seeds without consulting localeCompare', async () => {
    const source = makeCompactionSource();
    source.eventRanges = [];
    source.artifacts = [
      {
        link: { runId: SCOPE.runId, artifactId: 'ä-source' },
        scope: SCOPE,
        kind: 'other',
        content: 'ä',
      },
      {
        link: { runId: SCOPE.runId, artifactId: 'z-source' },
        scope: SCOPE,
        kind: 'other',
        content: 'z',
      },
    ];
    const retained = '[artifact other:z-source]\nz';
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(function mockSwedishOrder(this: string, other) {
        return this === 'ä-source' && other === 'z-source' ? -1 : 1;
      });

    try {
      const { repository } = makeRepository({ compaction: source });
      const summary = await compactWithOperation(
        makeService(repository, {
          countTokens: (value) => value.length,
          compactionTokenBudget: retained.length,
        }),
        'locale-independent-operation',
      );

      expect(summary.content).toBe(retained);
      expect(summary.tokenCount).toBe(retained.length);
    } finally {
      localeCompare.mockRestore();
    }
  });
});

describe('strict boundaries and non-mutation', () => {
  it('rejects unknown public input fields and malformed repository results', async () => {
    const { repository } = makeRepository();
    const service = makeService(repository);

    await expect(
      service.assembleContext('builder', { ...SCOPE, tokenBudget: 10, unexpected: true }, TASK),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'MALFORMED_INPUT');
      return true;
    });
    await expect(service.compact({ runId: SCOPE.runId })).rejects.toSatisfy(
      (error: unknown) => {
        expectContextError(error, 'MALFORMED_INPUT');
        return true;
      },
    );
    await expect(
      service.compact({ runId: SCOPE.runId, operationId: '   ' }),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'MALFORMED_INPUT');
      return true;
    });
    await expect(
      service.compact({ runId: SCOPE.runId, operationId: 'strict-operation', unexpected: true }),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'MALFORMED_INPUT');
      return true;
    });

    const malformed = { ...makeContextSource(), unexpected: true };
    const malformedRepository = makeRepository({ context: malformed }).repository;
    await expect(
      makeService(malformedRepository).assembleContext(
        'builder',
        { ...SCOPE, tokenBudget: 10 },
        TASK,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectContextError(error, 'REPOSITORY_RESULT');
      return true;
    });
  });

  it('wraps repository failures without leaking the repository message', async () => {
    const { repository } = makeRepository({
      failContextWith: new Error(`provider failed with ${SENSITIVE_VALUE}`),
    });

    let caught: unknown;
    try {
      await makeService(repository).assembleContext('builder', { ...SCOPE, tokenBudget: 10 }, TASK);
    } catch (error) {
      caught = error;
    }

    expectContextError(caught, 'REPOSITORY_FAILURE');
    expect(String(caught)).not.toContain(SENSITIVE_VALUE);
  });

  it('does not mutate repository inputs', async () => {
    const source = makeContextSource();
    const before = clone(source);
    const { repository } = makeRepository({ context: source });

    await makeService(repository).assembleContext(
      'summarizer',
      { ...SCOPE, tokenBudget: 100 },
      TASK,
    );

    expect(source).toEqual(before);
  });
});
