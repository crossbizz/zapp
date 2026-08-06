import { describe, expect, it } from 'vitest';

import {
  CompactionSourceBundleSchema,
  ContextError,
  ContextSourceBundleSchema,
  SummaryArtifactSchema,
  createContextService,
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
          sha: 'abc1234',
          message: 'Add context tests',
          diffstat: '2 files changed, 20 insertions(+)',
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

type RepositoryState = {
  context: unknown;
  compaction: unknown;
  summaries: SummaryArtifact[];
  sourceEvents: CompactionSourceBundle['eventRanges'];
  sourceArtifacts: CompactionSourceBundle['artifacts'];
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
}): { repository: ContextRepository; state: RepositoryState } {
  const compaction = options?.compaction ?? makeCompactionSource();
  const parsedCompaction = CompactionSourceBundleSchema.safeParse(compaction);
  const state: RepositoryState = {
    context: options?.context ?? makeContextSource(),
    compaction,
    summaries: [],
    sourceEvents: parsedCompaction.success ? clone(parsedCompaction.data.eventRanges) : [],
    sourceArtifacts: parsedCompaction.success ? clone(parsedCompaction.data.artifacts) : [],
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
    fetchCompactionSources() {
      return Promise.resolve(state.compaction);
    },
    getLatestSummary() {
      return Promise.resolve(clone(state.summaries.at(-1) ?? null));
    },
    appendSummary(summary) {
      const saved = SummaryArtifactSchema.parse(summary);
      state.summaries.push(clone(saved));
      return Promise.resolve(clone(saved));
    },
    resolveEventRange(link) {
      const range = state.sourceEvents.find(
        (candidate) =>
          candidate.link.runId === link.runId &&
          candidate.link.startEventId === link.startEventId &&
          candidate.link.endEventId === link.endEventId &&
          candidate.link.startSequence === link.startSequence &&
          candidate.link.endSequence === link.endSequence,
      );
      return Promise.resolve(clone(range ?? null));
    },
    resolveArtifact(link) {
      const artifact = state.sourceArtifacts.find(
        (candidate) =>
          candidate.link.runId === link.runId && candidate.link.artifactId === link.artifactId,
      );
      return Promise.resolve(clone(artifact ?? null));
    },
  };

  return { repository, state };
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

  it('scrubs every assembled section before token counting and output', async () => {
    const source = makeContextSource();
    source.specification.content += ` ${SENSITIVE_VALUE}`;
    source.specification.acceptanceCriteria[0] = `${firstItem(source.specification.acceptanceCriteria)} ${SENSITIVE_VALUE}`;
    source.plan.content += ` ${SENSITIVE_VALUE}`;
    source.plan.task.title += ` ${SENSITIVE_VALUE}`;
    source.plan.task.acceptanceCriteria[0] = `${firstItem(source.plan.task.acceptanceCriteria)} ${SENSITIVE_VALUE}`;
    firstItem(source.decisionLog.decisions).content += ` ${SENSITIVE_VALUE}`;
    source.architectureSummary.content += ` ${SENSITIVE_VALUE}`;
    firstItem(source.fileIndex.files).path += SENSITIVE_VALUE;
    firstItem(source.recentChanges.commits).message += ` ${SENSITIVE_VALUE}`;
    firstItem(source.recentChanges.commits).diffstat += ` ${SENSITIVE_VALUE}`;
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

describe('compact', () => {
  it('appends v1 then v2 while original events, artifacts, and exact links remain resolvable', async () => {
    const { repository, state } = makeRepository();
    const originalCompaction = clone(state.compaction);
    const originalEvents = clone(state.sourceEvents);
    const originalArtifacts = clone(state.sourceArtifacts);
    const service = makeService(repository);

    const first = await service.compact(SCOPE.runId);
    const second = await service.compact(SCOPE.runId);

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
    const { repository, state } = makeRepository({ compaction: source });
    const service = makeService(repository, {
      scrub: (value) => value.replaceAll(SENSITIVE_VALUE, '[REDACTED]'),
      countTokens: (value) => {
        countedValues.push(value);
        return 1;
      },
    });

    const summary = await service.compact(SCOPE.runId);

    expect(JSON.stringify(summary)).not.toContain(SENSITIVE_VALUE);
    expect(JSON.stringify(state.summaries)).not.toContain(SENSITIVE_VALUE);
    expect(JSON.stringify(countedValues)).not.toContain(SENSITIVE_VALUE);
    expect(summary.content).toContain('[REDACTED]');
  });

  it('fails before appending when an exact source link cannot be resolved', async () => {
    const source = makeCompactionSource();
    firstItem(source.eventRanges).link.endEventId = 'missing-event';
    const { repository, state } = makeRepository({ compaction: source });

    await expect(makeService(repository).compact(SCOPE.runId)).rejects.toSatisfy(
      (error: unknown) => {
        expectContextError(error, 'UNRESOLVED_LINK');
        return true;
      },
    );
    expect(state.summaries).toEqual([]);
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
