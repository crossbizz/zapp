import {
  idSchema,
  PreviewOperationFailurePayloadSchema,
  PreviewReadyPayloadSchema,
  PreviewStartingPayloadSchema,
  PreviewTerminalFailurePayloadSchema,
} from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { RunSchema, toRun } from '../tenant/view.js';

const RunParamsSchema = z.object({ runId: idSchema('run') }).strict();
const PageQuerySchema = z
  .object({
    cursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const PhaseSchema = z
  .object({
    id: idSchema('phase'),
    sequence: z.number().int().positive(),
    title: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

const TaskNodeSchema = z
  .object({
    id: idSchema('task'),
    phaseId: idSchema('phase'),
    title: z.string().min(1),
    status: z.string().min(1),
    riskLevel: z.string().min(1),
    assignedAgentRole: z.string().min(1).nullable(),
  })
  .strict();

const TaskEdgeSchema = z
  .object({ from: idSchema('task'), to: idSchema('task') })
  .strict();

const ActiveAgentSchema = z
  .object({
    agentId: z.string().min(1),
    role: z.string().min(1),
    taskId: idSchema('task').nullable(),
    startedAt: z.string().datetime(),
  })
  .strict();

const ToolCallSchema = z
  .object({
    sequence: z.number().int().positive(),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    status: z.string().min(1),
    userSummary: z.string().min(1).nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    taskId: idSchema('task').nullable(),
    agentId: z.string().min(1).nullable(),
    occurredAt: z.string().datetime(),
  })
  .strict();

const DiffstatSchema = z
  .object({
    path: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();

const CommitSchema = z
  .object({
    sequence: z.number().int().positive(),
    sha: z.string().regex(/^[0-9a-f]{40}$/u),
    message: z.string().min(1).nullable(),
    taskId: idSchema('task').nullable(),
    occurredAt: z.string().datetime(),
    diffstat: z.array(DiffstatSchema),
  })
  .strict();

const TestRunSchema = z
  .object({
    testRunId: idSchema('trun'),
    type: z.string().min(1),
    status: z.string().min(1),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/u),
    summary: z.unknown().nullable(),
    taskId: idSchema('task').nullable(),
    occurredAt: z.string().datetime(),
  })
  .strict();

const PreviewStatusSchema = z
  .object({ status: z.enum(['starting', 'ready', 'failed']), occurredAt: z.string().datetime() })
  .strict();

const ScreenshotSchema = z
  .object({
    artifactId: idSchema('art'),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    createdAt: z.string().datetime(),
  })
  .strict();

const ApprovalSchema = z
  .object({
    approvalId: idSchema('appr'),
    taskId: idSchema('task').nullable(),
    type: z.string().min(1),
    status: z.string().min(1),
    request: z.unknown(),
    response: z.unknown().nullable(),
    requestedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
  })
  .strict();

const RiskSchema = z
  .object({
    id: z.string().min(1),
    severity: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

export const BuilderRetryReasonSchema = z.enum([
  'eligible',
  'run_not_active',
  'mode_unsupported',
  'task_not_found',
  'task_not_failed',
  'dependencies_unsatisfied',
]);
export const BuilderSkipReasonSchema = z.enum([
  'eligible',
  'run_not_active',
  'mode_unsupported',
  'phase_not_found',
  'phase_required',
  'phase_task_started',
  'phase_already_skipped',
]);
const BuilderActionsSchema = z
  .object({
    retryFailedTasks: z.array(
      z.object({
        taskId: idSchema('task'),
        eligible: z.boolean(),
        reason: BuilderRetryReasonSchema,
      }).strict(),
    ),
    skipOptionalPhases: z.array(
      z.object({
        phaseId: idSchema('phase'),
        eligible: z.boolean(),
        reason: BuilderSkipReasonSchema,
      }).strict(),
    ),
  })
  .strict();
export type BuilderActions = z.infer<typeof BuilderActionsSchema>;

export const MissionControlSchema = z
  .object({
    run: RunSchema,
    currentPhase: PhaseSchema.nullable(),
    progress: z.object({ done: z.number().int(), total: z.number().int() }).strict(),
    taskGraph: z
      .object({ nodes: z.array(TaskNodeSchema), edges: z.array(TaskEdgeSchema) })
      .strict(),
    activeAgents: z.array(ActiveAgentSchema),
    recentToolCalls: z.array(ToolCallSchema).max(50),
    filesChanged: z.array(DiffstatSchema),
    commits: z.array(CommitSchema).max(50),
    testRuns: z.array(TestRunSchema),
    previewStatus: PreviewStatusSchema.nullable(),
    screenshots: z.array(ScreenshotSchema),
    cost: z
      .object({ creditsUsed: z.number().nonnegative(), budget: z.number().nonnegative().nullable() })
      .strict(),
    approvals: z.array(ApprovalSchema),
    risks: z.array(RiskSchema),
    actions: BuilderActionsSchema,
  })
  .strict();

const ToolCallPageSchema = z
  .object({ items: z.array(ToolCallSchema), nextCursor: z.string().nullable() })
  .strict();
const CommitPageSchema = z
  .object({ items: z.array(CommitSchema), nextCursor: z.string().nullable() })
  .strict();

const PhasePayloadSchema = z.object({
  phaseId: idSchema('phase'),
  sequence: z.number().int().positive(),
  title: z.string().min(1),
  status: z.string().min(1),
});
const TaskCreatedPayloadSchema = z.object({
  taskId: idSchema('task'),
  phaseId: idSchema('phase'),
  title: z.string().min(1),
  status: z.string().min(1),
  riskLevel: z.string().min(1),
  dependencies: z.array(idSchema('task')),
  assignedAgentRole: z.string().min(1).nullable().optional(),
});
const TaskStatePayloadSchema = z.object({
  taskId: idSchema('task'),
  status: z.string().min(1),
});
const AgentStartedPayloadSchema = z.object({
  agentId: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  taskId: idSchema('task').nullable().optional(),
});
const AgentCompletedPayloadSchema = z.object({
  agentId: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});
const ToolPayloadSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  userSummary: z.string().min(1).nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
});
const CommitPayloadSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/u).optional(),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/u).optional(),
  message: z.string().min(1).optional(),
  diffstat: z.array(DiffstatSchema).optional(),
});
const TestRunPayloadSchema = z.object({
  testRunId: idSchema('trun'),
  type: z.string().min(1),
  status: z.string().min(1),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  summary: z.unknown().optional(),
});
const ArtifactPayloadSchema = z.object({
  artifactId: idSchema('art'),
  type: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
});
const PlanArtifactPayloadSchema = z.object({
  artifactId: idSchema('art'),
  artifactType: z.literal('implementation_plan'),
  phases: z.array(
    z.object({ phaseId: idSchema('phase'), optional: z.boolean() }).strict(),
  ),
});
const UsagePayloadSchema = z.object({
  creditsCharged: z.union([z.number(), z.string().regex(/^-?[0-9]+(?:\.[0-9]+)?$/u)]),
});
const ApprovalRequestedPayloadSchema = z.object({
  approvalId: idSchema('appr'),
  type: z.string().min(1),
  status: z.string().min(1),
  request: z.unknown(),
});
const ApprovalResolvedPayloadSchema = z.object({
  approvalId: idSchema('appr'),
  status: z.string().min(1),
  response: z.unknown().optional(),
});
const VerificationPayloadSchema = z.object({
  risks: z.array(RiskSchema).optional(),
});
const BudgetPayloadSchema = z.object({ maxCredits: z.number().nonnegative() });

interface MissionEvent {
  readonly sequence: number;
  readonly type: string;
  readonly payloadJson: unknown;
  readonly visibility: string;
  readonly occurredAt: Date;
  readonly phaseId: string | null;
  readonly taskId: string | null;
  readonly agentId: string | null;
}

interface TaskProjection {
  node: z.infer<typeof TaskNodeSchema>;
  readonly dependencies: string[];
}

type ApprovalProjection = z.infer<typeof ApprovalSchema>;

interface Projection {
  currentPhase: z.infer<typeof PhaseSchema> | null;
  readonly phases: Map<string, z.infer<typeof PhaseSchema>>;
  readonly planPhases: Map<string, boolean>;
  readonly tasks: Map<string, TaskProjection>;
  readonly agents: Map<string, z.infer<typeof ActiveAgentSchema>>;
  readonly tools: Map<string, z.infer<typeof ToolCallSchema>>;
  readonly commits: z.infer<typeof CommitSchema>[];
  readonly tests: Map<string, z.infer<typeof TestRunSchema>>;
  preview: z.infer<typeof PreviewStatusSchema> | null;
  screenshots: z.infer<typeof ScreenshotSchema>[];
  creditsUsed: number;
  readonly approvals: Map<string, ApprovalProjection>;
  readonly risks: Map<string, z.infer<typeof RiskSchema>>;
}

export function registerMissionControlRoutes(app: AppInstance): void {
  app.get(
    '/v1/runs/:runId/mission-control',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: RunParamsSchema, response: { 200: MissionControlSchema } },
    },
    async (request) => {
      const { run, events, rows } = await loadRunEvents(request, request.params.runId);
      return buildMissionControl(run, events, rows);
    },
  );

  app.get(
    '/v1/runs/:runId/mission-control/tool-calls',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: RunParamsSchema,
        querystring: PageQuerySchema,
        response: { 200: ToolCallPageSchema },
      },
    },
    async (request) => {
      const { events } = await loadRunEvents(request, request.params.runId);
      const tools = sortedTools(projectVisibleEvents(events));
      return pageBySequence(tools, request.query.cursor, request.query.limit);
    },
  );

  app.get(
    '/v1/runs/:runId/mission-control/commits',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: RunParamsSchema,
        querystring: PageQuerySchema,
        response: { 200: CommitPageSchema },
      },
    },
    async (request) => {
      const { events } = await loadRunEvents(request, request.params.runId);
      const commits = projectVisibleEvents(events).commits.sort(descendingSequence);
      return pageBySequence(commits, request.query.cursor, request.query.limit);
    },
  );
}

