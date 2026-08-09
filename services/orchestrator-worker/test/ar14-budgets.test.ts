import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunWorker, type RunActivities } from '../src/worker.js';
import { runWorkflow, type RunWorkflowInput } from '../src/workflows/run.js';

const id = (prefix: 'run' | 'org' | 'proj'): string =>
  `${prefix}_01J00000000000000000000000`;

function input(runId = id('run')): RunWorkflowInput {
  return {
    runId,
    workflowId: runId,
    organizationId: id('org'),
    projectId: id('proj'),
    branchId: null,
    mode: 'build',
    appType: 'web',
    model: null,
    prompt: 'Build within the approved run budget.',
    budget: { maxCredits: 100 },
    operationKey: `op_${'a'.repeat(64)}`,
  };
}

describe('AR-14 durable run budget approval loop', () => {
  let environment: TestWorkflowEnvironment | undefined;

  afterEach(async () => {
    await environment?.teardown();
    environment = undefined;
  });

  it('pauses once at the hard ceiling and resumes with the approved absolute ceiling', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar14-approve-${Date.now().toString(36)}`;
    const statuses: string[] = [];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const approvalRequests: unknown[] = [];
    const sessionBudgets: unknown[] = [];
    let sessionAttempts = 0;
    const activities: RunActivities = {
      transitionRunStatus: ({ status }) => {
        statuses.push(status);
        return Promise.resolve();
      },
      emitEvents: ({ events: batch }) => {
        events.push(...batch.map(({ type, payload }) => ({ type, payload })));
        return Promise.resolve();
      },
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-ar14' }),
      runBuilderSession: ({ budget }) => {
        sessionAttempts += 1;
        sessionBudgets.push(budget);
        return Promise.resolve({
          status: sessionAttempts === 1 ? 'budget_exhausted' : 'completed',
          commits: [],
          artifacts: [],
          summary: 'budget boundary',
        });
      },
      commitAndPush: () => Promise.resolve({ commitSha: 'd'.repeat(40), diffstat: [] }),
      estimateRunCost: () => Promise.resolve({ estimatedCredits: '12.0000' }),
      requestBudgetIncrease: (request: unknown) => {
        approvalRequests.push(request);
        return Promise.resolve({
          approvalId: 'appr_01J00000000000000000000000',
          absoluteCeiling: '200.0000',
        });
      },
      checkpointBudgetStop: () => Promise.reject(new Error('approval must resume, not stop')),
    };
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const workflowInput = input();
      const handle = await environment?.client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: workflowInput.workflowId,
        args: [workflowInput],
      });
      if (handle === undefined) throw new Error('Temporal environment was not created');
      const result = handle.result();
      void result.catch(() => undefined);
      await Promise.race([
        vi.waitFor(() => {
          expect(approvalRequests).toHaveLength(1);
        }, { timeout: 5_000 }),
        result.then(
          () => Promise.reject(new Error('workflow completed before requesting approval')),
          (error: unknown) =>
            Promise.reject(error instanceof Error ? error : new Error('workflow failed')),
        ),
      ]);
      await handle.signal('budgetApprovalResolved', {
        approvalId: 'appr_01J00000000000000000000000',
        decision: 'approved',
        absoluteCeiling: '200.0000',
      });
      await expect(result).resolves.toEqual({ status: 'completed', commitSha: 'd'.repeat(40) });
    });

    expect(sessionBudgets).toEqual([{ maxCredits: 100 }, { maxCredits: 200 }]);
    expect(statuses).toEqual(['running', 'waiting_for_approval', 'running', 'completed']);
    expect(events.map(({ type }) => type)).toContain('approval.requested');
    expect(events.map(({ type }) => type)).toContain('approval.resolved');
    expect(events.find(({ type }) => type === 'run.started')?.payload).toMatchObject({
      estimatedCredits: '12.0000',
      maxCredits: 100,
    });
  }, 30_000);

  it('checkpoints and cancels gracefully when the budget increase is rejected', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar14-reject-${Date.now().toString(36)}`;
    const statuses: string[] = [];
    const approvalRequests: unknown[] = [];
    const checkpoints: unknown[] = [];
    let commits = 0;
    const activities: RunActivities = {
      transitionRunStatus: ({ status }) => {
        statuses.push(status);
        return Promise.resolve();
      },
      emitEvents: () => Promise.resolve(),
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-ar14-reject' }),
      runBuilderSession: () =>
        Promise.resolve({
          status: 'budget_exhausted',
          commits: [],
          artifacts: [],
          summary: 'budget boundary',
        }),
      commitAndPush: () => {
        commits += 1;
        return Promise.resolve({ commitSha: 'e'.repeat(40), diffstat: [] });
      },
      estimateRunCost: () => Promise.resolve({ estimatedCredits: '9.0000' }),
      requestBudgetIncrease: (request: unknown) => {
        approvalRequests.push(request);
        return Promise.resolve({
          approvalId: 'appr_01J00000000000000000000001',
          absoluteCeiling: '200.0000',
        });
      },
      checkpointBudgetStop: (request: unknown) => {
        checkpoints.push(request);
        return Promise.resolve({ checkpointRef: 'checkpoint-budget-stop' });
      },
    };
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const workflowInput = input('run_01J00000000000000000000001');
      const handle = await environment?.client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: workflowInput.workflowId,
        args: [workflowInput],
      });
      if (handle === undefined) throw new Error('Temporal environment was not created');
      const result = handle.result();
      void result.catch(() => undefined);
      await Promise.race([
        vi.waitFor(() => {
          expect(approvalRequests).toHaveLength(1);
        }, { timeout: 5_000 }),
        result.then(
          () => Promise.reject(new Error('workflow completed before requesting approval')),
          (error: unknown) =>
            Promise.reject(error instanceof Error ? error : new Error('workflow failed')),
        ),
      ]);
      await handle.signal('budgetApprovalResolved', {
        approvalId: 'appr_01J00000000000000000000001',
        decision: 'rejected',
      });
      await expect(result).resolves.toEqual({
        status: 'cancelled',
        checkpointRef: 'checkpoint-budget-stop',
      });
    });

    expect(checkpoints).toHaveLength(1);
    expect(commits).toBe(0);
    expect(statuses).toEqual(['running', 'waiting_for_approval', 'cancelled']);
  }, 30_000);
});
