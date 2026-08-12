import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { newId } from '@zapp/contracts';
import { applyPlanDiff, type PlanDiff } from '@zapp/planning-engine';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  ApprovalActivities,
  RunApprovalActivities,
} from '../../src/activities/approvals.js';
import type { EventActivities, PendingAgentEvent } from '../../src/activities/events.js';
import type { FeatureFlagActivities } from '../../src/activities/feature-flags.js';
import type { TaskWorkflowActivities } from '../../src/activities/merge.js';
import {
  autonomousCreditBalanceExhaustedSignal,
  autonomousPlanApprovalSignal,
  autonomousRedirectSignal,
  autonomousSpecificationApprovalSignal,
  autonomousWorkflow,
  type AutonomousActivities,
  type AutonomousWorkflowInput,
} from '../../src/workflows/autonomous.js';
import { budgetApprovalResolvedSignal } from '../../src/workflows/budget-approval.js';
import type { RedirectActivities } from '../../src/workflows/redirect.js';

const PHASE_ID = 'phase_01J00000000000000000000001';
const TASK_A = 'task_01J00000000000000000000001';
const TASK_B = 'task_01J00000000000000000000002';
const TASK_C = 'task_01J00000000000000000000003';
const TASK_FEATURE = 'task_01J00000000000000000000004';
const ORIGINAL_PLAN_ARTIFACT_ID = 'art_01J00000000000000000000001';
const DIFF_ARTIFACT_ID = 'art_01J00000000000000000000002';
const UPDATED_PLAN_ARTIFACT_ID = 'art_01J00000000000000000000003';
const TASK_A_ARTIFACT_ID = 'art_01J00000000000000000000004';
const RELEASE_EVIDENCE_ID = 'art_01J00000000000000000000005';
const RELEASE_ID = 'rel_01J00000000000000000000001';
const VERIFIED_COMMIT = 'f'.repeat(40);

const allowAllFeatureFlags: FeatureFlagActivities = {
  evaluateFeatureFlag: () => Promise.resolve({ enabled: true }),
};

const task = (id: string, title: string, dependsOn: readonly string[]) => ({
  id,
  phaseId: PHASE_ID,
  title,
  dependsOn: [...dependsOn],
  riskLevel: 'low' as const,
  requiredTools: ['read_file', 'apply_patch'],
  expectedFiles: [`src/${id}.ts`],
  acceptanceCriteriaIds: ['AC-1'],
  requiredTests: [`test/${id}.test.ts`],
  estimate: { credits: 2, wallClockMinutes: 5 },
});

const ORIGINAL_PLAN = {
  phases: [
    {
      id: PHASE_ID,
      sequence: 1,
      title: 'Build the product',
      acceptanceCriteria: ['AC-1'],
      approvalAfter: false,
    },
  ],
  tasks: [
    task(TASK_A, 'Build the foundation', []),
    task(TASK_B, 'Write the primary copy', [TASK_A]),
    task(TASK_C, 'Verify the flow', [TASK_B]),
  ],
  budget: { credits: 20, wallClockHours: 1 },
};

interface TaskRecord {
  status: string;
  readonly artifactIds: string[];
}

interface RedirectFixtureResult {
  readonly events: PendingAgentEvent[];
  readonly pausedTaskIds: readonly string[];
  readonly resumedTaskIds: readonly string[];
  readonly revalidatedTaskIds: readonly string[];
  readonly taskRecords: ReadonlyMap<string, TaskRecord>;
  readonly taskPrompts: ReadonlyMap<string, string>;
  readonly appliedBeforeApproval: boolean;
  readonly redirectPlanCallsBeforeCreditApproval: number | null;
  readonly revalidationCallsBeforeCreditApproval: number | null;
  readonly finalEvidencePlanArtifactId: string;
}

