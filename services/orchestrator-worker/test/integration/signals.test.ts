import { Context } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createEventActivities, EventBatchClient } from '../../src/activities/events.js';
import {
  createRunWorker,
  createTemporalOrchestrator,
  type RunActivities,
} from '../../src/worker.js';
import {
  cancelRunSignal,
  getRunStatusQuery,
  pauseRunSignal,
  redirectRunSignal,
  resumeRunSignal,
  runWorkflow,
  type RunWorkflowInput,
} from '../../src/workflows/run.js';

const id = (prefix: 'run' | 'org' | 'proj'): string => `${prefix}_01J00000000000000000000000`;

function workflowInput(runId: string): RunWorkflowInput {
  return {
    runId,
    workflowId: runId,
    organizationId: id('org'),
    projectId: id('proj'),
    branchId: null,
    mode: 'build',
    appType: 'web',
    model: null,
    prompt: 'Complete the current builder turn.',
    budget: null,
    planMaxCredits: 1000,
    operationKey: `op_${'a'.repeat(64)}`,
  };
}

function operationKey(character: string): string {
  return `op_${character.repeat(64)}`;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function approvalActivityNotExpected(): Promise<never> {
  return Promise.reject(new Error('budget approval is not expected in AR-10'));
}

describe('AR-10 durable run control signals', () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
  }, 30_000);

  afterAll(async () => {
    await environment.teardown();
  });

  it('flushes control acknowledgements without the normal event batching linger', async () => {
    const publishedAt: number[] = [];
    const activities = createEventActivities({
      client: new EventBatchClient({
        publish: () => {
          publishedAt.push(Date.now());
          return Promise.resolve();
        },
      }),
      assistantContent: {
        store: ({ artifactId, contentHash }) => Promise.resolve({ artifactId, contentHash }),
      },
      transitionStatus: () => Promise.resolve(),
    });
    const startedAt = Date.now();

    await activities.emitEvents({
      events: [
        {
          eventKey: 'control-paused',
          runId: 'run_01J00000000000000000000015',
          organizationId: id('org'),
          projectId: id('proj'),
          occurredAt: '2026-08-09T00:00:00.000Z',
          type: 'run.paused',
          visibility: 'user',
          payload: { checkpointRef: 'checkpoint-ar10-immediate' },
        },
      ],
      flushImmediately: true,
    } as never);

    expect(publishedAt).toHaveLength(1);
    expect((publishedAt[0] ?? Number.POSITIVE_INFINITY) - startedAt).toBeLessThan(250);
  });

  it('maps the public redirect signal to the strict workflow instruction envelope', async () => {
    const signal = vi.fn(() => Promise.resolve());
    const orchestrator = createTemporalOrchestrator({
      client: {
        workflow: {
          getHandle: () => ({ signal }),
        },
      } as never,
    });
    const input = workflowInput('run_01J00000000000000000000013');
    await expect(
      orchestrator.signalRun({
        runId: input.runId,
        workflowId: input.workflowId,
        mode: 'build',
        signal: 'redirect',
        prompt: 'Keep the existing API and use the repository adapter.',
        operationKey: operationKey('1'),
      }),
    ).resolves.toEqual({ applied: true });
    expect(signal).toHaveBeenCalledWith('redirect', {
      runId: input.runId,
      instruction: 'Keep the existing API and use the repository adapter.',
      operationKey: operationKey('1'),
    });
  });

  it('maps the credit-exhaustion boundary signal to the durable workflow gate', async () => {
    const signal = vi.fn(() => Promise.resolve());
    const orchestrator = createTemporalOrchestrator({
      client: { workflow: { getHandle: () => ({ signal }) } } as never,
    });
    const input = workflowInput('run_01J00000000000000000000014');

    await expect(
      orchestrator.signalRun({
        runId: input.runId,
        workflowId: input.workflowId,
        mode: 'build',
        signal: 'credit_balance_exhausted',
        operationKey: operationKey('2'),
      }),
    ).resolves.toEqual({ applied: true });
    expect(signal).toHaveBeenCalledWith('creditBalanceExhausted', {
      runId: input.runId,
      operationKey: operationKey('2'),
    });
  });

  it('terminates a failed builder session instead of retrying the workflow task forever', async () => {
    const statuses: string[] = [];
    const published: Array<{ readonly type: string; readonly payload: Record<string, unknown> }> =
      [];
    const failedTransition = deferred<undefined>();
    const activities: RunActivities = {
      storeAssistantContent: () => Promise.reject(new Error('assistant overflow not expected')),
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-ar10-failed' }),
      runBuilderSession: () =>
        Promise.resolve({
          status: 'failed',
          commits: [],
          artifacts: [],
          errorCode: 'provider_error',
          summary: 'The model provider request failed after its retries.',
        }),
      commitAndPush: () => Promise.reject(new Error('failed run must not commit')),
      emitEvents: ({ events }) => {
        published.push(...events.map(({ type, payload }) => ({ type, payload })));
        return Promise.resolve();
      },
      transitionRunStatus: ({ status }) => {
        statuses.push(status);
        if (status === 'failed') failedTransition.resolve(undefined);
        return Promise.resolve();
      },
      estimateRunCost: approvalActivityNotExpected,
      requestBudgetIncrease: approvalActivityNotExpected,
      checkpointBudgetStop: approvalActivityNotExpected,
    };
    const taskQueue = `ar10-failed-${Date.now().toString(36)}`;
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const input = workflowInput('run_01J00000000000000000000016');
      const handle = await environment.client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: input.workflowId,
        args: [input],
      });
      const result = handle.result();
      const terminalResult = result.then(
        () => 'unexpected-success' as const,
        () => 'rejected' as const,
      );
      const outcome = await Promise.race([
        failedTransition.promise.then(() => terminalResult),
        new Promise<'still-running'>((resolve) => {
          setTimeout(() => {
            resolve('still-running');
          }, 20_000);
        }),
      ]);
      if (outcome === 'still-running') {
        await handle.terminate('test cleanup for non-terminal workflow');
        await result.catch(() => undefined);
      }
      expect(outcome).toBe('rejected');
    });

    expect(statuses).toEqual(['running', 'failed']);
    expect(published.find(({ type }) => type === 'message.assistant')?.payload).toMatchObject({
      content: 'The model provider request failed after its retries.',
      model: 'policy/default',
    });
    expect(published.find(({ type }) => type === 'run.completed')?.payload).toEqual({
      status: 'failed',
      code: 'provider_error',
      summary: 'The model provider request failed after its retries.',
    });
  }, 30_000);

  it('finishes the active turn, checkpoints, pauses, reports status, and resumes once', async () => {
    const firstTurn = deferred<{
      status: 'yielded';
      commits: never[];
      artifacts: never[];
      summary: string;
    }>();
    const statuses: string[] = [];
    const events: Array<{
      readonly type: string;
      readonly at: number;
      readonly payload: Record<string, unknown>;
    }> = [];
    const checkpoints: string[] = [];
    let sessions = 0;
    const activities: RunActivities = {
      storeAssistantContent: () => Promise.reject(new Error('assistant overflow not expected')),
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-ar10-pause' }),
      runBuilderSession: () => {
        sessions += 1;
        if (sessions === 1) return firstTurn.promise;
        return Promise.resolve({
          status: 'completed',
          commits: [],
          artifacts: [],
          summary: 'session complete after resume',
        });
      },
      commitAndPush: () => Promise.resolve({ commitSha: 'b'.repeat(40), diffstat: [] }),
      emitEvents: ({ events: batch }) => {
        const at = Date.now();
        events.push(...batch.map((event) => ({ type: event.type, at, payload: event.payload })));
        return Promise.resolve();
      },
      transitionRunStatus: ({ status }) => {
        statuses.push(status);
        return Promise.resolve();
      },
      estimateRunCost: approvalActivityNotExpected,
      requestBudgetIncrease: approvalActivityNotExpected,
      checkpointBudgetStop: ({ workspaceId }) => {
        checkpoints.push(workspaceId);
        return Promise.resolve({ checkpointRef: 'checkpoint-ar10-pause' });
      },
    };
    const taskQueue = `ar10-pause-${Date.now().toString(36)}`;
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const input = workflowInput('run_01J00000000000000000000010');
      const handle = await environment.client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: input.workflowId,
        args: [input],
      });
      await vi.waitFor(
        async () => {
          expect((await handle.query(getRunStatusQuery)).phase).toBe('session');
          expect(sessions).toBe(1);
        },
        { timeout: 5_000 },
      );
      await handle.signal(pauseRunSignal, {
        runId: input.runId,
        operationKey: operationKey('b'),
      });
      await handle.signal(pauseRunSignal, {
        runId: input.runId,
        operationKey: operationKey('b'),
      });
      expect((await handle.query(getRunStatusQuery)).status).toBe('pause_requested');
      expect(checkpoints).toEqual([]);

      const toolCompletedAt = Date.now();
      firstTurn.resolve({
        status: 'yielded',
        commits: [],
        artifacts: [],
        summary: 'turn complete',
      });
      await vi.waitFor(async () => {
        expect(await handle.query(getRunStatusQuery)).toMatchObject({
          status: 'paused',
          phase: 'paused',
          taskId: 'task-m1',
          workspaceId: 'workspace-ar10-pause',
        });
      });
      expect(checkpoints).toEqual(['workspace-ar10-pause']);
      expect(sessions).toBe(1);
      const pauseAcknowledgement = events.find((event) => event.type === 'run.paused');
      expect(pauseAcknowledgement).toBeDefined();
      expect((pauseAcknowledgement?.at ?? Number.POSITIVE_INFINITY) - toolCompletedAt).toBeLessThan(
        5_000,
      );

      await handle.signal(resumeRunSignal, {
        runId: input.runId,
        operationKey: operationKey('c'),
      });
      await expect(handle.result()).resolves.toEqual({
        status: 'completed',
        commitSha: 'b'.repeat(40),
      });
    });

    expect(sessions).toBe(2);
    expect(statuses).toEqual(['running', 'completed']);
    expect(events.map((event) => event.type)).toContain('run.paused');
    expect(events.map((event) => event.type)).toContain('run.resumed');
    const pausedPayload = events.find((event) => event.type === 'run.paused')?.payload;
    expect(pausedPayload).toMatchObject({
      control: {
        operationKey: operationKey('b'),
      },
    });
    expect(
      typeof (pausedPayload?.['control'] as Record<string, unknown> | undefined)?.[
        'acknowledgementDeadlineAt'
      ],
    ).toBe('string');
    const resumedPayload = events.find((event) => event.type === 'run.resumed')?.payload;
    expect(resumedPayload).toMatchObject({
      control: {
        operationKey: operationKey('c'),
      },
    });
    expect(
      typeof (resumedPayload?.['control'] as Record<string, unknown> | undefined)?.[
        'acknowledgementDeadlineAt'
      ],
    ).toBe('string');
  }, 30_000);

  it('cancels the active tool, checkpoints, and acknowledges cancellation within five seconds', async () => {
    const eventTimes: Array<{
      readonly type: string;
      readonly at: number;
      readonly payload: Record<string, unknown>;
    }> = [];
    const checkpoints: string[] = [];
    let activityCancelled = false;
    let activityStarted = false;
    let activityCancelledAt = Number.POSITIVE_INFINITY;
    let checkpointedAt = Number.POSITIVE_INFINITY;
    const activities: RunActivities = {
      storeAssistantContent: () => Promise.reject(new Error('assistant overflow not expected')),
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-ar10-cancel' }),
      runBuilderSession: () =>
        new Promise((resolve) => {
          activityStarted = true;
          const context = Context.current();
          const cancellation = context.cancellationSignal;
          const heartbeat = setInterval(() => {
            context.heartbeat();
          }, 25);
          const finish = (): void => {
            clearInterval(heartbeat);
            activityCancelled = true;
            activityCancelledAt = Date.now();
            resolve({
              status: 'cancelled',
              commits: [],
              artifacts: [],
              summary: 'cancelled',
            });
          };
          cancellation.addEventListener('abort', finish, { once: true });
          if (cancellation.aborted) finish();
        }),
      commitAndPush: () => Promise.reject(new Error('cancelled run must not commit')),
      emitEvents: ({ events }) => {
        eventTimes.push(
          ...events.map((event) => ({
            type: event.type,
            at: Date.now(),
            payload: event.payload,
          })),
        );
        return Promise.resolve();
      },
      transitionRunStatus: () => Promise.resolve(),
      estimateRunCost: approvalActivityNotExpected,
      requestBudgetIncrease: approvalActivityNotExpected,
      checkpointBudgetStop: ({ workspaceId }) => {
        checkpoints.push(workspaceId);
        checkpointedAt = Date.now();
        return Promise.resolve({ checkpointRef: 'checkpoint-ar10-cancel' });
      },
    };
    const taskQueue = `ar10-cancel-${Date.now().toString(36)}`;
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const input = workflowInput('run_01J00000000000000000000011');
      const handle = await environment.client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: input.workflowId,
        args: [input],
      });
      await vi.waitFor(
        async () => {
          expect((await handle.query(getRunStatusQuery)).phase).toBe('session');
          expect(activityStarted).toBe(true);
        },
        { timeout: 5_000 },
      );
      const requestedAt = Date.now();
      await handle.signal(cancelRunSignal, {
        runId: input.runId,
        operationKey: operationKey('d'),
      });
      await handle.signal(cancelRunSignal, {
        runId: input.runId,
        operationKey: operationKey('e'),
      });
      await expect(handle.result()).resolves.toEqual({
        status: 'cancelled',
        checkpointRef: 'checkpoint-ar10-cancel',
      });
      const acknowledgement = eventTimes.find((entry) => entry.type === 'run.cancelled');
      expect(acknowledgement).toBeDefined();
      expect((acknowledgement?.at ?? Number.POSITIVE_INFINITY) - requestedAt).toBeLessThan(5_000);
      expect(acknowledgement?.payload).toMatchObject({
        reason: 'user_requested',
        control: {
          operationKey: operationKey('d'),
        },
      });
      expect(
        typeof (acknowledgement?.payload['control'] as Record<string, unknown> | undefined)?.[
          'acknowledgementDeadlineAt'
        ],
      ).toBe('string');
    });

    expect(activityCancelled).toBe(true);
    expect(checkpoints).toEqual(['workspace-ar10-cancel']);
    const cancelledEventAt = eventTimes.find((entry) => entry.type === 'run.cancelled')?.at;
    expect(activityCancelledAt).toBeLessThanOrEqual(checkpointedAt);
    expect(checkpointedAt).toBeLessThanOrEqual(cancelledEventAt ?? Number.NEGATIVE_INFINITY);
  }, 30_000);

  it('fails closed before five seconds when a control-boundary activity stalls', async () => {
    const currentTool = deferred<{
      status: 'yielded';
      commits: never[];
      artifacts: never[];
      summary: string;
    }>();
    let activityStarted = false;
    const activities: RunActivities = {
      storeAssistantContent: () => Promise.reject(new Error('assistant overflow not expected')),
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-ar10-deadline' }),
      runBuilderSession: () => {
        activityStarted = true;
        return currentTool.promise;
      },
      commitAndPush: () => Promise.reject(new Error('timed-out pause must not commit')),
      emitEvents: () => Promise.resolve(),
      transitionRunStatus: () => Promise.resolve(),
      estimateRunCost: approvalActivityNotExpected,
      requestBudgetIncrease: approvalActivityNotExpected,
      checkpointBudgetStop: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 6_000));
        return { checkpointRef: 'checkpoint-too-late' };
      },
    };
    const taskQueue = `ar10-deadline-${Date.now().toString(36)}`;
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const input = workflowInput('run_01J00000000000000000000014');
      const handle = await environment.client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: input.workflowId,
        args: [input],
      });
      const result = handle.result();
      void result.catch(() => undefined);
      await vi.waitFor(
        () => {
          expect(activityStarted).toBe(true);
        },
        { timeout: 5_000 },
      );
      await handle.signal(pauseRunSignal, {
        runId: input.runId,
        operationKey: operationKey('2'),
      });
      currentTool.resolve({ status: 'yielded', commits: [], artifacts: [], summary: 'tool done' });
      const outcome = await Promise.race([
        result.then(
          () => 'unexpected-success' as const,
          () => 'failed-before-deadline' as const,
        ),
        new Promise<'late'>((resolve) => {
          setTimeout(() => {
            resolve('late');
          }, 5_000);
        }),
      ]);
      if (outcome === 'late') {
        await handle.signal(cancelRunSignal, {
          runId: input.runId,
          operationKey: operationKey('3'),
        });
        await result.catch(() => undefined);
      }
      expect(outcome).toBe('failed-before-deadline');
    });
  }, 20_000);

  it('queues one idempotent redirect instruction for the next session turn', async () => {
    const firstTurn = deferred<{
      status: 'yielded';
      commits: never[];
      artifacts: never[];
      summary: string;
    }>();
    const prompts: string[] = [];
    const controls: Array<Parameters<RunActivities['runBuilderSession']>[0]['control']> = [];
    const activities: RunActivities = {
      storeAssistantContent: () => Promise.reject(new Error('assistant overflow not expected')),
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-ar10-redirect' }),
      runBuilderSession: ({ prompt, control }) => {
        prompts.push(prompt);
        controls.push(control);
        if (prompts.length === 1) return firstTurn.promise;
        return Promise.resolve({
          status: 'completed',
          commits: [],
          artifacts: [],
          summary: 'redirected turn complete',
          redirectApplied: true,
        });
      },
      commitAndPush: () => Promise.resolve({ commitSha: 'e'.repeat(40), diffstat: [] }),
      emitEvents: () => Promise.resolve(),
      transitionRunStatus: () => Promise.resolve(),
      estimateRunCost: approvalActivityNotExpected,
      requestBudgetIncrease: approvalActivityNotExpected,
      checkpointBudgetStop: approvalActivityNotExpected,
    };
    const taskQueue = `ar10-redirect-${Date.now().toString(36)}`;
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const input = workflowInput('run_01J00000000000000000000012');
      const handle = await environment.client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: input.workflowId,
        args: [input],
      });
      await vi.waitFor(
        () => {
          expect(prompts).toHaveLength(1);
        },
        { timeout: 5_000 },
      );
      const redirect = {
        runId: input.runId,
        instruction: 'Use the existing repository adapter and keep the public API unchanged.',
        operationKey: operationKey('f'),
      };
      await handle.signal(redirectRunSignal, redirect);
      await handle.signal(redirectRunSignal, redirect);
      expect((await handle.query(getRunStatusQuery)).pendingRedirectCount).toBe(1);
      firstTurn.resolve({
        status: 'yielded',
        commits: [],
        artifacts: [],
        summary: 'first turn complete',
      });
      await expect(handle.result()).resolves.toEqual({
        status: 'completed',
        commitSha: 'e'.repeat(40),
      });
    });

    expect(prompts).toEqual([
      'Complete the current builder turn.',
      'Complete the current builder turn.',
    ]);
    expect(controls[0]).toEqual({ yieldAfterTool: true, redirect: null });
    expect(controls[1]).toEqual({
      yieldAfterTool: true,
      redirect: {
        instruction: 'Use the existing repository adapter and keep the public API unchanged.',
        operationKey: operationKey('f'),
      },
    });
  }, 30_000);
});
