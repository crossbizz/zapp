import { EventEmitter } from 'node:events';

import { buildWorkflow, runWorkflow } from '../src/workflows/run.js';
import { describe, expect, it, vi } from 'vitest';

import { loadRunWorkerEnv } from '../src/env.js';
import { composeRunWorker } from '../src/runtime/run-worker.js';
import { runRunWorkerServer } from '../src/run-server.js';
import {
  createLocalM1TemporalOrchestrator,
  createTemporalOrchestrator,
  TASK_QUEUES,
} from '../src/worker.js';

const VALID_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://zapp:zapp@127.0.0.1:5432/zapp',
  TEMPORAL_ADDRESS: '127.0.0.1:7233',
  TEMPORAL_NAMESPACE: 'default',
  CONTROL_API_INTERNAL_URL: 'http://127.0.0.1:4000',
  MODEL_GATEWAY_URL: 'http://127.0.0.1:4100',
  SANDBOX_SERVICE_URL: 'http://127.0.0.1:4400',
  GIT_SERVICE_URL: 'http://127.0.0.1:4500',
  SERVICE_TOKEN_SECRET: 's'.repeat(64),
  SERVICE_TOKEN_ISSUER: 'zapp-control-plane',
  RUN_WORKFLOW_PROFILE: 'm1',
} as const;

const RUN_INPUT = {
  runId: `run_${'0'.repeat(26)}`,
  workflowId: 'run:test',
  organizationId: `org_${'0'.repeat(26)}`,
  projectId: `proj_${'0'.repeat(26)}`,
  branchId: `br_${'0'.repeat(26)}`,
  mode: 'build',
  appType: 'web',
  model: null,
  prompt: 'RUN_WORKFLOW_PROFILE=m1 must not be an implicit routing switch',
  budget: null,
  planMaxCredits: 100,
  operationKey: `op_${'a'.repeat(64)}`,
} as const;

describe('the local M1 routing profile', () => {
  it('requires every worker boundary and accepts only explicit development m1', () => {
    expect(loadRunWorkerEnv(VALID_ENV)).toMatchObject({
      nodeEnv: 'development',
      workflowProfile: 'm1',
      temporalNamespace: 'default',
    });
    expect(() => loadRunWorkerEnv({ ...VALID_ENV, NODE_ENV: 'production' })).toThrow(
      /RUN_WORKFLOW_PROFILE/,
    );
    expect(() => loadRunWorkerEnv({ ...VALID_ENV, NODE_ENV: 'test' })).toThrow(
      /RUN_WORKFLOW_PROFILE/,
    );
    expect(() => loadRunWorkerEnv({ ...VALID_ENV, RUN_WORKFLOW_PROFILE: undefined })).toThrow(
      /RUN_WORKFLOW_PROFILE/,
    );
  });

  it('uses the single-Builder workflow only under the explicit local profile', async () => {
    const start = vi.fn().mockResolvedValue({});
    const previousNodeEnv = process.env['NODE_ENV'];
    const previousProfile = process.env['RUN_WORKFLOW_PROFILE'];
    process.env['NODE_ENV'] = 'development';
    process.env['RUN_WORKFLOW_PROFILE'] = 'm1';
    try {
      await createLocalM1TemporalOrchestrator({
        client: { workflow: { start } } as never,
      }).startRun(RUN_INPUT);
    } finally {
      if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previousNodeEnv;
      if (previousProfile === undefined) delete process.env['RUN_WORKFLOW_PROFILE'];
      else process.env['RUN_WORKFLOW_PROFILE'] = previousProfile;
    }

    expect(start.mock.calls[0]?.[0]).toBe(runWorkflow);
    expect(start.mock.calls[0]?.[1]).toMatchObject({ taskQueue: TASK_QUEUES.agentRuns });
  });

  it('keeps default routing on the dedicated Build workflow even when prompt text names m1', async () => {
    const start = vi.fn().mockResolvedValue({});
    const orchestrator = createTemporalOrchestrator({
      client: { workflow: { start } } as never,
    });

    await orchestrator.startRun(RUN_INPUT);

    expect(start.mock.calls[0]?.[0]).toBe(buildWorkflow);
  });

  it.each(['production', 'test'] as const)('refuses local routing in %s', (nodeEnv) => {
    const previousNodeEnv = process.env['NODE_ENV'];
    const previousProfile = process.env['RUN_WORKFLOW_PROFILE'];
    process.env['NODE_ENV'] = nodeEnv;
    process.env['RUN_WORKFLOW_PROFILE'] = 'm1';
    try {
      expect(() =>
        createLocalM1TemporalOrchestrator({ client: { workflow: {} } as never }),
      ).toThrow(/development/);
    } finally {
      if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previousNodeEnv;
      if (previousProfile === undefined) delete process.env['RUN_WORKFLOW_PROFILE'];
      else process.env['RUN_WORKFLOW_PROFILE'] = previousProfile;
    }
  });
});