async function loadRunEvents(
  request: Parameters<typeof tenantOf>[0],
  runId: string,
): Promise<{
  run: Awaited<ReturnType<ReturnType<typeof tenantOf>['db']['runs']['getById']>> & {};
  events: MissionEvent[];
  rows: Awaited<ReturnType<ReturnType<typeof tenantOf>['db']['missionControl']['forRun']>>;
}> {
  const ctx = tenantOf(request);
  const run = await ctx.db.runs.getById(runId);
  if (run === undefined) throw runNotFound();
  authorize(ctx, 'view_project');
  const [events, rows] = await Promise.all([
    ctx.db.events.byRun(run.id),
    ctx.db.missionControl.forRun(run.id),
  ]);
  return { run, events: events.slice().sort((left, right) => left.sequence - right.sequence), rows };
}

function buildMissionControl(
  run: NonNullable<Awaited<ReturnType<ReturnType<typeof tenantOf>['db']['runs']['getById']>>>,
  events: readonly MissionEvent[],
  rows: Awaited<ReturnType<ReturnType<typeof tenantOf>['db']['missionControl']['forRun']>>,
): z.infer<typeof MissionControlSchema> {
  const projection = projectVisibleEvents(events);
  applyStoredRows(projection, rows);
  if (
    run.status === 'completed' ||
    run.status === 'failed' ||
    run.status === 'cancelled'
  ) {
    projection.agents.clear();
  }
  const taskGraph = taskGraphOf(projection.tasks);
  const initialBudget = BudgetPayloadSchema.safeParse(run.budgetJson);
  const storedBudget = Number(rows.effectiveCreditCeiling);
  return MissionControlSchema.parse({
    run: toRun(run),
    currentPhase: projection.currentPhase,
    progress: {
      done: taskGraph.nodes.filter(
        (task) => task.status === 'passed' || task.status === 'completed',
      ).length,
      total: taskGraph.nodes.length,
    },
    taskGraph,
    activeAgents: [...projection.agents.values()],
    recentToolCalls: sortedTools(projection).slice(0, 50),
    filesChanged: filesChangedOf(projection.commits),
    commits: projection.commits.slice().sort(descendingSequence).slice(0, 50),
    testRuns: [...projection.tests.values()].sort(descendingOccurredAt),
    previewStatus: projection.preview,
    screenshots: projection.screenshots.slice().sort(descendingCreatedAt),
    cost: {
      creditsUsed: Math.max(0, projection.creditsUsed),
      budget: Number.isFinite(storedBudget)
        ? storedBudget
        : initialBudget.success
          ? initialBudget.data.maxCredits
          : null,
    },
    approvals: [...projection.approvals.values()],
    risks: [...projection.risks.values()],
    actions: builderActionsFor(run, projection),
  });
}

