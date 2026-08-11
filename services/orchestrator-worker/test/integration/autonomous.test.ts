import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventActivities, PendingAgentEvent } from '../../src/activities/events.js';
import { createTemporalOrchestrator, TASK_QUEUES } from '../../src/worker.js';
import {
  autonomousCancelSignal,
  autonomousPlanApprovalSignal,
  autonomousSpecificationApprovalSignal,
  autonomousWorkflow,
  type AutonomousActivities,
  type AutonomousWorkflowInput,
} from '../../src/workflows/autonomous.js';

const PLAN = {
  phases: [
    {
      id: 'phase_01J00000000000000000000001',
      sequence: 1,
      title: 'Foundation',
      acceptanceCriteria: ['AC-1'],
      approvalAfter: false,
    },
    {
      id: 'phase_01J00000000000000000000002',
      sequence: 2,
      title: 'Acceptance',
      acceptanceCriteria: ['AC-1'],
      approvalAfter: false,
    },
  ],
  tasks: [
    {
      id: 'task_01J00000000000000000000001',
      phaseId: 'phase_01J00000000000000000000001',
      title: 'Build the frontend',
      dependsOn: [],
      riskLevel: 'medium' as const,
      requiredTools: ['read_file', 'apply_patch'],
      expectedFiles: ['src/app.tsx', 'src/app.css'],
      acceptanceCriteriaIds: ['AC-1'],
      requiredTests: ['app.test.tsx'],
      estimate: { credits: 10, wallClockMinutes: 20 },
    },
    {
      id: 'task_01J00000000000000000000002',
      phaseId: 'phase_01J00000000000000000000001',
      title: 'Build the API',
      dependsOn: [],
      riskLevel: 'high' as const,
      requiredTools: ['read_file', 'apply_patch'],
      expectedFiles: ['src/api.ts'],
      acceptanceCriteriaIds: ['AC-1'],
      requiredTests: ['api.test.ts'],
      estimate: { credits: 10, wallClockMinutes: 20 },
    },
    {
      id: 'task_01J00000000000000000000003',
      phaseId: 'phase_01J00000000000000000000002',
      title: 'Add acceptance tests',
      dependsOn: [
        'task_01J00000000000000000000001',
        'task_01J00000000000000000000002',
      ],
      riskLevel: 'medium' as const,
      requiredTools: ['read_file', 'apply_patch'],
      expectedFiles: ['test/acceptance.test.ts'],
      acceptanceCriteriaIds: ['AC-1'],
      requiredTests: ['test/acceptance.test.ts'],
      estimate: { credits: 5, wallClockMinutes: 10 },
    },
  ],
  budget: { credits: 25, wallClockHours: 1 },
};