describe('the deployable agent-runs worker lifecycle', () => {
  it('composes the production queue and reports ready only after pollers are running', async () => {
    const order: string[] = [];
    let resolveRun = (): void => undefined;
    const running = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    let state = 'INITIALIZED';
    const worker = {
      run: vi.fn(() => {
        order.push('pollers');
        state = 'RUNNING';
        return running;
      }),
      getState: vi.fn(() => state),
      shutdown: vi.fn(() => {
        order.push('shutdown');
        state = 'STOPPED';
        resolveRun();
      }),
    };
    const connection = {
      close: vi.fn(() => {
        order.push('connection.close');
        return Promise.resolve();
      }),
    };
    const database = {
      db: {} as never,
      sql: {} as never,
      close: vi.fn(() => {
        order.push('database.close');
        return Promise.resolve();
      }),
    };
    const activities = { runBuilderSession: vi.fn() } as never;
    const createActivities = vi.fn(() => activities);
    const createWorker = vi.fn((input: unknown) => {
      order.push('worker.compose');
      expect(input).toMatchObject({
        taskQueue: TASK_QUEUES.agentRuns,
        namespace: 'default',
        database: database.db,
        activities,
      });
      return Promise.resolve(worker);
    });
    const runtime = await composeRunWorker(loadRunWorkerEnv(VALID_ENV), {
      createDatabase: vi.fn(() => database),
      connectTemporal: vi.fn(() => Promise.resolve(connection as never)),
      composeActivities: createActivities,
      createWorker: createWorker as never,
    });

    const runPromise = runtime.run(() => {
      order.push('ready');
    });
    await vi.waitFor(() => {
      expect(order).toContain('ready');
    });
    expect(order.indexOf('pollers')).toBeLessThan(order.indexOf('ready'));
    expect(createActivities).toHaveBeenCalledOnce();

    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    await runPromise;
    expect(worker.shutdown).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
    expect(order.indexOf('shutdown')).toBeLessThan(order.indexOf('connection.close'));
    expect(order.indexOf('connection.close')).toBeLessThan(order.indexOf('database.close'));
  });

  it('drains once when repeated termination signals arrive', async () => {
    const signals = new EventEmitter();
    let resolveRun = (): void => undefined;
    const running = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const shutdown = vi.fn(() => {
      resolveRun();
      return Promise.resolve();
    });
    const ready = vi.fn();
    const server = runRunWorkerServer({
      env: loadRunWorkerEnv(VALID_ENV),
      signals,
      writeReady: ready,
      compose: () =>
        Promise.resolve({
          run(onReady) {
            void onReady?.();
            return running;
          },
          shutdown,
        }),
    });
    await vi.waitFor(() => {
      expect(ready).toHaveBeenCalledOnce();
    });

    signals.emit('SIGTERM');
    signals.emit('SIGTERM');
    await server;

    expect(shutdown).toHaveBeenCalledOnce();
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});