function projectVisibleEvents(events: readonly MissionEvent[]): Projection {
  const projection: Projection = {
    currentPhase: null,
    phases: new Map(),
    planPhases: new Map(),
    tasks: new Map(),
    agents: new Map(),
    tools: new Map(),
    commits: [],
    tests: new Map(),
    preview: null,
    screenshots: [],
    creditsUsed: 0,
    approvals: new Map(),
    risks: new Map(),
  };
  for (const event of events) {
    if (event.visibility !== 'user') continue;
    projectEvent(projection, event);
  }
  return projection;
}

function projectEvent(projection: Projection, event: MissionEvent): void {
  if (event.type.startsWith('phase.')) {
    const payload = PhasePayloadSchema.safeParse(event.payloadJson);
    if (payload.success) {
      projection.currentPhase = PhaseSchema.parse({
        id: payload.data.phaseId,
        sequence: payload.data.sequence,
        title: payload.data.title,
        status: payload.data.status,
      });
      projection.phases.set(payload.data.phaseId, projection.currentPhase);
    }
    return;
  }
  if (event.type === 'task.created') {
    const payload = TaskCreatedPayloadSchema.safeParse(event.payloadJson);
    if (!payload.success) return;
    projection.tasks.set(payload.data.taskId, {
      node: TaskNodeSchema.parse({
        id: payload.data.taskId,
        phaseId: payload.data.phaseId,
        title: payload.data.title,
        status: payload.data.status,
        riskLevel: payload.data.riskLevel,
        assignedAgentRole: payload.data.assignedAgentRole ?? null,
      }),
      dependencies: payload.data.dependencies,
    });
    return;
  }
  if (event.type.startsWith('task.')) {
    const payload = TaskStatePayloadSchema.safeParse(event.payloadJson);
    if (!payload.success) return;
    const task = projection.tasks.get(payload.data.taskId);
    if (task !== undefined) task.node = { ...task.node, status: payload.data.status };
    return;
  }
  if (event.type === 'agent.started') {
    const payload = AgentStartedPayloadSchema.safeParse(event.payloadJson);
    if (!payload.success) return;
    const agentId = event.agentId ?? payload.data.agentId ?? payload.data.agent;
    const role = payload.data.role ?? payload.data.agent;
    if (agentId === undefined || role === undefined) return;
    projection.agents.set(agentId, {
      agentId,
      role,
      taskId: payload.data.taskId ?? event.taskId,
      startedAt: event.occurredAt.toISOString(),
    });
    return;
  }
  if (event.type === 'agent.completed') {
    const payload = AgentCompletedPayloadSchema.safeParse(event.payloadJson);
    const agentId = payload.success
      ? (event.agentId ?? payload.data.agentId ?? payload.data.agent)
      : undefined;
    if (agentId !== undefined) projection.agents.delete(agentId);
    return;
  }
  if (event.type === 'run.completed' || event.type === 'run.cancelled') {
    projection.agents.clear();
    return;
  }
  if (event.type.startsWith('tool.')) {
    const payload = ToolPayloadSchema.safeParse(event.payloadJson);
    if (!payload.success) return;
    const prior = projection.tools.get(payload.data.toolCallId);
    const toolName = payload.data.toolName ?? payload.data.tool ?? prior?.toolName;
    if (toolName === undefined) return;
    projection.tools.set(payload.data.toolCallId, {
      sequence: event.sequence,
      toolCallId: payload.data.toolCallId,
      toolName,
      status: payload.data.status ?? event.type.slice('tool.'.length),
      userSummary: payload.data.userSummary ?? prior?.userSummary ?? null,
      durationMs: payload.data.durationMs ?? prior?.durationMs ?? null,
      taskId: event.taskId,
      agentId: event.agentId,
      occurredAt: event.occurredAt.toISOString(),
    });
    return;
  }
  if (event.type === 'commit.created') {
    const payload = CommitPayloadSchema.safeParse(event.payloadJson);
    if (!payload.success) return;
    const sha = payload.data.sha ?? payload.data.commitSha;
    if (sha === undefined) return;
    projection.commits.push({
      sequence: event.sequence,
      sha,
      message: payload.data.message ?? null,
      taskId: event.taskId,
      occurredAt: event.occurredAt.toISOString(),
      diffstat: payload.data.diffstat ?? [],
    });
    return;
  }
  if (event.type === 'test.started' || event.type === 'test.completed') {
    const payload = TestRunPayloadSchema.safeParse(event.payloadJson);
    if (!payload.success) return;
    projection.tests.set(payload.data.testRunId, {
      testRunId: payload.data.testRunId,
      type: payload.data.type,
      status: payload.data.status,
      commitSha: payload.data.commitSha,
      summary: payload.data.summary ?? null,
      taskId: event.taskId,
      occurredAt: event.occurredAt.toISOString(),
    });
    return;
  }
  if (event.type.startsWith('preview.')) {
    const validPayload =
      event.type === 'preview.starting'
        ? PreviewStartingPayloadSchema.safeParse(event.payloadJson).success
        : event.type === 'preview.ready'
          ? PreviewReadyPayloadSchema.safeParse(event.payloadJson).success
          : event.type === 'preview.failed'
            ? z
                .union([
                  PreviewOperationFailurePayloadSchema,
                  PreviewTerminalFailurePayloadSchema,
                ])
                .safeParse(event.payloadJson).success
            : false;
    if (validPayload) {
      projection.preview = {
        status: event.type.slice('preview.'.length) as 'failed' | 'ready' | 'starting',
        occurredAt: event.occurredAt.toISOString(),
      };
    }
    return;
  }
  if (event.type === 'artifact.created') {
    const plan = PlanArtifactPayloadSchema.safeParse(event.payloadJson);
    if (plan.success) {
      for (const phase of plan.data.phases) {
        projection.planPhases.set(phase.phaseId, phase.optional);
      }
      return;
    }
    const payload = ArtifactPayloadSchema.safeParse(event.payloadJson);
    if (payload.success && payload.data.type === 'screenshot') {
      projection.screenshots.push({
        artifactId: payload.data.artifactId,
        contentHash: payload.data.contentHash,
        createdAt: event.occurredAt.toISOString(),
      });
    }
    return;
  }
  if (event.type === 'usage.recorded') {
    const payload = UsagePayloadSchema.safeParse(event.payloadJson);
    if (payload.success) projection.creditsUsed += Number(payload.data.creditsCharged);
    return;
  }
  if (event.type === 'approval.requested') {
    const payload = ApprovalRequestedPayloadSchema.safeParse(event.payloadJson);
    if (!payload.success) return;
    projection.approvals.set(payload.data.approvalId, {
      approvalId: payload.data.approvalId,
      taskId: event.taskId,
      type: payload.data.type,
      status: payload.data.status,
      request: payload.data.request,
      response: null,
      requestedAt: event.occurredAt.toISOString(),
      resolvedAt: null,
    });
    return;
  }
  if (event.type === 'approval.resolved') {
    const payload = ApprovalResolvedPayloadSchema.safeParse(event.payloadJson);
    if (!payload.success) return;
    const approval = projection.approvals.get(payload.data.approvalId);
    if (approval !== undefined) {
      projection.approvals.set(payload.data.approvalId, {
        ...approval,
        status: payload.data.status,
        response: payload.data.response ?? null,
        resolvedAt: event.occurredAt.toISOString(),
      });
    }
    return;
  }
  if (event.type === 'verification.completed') {
    const payload = VerificationPayloadSchema.safeParse(event.payloadJson);
    if (!payload.success) return;
    for (const risk of payload.data.risks ?? []) projection.risks.set(risk.id, risk);
  }
}

