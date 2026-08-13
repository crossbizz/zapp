import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ConversationCardSchema, TOOL_GROUPS } from '@zapp/contracts';
import { applyPlanDiff, type PlanDiff } from '@zapp/planning-engine';
import { afterEach, describe, expect, it } from 'vitest';

import { createRunWorker, type RunActivities } from '../src/worker.js';
import {
  BUILD_MODE_APPROVAL_CONFIG,
  BuildModePlanSchema,
  budgetApprovalResolvedSignal,
  buildWorkflow,
  creditBalanceExhaustedSignal,
  redirectRunSignal,
  runWorkflow,
  shouldAutoApproveBuildPlan,
  type RunWorkflowInput,
} from '../src/workflows/run.js';
import { autonomousPlanApprovalSignal } from '../src/workflows/autonomous.js';

const id = (
  prefix: 'run' | 'org' | 'proj' | 'br' | 'phase' | 'task' | 'art' | 'vr',
  suffix = '0',
): string =>
  `${prefix}_01J0000000000000000000000${suffix}`;

function input(mode: RunWorkflowInput['mode']): RunWorkflowInput {
  const runId = id('run', mode === 'ask' ? '2' : '3');
  return {
    runId,
    workflowId: runId,
    organizationId: id('org'),
    projectId: id('proj'),
    branchId: mode === 'ask' ? null : id('br'),
    mode,
    appType: 'web',
    model: null,
    prompt: mode === 'ask' ? 'Where is request validation implemented?' : 'Prototype checkout.',
    budget: null,
    planMaxCredits: 1000,
    operationKey: `op_${'b'.repeat(64)}`,
  };
}

