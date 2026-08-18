import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunWorker, type RunActivities } from '../src/worker.js';
import {
  createApprovalActivities,
  RequestBudgetIncreaseInputSchema,
} from '../src/activities/approvals.js';
import { createTemporalRunOrchestrator } from '../../control-api/src/orchestrator/temporal.js';
import { CreditBalanceExhaustedError } from '../../control-api/src/usage/limits.js';
import { createCreditBalanceExhaustionProducer } from '../../control-api/src/usage/reconciliation.js';
import {
  getRunStatusQuery,
  runWorkflow,
  type RunWorkflowInput,
} from '../src/workflows/run.js';

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
    planMaxCredits: 1000,
    operationKey: `op_${'a'.repeat(64)}`,
  };
}

describe('AR-14 durable run budget approval loop', () => {
  let environment: TestWorkflowEnvironment | undefined;

  afterEach(async () => {
    await environment?.teardown();
    environment = undefined;
  });

  it('keeps ordinary increases monotonic and permits an equal ceiling only for organization credit', () => {
    const request = {
      runId: id('run'),
      organizationId: id('org'),
      projectId: id('proj'),
      workspaceId: 'workspace-budget-reason',
      currentCeiling: '100.0000',
      absoluteCeiling: '100.0000',
      idempotencyKey: 'budget-reason',
    };

    expect(RequestBudgetIncreaseInputSchema.safeParse({
      ...request,
      reason: 'run_budget_exhausted',
    }).success).toBe(false);
    expect(RequestBudgetIncreaseInputSchema.safeParse({
      ...request,
      reason: 'organization_credit_exhausted',
    }).success).toBe(true);
  });

  it('does not request a credit increase for a session token limit', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar14-token-limit-${Date.now().toString(36)}`;
    const statuses: string[] = [];
    let approvalRequests = 0;
    const activities: RunActivities = {
      transitionRunStatus: ({ status }) => {
        statuses.push(status);
        return Promise.resolve();
      },
      storeAssistantContent: () => Promise.reject(new Error('assistant overflow not expected')),
      emitEvents: () => Promise.resolve(),
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-token-limit' }),
      runBuilderSession: () =>
        Promise.resolve({
          status: 'budget_exhausted',
          errorCode: 'token_budget_exhausted',
          commits: [],
          artifacts: [],
          summary: 'token boundary',
        } as never),
      commitAndPush: () => Promise.reject(new Error('commit not expected')),
      estimateRunCost: () => Promise.resolve({ estimatedCredits: '1.0000' }),
      requestBudgetIncrease: () => {
        approvalRequests += 1;
        return Promise.reject(new Error('credit approval not expected'));
      },
      checkpointBudgetStop: () => Promise.reject(new Error('checkpoint not expected')),
    };
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const workflowInput = input('run_01J00000000000000000000007');
      const handle = await environment?.client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: workflowInput.workflowId,
        args: [workflowInput],
      });
      if (handle === undefined) throw new Error('Temporal environment was not created');
      await expect(handle.result()).rejects.toThrow();
    });

    expect(approvalRequests).toBe(0);
    expect(statuses).toEqual(['running', 'failed']);
  }, 30_000);

  it('defaults only a legacy activity payload that omitted the approval reason', async () => {
    const forwarded: unknown[] = [];
    const activities = createApprovalActivities({
      estimateRunCost: () => Promise.reject(new Error('estimate not expected')),
      requestBudgetIncrease: (request) => {
        forwarded.push(request);
        return Promise.resolve({
          approvalId: 'appr_01J00000000000000000000006',
          absoluteCeiling: '120.0000',
        });
      },
      checkpointBudgetStop: () => Promise.reject(new Error('checkpoint not expected')),
    });
    const legacyPayload = {
      runId: id('run'),
      organizationId: id('org'),
      projectId: id('proj'),
      workspaceId: 'workspace-legacy-activity',
      currentCeiling: '100.0000',
      absoluteCeiling: '120.0000',
      idempotencyKey: 'legacy-budget-activity',
    };

    expect(RequestBudgetIncreaseInputSchema.safeParse(legacyPayload).success).toBe(false);
    const executeLegacyActivity = (inputValue: unknown): Promise<unknown> =>
      activities.requestBudgetIncrease(inputValue as never);
    await expect(executeLegacyActivity(legacyPayload)).resolves.toEqual({
      approvalId: 'appr_01J00000000000000000000006',
      absoluteCeiling: '120.0000',
    });
    expect(forwarded).toEqual([
      {
        ...legacyPayload,
        reason: 'run_budget_exhausted',
      },
    ]);
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
      storeAssistantContent: () => Promise.reject(new Error('assistant overflow not expected')),
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
      await vi.waitFor(async () => {
        expect(await handle.query(getRunStatusQuery)).toMatchObject({
          status: 'waiting_for_approval',
          phase: 'session',
          taskId: 'task-m1',
        });
      });
      await handle.signal('budgetApprovalResolved', {
        approvalId: 'appr_01J00000000000000000000000',
        decision: 'approved',
        absoluteCeiling: '200.0000',
        reason: 'run_budget_exhausted',
      });
      await expect(result).resolves.toEqual({ status: 'completed', commitSha: 'd'.repeat(40) });
    });

    expect(sessionBudgets).toEqual([{ maxCredits: 100 }, { maxCredits: 200 }]);
    expect(statuses).toEqual(['running', 'waiting_for_approval', 'running', 'completed']);
    expect(events.map(({ type }) => type)).toContain('approval.requested');
    expect(events.map(({ type }) => type)).toContain('approval.resolved');
    expect(events.find(({ type }) => type === 'conversation.card')?.payload).toEqual({
      card: {
        version: 1,
        kind: 'approval',
        cardId: `card_${id('run')}:budget:0`,
        approvalId: 'appr_01J00000000000000000000000',
        approvalKind: 'budget_increase',
      },
    });
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
      storeAssistantContent: () => Promise.reject(new Error('assistant overflow not expected')),
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
      const history = await handle.fetchHistory();
      await Worker.runReplayHistory(
        { workflowsPath: new URL('../src/workflows/run.ts', import.meta.url).pathname },
        history,
        workflowInput.workflowId,
      );
    });

    expect(checkpoints).toHaveLength(1);
    expect(commits).toBe(0);
    expect(statuses).toEqual(['running', 'waiting_for_approval', 'cancelled']);
  }, 30_000);

  it('finishes the current task, ignores generic resume, and requires a matching credit approval at plan cap', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar14-credit-gate-${Date.now().toString(36)}`;
    let completeFirstTask!: (value: {
      status: 'completed';
      commits: never[];
      artifacts: never[];
      summary: string;
    }) => void;
    const firstTask = new Promise<{
      status: 'completed';
      commits: never[];
      artifacts: never[];
      summary: string;
    }>((resolve) => {
      completeFirstTask = resolve;
    });
    const approvalRequests: unknown[] = [];
    const statuses: string[] = [];
    let sessionAttempts = 0;
    const activities: RunActivities = {
      transitionRunStatus: ({ status }) => {
        statuses.push(status);
        return Promise.resolve();
      },
      storeAssistantContent: () => Promise.reject(new Error('assistant overflow not expected')),
      emitEvents: () => Promise.resolve(),
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-credit-gate' }),
      runBuilderSession: () => {
        sessionAttempts += 1;
        if (sessionAttempts === 1) return firstTask;
        return Promise.resolve({
          status: 'completed' as const,
          commits: [],
          artifacts: [],
          summary: 'continued after approved credit budget',
        });
      },
      commitAndPush: () => Promise.resolve({ commitSha: 'f'.repeat(40), diffstat: [] }),
      estimateRunCost: () => Promise.resolve({ estimatedCredits: '1.0000' }),
      requestBudgetIncrease: (request: unknown) => {
        approvalRequests.push(request);
        return Promise.resolve({
          approvalId: 'appr_01J00000000000000000000002',
          absoluteCeiling: '100.0000',
        });
      },
      checkpointBudgetStop: () => Promise.reject(new Error('approval should resume')),
    };
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const workflowInput = input('run_01J00000000000000000000002');
      const handle = await environment?.client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: workflowInput.workflowId,
        args: [workflowInput],
      });
      if (handle === undefined) throw new Error('Temporal environment was not created');
      const result = handle.result();
      void result.catch(() => undefined);
      await vi.waitFor(() => {
        expect(sessionAttempts).toBe(1);
      }, { timeout: 5_000 });

      await handle.signal('creditBalanceExhausted', {
        runId: workflowInput.runId,
        operationKey: `op_${'c'.repeat(64)}`,
      });
      expect(approvalRequests).toEqual([]);
      expect(statuses).toEqual(['running']);

      completeFirstTask({
        status: 'completed',
        commits: [],
        artifacts: [],
        summary: 'the current task finished before the balance gate',
      });
      await vi.waitFor(() => {
        expect(approvalRequests).toHaveLength(1);
      }, { timeout: 5_000 });
      expect(approvalRequests).toEqual([
        expect.objectContaining({
          currentCeiling: '100.0000',
          absoluteCeiling: '100.0000',
          reason: 'organization_credit_exhausted',
        }),
      ]);
      await vi.waitFor(async () => {
        expect(await handle.query(getRunStatusQuery)).toMatchObject({
          status: 'waiting_for_approval',
          phase: 'session',
        });
      });
      expect(sessionAttempts).toBe(1);

      await handle.signal('resume', {
        runId: workflowInput.runId,
        operationKey: `op_${'d'.repeat(64)}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sessionAttempts).toBe(1);

      await handle.signal('budgetApprovalResolved', {
        approvalId: 'appr_01J00000000000000000000002',
        decision: 'approved',
        absoluteCeiling: '100.0000',
        reason: 'organization_credit_exhausted',
      });
      await expect(result).resolves.toEqual({ status: 'completed', commitSha: 'f'.repeat(40) });
    });

    expect(sessionAttempts).toBe(1);
    expect(statuses).toEqual(['running', 'waiting_for_approval', 'running', 'completed']);
  }, 30_000);

  it('composes the production exhaustion producer through Temporal before the next task boundary', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const temporalClient = environment.client;
    const taskQueue = `ar14-producer-${Date.now().toString(36)}`;
    let completeCurrentTask!: (value: {
      status: 'completed'; commits: never[]; artifacts: never[]; summary: string;
    }) => void;
    const currentTask = new Promise<{
      status: 'completed'; commits: never[]; artifacts: never[]; summary: string;
    }>((resolve) => { completeCurrentTask = resolve; });
    const approvals: unknown[] = [];
    let attempts = 0;
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities: {
        transitionRunStatus: () => Promise.resolve(),
        storeAssistantContent: () => Promise.reject(new Error('not expected')),
        emitEvents: () => Promise.resolve(),
        ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-producer' }),
        runBuilderSession: () => {
          attempts += 1;
          return attempts === 1
            ? currentTask
            : Promise.resolve({ status: 'completed' as const, commits: [], artifacts: [], summary: 'resumed' });
        },
        commitAndPush: () => Promise.resolve({ commitSha: '9'.repeat(40), diffstat: [] }),
        estimateRunCost: () => Promise.resolve({ estimatedCredits: '1.0000' }),
        requestBudgetIncrease: (request: unknown) => {
          approvals.push(request);
          return Promise.resolve({ approvalId: 'appr_01J00000000000000000000003', absoluteCeiling: '100.0000' });
        },
        checkpointBudgetStop: () => Promise.reject(new Error('not expected')),
      },
      testOnlyBypassActivityIdempotency: true,
    });
    await worker.runUntil(async () => {
      const workflowInput = input('run_01J00000000000000000000003');
      const handle = await environment?.client.workflow.start(runWorkflow, {
        taskQueue, workflowId: workflowInput.workflowId, args: [workflowInput],
      });
      if (handle === undefined) throw new Error('Temporal environment was not created');
      const result = handle.result();
      void result.catch(() => undefined);
      await vi.waitFor(() => {
        expect(attempts).toBe(1);
      }, { timeout: 5_000 });
      const producer = createCreditBalanceExhaustionProducer({
        store: {
          claimOrganizations: () => Promise.resolve({ acquired: true, leaseToken: 'ar14-lease', renewAfterMs: 10_000, organizationIds: [workflowInput.organizationId] }),
          renewLease: () => Promise.resolve(true),
          releaseLease: () => Promise.resolve(),
          getOrOpenEpisode: () => Promise.resolve({ operationKey: `op_${'e'.repeat(64)}`, cursorRunId: null }),
          closeEpisode: () => Promise.resolve(),
          listActiveRuns: () => Promise.resolve([{ runId: workflowInput.runId, temporalWorkflowId: workflowInput.workflowId, mode: workflowInput.mode }]),
          advanceEpisode: () => Promise.resolve(),
        },
        creditBalance: {
          availableCredits: () => Promise.reject(new Error('not reached')),
          requireRunAdmission: () => Promise.reject(new CreditBalanceExhaustedError()),
        },
        orchestrator: createTemporalRunOrchestrator({ client: temporalClient }),
        batchSize: 10,
        signalConcurrency: 2,
      });
      await producer.runOnce();
      expect(approvals).toEqual([]);
      completeCurrentTask({ status: 'completed', commits: [], artifacts: [], summary: 'finished first' });
      await vi.waitFor(() => {
        expect(approvals).toHaveLength(1);
      }, { timeout: 5_000 });
      await vi.waitFor(async () => {
        expect(await handle.query(getRunStatusQuery)).toMatchObject({
          status: 'waiting_for_approval',
        });
      });
      await handle.signal('budgetApprovalResolved', {
        approvalId: 'appr_01J00000000000000000000003', decision: 'approved', absoluteCeiling: '100.0000', reason: 'organization_credit_exhausted',
      });
      await expect(result).resolves.toEqual({ status: 'completed', commitSha: '9'.repeat(40) });
    });
  }, 30_000);
});
