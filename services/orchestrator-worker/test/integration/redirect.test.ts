import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { newId } from '@zapp/contracts';
import { applyPlanDiff, type PlanDiff } from '@zapp/planning-engine';
import { afterEach, describe, expect, it } from 'vitest';

import type { EventActivities, PendingAgentEvent } from '../../src/activities/events.js';
import type { TaskWorkflowActivities } from '../../src/activities/merge.js';
import {
  autonomousPlanApprovalSignal,
  autonomousRedirectSignal,
  autonomousSpecificationApprovalSignal,
  autonomousWorkflow,
  type AutonomousActivities,
  type AutonomousWorkflowInput,
} from '../../src/workflows/autonomous.js';
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

    const eventActivities: EventActivities = {
      emitEvents(input) {
        events.push(...input.events);
        for (const emitted of input.events) {
          if (emitted.type !== 'approval.requested') continue;
          if (emitted.payload['gate'] === 'specification') resolveSpecificationApproval?.();
          if (emitted.payload['gate'] === 'plan') resolvePlanApproval?.();
          if (emitted.payload['gate'] === 'plan_diff') resolveRedirectApproval?.();
        }
        return Promise.resolve();
      },
      transitionRunStatus() {
        return Promise.resolve();
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
        ...redirectActivities,
        ...taskActivities,
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