describe('AR-15 Ask and Prototype modes', () => {
  let environment: TestWorkflowEnvironment | undefined;

  afterEach(async () => {
    await environment?.teardown();
    environment = undefined;
  });

  it('keeps Ask read-only, warns on an uncited code claim, and does not commit', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar15-ask-${Date.now().toString(36)}`;
    const sessionInputs: Array<Record<string, unknown>> = [];
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let commits = 0;
    const activities: RunActivities = {
      transitionRunStatus: () => Promise.resolve(),
      storeAssistantContent: () => Promise.reject(new Error('assistant overflow not expected')),
      emitEvents: ({ events }) => {
        emitted.push(...events.map(({ type, payload }) => ({ type, payload })));
        return Promise.resolve();
      },
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-ask' }),
      runBuilderSession: (request) => {
        sessionInputs.push(request);
        return Promise.resolve({
          status: 'completed',
          commits: [],
          artifacts: [],
          summary: 'Request validation is implemented in services/control-api/src/app.ts.',
        });
      },
      commitAndPush: () => {
        commits += 1;
        return Promise.resolve({ commitSha: 'a'.repeat(40), diffstat: [] });
      },
      estimateRunCost: () => Promise.resolve({ estimatedCredits: '1.0000' }),
      requestBudgetIncrease: () => Promise.reject(new Error('Ask must not request a budget increase')),
      checkpointBudgetStop: () => Promise.reject(new Error('Ask must not checkpoint a budget stop')),
    };
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const workflowInput = input('ask');
      const result = await environment?.client.workflow.execute(runWorkflow, {
        taskQueue,
        workflowId: workflowInput.workflowId,
        args: [workflowInput],
      });
      expect(result).toEqual({ status: 'completed', commitSha: null });
    });

    expect(sessionInputs).toHaveLength(1);
    expect(sessionInputs[0]).toMatchObject({
      mode: 'ask',
      allowedTools: [...TOOL_GROUPS.read],
    });
    expect(sessionInputs[0]?.modeInstructions).toEqual(expect.stringContaining('path:line'));
    expect(commits).toBe(0);
    expect(emitted).toContainEqual({
      type: 'verification.completed',
      payload: {
        code: 'ask_citation_required',
        severity: 'warning',
      },
    });
  }, 30_000);

  it('labels Prototype mocks, requires preview health tools, and marks its commit origin', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar15-prototype-${Date.now().toString(36)}`;
    const sessionInputs: Array<Record<string, unknown>> = [];
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const activities: RunActivities = {
      transitionRunStatus: () => Promise.resolve(),
      storeAssistantContent: () => Promise.reject(new Error('assistant overflow not expected')),
      emitEvents: ({ events }) => {
        emitted.push(...events.map(({ type, payload }) => ({ type, payload })));
        return Promise.resolve();
      },
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-prototype' }),
      runBuilderSession: (request) => {
        sessionInputs.push(request);
        return Promise.resolve({
          status: 'completed',
          commits: [],
          artifacts: [],
          summary: 'Interactive checkout prototype ready.',
          completedTools: ['run_dev_server', 'run_preview_smoke_test'],
          mocks: [
            {
              name: 'payment-provider',
              reason: 'Provider credentials are not configured for this prototype.',
            },
          ],
        });
      },
      commitAndPush: () =>
        Promise.resolve({
          commitSha: 'c'.repeat(40),
          diffstat: [{ path: 'src/checkout.ts', additions: 14, deletions: 0 }],
        }),
      estimateRunCost: () => Promise.resolve({ estimatedCredits: '2.0000' }),
      requestBudgetIncrease: () =>
        Promise.reject(new Error('Prototype must not request a budget increase in this fixture')),
      checkpointBudgetStop: () =>
        Promise.reject(new Error('Prototype must not checkpoint a budget stop in this fixture')),
    };
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const workflowInput = input('prototype');
      const result = await environment?.client.workflow.execute(runWorkflow, {
        taskQueue,
        workflowId: workflowInput.workflowId,
        args: [workflowInput],
      });
      expect(result).toEqual({ status: 'completed', commitSha: 'c'.repeat(40) });
    });

    expect(sessionInputs).toHaveLength(1);
    expect(sessionInputs[0]?.allowedTools).toEqual(
      expect.arrayContaining(['run_dev_server', 'run_preview_smoke_test']),
    );
    expect(sessionInputs[0]?.modeInstructions).toEqual(expect.stringContaining('label every mock'));
    expect(emitted).toContainEqual({
      type: 'artifact.created',
      payload: {
        kind: 'prototype_assumptions',
        mocks: [
          {
            name: 'payment-provider',
            reason: 'Provider credentials are not configured for this prototype.',
          },
        ],
      },
    });
    expect(emitted.find(({ type }) => type === 'commit.created')?.payload).toMatchObject({
      commitSha: 'c'.repeat(40),
      mode: 'prototype',
    });
  }, 30_000);

  it('fails a Prototype before commit when its dev-server smoke gate is incomplete', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar15-prototype-gate-${Date.now().toString(36)}`;
    let commits = 0;
    const statuses: string[] = [];
    const activities: RunActivities = {
      transitionRunStatus: ({ status }) => {
        statuses.push(status);
        return Promise.resolve();
      },
      storeAssistantContent: () => Promise.reject(new Error('assistant overflow not expected')),
      emitEvents: () => Promise.resolve(),
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-prototype-gate' }),
      runBuilderSession: () =>
        Promise.resolve({
          status: 'completed',
          commits: [],
          artifacts: [],
          summary: 'Preview not smoke-tested.',
          completedTools: ['run_dev_server'],
        }),
      commitAndPush: () => {
        commits += 1;
        return Promise.resolve({ commitSha: 'd'.repeat(40), diffstat: [] });
      },
      estimateRunCost: () => Promise.resolve({ estimatedCredits: '2.0000' }),
      requestBudgetIncrease: () => Promise.reject(new Error('not expected')),
      checkpointBudgetStop: () => Promise.reject(new Error('not expected')),
    };
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await expect(
      worker.runUntil(async () => {
        const workflowInput = input('prototype');
        return await environment?.client.workflow.execute(runWorkflow, {
          taskQueue,
          workflowId: `${workflowInput.workflowId}-gate`,
          args: [workflowInput],
        });
      }),
    ).rejects.toThrow('Workflow execution failed');
    expect(commits).toBe(0);
    expect(statuses.at(-1)).toBe('failed');
  }, 30_000);
});

function buildInput(suffix: string): RunWorkflowInput {
  const runId = id('run', suffix);
  return {
    runId,
    workflowId: runId,
    organizationId: id('org', suffix),
    projectId: id('proj', suffix),
    branchId: id('br', suffix),
    mode: 'build',
    appType: 'web',
    model: null,
    prompt: 'Add an organization-scoped activity feed with tests.',
    budget: { maxCredits: 40 },
    planMaxCredits: 1000,
    operationKey: `op_${suffix.repeat(64)}`,
  };
}

function lightweightPlan(options: {
  readonly suffix: string;
  readonly riskLevel: 'low' | 'medium' | 'high';
  readonly expectedFiles?: readonly string[];
  readonly taskCount?: number;
}) {
  const phaseId = id('phase', options.suffix);
  const taskCount = options.taskCount ?? 2;
  const criteria = Array.from({ length: taskCount }, (_, index) => `AC-${String(index + 1)}`);
  return {
    phases: [
      {
        id: phaseId,
        sequence: 1,
        title: 'Build requested change',
        acceptanceCriteria: criteria,
        approvalAfter: false,
      },
    ],
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: id('task', String((Number(options.suffix) + index) % 10)),
      phaseId,
      title: `Build task ${String(index + 1)}`,
      dependsOn: index === 0 ? [] : [id('task', options.suffix)],
      riskLevel: options.riskLevel,
      requiredTools: ['read_file', 'write_file'],
      expectedFiles: [...(options.expectedFiles ?? [`src/task-${String(index + 1)}.ts`])],
      acceptanceCriteriaIds: [criteria[index]],
      requiredTests: [`test/task-${String(index + 1)}.test.ts`],
      estimate: { credits: 10, wallClockMinutes: 15 },
    })),
    budget: { credits: 20, wallClockHours: 1 },
  };
}

describe('AR-18 Build mode', () => {
  let environment: TestWorkflowEnvironment | undefined;

  afterEach(async () => {
    await environment?.teardown();
    environment = undefined;
  });

  it('rejects plans outside one phase or five tasks and auto-approves only bounded low-risk work', () => {
    BuildModePlanSchema.parse(lightweightPlan({ suffix: '4', riskLevel: 'low' }));
    expect(
      shouldAutoApproveBuildPlan(
        { source: 'policy_engine', diffFiles: 2, risk: 'low' },
        BUILD_MODE_APPROVAL_CONFIG,
      ),
    ).toBe(true);
    expect(
      shouldAutoApproveBuildPlan(
        { source: 'policy_engine', diffFiles: 2, risk: 'high' },
        BUILD_MODE_APPROVAL_CONFIG,
      ),
    ).toBe(false);
    expect(
      shouldAutoApproveBuildPlan(
        { source: 'policy_engine', diffFiles: 9, risk: 'low' },
        BUILD_MODE_APPROVAL_CONFIG,
      ),
    ).toBe(false);
    expect(
      BuildModePlanSchema.safeParse(
        lightweightPlan({ suffix: '6', riskLevel: 'low', taskCount: 6 }),
      ).success,
    ).toBe(false);
    const unmapped = lightweightPlan({ suffix: '6', riskLevel: 'low' });
    const firstTask = unmapped.tasks[0];
    if (firstTask === undefined) throw new Error('fixture task missing');
    firstTask.acceptanceCriteriaIds = ['AC-404'];
    expect(BuildModePlanSchema.safeParse(unmapped).success).toBe(false);
  });

  it('rejects caller-supplied Build continuations before any activity can run', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar18-build-provenance-${Date.now().toString(36)}`;
    const workflowInput = buildInput('9');
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../src/workflows/run.ts', import.meta.url).pathname,
      activities: {},
    });

    await expect(
      worker.runUntil(async () =>
        await environment?.client.workflow.execute(buildWorkflow, {
          taskQueue,
          workflowId: workflowInput.workflowId,
          args: [
            {
              ...workflowInput,
              buildModeVersion: 'lightweight-v1',
              continuation: { phase: 'build_plan', workspaceId: 'caller-workspace' },
            },
          ],
        }),
      ),
    ).rejects.toThrow('Workflow execution failed');
  }, 30_000);

  it('holds workspace scheduling when credit exhausts during the starting-event await', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar18-build-workspace-credit-${Date.now().toString(36)}`;
    const workflowInput = buildInput('8');
    let resolveStartingEvents: (() => void) | undefined;
    const startingEvents = new Promise<void>((resolve) => {
      resolveStartingEvents = resolve;
    });
    let releaseStartingEvents: (() => void) | undefined;
    const startingEventsReleased = new Promise<void>((resolve) => {
      releaseStartingEvents = resolve;
    });
    let resolveApprovalRequested: (() => void) | undefined;
    const approvalRequested = new Promise<void>((resolve) => {
      resolveApprovalRequested = resolve;
    });
    let resolveWorkspaceScheduled: (() => void) | undefined;
    const workspaceScheduled = new Promise<void>((resolve) => {
      resolveWorkspaceScheduled = resolve;
    });
    let workspaceCalls = 0;

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../src/workflows/run.ts', import.meta.url).pathname,
      activities: {
        transitionRunStatus: () => Promise.resolve(),
        async emitEvents({ events }: { events: Array<{ type: string }> }) {
          if (events.some(({ type }) => type === 'run.started')) {
            resolveStartingEvents?.();
            await startingEventsReleased;
          }
        },
        storeAssistantContent: () => Promise.reject(new Error('not expected')),
        ensureWorkspace: () => {
          workspaceCalls += 1;
          resolveWorkspaceScheduled?.();
          return Promise.resolve({ workspaceId: 'workspace-build-credit-boundary' });
        },
        estimateRunCost: () => Promise.resolve({ estimatedCredits: '20.0000' }),
        requestBudgetIncrease: () => {
          resolveApprovalRequested?.();
          return Promise.resolve({
            approvalId: 'appr_01J00000000000000000000006',
            absoluteCeiling: '40.0000',
          });
        },
        checkpointBudgetStop: () => Promise.reject(new Error('checkpoint not expected')),
      },
    });

    await worker.runUntil(async () => {
      const handle = await environment?.client.workflow.start(buildWorkflow, {
        taskQueue,
        workflowId: workflowInput.workflowId,
        args: [workflowInput],
      });
      await startingEvents;
      await handle?.signal(creditBalanceExhaustedSignal, {
        runId: workflowInput.runId,
        operationKey: `op_${'6'.repeat(64)}`,
      });
      releaseStartingEvents?.();

      const firstBoundary = await Promise.race([
        approvalRequested.then(() => 'approval' as const),
        workspaceScheduled.then(() => 'workspace' as const),
      ]);
      expect(firstBoundary).toBe('approval');
      expect(workspaceCalls).toBe(0);
      await handle?.terminate('workspace boundary observed');
      await expect(handle?.result()).rejects.toThrow('workspace boundary observed');
    });
  }, 30_000);

  it('holds redirect planning when credit exhausts during redirect status work, then passes VF', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar18-build-auto-${Date.now().toString(36)}`;
    const workflowInput = buildInput('4');
    const plan = BuildModePlanSchema.parse(lightweightPlan({ suffix: '4', riskLevel: 'low' }));
    const planArtifactId = id('art', '4');
    const integrationCommit = 'f'.repeat(40);
    const timeline: string[] = [];
    const taskPrompts: string[] = [];
    const taskTransitions: Array<{ status: string; taskIds: string[] }> = [];
    let legacyCommits = 0;
    let redirectApplied = false;
    let redirectPlanCalls = 0;
    let resolveHeadCalls = 0;
    let resolveTaskSessionStarted: (() => void) | undefined;
    const taskSessionStarted = new Promise<void>((resolve) => {
      resolveTaskSessionStarted = resolve;
    });
    let releaseTaskSession: (() => void) | undefined;
    const taskSessionReleased = new Promise<void>((resolve) => {
      releaseTaskSession = resolve;
    });
    let resolveRedirectPausedStatusStarted: (() => void) | undefined;
    const redirectPausedStatusStarted = new Promise<void>((resolve) => {
      resolveRedirectPausedStatusStarted = resolve;
    });
    let releaseRedirectPausedStatus: (() => void) | undefined;
    const redirectPausedStatusReleased = new Promise<void>((resolve) => {
      releaseRedirectPausedStatus = resolve;
    });
    let resolveCreditApprovalRequested: (() => void) | undefined;
    const creditApprovalRequested = new Promise<void>((resolve) => {
      resolveCreditApprovalRequested = resolve;
    });
    const redirectedPlanArtifactId = id('art', '6');
    const redirectedTask = plan.tasks[1];
    if (redirectedTask === undefined) throw new Error('redirect fixture task missing');
    const redirectDiff: PlanDiff = {
      addedTasks: [],
      removedTaskIds: [],
      modifiedTasks: [{ ...redirectedTask, title: 'Build task 2 with final copy' }],
      supersededTaskIds: [],
      impact: { scope: false, costDelta: false, archChange: false, dataChange: false },
    };

    const mainWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../src/workflows/run.ts', import.meta.url).pathname,
      activities: {
        transitionRunStatus: async ({ status }: { status: string }) => {
          timeline.push(`run:${status}`);
          if (status === 'paused') {
            resolveRedirectPausedStatusStarted?.();
            await redirectPausedStatusReleased;
          }
        },
        emitEvents: ({ events }: { events: Array<{ type: string }> }) => {
          timeline.push(...events.map(({ type }) => `event:${type}`));
          return Promise.resolve();
        },
        storeAssistantContent: () => Promise.reject(new Error('not expected')),
        ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-build-auto' }),
        runBuilderSession: () => Promise.reject(new Error('legacy builder session not expected')),
        commitAndPush: () => {
          legacyCommits += 1;
          return Promise.resolve({ commitSha: '0'.repeat(40), diffstat: [] });
        },
        estimateRunCost: () => Promise.resolve({ estimatedCredits: '20.0000' }),
        requestBudgetIncrease: () => {
          resolveCreditApprovalRequested?.();
          return Promise.resolve({
            approvalId: 'appr_01J00000000000000000000004',
            absoluteCeiling: '40.0000',
          });
        },
        checkpointBudgetStop: () => Promise.resolve({ checkpointRef: 'checkpoint-build-auto' }),
        producePlan: ({ specificationVersionId }: { specificationVersionId: string }) => {
          timeline.push(`plan:${specificationVersionId}`);
          return Promise.resolve({ planArtifactId, plan });
        },
        assessBuildPlanApproval: () =>
          Promise.resolve({ source: 'policy_engine' as const, diffFiles: 2, risk: 'low' as const }),
        approvePlan: ({ approvalOperationKey }: { approvalOperationKey: string }) => {
          timeline.push(`approved:${approvalOperationKey}`);
          return Promise.resolve({ planArtifactId, status: 'approved' as const });
        },
        resolveIntegrationHead() {
          resolveHeadCalls += 1;
          return Promise.resolve({ commitSha: integrationCommit });
        },
        pauseRedirectTasks: ({ affectedTaskIds }: { affectedTaskIds: string[] }) =>
          Promise.resolve({ pausedTaskIds: affectedTaskIds }),
        resumeRedirectTasks: ({ taskIds }: { taskIds: string[] }) =>
          Promise.resolve({ resumedTaskIds: taskIds }),
        produceRedirectPlanDiff: () => {
          redirectPlanCalls += 1;
          return Promise.resolve({ planDiffArtifactId: id('art', '5'), planDiff: redirectDiff });
        },
        applyRedirectPlanDiff: ({ currentPlan }: { currentPlan: typeof plan }) => {
          redirectApplied = true;
          return Promise.resolve({
            planArtifactId: redirectedPlanArtifactId,
            plan: applyPlanDiff(currentPlan, redirectDiff),
            supersededTasks: [],
          });
        },
        revalidateRedirectedTasks: ({ taskIds }: { taskIds: string[] }) =>
          Promise.resolve({
            verificationResultId: id('vr', '6'),
            decision: 'approved' as const,
            taskIds,
          }),
        checkpointRedirect: () => Promise.resolve({ checkpointRef: 'build-redirect-checkpoint' }),
        transitionPhaseTasks: ({ status, taskIds }: { status: string; taskIds: string[] }) => {
          taskTransitions.push({ status, taskIds });
          return Promise.resolve();
        },
        recordBaseCommit: () => Promise.resolve({ baseCommitSha: '1'.repeat(40) }),
        createTaskWorkspace: ({ taskId }: { taskId: string }) =>
          Promise.resolve({ workspaceId: `workspace-${taskId}`, workspacePath: `/tmp/${taskId}` }),
        transitionTaskState: ({ taskId, status }: { taskId: string; status: string }) => {
          timeline.push(`task:${taskId}:${status}`);
          return Promise.resolve();
        },
        async runTaskBuilderSession({ prompt }: { prompt: string }) {
          taskPrompts.push(prompt);
          if (taskPrompts.length === 1) {
            resolveTaskSessionStarted?.();
            await taskSessionReleased;
          }
          return { status: 'completed' as const };
        },
        commitAndPushTask: ({ taskId }: { taskId: string }) => {
          timeline.push(`commit:${taskId}`);
          return Promise.resolve({ commitSha: taskId.endsWith('4') ? '4'.repeat(40) : '5'.repeat(40) });
        },
        mergeTask: () => Promise.resolve({ outcome: 'merged' as const }),
        createConflictTask: () => Promise.reject(new Error('not expected')),
        emitTaskBlocked: () => Promise.reject(new Error('not expected')),
      },
    });
    const verificationWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'verification',
      workflowsPath: new URL('../src/workflows/run.ts', import.meta.url).pathname,
      activities: {
        verifyPhase: (_runId: string, _phaseId: string, commitSha: string) => {
          timeline.push(`verify:${commitSha}`);
          return Promise.resolve({
            verificationResultId: id('vr', '4'),
            decision: 'approved' as const,
            criteriaResults: [
              {
                criterionId: 'AC-1',
                specificationVersion: 1,
                taskIds: [id('task', '4')],
                testCaseIds: ['test-case-1'],
                result: 'passed' as const,
                evidenceArtifactIds: ['evidence-1'],
                verifierComments: [],
              },
              {
                criterionId: 'AC-2',
                specificationVersion: 1,
                taskIds: [id('task', '5')],
                testCaseIds: ['test-case-2'],
                result: 'passed' as const,
                evidenceArtifactIds: ['evidence-2'],
                verifierComments: [],
              },
            ],
            risks: [],
          });
        },
      },
    });
    const verificationRun = verificationWorker.run();

    try {
      await mainWorker.runUntil(async () => {
        const handle = await environment?.client.workflow.start(buildWorkflow, {
            taskQueue,
            workflowId: workflowInput.workflowId,
            args: [workflowInput],
          });
        await taskSessionStarted;
        await handle?.signal(redirectRunSignal, {
          runId: workflowInput.runId,
          instruction: 'Change the final copy before verification.',
          operationKey: `op_${'6'.repeat(64)}`,
        });
        releaseTaskSession?.();
        await redirectPausedStatusStarted;
        await handle?.signal(creditBalanceExhaustedSignal, {
          runId: workflowInput.runId,
          operationKey: `op_${'7'.repeat(64)}`,
        });
        releaseRedirectPausedStatus?.();
        await creditApprovalRequested;
        const redirectPlanCallsBeforeApproval = redirectPlanCalls;
        await handle?.signal(budgetApprovalResolvedSignal, {
          approvalId: 'appr_01J00000000000000000000004',
          decision: 'approved',
          absoluteCeiling: '40.0000',
          reason: 'organization_credit_exhausted',
        });
        await expect(handle?.result()).resolves.toEqual({
          status: 'completed',
          commitSha: integrationCommit,
        });
        expect(redirectPlanCallsBeforeApproval).toBe(0);
      });
    } finally {
      verificationWorker.shutdown();
      await verificationRun;
    }

    expect(legacyCommits).toBe(0);
    expect(redirectApplied).toBe(true);
    expect(redirectPlanCalls).toBe(1);
    expect(resolveHeadCalls).toBe(1);
    expect(taskPrompts).toHaveLength(2);
    expect(taskPrompts[0]).toContain('Acceptance criteria: AC-1');
    expect(taskPrompts[1]).toContain('Acceptance criteria: AC-2');
    expect(timeline.filter((entry) => entry.startsWith('commit:'))).toHaveLength(2);
    expect(timeline.indexOf(`verify:${integrationCommit}`)).toBeGreaterThan(
      timeline.indexOf(`commit:${id('task', '5')}`),
    );
    expect(taskTransitions).toContainEqual({
      status: 'passed',
      taskIds: [id('task', '4'), id('task', '5')],
    });
  }, 40_000);

  it('waits for exact approval when risk exceeds the configured auto-approval boundary', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar18-build-approval-${Date.now().toString(36)}`;
    const workflowInput = buildInput('7');
    const plan = lightweightPlan({ suffix: '7', riskLevel: 'low', taskCount: 1 });
    const planArtifactId = id('art', '7');
    let resolveApprovalRequested: (() => void) | undefined;
    const approvalRequested = new Promise<void>((resolve) => {
      resolveApprovalRequested = resolve;
    });
    let taskSessions = 0;
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const approvalId = 'appr_01J00000000000000000000007';
    const approvalRequests: unknown[] = [];

    const mainWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../src/workflows/run.ts', import.meta.url).pathname,
      activities: {
        transitionRunStatus: () => Promise.resolve(),
        emitEvents: ({ events }: { events: Array<{ type: string; payload: Record<string, unknown> }> }) => {
          emitted.push(...events);
          if (
            events.some(
              ({ type, payload }) =>
                type === 'approval.requested' && payload['gate'] === 'build_plan',
            )
          ) {
            resolveApprovalRequested?.();
          }
          return Promise.resolve();
        },
        storeAssistantContent: () => Promise.reject(new Error('not expected')),
        ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-build-approval' }),
        runBuilderSession: () => Promise.reject(new Error('not expected')),
        commitAndPush: () => Promise.reject(new Error('not expected')),
        estimateRunCost: () => Promise.resolve({ estimatedCredits: '10.0000' }),
        requestBudgetIncrease: () => Promise.reject(new Error('not expected')),
        requestRunApproval: (request: unknown) => {
          approvalRequests.push(request);
          return Promise.resolve({ approvalId });
        },
        checkpointBudgetStop: () => Promise.resolve({ checkpointRef: 'checkpoint-build-approval' }),
        producePlan: () => Promise.resolve({ planArtifactId, plan }),
        assessBuildPlanApproval: () =>
          Promise.resolve({ source: 'policy_engine' as const, diffFiles: 1, risk: 'high' as const }),
        approvePlan: () => Promise.resolve({ planArtifactId, status: 'approved' as const }),
        resolveIntegrationHead: () => Promise.resolve({ commitSha: '8'.repeat(40) }),
        transitionPhaseTasks: () => Promise.resolve(),
        recordBaseCommit: () => Promise.resolve({ baseCommitSha: '1'.repeat(40) }),
        createTaskWorkspace: () =>
          Promise.resolve({ workspaceId: 'workspace-task-approval', workspacePath: '/tmp/task' }),
        transitionTaskState: () => Promise.resolve(),
        runTaskBuilderSession: () => {
          taskSessions += 1;
          return Promise.resolve({ status: 'completed' as const });
        },
        commitAndPushTask: () => Promise.resolve({ commitSha: '7'.repeat(40) }),
        mergeTask: () => Promise.resolve({ outcome: 'merged' as const }),
        createConflictTask: () => Promise.reject(new Error('not expected')),
        emitTaskBlocked: () => Promise.reject(new Error('not expected')),
      },
    });
    const verificationWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'verification',
      workflowsPath: new URL('../src/workflows/run.ts', import.meta.url).pathname,
      activities: {
        verifyPhase: () =>
          Promise.resolve({
            verificationResultId: id('vr', '7'),
            decision: 'approved' as const,
            criteriaResults: [
              {
                criterionId: 'AC-1',
                specificationVersion: 1,
                taskIds: [id('task', '7')],
                testCaseIds: ['test-case-1'],
                result: 'passed' as const,
                evidenceArtifactIds: ['evidence-1'],
                verifierComments: [],
              },
            ],
            risks: [],
          }),
      },
    });
    const verificationRun = verificationWorker.run();

    try {
      await mainWorker.runUntil(async () => {
        const handle = await environment?.client.workflow.start(buildWorkflow, {
          taskQueue,
          workflowId: workflowInput.workflowId,
          args: [workflowInput],
        });
        await approvalRequested;
        expect(taskSessions).toBe(0);
        await handle?.signal(autonomousPlanApprovalSignal, {
          runId: workflowInput.runId,
          artifactId: id('art', '8'),
          decision: 'approved',
          operationKey: `op_${'8'.repeat(64)}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(taskSessions).toBe(0);
        await handle?.signal(autonomousPlanApprovalSignal, {
          runId: workflowInput.runId,
          artifactId: planArtifactId,
          approvalId,
          approvalKind: 'plan',
          decision: 'approved',
          operationKey: `op_${'7'.repeat(64)}`,
        });
        await expect(handle?.result()).resolves.toEqual({
          status: 'completed',
          commitSha: '8'.repeat(40),
        });
      });
    } finally {
      verificationWorker.shutdown();
      await verificationRun;
    }
    expect(taskSessions).toBe(1);
    expect(approvalRequests).toEqual([expect.objectContaining({
      kind: 'plan', artifactId: planArtifactId,
    })]);
    const cardEvent = emitted.find(({ type }) => type === 'conversation.card');
    expect(ConversationCardSchema.parse(cardEvent?.payload['card'])).toEqual({
      version: 1,
      kind: 'plan',
      cardId: `card_${workflowInput.runId}:build-plan`,
      approvalId,
      artifactId: planArtifactId,
      approvalKind: 'plan',
    });
  }, 40_000);
});