function applyStoredRows(
  projection: Projection,
  rows: Awaited<ReturnType<ReturnType<typeof tenantOf>['db']['missionControl']['forRun']>>,
): void {
  if (rows.phases.length > 0) {
    projection.phases.clear();
    for (const stored of rows.phases) {
      projection.phases.set(stored.id, {
        id: stored.id,
        sequence: stored.sequence,
        title: stored.title,
        status: stored.status,
      });
    }
    const phase =
      rows.phases.findLast((candidate) => candidate.status === 'running') ?? rows.phases.at(-1);
    projection.currentPhase =
      phase === undefined
        ? null
        : {
            id: phase.id,
            sequence: phase.sequence,
            title: phase.title,
            status: phase.status,
          };
  }

  if (rows.tasks.length > 0) {
    projection.tasks.clear();
    for (const task of rows.tasks) {
      const dependencies = z.array(idSchema('task')).safeParse(task.dependenciesJson);
      projection.tasks.set(task.id, {
        node: {
          id: task.id,
          phaseId: task.phaseId,
          title: task.title,
          status: task.status,
          riskLevel: task.riskLevel,
          assignedAgentRole: task.assignedAgentRole,
        },
        dependencies: dependencies.success ? dependencies.data : [],
      });
    }
  }

  if (rows.approvals.length > 0) {
    projection.approvals.clear();
    for (const approval of rows.approvals) {
      projection.approvals.set(approval.id, {
        approvalId: approval.id,
        taskId: approval.taskId,
        type: approval.type,
        status: approval.status,
        request: approval.requestJson,
        response: approval.responseJson,
        requestedAt: approval.requestedAt.toISOString(),
        resolvedAt: approval.resolvedAt?.toISOString() ?? null,
      });
    }
  }

  if (rows.artifacts.length > 0) {
    projection.screenshots = rows.artifacts
      .filter((artifact) => artifact.type === 'screenshot')
      .map((artifact) => ({
        artifactId: artifact.id,
        contentHash: artifact.contentHash,
        createdAt: artifact.createdAt.toISOString(),
      }));
  }

  if (rows.testRuns.length > 0) {
    projection.tests.clear();
    for (const testRun of rows.testRuns) {
      projection.tests.set(testRun.id, {
        testRunId: testRun.id,
        type: testRun.type,
        status: testRun.status,
        commitSha: testRun.commitSha,
        summary: testRun.summaryJson,
        taskId: testRun.taskId,
        occurredAt: (testRun.completedAt ?? testRun.startedAt).toISOString(),
      });
    }
  }

  if (rows.verificationResults.length > 0) {
    projection.risks.clear();
    for (const result of rows.verificationResults) {
      const risks = z.array(RiskSchema).safeParse(result.risksJson);
      if (!risks.success) continue;
      for (const risk of risks.data) projection.risks.set(risk.id, risk);
    }
  }

  if (rows.creditAccount !== undefined) {
    const credits = Number(rows.creditAccount.usedCredits);
    projection.creditsUsed = Number.isFinite(credits) ? credits : 0;
  }
}

