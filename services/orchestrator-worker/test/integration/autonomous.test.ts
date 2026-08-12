import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventActivities, PendingAgentEvent } from '../../src/activities/events.js';
import type { ApprovalActivities } from '../../src/activities/approvals.js';
import type { FeatureFlagActivities } from '../../src/activities/feature-flags.js';
import { createTemporalOrchestrator, TASK_QUEUES } from '../../src/worker.js';
import {
  autonomousCancelSignal,
  autonomousCreditBalanceExhaustedSignal,
  autonomousPlanApprovalSignal,
  autonomousResumeSignal,
  autonomousSpecificationApprovalSignal,
  autonomousWorkflow,
  type AutonomousActivities,
  type AutonomousWorkflowInput,
} from '../../src/workflows/autonomous.js';
import { budgetApprovalResolvedSignal } from '../../src/workflows/budget-approval.js';

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

const allowAllFeatureFlags: FeatureFlagActivities = {
  evaluateFeatureFlag: () => Promise.resolve({ enabled: true }),
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

  async function runPreparationCreditInterleaving(
    stage: 'interview' | 'specification' | 'plan',
  ): Promise<boolean> {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar17-preparation-credit-${stage}-${Date.now().toString(36)}`;
    const runId = newId('run');
    const specificationVersionId = `specification-version-credit-${stage}`;
    const planArtifactId = newId('art');
    const paidCalls: string[] = [];
    let resolveBoundaryStarted: (() => void) | undefined;
    const boundaryStarted = new Promise<void>((resolve) => {
      resolveBoundaryStarted = resolve;
    });
    let releaseBoundary: (() => void) | undefined;
    const boundaryReleased = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    let resolveCreditApprovalRequested: (() => void) | undefined;
    const creditApprovalRequested = new Promise<void>((resolve) => {
      resolveCreditApprovalRequested = resolve;
    });
    let resolveSpecificationRequested: (() => void) | undefined;
    const specificationRequested = new Promise<void>((resolve) => {
      resolveSpecificationRequested = resolve;
    });
    let resolvePlanRequested: (() => void) | undefined;
    const planRequested = new Promise<void>((resolve) => {
      resolvePlanRequested = resolve;
    });

    const autonomousActivities = {
      conductInterview() {
        paidCalls.push('interview');
        return Promise.resolve({ interviewArtifactId: newId('art'), status: 'executable' as const });
      },
      createSpecificationDraft() {
        paidCalls.push('specification');
        return Promise.resolve({
          specificationVersionId,
          version: 1,
          contentEtag: `sha256:${'a'.repeat(64)}`,
        });
      },
      approveSpecification() {
        return Promise.resolve({ specificationVersionId, version: 1, status: 'approved' as const });
      },
      producePlan() {
        paidCalls.push('plan');
        return Promise.resolve({ planArtifactId, plan: PLAN });
      },
      approvePlan() {
        return Promise.reject(new Error('rejected plan must not be approved'));
      },
      requestBudgetIncrease() {
        resolveCreditApprovalRequested?.();
        return Promise.resolve({
          approvalId: 'appr_01J00000000000000000000009',
          absoluteCeiling: '100.0000',
        });
      },
      checkpointBudgetStop() {
        return Promise.reject(new Error('credit approval must resume preparation'));
      },
    } satisfies Partial<AutonomousActivities> & Partial<ApprovalActivities>;
    let blocked = false;
    const eventActivities: EventActivities = {
      async emitEvents(input) {
        for (const emitted of input.events) {
          if (emitted.type === 'approval.requested' && emitted.payload['gate'] === 'specification') {
            resolveSpecificationRequested?.();
          }
          if (emitted.type === 'approval.requested' && emitted.payload['gate'] === 'plan') {
            resolvePlanRequested?.();
          }
        }
        const blocksInterview =
          stage === 'interview' &&
          input.events.some(
            ({ type, payload }) => type === 'phase.started' && payload['stage'] === 'interview',
          );
        const blocksSpecification =
          stage === 'specification' &&
          input.events.some(
            ({ type, payload }) => type === 'phase.completed' && payload['stage'] === 'interview',
          );
        if (!blocked && (blocksInterview || blocksSpecification)) {
          blocked = true;
          resolveBoundaryStarted?.();
          await boundaryReleased;
        }
      },
      async transitionRunStatus(input) {
        if (
          !blocked &&
          stage === 'plan' &&
          input.idempotencyKey.endsWith('status-specification-approved')
        ) {
          blocked = true;
          resolveBoundaryStarted?.();
          await boundaryReleased;
        }
      },
      storeAssistantContent() {
        return Promise.reject(new Error('preparation fixture stores no assistant content'));
      },
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/run.ts', import.meta.url).pathname,
      activities: { ...eventActivities, ...autonomousActivities, ...allowAllFeatureFlags },
    });
    workers.push(worker);
    workerRuns.push(worker.run());
    const handle = await environment.client.workflow.start(autonomousWorkflow, {
      taskQueue,
      workflowId: runId,
      args: [{
        workflowId: runId,
        runId,
        organizationId: newId('org'),
        projectId: newId('proj'),
        prompt: 'Exercise the preparation credit boundary.',
        model: null,
        budget: { maxCredits: 100 },
        planMaxCredits: 1000,
        maxConcurrency: 1,
      } satisfies AutonomousWorkflowInput],
    });

    if (stage === 'plan') {
      await specificationRequested;
      await handle.signal(autonomousSpecificationApprovalSignal, {
        runId,
        artifactId: specificationVersionId,
        decision: 'approved',
        operationKey: `op_${'1'.repeat(64)}`,
      });
    }
    await boundaryStarted;
    await handle.signal(autonomousCreditBalanceExhaustedSignal, {
      runId,
      operationKey: `op_${'2'.repeat(64)}`,
    });
    releaseBoundary?.();
    await creditApprovalRequested;
    const paidCallStartedBeforeApproval = paidCalls.includes(stage);
    await handle.signal(budgetApprovalResolvedSignal, {
      approvalId: 'appr_01J00000000000000000000009',
      decision: 'approved',
      absoluteCeiling: '100.0000',
      reason: 'organization_credit_exhausted',
    });
    if (stage !== 'plan') {
      await specificationRequested;
      await handle.signal(autonomousSpecificationApprovalSignal, {
        runId,
        artifactId: specificationVersionId,
        decision: 'approved',
        operationKey: `op_${'1'.repeat(64)}`,
      });
    }
    await planRequested;
    await handle.signal(autonomousPlanApprovalSignal, {
      runId,
      artifactId: planArtifactId,
      decision: 'rejected',
      operationKey: `op_${'3'.repeat(64)}`,
    });
    await expect(handle.result()).resolves.toEqual({ status: 'rejected', gate: 'plan' });
    return paidCallStartedBeforeApproval;
  }

  it.each([
    ['interview event', 'interview'],
    ['interview completion event', 'specification'],
    ['specification approval status', 'plan'],
  ] as const)(
    'holds the next paid preparation call when credit exhausts during %s',
    async (_label, stage) => {
      await expect(runPreparationCreditInterleaving(stage)).resolves.toBe(false);
    },
    30_000,
  );

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
      planMaxCredits: 1000,
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
    const budgetApprovalRequests: unknown[] = [];
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
      requestBudgetIncrease(input: unknown) {
        budgetApprovalRequests.push(input);
        return Promise.resolve({
          approvalId: 'appr_01J00000000000000000000009',
          absoluteCeiling: '100.0000',
        });
      },
      checkpointBudgetStop: () => Promise.resolve({ checkpointRef: 'autonomous-credit-stop' }),
    } satisfies Partial<AutonomousActivities> & Partial<ApprovalActivities>;
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
      activities: { ...eventActivities, ...autonomousActivities, ...allowAllFeatureFlags },
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
      planMaxCredits: 1000,
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
    await handle.signal(autonomousCreditBalanceExhaustedSignal, {
      runId,
      operationKey: `op_${'d'.repeat(64)}`,
    });
    await vi.waitFor(() => {
      expect(budgetApprovalRequests).toHaveLength(1);
    });
    expect(budgetApprovalRequests).toEqual([
      expect.objectContaining({
        currentCeiling: '100.0000',
        absoluteCeiling: '100.0000',
        reason: 'organization_credit_exhausted',
      }),
    ]);
    expect(activityCalls.some((call) => call.startsWith('specification-approved:'))).toBe(false);
    await handle.signal(autonomousResumeSignal, {
      runId,
      operationKey: `op_${'e'.repeat(64)}`,
    });
    await handle.signal(autonomousSpecificationApprovalSignal, {
      runId,
      artifactId: specificationVersionId,
      decision: 'approved',
      operationKey: `op_${'b'.repeat(64)}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activityCalls.some((call) => call.startsWith('plan-produced:'))).toBe(false);
    await handle.signal(budgetApprovalResolvedSignal, {
      approvalId: 'appr_01J00000000000000000000009',
      decision: 'approved',
      absoluteCeiling: '100.0000',
      reason: 'organization_credit_exhausted',
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
    expect(events.filter(({ type }) => type === 'approval.requested')).toHaveLength(3);
    expect(events.filter(({ type }) => type === 'approval.resolved')).toHaveLength(3);
    expect(runStatuses).toEqual([
      'running',
      'waiting_for_approval',
      'waiting_for_approval',
      'running',
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
      activities: { ...eventActivities, ...autonomousActivities, ...allowAllFeatureFlags },
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
      planMaxCredits: 1000,
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
          creditBalanceExhausted: false,
          creditBalanceOperationKey: null,
          creditApprovalResolution: null,
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
      ...allowAllFeatureFlags,
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
        planMaxCredits: 1000,
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

  it('survives a worker restart, pauses the next phase after a flag flip, and creates final evidence once', async () => {
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
    const budgetApprovalRequests: unknown[] = [];
    let resolveFirstCreditApprovalRequested: (() => void) | undefined;
    const firstCreditApprovalRequested = new Promise<void>((resolve) => {
      resolveFirstCreditApprovalRequested = resolve;
    });
    let resolveFirstTaskSessionStarted: (() => void) | undefined;
    const firstTaskSessionStarted = new Promise<void>((resolve) => {
      resolveFirstTaskSessionStarted = resolve;
    });
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
    let resolveFlagPause: (() => void) | undefined;
    const flagPaused = new Promise<void>((resolve) => {
      resolveFlagPause = resolve;
    });
    let releasePhaseTwoTransition: (() => void) | undefined;
    const phaseTwoTransitionReleased = new Promise<void>((resolve) => {
      releasePhaseTwoTransition = resolve;
    });
    let phaseTwoTransitionBlocked = false;
    let resolveWaveEventStarted: (() => void) | undefined;
    const waveEventStarted = new Promise<void>((resolve) => {
      resolveWaveEventStarted = resolve;
    });
    let releaseWaveEvent: (() => void) | undefined;
    const waveEventReleased = new Promise<void>((resolve) => {
      releaseWaveEvent = resolve;
    });
    let waveEventBlocked = false;
    let resolveFirstVerificationStarted: (() => void) | undefined;
    const firstVerificationStarted = new Promise<void>((resolve) => {
      resolveFirstVerificationStarted = resolve;
    });
    let releaseFirstVerification: (() => void) | undefined;
    const firstVerificationReleased = new Promise<void>((resolve) => {
      releaseFirstVerification = resolve;
    });
    let resolveRepairStarted: (() => void) | undefined;
    const repairStarted = new Promise<void>((resolve) => {
      resolveRepairStarted = resolve;
    });
    let releaseRepair: (() => void) | undefined;
    const repairReleased = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    let resolveRepairTransitionStarted: (() => void) | undefined;
    const repairTransitionStarted = new Promise<void>((resolve) => {
      resolveRepairTransitionStarted = resolve;
    });
    let releaseRepairTransition: (() => void) | undefined;
    const repairTransitionReleased = new Promise<void>((resolve) => {
      releaseRepairTransition = resolve;
    });

    const phaseOneCommit = 'a'.repeat(40);
    const repairedCommit = 'b'.repeat(40);
    const phaseTwoCommit = 'c'.repeat(40);
    const taskCommits = new Map([
      ['task_01J00000000000000000000001', '1'.repeat(40)],
      ['task_01J00000000000000000000002', '2'.repeat(40)],
      ['task_01J00000000000000000000003', '3'.repeat(40)],
    ]);
    let autonomousFlagEnabled = true;
    const flagChecks: string[] = [];
    const featureFlagActivities: FeatureFlagActivities = {
      evaluateFeatureFlag(input) {
        flagChecks.push(input.flag);
        timeline.push(`flag:${input.flag}`);
        return Promise.resolve({
          enabled: input.flag === 'autonomous-mode' ? autonomousFlagEnabled : true,
        });
      },
    };

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
      async repairPhase(input) {
        timeline.push(`repair:${input.phaseId}:${input.failingCommitSha}`);
        expect(input.maxCredits).toBe(5);
        resolveRepairStarted?.();
        await repairReleased;
        return {
          status: 'repaired' as const,
          commitSha: repairedCommit,
          evidenceArtifactIds: [newId('art')],
          creditsConsumed: 0,
        };
      },
      requestBudgetIncrease(input) {
        budgetApprovalRequests.push(input);
        if (budgetApprovalRequests.length === 1) resolveFirstCreditApprovalRequested?.();
        const sequence = String(9 + budgetApprovalRequests.length);
        return Promise.resolve({
          approvalId: `appr_01J000000000000000000000${sequence.padStart(2, '0')}`,
          absoluteCeiling: '100.0000',
        });
      },
      checkpointBudgetStop() {
        return Promise.reject(new Error('organization-credit approval must resume'));
      },
      async transitionPhaseTasks(input) {
        phaseTaskTransitions.push(input);
        timeline.push(`tasks:${input.phaseId}:${input.status}`);
        if (input.status === 'repairing') {
          resolveRepairTransitionStarted?.();
          await repairTransitionReleased;
        }
      },
      checkpointPhase(input) {
        timeline.push(`checkpoint:${input.phaseId}:${input.commitSha}`);
        if (input.phaseId.endsWith('1')) autonomousFlagEnabled = false;
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
    } satisfies Partial<AutonomousActivities> & Partial<ApprovalActivities>;
    const eventActivities: EventActivities = {
      async emitEvents(input) {
        for (const event of input.events) {
          if (event.type === 'approval.requested' && event.payload['gate'] === 'specification') {
            resolveSpecificationRequest?.();
          }
          if (event.type === 'approval.requested' && event.payload['gate'] === 'plan') {
            resolvePlanRequest?.();
          }
          if (
            event.type === 'run.paused' &&
            event.payload['reason'] === 'feature_flag_disabled'
          ) {
            resolveFlagPause?.();
          }
        }
        if (
          !waveEventBlocked &&
          input.events.some(
            (event) =>
              event.type === 'agent.started' &&
              event.phaseId === 'phase_01J00000000000000000000001',
          )
        ) {
          waveEventBlocked = true;
          resolveWaveEventStarted?.();
          await waveEventReleased;
        }
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
        resolveFirstTaskSessionStarted?.();
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
      async verifyPhase(_verifiedRunId: string, phaseId: string, commitSha: string) {
        timeline.push(`verify:${phaseId}:${commitSha}`);
        if (phaseId.endsWith('1')) {
          phaseOneVerificationAttempt += 1;
          if (phaseOneVerificationAttempt === 1) {
            resolveFirstVerificationStarted?.();
            await firstVerificationReleased;
          }
          return {
            verificationResultId:
              phaseOneVerificationAttempt === 1
                ? 'vr_01J00000000000000000000001'
                : 'vr_01J00000000000000000000002',
            decision: phaseOneVerificationAttempt === 1 ? 'rejected' as const : 'approved' as const,
            criteriaResults: [{}],
            risks: phaseOneVerificationAttempt === 1 ? [{}] : [],
          };
        }
        return {
          verificationResultId: 'vr_01J00000000000000000000003',
          decision: 'approved' as const,
          criteriaResults: [{}],
          risks: [],
        };
      },
    };

    const mainWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/run.ts', import.meta.url).pathname,
      activities: {
        ...eventActivities,
        ...taskActivities,
        ...autonomousActivities,
        ...featureFlagActivities,
      },
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
      planMaxCredits: 1000,
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

    await waveEventStarted;
    await handle.signal(autonomousCreditBalanceExhaustedSignal, {
      runId,
      operationKey: `op_${'6'.repeat(64)}`,
    });
    releaseWaveEvent?.();
    const waveBoundaryOutcome = await Promise.race([
      firstCreditApprovalRequested.then(() => 'approval' as const),
      firstTaskSessionStarted.then(() => 'task' as const),
    ]);
    await firstCreditApprovalRequested;
    const taskSessionsBeforeWaveApproval = sessionPrompts.size;
    await handle.signal(budgetApprovalResolvedSignal, {
      approvalId: 'appr_01J00000000000000000000010',
      decision: 'approved',
      absoluteCeiling: '100.0000',
      reason: 'organization_credit_exhausted',
    });

    await firstVerificationStarted;
    releaseFirstVerification?.();
    await repairTransitionStarted;
    await handle.signal(autonomousCreditBalanceExhaustedSignal, {
      runId,
      operationKey: `op_${'7'.repeat(64)}`,
    });
    releaseRepairTransition?.();
    const repairBoundaryOutcome = await Promise.race([
      vi.waitFor(() => {
        expect(budgetApprovalRequests).toHaveLength(2);
      }).then(() => 'approval' as const),
      repairStarted.then(() => 'repair' as const),
    ]);
    if (repairBoundaryOutcome === 'repair') releaseRepair?.();
    await vi.waitFor(() => {
      expect(budgetApprovalRequests).toHaveLength(2);
    });
    await handle.signal(budgetApprovalResolvedSignal, {
      approvalId: 'appr_01J00000000000000000000011',
      decision: 'approved',
      absoluteCeiling: '100.0000',
      reason: 'organization_credit_exhausted',
    });

    let reverificationAttemptsBeforeApproval = phaseOneVerificationAttempt;
    if (repairBoundaryOutcome === 'approval') {
      await repairStarted;
      await handle.signal(autonomousCreditBalanceExhaustedSignal, {
        runId,
        operationKey: `op_${'8'.repeat(64)}`,
      });
      releaseRepair?.();
      await vi.waitFor(() => {
        expect(budgetApprovalRequests).toHaveLength(3);
      });
      reverificationAttemptsBeforeApproval = phaseOneVerificationAttempt;
      await handle.signal(budgetApprovalResolvedSignal, {
        approvalId: 'appr_01J00000000000000000000012',
        decision: 'approved',
        absoluteCeiling: '100.0000',
        reason: 'organization_credit_exhausted',
      });
    }

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
      activities: {
        ...eventActivities,
        ...taskActivities,
        ...autonomousActivities,
        ...featureFlagActivities,
      },
    });
    workers.push(restartedWorker);
    workerRuns.push(restartedWorker.run());

    await flagPaused;
    expect(timeline).not.toContain('session:task_01J00000000000000000000003');
    autonomousFlagEnabled = true;
    await handle.signal(autonomousResumeSignal, {
      runId,
      operationKey: `op_${'9'.repeat(64)}`,
    });

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
    expect({
      taskSessionsBeforeWaveApproval,
      waveBoundaryOutcome,
      repairBoundaryOutcome,
      reverificationAttemptsBeforeApproval,
    }).toEqual({
      taskSessionsBeforeWaveApproval: 0,
      waveBoundaryOutcome: 'approval',
      repairBoundaryOutcome: 'approval',
      reverificationAttemptsBeforeApproval: 1,
    });
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
    expect(timeline.indexOf('flag:autonomous-mode')).toBeLessThan(timeline.indexOf('interview'));
    expect(flagChecks.filter((flag) => flag === 'autonomous-mode')).toHaveLength(4);
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