describe('AR-20 redirect + plan change', () => {
  let environment: TestWorkflowEnvironment | undefined;
  const workers: Worker[] = [];
  const workerRuns: Promise<void>[] = [];

  afterEach(async () => {
    for (const worker of workers) worker.shutdown();
    await Promise.all(workerRuns);
    await environment?.teardown();
    workers.length = 0;
    workerRuns.length = 0;
    environment = undefined;
  }, 30_000);

  async function runFixture(options: {
    readonly instruction: string;
    readonly diff: PlanDiff;
    readonly approveMaterial: boolean;
    readonly rejectMaterial?: boolean;
    readonly signalAtFinalBoundary?: boolean;
    readonly exhaustCreditDuringRedirectStatus?: boolean;
    readonly exhaustCreditDuringRedirectRevalidationEvent?: boolean;
  }): Promise<RedirectFixtureResult> {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar20-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const runId = newId('run');
    const organizationId = newId('org');
    const projectId = newId('proj');
    const specificationVersionId = 'specification-version-ar20';
    const events: PendingAgentEvent[] = [];
    const pausedTaskIds: string[] = [];
    const resumedTaskIds: string[] = [];
    const revalidatedTaskIds: string[] = [];
    const taskPrompts = new Map<string, string>();
    const taskRecords = new Map<string, TaskRecord>([
      [TASK_A, { status: 'queued', artifactIds: [TASK_A_ARTIFACT_ID] }],
      [TASK_B, { status: 'queued', artifactIds: [] }],
      [TASK_C, { status: 'queued', artifactIds: [] }],
    ]);
    let appliedBeforeApproval = false;
    let redirectApproved = false;
    let redirectPlanCalls = 0;
    let redirectPlanCallsBeforeCreditApproval: number | null = null;
    let revalidationCalls = 0;
    let revalidationCallsBeforeCreditApproval: number | null = null;
    let finalEvidencePlanArtifactId = ORIGINAL_PLAN_ARTIFACT_ID;

    let resolveSpecificationApproval: (() => void) | undefined;
    const specificationApprovalRequested = new Promise<void>((resolve) => {
      resolveSpecificationApproval = resolve;
    });
    let resolvePlanApproval: (() => void) | undefined;
    const planApprovalRequested = new Promise<void>((resolve) => {
      resolvePlanApproval = resolve;
    });
    let resolveTaskAStarted: (() => void) | undefined;
    const taskAStarted = new Promise<void>((resolve) => {
      resolveTaskAStarted = resolve;
    });
    let releaseTaskA: (() => void) | undefined;
    const taskAReleased = new Promise<void>((resolve) => {
      releaseTaskA = resolve;
    });
    let resolveFinalCheckpointStarted: (() => void) | undefined;
    const finalCheckpointStarted = new Promise<void>((resolve) => {
      resolveFinalCheckpointStarted = resolve;
    });
    let releaseFinalCheckpoint: (() => void) | undefined;
    const finalCheckpointReleased = new Promise<void>((resolve) => {
      releaseFinalCheckpoint = resolve;
    });
    let resolveRedirectApproval: (() => void) | undefined;
    const redirectApprovalRequested = new Promise<void>((resolve) => {
      resolveRedirectApproval = resolve;
    });
    let resolveCreditApproval: (() => void) | undefined;
    const creditApprovalRequested = new Promise<void>((resolve) => {
      resolveCreditApproval = resolve;
    });
    let resolveRedirectPausedStatusStarted: (() => void) | undefined;
    const redirectPausedStatusStarted = new Promise<void>((resolve) => {
      resolveRedirectPausedStatusStarted = resolve;
    });
    let releaseRedirectPausedStatus: (() => void) | undefined;
    const redirectPausedStatusReleased = new Promise<void>((resolve) => {
      releaseRedirectPausedStatus = resolve;
    });
    let resolveRevalidationEventStarted: (() => void) | undefined;
    const revalidationEventStarted = new Promise<void>((resolve) => {
      resolveRevalidationEventStarted = resolve;
    });
    let releaseRevalidationEvent: (() => void) | undefined;
    const revalidationEventReleased = new Promise<void>((resolve) => {
      releaseRevalidationEvent = resolve;
    });

    const eventActivities: EventActivities = {
      async emitEvents(input) {
        events.push(...input.events);
        for (const emitted of input.events) {
          if (emitted.type !== 'approval.requested') continue;
          if (emitted.payload['gate'] === 'specification') resolveSpecificationApproval?.();
          if (emitted.payload['gate'] === 'plan') resolvePlanApproval?.();
          if (emitted.payload['gate'] === 'plan_diff') resolveRedirectApproval?.();
        }
        if (
          options.exhaustCreditDuringRedirectRevalidationEvent === true &&
          input.events.some(
            ({ type, payload }) => type === 'task.updated' && payload['status'] === 'superseded',
          )
        ) {
          resolveRevalidationEventStarted?.();
          await revalidationEventReleased;
        }
      },
      async transitionRunStatus(input) {
        if (
          options.exhaustCreditDuringRedirectStatus === true &&
          input.status === 'paused'
        ) {
          resolveRedirectPausedStatusStarted?.();
          await redirectPausedStatusReleased;
        }
      },
      storeAssistantContent() {
        return Promise.reject(new Error('AR-20 stores no assistant content'));
      },
    };

    const autonomousActivities: AutonomousActivities = {
      conductInterview() {
        return Promise.resolve({ interviewArtifactId: newId('art'), status: 'executable' });
      },
      createSpecificationDraft() {
        return Promise.resolve({
          specificationVersionId,
          version: 1,
          contentEtag: `sha256:${'a'.repeat(64)}`,
        });
      },
      approveSpecification() {
        return Promise.resolve({ specificationVersionId, version: 1, status: 'approved' });
      },
      producePlan() {
        return Promise.resolve({ planArtifactId: ORIGINAL_PLAN_ARTIFACT_ID, plan: ORIGINAL_PLAN });
      },
      approvePlan(input) {
        return Promise.resolve({ planArtifactId: input.planArtifactId, status: 'approved' });
      },
      resolveIntegrationHead() {
        return Promise.resolve({ commitSha: VERIFIED_COMMIT });
      },
      repairPhase() {
        return Promise.reject(new Error('AR-20 fixture does not repair'));
      },
      transitionPhaseTasks(input) {
        for (const taskId of input.taskIds) {
          const record = taskRecords.get(taskId);
          if (record !== undefined) record.status = input.status;
        }
        return Promise.resolve();
      },
      async checkpointPhase() {
        if (options.signalAtFinalBoundary === true) {
          resolveFinalCheckpointStarted?.();
          await finalCheckpointReleased;
        }
        return Promise.resolve({ checkpointRef: `checkpoint:${PHASE_ID}` });
      },
      createFinalEvidence(input) {
        finalEvidencePlanArtifactId = input.planArtifactId;
        return Promise.resolve({
          releaseId: RELEASE_ID,
          evidenceArtifactId: RELEASE_EVIDENCE_ID,
          commitSha: input.commitSha,
          runId: input.runId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          specificationVersionId: input.specificationVersionId,
          planArtifactId: input.planArtifactId,
        });
      },
    };

    const redirectActivities: RedirectActivities = {
      pauseRedirectTasks(input) {
        pausedTaskIds.push(...input.affectedTaskIds);
        for (const taskId of input.affectedTaskIds) {
          const record = taskRecords.get(taskId);
          if (record !== undefined && record.status !== 'passed') record.status = 'blocked';
        }
        return Promise.resolve({ pausedTaskIds: input.affectedTaskIds });
      },
      resumeRedirectTasks(input) {
        resumedTaskIds.push(...input.taskIds);
        for (const taskId of input.taskIds) {
          const record = taskRecords.get(taskId);
          if (record?.status === 'blocked') record.status = 'queued';
        }
        return Promise.resolve({ resumedTaskIds: input.taskIds });
      },
      produceRedirectPlanDiff(input) {
        redirectPlanCalls += 1;
        expect(input.instruction).toBe(options.instruction);
        expect(input.currentPlanArtifactId).toBe(ORIGINAL_PLAN_ARTIFACT_ID);
        return Promise.resolve({ planDiffArtifactId: DIFF_ARTIFACT_ID, planDiff: options.diff });
      },
      applyRedirectPlanDiff(input) {
        appliedBeforeApproval = options.approveMaterial && !redirectApproved;
        const updatedPlan = applyPlanDiff(input.currentPlan, input.planDiff);
        const supersededTasks = input.planDiff.supersededTaskIds.map((taskId) => {
          const record = taskRecords.get(taskId);
          if (record === undefined) throw new Error(`missing task record ${taskId}`);
          record.status = 'superseded';
          return { taskId, retainedArtifactIds: [...record.artifactIds] };
        });
        for (const added of input.planDiff.addedTasks) {
          taskRecords.set(added.id, { status: 'queued', artifactIds: [] });
        }
        return Promise.resolve({
          planArtifactId: UPDATED_PLAN_ARTIFACT_ID,
          plan: updatedPlan,
          supersededTasks,
        });
      },
      revalidateRedirectedTasks(input) {
        revalidationCalls += 1;
        revalidatedTaskIds.push(...input.taskIds);
        return Promise.resolve({
          verificationResultId: 'vr_01J00000000000000000000001',
          decision: 'approved',
          taskIds: input.taskIds,
        });
      },
      checkpointRedirect() {
        return Promise.resolve({ checkpointRef: `redirect:${DIFF_ARTIFACT_ID}` });
      },
    };

    const approvalActivities: ApprovalActivities = {
      estimateRunCost() {
        return Promise.reject(new Error('AR-20 does not estimate run costs'));
      },
      requestBudgetIncrease() {
        resolveCreditApproval?.();
        return Promise.resolve({
          approvalId: 'appr_01J00000000000000000000020',
          absoluteCeiling: '20.0000',
        });
      },
      checkpointBudgetStop() {
        return Promise.reject(new Error('AR-20 organization-credit approval must resume'));
      },
    };
    const runApprovalActivities: RunApprovalActivities = {
      requestRunApproval(input) {
        expect(input.kind).toBe('plan_diff');
        expect(input.artifactId).toBe(DIFF_ARTIFACT_ID);
        return Promise.resolve({ approvalId: 'appr_01J00000000000000000000024' });
      },
    };

    const commitByTask = new Map([
      [TASK_A, '1'.repeat(40)],
      [TASK_B, '2'.repeat(40)],
      [TASK_C, '3'.repeat(40)],
      [TASK_FEATURE, '4'.repeat(40)],
    ]);
    const taskActivities: TaskWorkflowActivities = {
      recordBaseCommit() {
        return Promise.resolve({ baseCommitSha: '0'.repeat(40) });
      },
      createTaskWorkspace(input) {
        return Promise.resolve({
          workspaceId: `workspace-${input.taskId}`,
          workspacePath: `/tmp/workspace-${input.taskId}`,
        });
      },
      transitionTaskState(input) {
        const record = taskRecords.get(input.taskId);
        if (record !== undefined) record.status = input.status;
        return Promise.resolve();
      },
      async runTaskBuilderSession(input) {
        taskPrompts.set(input.taskId, input.prompt);
        if (input.taskId === TASK_A) {
          resolveTaskAStarted?.();
          await taskAReleased;
        }
        return { status: 'completed' };
      },
      commitAndPushTask(input) {
        const commitSha = commitByTask.get(input.taskId);
        if (commitSha === undefined) return Promise.reject(new Error('unknown task commit'));
        return Promise.resolve({ commitSha });
      },
      mergeTask() {
        return Promise.resolve({ outcome: 'merged' });
      },
      createConflictTask() {
        return Promise.reject(new Error('AR-20 fixture does not create conflicts'));
      },
      emitTaskBlocked() {
        return Promise.reject(new Error('AR-20 fixture does not block on conflicts'));
      },
    };

    const mainWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/run.ts', import.meta.url).pathname,
      activities: {
        ...eventActivities,
        ...autonomousActivities,
        ...approvalActivities,
        ...runApprovalActivities,
        ...redirectActivities,
        ...taskActivities,
        ...allowAllFeatureFlags,
      },
    });
    const verificationWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'verification',
      workflowsPath: new URL('../../src/workflows/run.ts', import.meta.url).pathname,
      activities: {
        verifyPhase() {
          return Promise.resolve({
            verificationResultId: 'vr_01J00000000000000000000002',
            decision: 'approved',
            criteriaResults: [{}],
            risks: [],
          });
        },
      },
    });
    workers.push(mainWorker, verificationWorker);
    workerRuns.push(mainWorker.run(), verificationWorker.run());

    const workflowInput: AutonomousWorkflowInput = {
      workflowId: `${runId}:autonomous`,
      runId,
      organizationId,
      projectId,
      prompt: 'Build the product.',
      model: null,
      budget: { maxCredits: 20 },
      planMaxCredits: 1000,
      maxConcurrency: 1,
    };
    const handle = await environment.client.workflow.start(autonomousWorkflow, {
      taskQueue,
      workflowId: workflowInput.workflowId,
      args: [workflowInput],
    });
    await specificationApprovalRequested;
    await handle.signal(autonomousSpecificationApprovalSignal, {
      runId,
      artifactId: specificationVersionId,
      decision: 'approved',
      operationKey: `op_${'1'.repeat(64)}`,
    });
    await planApprovalRequested;
    await handle.signal(autonomousPlanApprovalSignal, {
      runId,
      artifactId: ORIGINAL_PLAN_ARTIFACT_ID,
      decision: 'approved',
      operationKey: `op_${'2'.repeat(64)}`,
    });

    await taskAStarted;
    if (options.signalAtFinalBoundary === true) {
      releaseTaskA?.();
      await finalCheckpointStarted;
      await handle.signal(autonomousRedirectSignal, {
        runId,
        instruction: options.instruction,
        operationKey: `op_${'3'.repeat(64)}`,
      });
      releaseFinalCheckpoint?.();
    } else {
      await handle.signal(autonomousRedirectSignal, {
        runId,
        instruction: options.instruction,
        operationKey: `op_${'3'.repeat(64)}`,
      });
      releaseTaskA?.();
    }

    if (options.exhaustCreditDuringRedirectStatus === true) {
      await redirectPausedStatusStarted;
      await handle.signal(autonomousCreditBalanceExhaustedSignal, {
        runId,
        operationKey: `op_${'5'.repeat(64)}`,
      });
      releaseRedirectPausedStatus?.();
      await creditApprovalRequested;
      redirectPlanCallsBeforeCreditApproval = redirectPlanCalls;
      await handle.signal(budgetApprovalResolvedSignal, {
        approvalId: 'appr_01J00000000000000000000020',
        decision: 'approved',
        absoluteCeiling: '20.0000',
        reason: 'organization_credit_exhausted',
      });
    }

    if (options.approveMaterial) {
      await redirectApprovalRequested;
      redirectApproved = true;
      await handle.signal(autonomousPlanApprovalSignal, {
        runId,
        artifactId: DIFF_ARTIFACT_ID,
        decision: options.rejectMaterial === true ? 'rejected' : 'approved',
        operationKey: `op_${'4'.repeat(64)}`,
      });
    }

    if (options.exhaustCreditDuringRedirectRevalidationEvent === true) {
      await revalidationEventStarted;
      await handle.signal(autonomousCreditBalanceExhaustedSignal, {
        runId,
        operationKey: `op_${'5'.repeat(64)}`,
      });
      releaseRevalidationEvent?.();
      await creditApprovalRequested;
      revalidationCallsBeforeCreditApproval = revalidationCalls;
      await handle.signal(budgetApprovalResolvedSignal, {
        approvalId: 'appr_01J00000000000000000000020',
        decision: 'approved',
        absoluteCeiling: '20.0000',
        reason: 'organization_credit_exhausted',
      });
    }

    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
      releaseId: RELEASE_ID,
      evidenceArtifactId: RELEASE_EVIDENCE_ID,
    });
    return {
      events,
      pausedTaskIds,
      resumedTaskIds,
      revalidatedTaskIds,
      taskRecords,
      taskPrompts,
      appliedBeforeApproval,
      redirectPlanCallsBeforeCreditApproval,
      revalidationCallsBeforeCreditApproval,
      finalEvidencePlanArtifactId,
    };
  }

  it('pauses the dependency closure and requires approval for a material feature redirect', async () => {
    const feature = task(TASK_FEATURE, 'Add team invitations', [TASK_A]);
    const result = await runFixture({
      instruction: 'Add team invitations before finishing.',
      approveMaterial: true,
      diff: {
        addedTasks: [feature],
        removedTaskIds: [],
        modifiedTasks: [task(TASK_B, 'Write invitation copy', [TASK_A, TASK_FEATURE])],
        supersededTaskIds: [],
        impact: { scope: false, costDelta: false, archChange: false, dataChange: false },
      },
    });

    expect(result.pausedTaskIds).toEqual([TASK_B, TASK_C]);
    expect(result.appliedBeforeApproval).toBe(false);
    expect(
      result.events.some(
        ({ type, payload }) =>
          type === 'approval.requested' &&
          payload['gate'] === 'plan_diff' &&
          payload['artifactId'] === DIFF_ARTIFACT_ID,
      ),
    ).toBe(true);
    expect(
      result.events.some(
        ({ type, payload }) =>
          type === 'conversation.card' &&
          payload['card'] !== null &&
          typeof payload['card'] === 'object' &&
          (payload['card'] as Record<string, unknown>)['approvalKind'] === 'plan_diff' &&
          (payload['card'] as Record<string, unknown>)['approvalId'] ===
            'appr_01J00000000000000000000024',
      ),
    ).toBe(true);
    expect(result.taskPrompts.has(TASK_FEATURE)).toBe(true);
    expect(result.taskPrompts.get(TASK_B)).toContain('Task: Write invitation copy');
  }, 30_000);

  it('restores the paused dependency closure when a material redirect is rejected', async () => {
    const result = await runFixture({
      instruction: 'Replace the approved product direction.',
      approveMaterial: true,
      rejectMaterial: true,
      diff: {
        addedTasks: [task(TASK_FEATURE, 'Replace the approved direction', [TASK_A])],
        removedTaskIds: [],
        modifiedTasks: [],
        supersededTaskIds: [],
        impact: { scope: true, costDelta: false, archChange: false, dataChange: false },
      },
    });

    expect(result.resumedTaskIds).toEqual([TASK_B, TASK_C]);
    expect(result.taskRecords.get(TASK_B)?.status).toBe('passed');
    expect(result.taskRecords.get(TASK_C)?.status).toBe('passed');
  }, 30_000);

  it('auto-applies a non-material copy redirect and resumes from its checkpoint', async () => {
    const result = await runFixture({
      instruction: 'Change the primary heading copy.',
      approveMaterial: false,
      diff: {
        addedTasks: [],
        removedTaskIds: [],
        modifiedTasks: [task(TASK_B, 'Write the clearer primary copy', [TASK_A])],
        supersededTaskIds: [],
        impact: { scope: false, costDelta: false, archChange: false, dataChange: false },
      },
    });

    expect(
      result.events.filter(
        ({ type, payload }) => type === 'approval.requested' && payload['gate'] === 'plan_diff',
      ),
    ).toEqual([]);
    expect(
      result.events.some(
        ({ type, payload }) =>
          type === 'approval.resolved' &&
          payload['gate'] === 'plan_diff' &&
          payload['resolution'] === 'policy_auto',
      ),
    ).toBe(true);
    expect(
      result.events.some(
        ({ type, payload }) =>
          type === 'run.resumed' &&
          payload['checkpointRef'] === `redirect:${DIFF_ARTIFACT_ID}`,
      ),
    ).toBe(true);
    expect(result.taskPrompts.get(TASK_B)).toContain('Task: Write the clearer primary copy');
  }, 30_000);

  it('holds an Autonomous redirect planner when credit exhausts during redirect status work', async () => {
    const result = await runFixture({
      instruction: 'Change the heading after the current task.',
      approveMaterial: false,
      exhaustCreditDuringRedirectStatus: true,
      diff: {
        addedTasks: [],
        removedTaskIds: [],
        modifiedTasks: [task(TASK_B, 'Write the credit-approved heading', [TASK_A])],
        supersededTaskIds: [],
        impact: { scope: false, costDelta: false, archChange: false, dataChange: false },
      },
    });

    expect(result.redirectPlanCallsBeforeCreditApproval).toBe(0);
    expect(result.taskPrompts.get(TASK_B)).toContain('Task: Write the credit-approved heading');
  }, 30_000);

  it('holds redirect revalidation when credit exhausts during the preceding task event', async () => {
    const result = await runFixture({
      instruction: 'Replace the completed foundation task.',
      approveMaterial: true,
      exhaustCreditDuringRedirectRevalidationEvent: true,
      diff: {
        addedTasks: [],
        removedTaskIds: [TASK_A],
        modifiedTasks: [task(TASK_B, 'Write after the replacement', [])],
        supersededTaskIds: [TASK_A],
        impact: { scope: true, costDelta: false, archChange: false, dataChange: false },
      },
    });

    expect(result.revalidationCallsBeforeCreditApproval).toBe(0);
    expect(result.revalidatedTaskIds).toEqual([TASK_A]);
  }, 30_000);

  it('processes a redirect signalled after the final task before creating release evidence', async () => {
    const result = await runFixture({
      instruction: 'Change the final heading copy before release.',
      approveMaterial: false,
      signalAtFinalBoundary: true,
      diff: {
        addedTasks: [],
        removedTaskIds: [],
        modifiedTasks: [task(TASK_B, 'Write the final release copy', [TASK_A])],
        supersededTaskIds: [],
        impact: { scope: false, costDelta: false, archChange: false, dataChange: false },
      },
    });

    expect(result.finalEvidencePlanArtifactId).toBe(UPDATED_PLAN_ARTIFACT_ID);
    expect(result.revalidatedTaskIds).toEqual([TASK_B, TASK_C]);
  }, 30_000);

  it('marks obsolete tasks superseded without deleting artifacts and revalidates only affected completed work', async () => {
    const result = await runFixture({
      instruction: 'Replace the foundation task with the existing integrated result.',
      approveMaterial: true,
      diff: {
        addedTasks: [],
        removedTaskIds: [TASK_A],
        modifiedTasks: [task(TASK_B, 'Write the primary copy', [])],
        supersededTaskIds: [TASK_A],
        impact: { scope: true, costDelta: false, archChange: false, dataChange: false },
      },
    });

    expect(result.taskRecords.get(TASK_A)).toEqual({
      status: 'superseded',
      artifactIds: [TASK_A_ARTIFACT_ID],
    });
    expect(result.revalidatedTaskIds).toEqual([TASK_A]);
    expect(
      result.events.some(
        ({ type, payload }) =>
          type === 'task.updated' &&
          payload['taskId'] === TASK_A &&
          payload['status'] === 'superseded' &&
          JSON.stringify(payload['retainedArtifactIds']) === JSON.stringify([TASK_A_ARTIFACT_ID]),
      ),
    ).toBe(true);
  }, 30_000);
});
