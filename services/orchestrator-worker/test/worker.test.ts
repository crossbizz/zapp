import { ApplicationFailure } from '@temporalio/activity';
import { Worker } from '@temporalio/worker';
import { describe, expect, it, vi } from 'vitest';

import type { ActivityIdempotencyStore } from '../src/activities/idempotency.js';
import {
  createBusinessFailure,
  createProductionRunWorker,
  createRunWorker,
  createTemporalOrchestrator,
  TASK_QUEUES,
  TaskQueueSchema,
  type ProductionRunActivities,
  type RunActivities,
} from '../src/worker.js';
import { ACTIVITY_RETRY_POLICY, RunWorkflowInputSchema } from '../src/workflows/run.js';

const unusedStore: ActivityIdempotencyStore = {
  claim: () => Promise.resolve({ status: 'acquired' }),
  renew: () => Promise.resolve(true),
  complete: () => Promise.resolve(true),
  release: () => Promise.resolve(),
};

describe('AR-9 worker queue and activity policy', () => {
  it('publishes exactly the three production Temporal task queues', () => {
    expect(TASK_QUEUES).toEqual({
      agentRuns: 'agent-runs',
      verification: 'verification',
      releases: 'releases',
    });
    expect(TaskQueueSchema.options).toEqual(['agent-runs', 'verification', 'releases']);
    expect(() => TaskQueueSchema.parse('agent_run')).toThrow();
  });

  it('wires the durable inbound interceptor into a production run worker', async () => {
    const created = { run: vi.fn() };
    const create = vi.spyOn(Worker, 'create').mockResolvedValueOnce(created as never);

    await expect(
      createRunWorker({
        connection: {} as never,
        taskQueue: TASK_QUEUES.agentRuns,
        activities: {} as RunActivities,
        idempotencyStore: unusedStore,
      }),
    ).resolves.toBe(created);

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      taskQueue: 'agent-runs',
      interceptors: { activity: [expect.any(Function)] },
    });
    create.mockRestore();
  });

  it('requires an explicit test-only bypass when no durable store is supplied', async () => {
    const create = vi.spyOn(Worker, 'create').mockResolvedValueOnce({} as never);

    await createRunWorker({
      connection: {} as never,
      taskQueue: 'ar9-isolated-test-queue',
      activities: {} as RunActivities,
      testOnlyBypassActivityIdempotency: true,
    });

    expect(create.mock.calls[0]?.[0].interceptors).toBeUndefined();
    create.mockRestore();
  });

  it('never permits the test-only bypass on a production queue', () => {
    const create = vi.spyOn(Worker, 'create').mockResolvedValueOnce({} as never);

    expect(() =>
      createRunWorker({
        connection: {} as never,
        taskQueue: TASK_QUEUES.agentRuns,
        activities: {} as RunActivities,
        testOnlyBypassActivityIdempotency: true,
      }),
    ).toThrow('production Temporal queue');
    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });

  it('composes the concrete Postgres repository into a production worker', async () => {
    const created = { run: vi.fn() };
    const create = vi.spyOn(Worker, 'create').mockResolvedValueOnce(created as never);

    await expect(
      createProductionRunWorker({
        connection: {} as never,
        taskQueue: TASK_QUEUES.agentRuns,
        activities: {} as ProductionRunActivities,
        database: {} as never,
      }),
    ).resolves.toBe(created);
    expect(create.mock.calls[0]?.[0].interceptors?.activity).toHaveLength(1);
    create.mockRestore();
  });

  it('creates typed non-retryable business failures', () => {
    const failure = createBusinessFailure('branch_locked', 'The branch already has a writer');
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({ type: 'branch_locked', nonRetryable: true });
  });

  it('caps transient delivery at three attempts and lists durable business failures', () => {
    expect(ACTIVITY_RETRY_POLICY.maximumAttempts).toBe(3);
    expect(ACTIVITY_RETRY_POLICY.nonRetryableErrorTypes).toEqual([
      'activity_idempotency_conflict',
      'activity_idempotency_key_required',
      'activity_idempotency_corrupt',
    ]);
  });

  it('does not let a workflow starter inject internal continue-as-new state', () => {
    expect(
      RunWorkflowInputSchema.safeParse({
        runId: `run_${'0'.repeat(26)}`,
        workflowId: 'run:test',
        organizationId: `org_${'0'.repeat(26)}`,
        projectId: `proj_${'0'.repeat(26)}`,
        branchId: null,
        mode: 'build',
        appType: 'web',
        model: null,
        prompt: 'Build the app',
        budget: null,
        operationKey: `op_${'a'.repeat(64)}`,
        continuation: { phase: 'commit', workspaceId: 'foreign-workspace' },
      }).success,
    ).toBe(false);
  });

  it('always starts production run workflows on agent-runs', async () => {
    const start = vi
      .fn<(workflow: unknown, options: unknown) => Promise<never>>()
      .mockResolvedValue({} as never);
    const orchestrator = createTemporalOrchestrator({
      client: { workflow: { start } } as never,
    });
    const input = {
      runId: `run_${'0'.repeat(26)}`,
      workflowId: 'run:test',
      organizationId: `org_${'0'.repeat(26)}`,
      projectId: `proj_${'0'.repeat(26)}`,
      branchId: null,
      mode: 'build',
      appType: 'web',
      model: null,
      prompt: 'Build the app',
      budget: null,
      operationKey: `op_${'a'.repeat(64)}`,
    };

    await orchestrator.startRun(input);

    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[1]).toMatchObject({ taskQueue: TASK_QUEUES.agentRuns });
  });
});