export function deriveBuilderActions(
  run: { readonly status: string; readonly mode: string },
  events: readonly MissionEvent[],
  rows: Awaited<ReturnType<ReturnType<typeof tenantOf>['db']['missionControl']['forRun']>>,
): BuilderActions {
  const projection = projectVisibleEvents(events);
  applyStoredRows(projection, rows);
  return builderActionsFor(run, projection);
}

function builderActionsFor(
  run: { readonly status: string; readonly mode: string },
  projection: Projection,
): BuilderActions {
  const active = !['completed', 'failed', 'cancelled'].includes(run.status);
  const supported = run.mode === 'build' || run.mode === 'autonomous';
  const retryFailedTasks = [...projection.tasks.values()].map(({ node, dependencies }) => {
    let reason: z.infer<typeof BuilderRetryReasonSchema> = 'eligible';
    if (!active) reason = 'run_not_active';
    else if (!supported) reason = 'mode_unsupported';
    else if (node.status !== 'failed') reason = 'task_not_failed';
    else if (
      dependencies.some((dependencyId) => {
        const dependency = projection.tasks.get(dependencyId)?.node;
        return dependency === undefined || !['completed', 'passed'].includes(dependency.status);
      })
    ) reason = 'dependencies_unsatisfied';
    return { taskId: node.id, eligible: reason === 'eligible', reason };
  });

  const phaseIds = new Set([...projection.planPhases.keys(), ...projection.phases.keys()]);
  const skipOptionalPhases = [...phaseIds].map((phaseId) => {
    let reason: z.infer<typeof BuilderSkipReasonSchema> = 'eligible';
    if (!active) reason = 'run_not_active';
    else if (!supported) reason = 'mode_unsupported';
    else if (projection.planPhases.get(phaseId) !== true) reason = 'phase_required';
    else if (projection.phases.get(phaseId)?.status === 'skipped') reason = 'phase_already_skipped';
    else if (
      [...projection.tasks.values()].some(
        ({ node }) => node.phaseId === phaseId && !['queued', 'pending'].includes(node.status),
      )
    ) reason = 'phase_task_started';
    return { phaseId, eligible: reason === 'eligible', reason };
  });
  return BuilderActionsSchema.parse({ retryFailedTasks, skipOptionalPhases });
}

