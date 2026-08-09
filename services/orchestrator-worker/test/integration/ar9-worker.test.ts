import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowContinuedAsNewError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createBusinessFailure,
  createRunWorker,
  type RunActivities,
} from '../../src/worker.js';
import {
  runWorkflow,
  type RunWorkflowInput,
  type RunWorkflowResult,
} from '../../src/workflows/run.js';

const id = (prefix: 'run' | 'org' | 'proj'): string =>
  `${prefix}_01J00000000000000000000000`;

function workflowInput(runId = id('run')): RunWorkflowInput {
  return {
    runId,
    workflowId: runId,
    organizationId: id('org'),
    projectId: id('proj'),
    branchId: null,
    mode: 'build',
    appType: 'web',
    model: null,
    prompt: 'Exercise the AR-9 workflow phases.',
    budget: null,
    operationKey: `op_${'a'.repeat(64)}`,
  };
}

describe('AR-9 Temporal worker hardening', () => {
  let environment: TestWorkflowEnvironment | undefined;

  afterEach(async () => {
    await environment?.teardown();
    environment = undefined;
  });

  it('continues as new after workspace and session while preserving state and retrying transient work 3x', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar9-phases-${Date.now().toString(36)}`;
    const statuses: string[] = [];
    const eventTypes: string[] = [];
    const sessionWorkspaceIds: string[] = [];
    let ensureAttempts = 0;
    let sessionAttempts = 0;
    let commitAttempts = 0;
    const activities: RunActivities = {
      transitionRunStatus: ({ status }) => {
        statuses.push(status);
        return Promise.resolve();
      },
      emitEvents: ({ events }) => {
        eventTypes.push(...events.map((event) => event.type));
        return Promise.resolve();
      },
      ensureWorkspace: () => {
        ensureAttempts += 1;
        if (ensureAttempts < 3) {
          throw ApplicationFailure.create({
            message: 'transient workspace failure',
            type: 'transient_workspace_failure',
            nonRetryable: false,
            nextRetryDelay: 1,
          });
        }
        return Promise.resolve({ workspaceId: 'workspace-ar9' });
      },
      runBuilderSession: ({ workspaceId }) => {
        sessionAttempts += 1;
        sessionWorkspaceIds.push(workspaceId);
        return Promise.resolve({
          status: 'completed',
          commits: [],
          artifacts: [],
          summary: 'phase complete',
        });
      },
      commitAndPush: () => {
        commitAttempts += 1;
        return Promise.resolve({ commitSha: 'b'.repeat(40), diffstat: [] });
      },
    };
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const input = workflowInput();
      const handle = await environment?.client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: input.workflowId,
        args: [input],
      });
      if (handle === undefined) throw new Error('Temporal environment was not created');
      const continuationRunIds: string[] = [];
      let runId = handle.firstExecutionRunId;
      for (let expected = 0; expected < 2; expected += 1) {
        const run = environment?.client.workflow.getHandle<typeof runWorkflow>(
          input.workflowId,
          runId,
          { followRuns: false },
        );
        if (run === undefined) throw new Error('Temporal environment was not created');
        try {
          await run.result();
          throw new Error('workflow completed before the required phase continuation');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(WorkflowContinuedAsNewError);
          runId = (error as WorkflowContinuedAsNewError).newExecutionRunId;
          continuationRunIds.push(runId);
        }
      }
      const finalRun = environment?.client.workflow.getHandle<typeof runWorkflow>(
        input.workflowId,
        runId,
        { followRuns: false },
      );
      if (finalRun === undefined) throw new Error('Temporal environment was not created');
      await expect(finalRun.result()).resolves.toEqual({
        status: 'completed',
        commitSha: 'b'.repeat(40),
      } satisfies RunWorkflowResult);
      expect(new Set(continuationRunIds).size).toBe(2);
    });

    expect(ensureAttempts).toBe(3);
    expect(sessionAttempts).toBe(1);
    expect(commitAttempts).toBe(1);
    expect(sessionWorkspaceIds).toEqual(['workspace-ar9']);
    expect(statuses).toEqual(['running', 'completed']);
    expect(eventTypes).toEqual([
      'run.started',
      'agent.started',
      'commit.created',
      'run.completed',
    ]);
  }, 30_000);

  it('does not retry a typed business failure', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar9-business-${Date.now().toString(36)}`;
    let ensureAttempts = 0;
    const activities: RunActivities = {
      transitionRunStatus: () => Promise.resolve(),
      emitEvents: () => Promise.resolve(),
      ensureWorkspace: () => {
        ensureAttempts += 1;
        throw createBusinessFailure('branch_locked', 'The branch already has a writer');
      },
      runBuilderSession: () => Promise.reject(new Error('session must not run')),
      commitAndPush: () => Promise.reject(new Error('commit must not run')),
    };
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const input = workflowInput('run_01J00000000000000000000001');
      await expect(
        environment?.client.workflow.execute(runWorkflow, {
          taskQueue,
          workflowId: input.workflowId,
          args: [input],
        }),
      ).rejects.toThrow('Workflow execution failed');
    });
    expect(ensureAttempts).toBe(1);
  }, 30_000);

});
