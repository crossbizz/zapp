import { TestWorkflowEnvironment } from '@temporalio/testing';
import { TOOL_GROUPS } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createRunWorker, type RunActivities } from '../src/worker.js';
import { runWorkflow, type RunWorkflowInput } from '../src/workflows/run.js';

const id = (prefix: 'run' | 'org' | 'proj' | 'br', suffix = '0'): string =>
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