function taskGraphOf(tasks: ReadonlyMap<string, TaskProjection>): {
  nodes: z.infer<typeof TaskNodeSchema>[];
  edges: z.infer<typeof TaskEdgeSchema>[];
} {
  const nodes = [...tasks.values()].map((task) => task.node);
  const edges = [...tasks.values()].flatMap((task) =>
    task.dependencies.map((dependency) => ({ from: dependency, to: task.node.id })),
  );
  return { nodes, edges };
}

function sortedTools(projection: Projection): z.infer<typeof ToolCallSchema>[] {
  return [...projection.tools.values()].sort(descendingSequence);
}

function filesChangedOf(commits: readonly z.infer<typeof CommitSchema>[]): z.infer<typeof DiffstatSchema>[] {
  const files = new Map<string, z.infer<typeof DiffstatSchema>>();
  for (const commit of commits) {
    for (const entry of commit.diffstat) {
      const prior = files.get(entry.path);
      files.set(entry.path, {
        path: entry.path,
        additions: (prior?.additions ?? 0) + entry.additions,
        deletions: (prior?.deletions ?? 0) + entry.deletions,
      });
    }
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function pageBySequence<T extends { readonly sequence: number }>(
  items: readonly T[],
  cursor: number | undefined,
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const eligible = items.filter((item) => cursor === undefined || item.sequence < cursor);
  const page = eligible.slice(0, limit + 1);
  const visible = page.slice(0, limit);
  return {
    items: visible,
    nextCursor: page.length > limit ? String(visible.at(-1)?.sequence) : null,
  };
}

function descendingSequence<T extends { readonly sequence: number }>(left: T, right: T): number {
  return right.sequence - left.sequence;
}

function descendingOccurredAt<T extends { readonly occurredAt: string }>(left: T, right: T): number {
  return right.occurredAt.localeCompare(left.occurredAt);
}

function descendingCreatedAt<T extends { readonly createdAt: string }>(left: T, right: T): number {
  return right.createdAt.localeCompare(left.createdAt);
}

function runNotFound(): ApiError {
  return new ApiError('run_not_found', 404, 'That run does not exist.');
}