describe('AR-17 autonomous workflow', () => {
  let environment: TestWorkflowEnvironment | undefined;
  const workers: Worker[] = [];
  const workerRuns: Promise<void>[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    workers.forEach((worker) => {
      worker.shutdown();
    });
    await Promise.all(workerRuns);
    await environment?.teardown();
    workers.length = 0;
    workerRuns.length = 0;
    environment = undefined;
  });

  it('dispatches production Autonomous starts and approval signals to the autonomous workflow', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const signal = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn(() => ({ signal }));
    const orchestrator = createTemporalOrchestrator({
      client: { workflow: { start, getHandle } } as never,
    });
    const runId = newId('run');
    const workflowId = `${runId}:autonomous`;
    const specificationVersionId = 'specification-version-production';
    const planArtifactId = newId('art');
    const baseInput = {
      runId,
      workflowId,
      organizationId: newId('org'),
      projectId: newId('proj'),
      branchId: null,
      mode: 'autonomous' as const,
      appType: 'web' as const,
      model: null,
      prompt: 'Build this product autonomously.',
      budget: { maxCredits: 50 },
      operationKey: `op_${'1'.repeat(64)}`,
    };

    await orchestrator.startRun(baseInput);
    await orchestrator.signalRun({
      runId,
      workflowId,
      signal: 'autonomous_specification_approval',
      artifactId: specificationVersionId,
      decision: 'approved',
      operationKey: `op_${'2'.repeat(64)}`,
    });
    await orchestrator.signalRun({
      runId,
      workflowId,
      signal: 'autonomous_plan_approval',
      artifactId: planArtifactId,
      decision: 'approved',
      operationKey: `op_${'3'.repeat(64)}`,
    });

    expect(start).toHaveBeenCalledWith(
      autonomousWorkflow,
      expect.objectContaining({
        taskQueue: TASK_QUEUES.agentRuns,
        workflowId,
        args: [expect.objectContaining({ runId, maxConcurrency: 3 })],
      }),
    );
    expect(signal).toHaveBeenNthCalledWith(1, autonomousSpecificationApprovalSignal, {
      runId,
      artifactId: specificationVersionId,
      decision: 'approved',
      operationKey: `op_${'2'.repeat(64)}`,
    });
    expect(signal).toHaveBeenNthCalledWith(2, autonomousPlanApprovalSignal, {
      runId,
      artifactId: planArtifactId,
      decision: 'approved',
      operationKey: `op_${'3'.repeat(64)}`,
    });
  });

  it('requires exact user signals before approving the specification or plan', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar17-approvals-${Date.now().toString(36)}`;
    const runId = newId('run');
    const organizationId = newId('org');
    const projectId = newId('proj');
    const specificationVersionId = 'specification-version-1';
    const planArtifactId = newId('art');
    const events: PendingAgentEvent[] = [];
    const activityCalls: string[] = [];
    const runStatuses: string[] = [];
    let resolveSpecificationRequest: (() => void) | undefined;
    const specificationRequested = new Promise<void>((resolve) => {
      resolveSpecificationRequest = resolve;
    });
    let resolvePlanRequest: (() => void) | undefined;
    const planRequested = new Promise<void>((resolve) => {
      resolvePlanRequest = resolve;
    });

    const autonomousActivities = {
      conductInterview(input) {
        activityCalls.push(`interview:${input.idempotencyKey}`);
        return Promise.resolve({
          interviewArtifactId: newId('art'),
          status: 'executable' as const,
        });
      },
      createSpecificationDraft(input) {
        activityCalls.push(`specification-draft:${input.idempotencyKey}`);
        expect(input.interviewArtifactId).toMatch(/^art_/u);
        return Promise.resolve({
          specificationVersionId,
          version: 1,
          contentEtag: `sha256:${'a'.repeat(64)}`,
        });
      },
      approveSpecification(input) {
        activityCalls.push(`specification-approved:${input.idempotencyKey}`);
        return Promise.resolve({
          specificationVersionId: input.specificationVersionId,
          version: input.version,
          status: 'approved' as const,
        });
      },
      producePlan(input) {
        activityCalls.push(`plan-produced:${input.idempotencyKey}`);
        return Promise.resolve({ planArtifactId, plan: PLAN });
      },
      approvePlan(input) {
        activityCalls.push(`plan-approved:${input.idempotencyKey}`);
        return Promise.resolve({ planArtifactId: input.planArtifactId, status: 'approved' as const });
      },
    } satisfies Partial<AutonomousActivities>;
    const eventActivities: EventActivities = {
      emitEvents(input) {
        events.push(...input.events);
        for (const event of input.events) {
          if (
            event.type === 'approval.requested' &&
            event.payload['gate'] === 'specification'
          ) {
            resolveSpecificationRequest?.();
          }
          if (event.type === 'approval.requested' && event.payload['gate'] === 'plan') {
            resolvePlanRequest?.();
          }
        }
        return Promise.resolve();
      },
      transitionRunStatus(input) {
        runStatuses.push(input.status);
        return Promise.resolve();
      },
      storeAssistantContent() {
        return Promise.reject(new Error('Autonomous approval fixture stores no assistant content'));
      },
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/run.ts', import.meta.url).pathname,
      activities: { ...eventActivities, ...autonomousActivities },
    });
    workers.push(worker);
    workerRuns.push(worker.run());

    const input: AutonomousWorkflowInput = {
      workflowId: runId,
      runId,
      organizationId,
      projectId,
      prompt: 'Build the approved product autonomously.',
      model: null,
      budget: { maxCredits: 100 },
      maxConcurrency: 3,
    };
    const handle = await environment.client.workflow.start(autonomousWorkflow, {
      taskQueue,
      workflowId: input.workflowId,
      args: [input],
    });

    await specificationRequested;
    expect(activityCalls.some((call) => call.startsWith('specification-approved:'))).toBe(false);
    expect(activityCalls.some((call) => call.startsWith('plan-produced:'))).toBe(false);
    await handle.signal(autonomousSpecificationApprovalSignal, {
      runId,
      artifactId: specificationVersionId,
      decision: 'approved',
      operationKey: `op_${'b'.repeat(64)}`,
    });

    await planRequested;
    expect(activityCalls.some((call) => call.startsWith('specification-approved:'))).toBe(true);
    expect(activityCalls.some((call) => call.startsWith('plan-produced:'))).toBe(true);
    expect(activityCalls.some((call) => call.startsWith('plan-approved:'))).toBe(false);
    await handle.signal(autonomousPlanApprovalSignal, {
      runId,
      artifactId: planArtifactId,
      decision: 'rejected',
      operationKey: `op_${'c'.repeat(64)}`,
    });

    await expect(handle.result()).resolves.toEqual({ status: 'rejected', gate: 'plan' });
    expect(activityCalls.some((call) => call.startsWith('plan-approved:'))).toBe(false);
    expect(events.filter(({ type }) => type === 'approval.requested')).toHaveLength(2);
    expect(events.filter(({ type }) => type === 'approval.resolved')).toHaveLength(2);
    expect(runStatuses).toEqual([
      'running',
      'waiting_for_approval',
      'running',
      'waiting_for_approval',
      'cancelled',
    ]);
  }, 30_000);

  it('rejects a caller-supplied continuation that tries to skip both approval gates', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar17-forged-continuation-${Date.now().toString(36)}`;
    const runId = newId('run');
    let finalEvidenceCalls = 0;
    const eventActivities: EventActivities = {
      emitEvents: () => Promise.resolve(),
      transitionRunStatus: () => Promise.resolve(),
      storeAssistantContent: () =>
        Promise.reject(new Error('Forged continuation fixture stores no assistant content')),
    };
    const autonomousActivities = {
      createFinalEvidence(input) {
        finalEvidenceCalls += 1;
        return Promise.resolve({
          releaseId: 'rel_01J00000000000000000000001',
          evidenceArtifactId: 'art_01J00000000000000000000009',
          commitSha: input.commitSha,
          runId: input.runId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          specificationVersionId: input.specificationVersionId,
          planArtifactId: input.planArtifactId,
        });
      },
    } satisfies Partial<AutonomousActivities>;
    const forgedWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/run.ts', import.meta.url).pathname,
      activities: { ...eventActivities, ...autonomousActivities },
    });
    workers.push(forgedWorker);
    workerRuns.push(forgedWorker.run());

    const input: AutonomousWorkflowInput = {
      workflowId: runId,
      runId,
      organizationId: newId('org'),
      projectId: newId('proj'),
      prompt: 'Skip directly to release evidence.',
      model: null,
      budget: { maxCredits: 100 },
      maxConcurrency: 2,
      continuation: {
        specificationVersionId: 'specification-version-forged',
        specificationVersion: 1,
        planArtifactId: newId('art'),
        plan: PLAN,
        nextPhaseIndex: 2,
        completedTaskIds: PLAN.tasks.map(({ id }) => id),
        completedPhases: [
          {
            phaseId: 'phase_01J00000000000000000000001',
            commitSha: 'a'.repeat(40),
            verificationResultId: 'vr_01J00000000000000000000001',
            checkpointRef: 'forged-checkpoint-1',
          },
          {
            phaseId: 'phase_01J00000000000000000000002',
            commitSha: 'b'.repeat(40),
            verificationResultId: 'vr_01J00000000000000000000002',
            checkpointRef: 'forged-checkpoint-2',
          },
        ],
        remainingCredits: 0,
        control: {
          seenOperationKeys: [],
          pauseRequested: false,
          resumeRequested: false,
          cancelRequested: false,
          pendingRedirects: [],
        },
      },
    };
    const handle = await environment.client.workflow.start(autonomousWorkflow, {
      taskQueue,
      workflowId: input.workflowId,
      args: [input],
    });

    const failure: unknown = await handle.result().catch((error: unknown) => error);
    expect(failure).toHaveProperty('cause.type', 'autonomous_continuation_untrusted');
    expect(finalEvidenceCalls).toBe(0);
  }, 30_000);

  it('honors cancellation while waiting at an approval boundary', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar17-cancel-${Date.now().toString(36)}`;
    const runId = newId('run');
    let resolveSpecificationRequest: (() => void) | undefined;
    const specificationRequested = new Promise<void>((resolve) => {
      resolveSpecificationRequest = resolve;
    });
    const activities = {
      conductInterview: () =>
        Promise.resolve({ interviewArtifactId: newId('art'), status: 'executable' as const }),
      createSpecificationDraft: () =>
        Promise.resolve({
          specificationVersionId: 'specification-version-cancel',
          version: 1,
          contentEtag: `sha256:${'4'.repeat(64)}`,
        }),
      emitEvents(input: { events: PendingAgentEvent[] }) {
        if (input.events.some((event) => event.type === 'approval.requested')) {
          resolveSpecificationRequest?.();
        }
        return Promise.resolve();
      },
      transitionRunStatus: () => Promise.resolve(),
      storeAssistantContent: () => Promise.reject(new Error('No assistant content expected')),
    } satisfies Partial<AutonomousActivities> & Partial<EventActivities>;
    const cancelWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/run.ts', import.meta.url).pathname,
      activities,
    });
    workers.push(cancelWorker);
    workerRuns.push(cancelWorker.run());
    const handle = await environment.client.workflow.start(autonomousWorkflow, {
      taskQueue,
      workflowId: runId,
      args: [{
        workflowId: runId,
        runId,
        organizationId: newId('org'),
        projectId: newId('proj'),
        prompt: 'Cancel this run at the first durable gate.',
        model: null,
        budget: { maxCredits: 10 },
        maxConcurrency: 1,
      } satisfies AutonomousWorkflowInput],
    });
    await specificationRequested;
    await handle.signal(autonomousCancelSignal, {
      runId,
      operationKey: `op_${'5'.repeat(64)}`,
    });

    const outcome = await Promise.race([
      handle.result(),
      new Promise<'timed_out'>((resolve) => {
        setTimeout(() => {
          resolve('timed_out');
        }, 2_000);
      }),
    ]);
    expect(outcome).toEqual({ status: 'cancelled', checkpointRef: `run:${runId}:cancelled` });
  }, 10_000);

  it('survives a worker restart between task-scoped phases and creates final evidence once', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar17-phases-${Date.now().toString(36)}`;
    const runId = newId('run');
    const organizationId = newId('org');
    const projectId = newId('proj');
    const specificationVersionId = 'specification-version-2';
    const planArtifactId = newId('art');
    const timeline: string[] = [];
    const sessionPrompts = new Map<string, string>();
    const taskBudgets: number[] = [];
    const phaseTaskTransitions: unknown[] = [];
    const finalEvidenceInputs: unknown[] = [];
    let resolveSpecificationRequest: (() => void) | undefined;
    const specificationRequested = new Promise<void>((resolve) => {
      resolveSpecificationRequest = resolve;
    });
    let resolvePlanRequest: (() => void) | undefined;
    const planRequested = new Promise<void>((resolve) => {
      resolvePlanRequest = resolve;
    });
    let resolvePhaseTwoEntered: (() => void) | undefined;
    const phaseTwoEntered = new Promise<void>((resolve) => {
      resolvePhaseTwoEntered = resolve;
    });
    let releasePhaseTwoTransition: (() => void) | undefined;
    const phaseTwoTransitionReleased = new Promise<void>((resolve) => {
      releasePhaseTwoTransition = resolve;
    });
    let phaseTwoTransitionBlocked = false;

    const phaseOneCommit = 'a'.repeat(40);
    const repairedCommit = 'b'.repeat(40);
    const phaseTwoCommit = 'c'.repeat(40);
    const taskCommits = new Map([
      ['task_01J00000000000000000000001', '1'.repeat(40)],
      ['task_01J00000000000000000000002', '2'.repeat(40)],
      ['task_01J00000000000000000000003', '3'.repeat(40)],
    ]);

    const autonomousActivities = {
      conductInterview() {
        timeline.push('interview');
        return Promise.resolve({ interviewArtifactId: newId('art'), status: 'executable' as const });
      },
      createSpecificationDraft() {
        timeline.push('specification:draft');
        return Promise.resolve({
          specificationVersionId,
          version: 1,
          contentEtag: `sha256:${'d'.repeat(64)}`,
        });
      },
      approveSpecification() {
        timeline.push('specification:approved');
        return Promise.resolve({ specificationVersionId, version: 1, status: 'approved' as const });
      },
      producePlan() {
        timeline.push('plan:produced');
        return Promise.resolve({ planArtifactId, plan: PLAN });
      },
      approvePlan() {
        timeline.push('plan:approved');
        return Promise.resolve({ planArtifactId, status: 'approved' as const });
      },
      resolveIntegrationHead(input) {
        const commitSha = input.phaseId.endsWith('1') ? phaseOneCommit : phaseTwoCommit;
        timeline.push(`head:${input.phaseId}:${commitSha}`);
        return Promise.resolve({ commitSha });
      },
      repairPhase(input) {
        timeline.push(`repair:${input.phaseId}:${input.failingCommitSha}`);
        expect(input.maxCredits).toBe(5);
        return Promise.resolve({
          status: 'repaired' as const,
          commitSha: repairedCommit,
          evidenceArtifactIds: [newId('art')],
          creditsConsumed: 0,
        });
      },
      transitionPhaseTasks(input) {
        phaseTaskTransitions.push(input);
        timeline.push(`tasks:${input.phaseId}:${input.status}`);
        return Promise.resolve();
      },
      checkpointPhase(input) {
        timeline.push(`checkpoint:${input.phaseId}:${input.commitSha}`);
        return Promise.resolve({ checkpointRef: `checkpoint:${input.phaseId}` });
      },
      createFinalEvidence(input) {
        timeline.push(`evidence:${input.commitSha}`);
        finalEvidenceInputs.push(input);
        return Promise.resolve({
          releaseId: 'rel_01J00000000000000000000001',
          evidenceArtifactId: 'art_01J00000000000000000000009',
          commitSha: input.commitSha,
          runId: input.runId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          specificationVersionId: input.specificationVersionId,
          planArtifactId: input.planArtifactId,
        });
      },
    } satisfies Partial<AutonomousActivities>;
    const eventActivities: EventActivities = {
      emitEvents(input) {
        for (const event of input.events) {
          if (event.type === 'approval.requested' && event.payload['gate'] === 'specification') {
            resolveSpecificationRequest?.();
          }
          if (event.type === 'approval.requested' && event.payload['gate'] === 'plan') {
            resolvePlanRequest?.();
          }
        }
        return Promise.resolve();
      },
      async transitionRunStatus(input) {
        if (input.idempotencyKey.endsWith('status-running:1') && !phaseTwoTransitionBlocked) {
          phaseTwoTransitionBlocked = true;
          timeline.push('phase-two:entered');
          resolvePhaseTwoEntered?.();
          await phaseTwoTransitionReleased;
        }
        return Promise.resolve();
      },
      storeAssistantContent() {
        return Promise.reject(new Error('Autonomous phase fixture stores no assistant content'));
      },
    };
    const taskActivities = {
      recordBaseCommit: () => Promise.resolve({ baseCommitSha: '0'.repeat(40) }),
      createTaskWorkspace: (input: { taskId: string }) =>
        Promise.resolve({
          workspaceId: `workspace-${input.taskId}`,
          workspacePath: `/tmp/workspace-${input.taskId}`,
        }),
      transitionTaskState: () => Promise.resolve(),
      runTaskBuilderSession(input: { taskId: string; prompt: string }) {
        timeline.push(`session:${input.taskId}`);
        sessionPrompts.set(input.taskId, input.prompt);
        taskBudgets.push(
          (input as unknown as { budget: { maxCredits: number } }).budget.maxCredits,
        );
        return Promise.resolve({ status: 'completed' as const });
      },
      commitAndPushTask(input: { taskId: string }) {
        const commitSha = taskCommits.get(input.taskId);
        if (commitSha === undefined) throw new Error('unknown task commit');
        return Promise.resolve({ commitSha });
      },
      mergeTask: () => Promise.resolve({ outcome: 'merged' as const }),
      createConflictTask: () => Promise.reject(new Error('No conflict expected')),
      emitTaskBlocked: () => Promise.reject(new Error('No blocked task expected')),
    };
    let phaseOneVerificationAttempt = 0;
    const verificationActivities = {
      verifyPhase(_verifiedRunId: string, phaseId: string, commitSha: string) {
        timeline.push(`verify:${phaseId}:${commitSha}`);
        if (phaseId.endsWith('1')) {
          phaseOneVerificationAttempt += 1;
          return Promise.resolve({
            verificationResultId:
              phaseOneVerificationAttempt === 1
                ? 'vr_01J00000000000000000000001'
                : 'vr_01J00000000000000000000002',
            decision: phaseOneVerificationAttempt === 1 ? 'rejected' as const : 'approved' as const,
            criteriaResults: [{}],
            risks: phaseOneVerificationAttempt === 1 ? [{}] : [],
          });
        }
        return Promise.resolve({
          verificationResultId: 'vr_01J00000000000000000000003',
          decision: 'approved' as const,
          criteriaResults: [{}],
          risks: [],
        });
      },
    };

    const mainWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/run.ts', import.meta.url).pathname,
      activities: { ...eventActivities, ...taskActivities, ...autonomousActivities },
    });
    const verificationWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'verification',
      workflowsPath: new URL('../../src/workflows/run.ts', import.meta.url).pathname,
      activities: verificationActivities,
    });
    workers.push(mainWorker, verificationWorker);
    const mainWorkerRun = mainWorker.run();
    const verificationWorkerRun = verificationWorker.run();
    workerRuns.push(mainWorkerRun, verificationWorkerRun);

    const input: AutonomousWorkflowInput = {
      workflowId: runId,
      runId,
      organizationId,
      projectId,
      prompt: 'Build the two-phase product.',
      model: null,
      budget: { maxCredits: 100 },
      maxConcurrency: 2,
    };
    const handle = await environment.client.workflow.start(autonomousWorkflow, {
      taskQueue,
      workflowId: input.workflowId,
      args: [input],
    });
    await specificationRequested;
    await handle.signal(autonomousSpecificationApprovalSignal, {
      runId,
      artifactId: specificationVersionId,
      decision: 'approved',
      operationKey: `op_${'e'.repeat(64)}`,
    });
    await planRequested;
    await handle.signal(autonomousPlanApprovalSignal, {
      runId,
      artifactId: planArtifactId,
      decision: 'approved',
      operationKey: `op_${'f'.repeat(64)}`,
    });

    await phaseTwoEntered;
    mainWorker.shutdown();
    releasePhaseTwoTransition?.();
    await mainWorkerRun;
    workers.splice(workers.indexOf(mainWorker), 1);
    timeline.push('worker:restarted');
    const restartedWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/run.ts', import.meta.url).pathname,
      activities: { ...eventActivities, ...taskActivities, ...autonomousActivities },
    });
    workers.push(restartedWorker);
    workerRuns.push(restartedWorker.run());

    await expect(handle.result()).resolves.toEqual({
      status: 'completed',
      releaseId: 'rel_01J00000000000000000000001',
      evidenceArtifactId: 'art_01J00000000000000000000009',
      commitSha: phaseTwoCommit,
    });
    expect(sessionPrompts.get('task_01J00000000000000000000001')).toContain(
      'Agent profile: frontend',
    );
    expect(sessionPrompts.get('task_01J00000000000000000000002')).toContain(
      'Agent profile: backend',
    );
    expect(sessionPrompts.get('task_01J00000000000000000000003')).toContain(
      'Agent profile: testing',
    );
    expect(timeline.indexOf('session:task_01J00000000000000000000003')).toBeGreaterThan(
      timeline.indexOf('worker:restarted'),
    );
    expect(timeline).toContain(
      `repair:phase_01J00000000000000000000001:${phaseOneCommit}`,
    );
    expect(timeline).toContain(
      `verify:phase_01J00000000000000000000001:${repairedCommit}`,
    );
    expect(phaseOneVerificationAttempt).toBe(2);
    expect(taskBudgets.reduce((sum, value) => sum + value, 0)).toBe(25);
    expect(phaseTaskTransitions).toEqual([
      expect.objectContaining({
        phaseId: 'phase_01J00000000000000000000001',
        status: 'repairing',
      }),
      expect.objectContaining({
        phaseId: 'phase_01J00000000000000000000001',
        status: 'passed',
      }),
      expect.objectContaining({
        phaseId: 'phase_01J00000000000000000000002',
        status: 'passed',
      }),
    ]);
    expect(timeline.filter((entry) => entry === 'interview')).toHaveLength(1);
    expect(timeline.filter((entry) => entry === 'plan:produced')).toHaveLength(1);
    expect(finalEvidenceInputs).toEqual([
      expect.objectContaining({
        commitSha: phaseTwoCommit,
        specificationVersionId,
        planArtifactId,
        completedPhases: [
          expect.objectContaining({
            phaseId: 'phase_01J00000000000000000000001',
            commitSha: repairedCommit,
          }),
          expect.objectContaining({
            phaseId: 'phase_01J00000000000000000000002',
            commitSha: phaseTwoCommit,
          }),
        ],
      }),
    ]);
  }, 30_000);
});
