import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';

import type { Client } from '@temporalio/client';
import { MockActivityEnvironment } from '@temporalio/testing';
import {
  buildWorkflow,
  runWorkflow,
  SESSION_ACTIVITY_HEARTBEAT_TIMEOUT,
} from '../src/workflows/run.js';
import { describe, expect, it, vi } from 'vitest';

import { loadRunWorkerEnv } from '../src/env.js';
import {
  composeProductionActivities,
  composeRunWorker,
  responseErrorFromResponse,
} from '../src/runtime/run-worker.js';
import { runRunWorkerServer } from '../src/run-server.js';
import {
  createLocalM1TemporalOrchestrator,
  createTemporalOrchestrator,
  TASK_QUEUES,
} from '../src/worker.js';

function localDatabaseUrl(): string {
  const url = new URL('postgres://127.0.0.1:5432/zapp');
  url.username = 'zapp';
  url.password = 'zapp';
  return url.toString();
}

const VALID_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL: localDatabaseUrl(),
  TEMPORAL_ADDRESS: '127.0.0.1:7233',
  TEMPORAL_NAMESPACE: 'default',
  CONTROL_API_INTERNAL_URL: 'http://127.0.0.1:4000',
  MODEL_GATEWAY_URL: 'http://127.0.0.1:4100',
  SANDBOX_SERVICE_URL: 'http://127.0.0.1:4400',
  SANDBOX_PROVIDER: 'docker',
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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  return body;
}

describe('the local M1 routing profile', () => {
  it('gives long-running Builder tools enough heartbeat headroom', () => {
    expect(SESSION_ACTIVITY_HEARTBEAT_TIMEOUT).toBe('30 seconds');
  });

  it('publishes session events through the production event boundary', async () => {
    const published: unknown[] = [];
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === `${VALID_ENV.MODEL_GATEWAY_URL}/internal/v1/complete`) {
        const request = JSON.parse(requestBodyText(init?.body)) as { completionId: string };
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const event of [
                  { type: 'text-delta', text: 'The build is ready.' },
                  {
                    type: 'usage',
                    provider: 'anthropic',
                    model: 'claude-test',
                    finishReason: 'stop',
                    inputTokens: 20,
                    outputTokens: 5,
                    totalTokens: 25,
                  },
                  {
                    type: 'usage.recorded',
                    completionId: request.completionId,
                    usage: [
                      {
                        provider: 'anthropic',
                        model: 'claude-test',
                        inputTokens: 20,
                        outputTokens: 5,
                        cacheReadInputTokens: 0,
                        cacheWriteInputTokens: 0,
                        occurredAt: '2026-08-14T12:00:00.000Z',
                      },
                    ],
                    credits: {
                      used: '0.0100',
                      reserved: '0.0000',
                      ceiling: '100.0000',
                      version: 1,
                    },
                  },
                  { type: 'done' },
                ]) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                }
                controller.close();
              },
            }),
            {
              status: 200,
              headers: { 'content-type': 'text/event-stream; charset=utf-8' },
            },
          ),
        );
      }
      if (url.includes('/internal/runs/') && url.endsWith('/events')) {
        published.push(JSON.parse(requestBodyText(init?.body)) as unknown);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      throw new Error(`Unexpected production activity request: ${url}`);
    });
    const activities = await composeProductionActivities({
      env: loadRunWorkerEnv(VALID_ENV),
      database: {} as never,
      fetchImpl,
    });
    const client = {
      withAbortSignal: <T>(_signal: AbortSignal, operation: () => T): T => operation(),
      activity: {
        heartbeat: () => Promise.resolve(),
        reportCancellation: () => Promise.resolve(),
      },
    } as unknown as Client;
    const environment = new MockActivityEnvironment(undefined, { client });

    const result = await environment.run(
      (input) => activities.runBuilderSession(input),
      {
        runId: RUN_INPUT.runId,
        organizationId: RUN_INPUT.organizationId,
        projectId: RUN_INPUT.projectId,
        workspaceId: `ws_${'2'.repeat(26)}`,
        mode: 'build' as const,
        model: null,
        prompt: 'Confirm the build is ready.',
        allowedTools: [],
        modeInstructions: 'Return a concise build result.',
        budget: { maxCredits: 100 },
        idempotencyKey: 'publish-production-session-events',
      },
    );

    expect(result).toMatchObject({ status: 'completed', summary: 'The build is ready.' });
    expect(published.length).toBeGreaterThan(0);
  });

  it('reuses the ready workspace for the same tenant project branch', async () => {
    const workspaceId = `ws_${'1'.repeat(26)}`;
    const runSelection = {
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() =>
              Promise.resolve([
                { name: 'main', startedAt: new Date('2026-08-14T12:00:00.000Z') },
              ]),
            ),
          })),
        })),
      })),
    };
    const workspaceSelection = {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([{ id: workspaceId }])),
          })),
        })),
      })),
    };
    const select = vi
      .fn()
      .mockReturnValueOnce(runSelection)
      .mockReturnValueOnce(workspaceSelection);
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            workspace: { id: workspaceId, status: 'ready' },
            providerStatus: 'ready',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const activities = await composeProductionActivities({
      env: loadRunWorkerEnv(VALID_ENV),
      database: { select } as never,
      fetchImpl,
    });

    await expect(
      activities.ensureWorkspace({
        runId: RUN_INPUT.runId,
        organizationId: RUN_INPUT.organizationId,
        projectId: RUN_INPUT.projectId,
        branchId: RUN_INPUT.branchId,
        appType: RUN_INPUT.appType,
        idempotencyKey: 'reuse-ready-workspace',
      }),
    ).resolves.toEqual({ workspaceId });

    expect(select).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `${VALID_ENV.SANDBOX_SERVICE_URL}/internal/workspaces/${workspaceId}`,
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('completes a no-op builder run by retaining the existing workspace commit', async () => {
    const commitSha = 'a'.repeat(40);
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          readonly operation?: string;
          readonly command?: string;
          readonly args?: readonly string[];
        };
        let result: Record<string, unknown> | undefined;
        if (request.url?.endsWith('/git') === true && body.operation === 'diff') {
          result = { exitCode: 0, stdout: '', stderr: '' };
        } else if (
          request.url?.endsWith('/exec') === true &&
          body.command === 'git' &&
          JSON.stringify(body.args) ===
            JSON.stringify(['ls-files', '--others', '--exclude-standard'])
        ) {
          result = {
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1,
            truncated: false,
          };
        } else if (
          request.url?.endsWith('/exec') === true &&
          body.command === 'git' &&
          JSON.stringify(body.args) === JSON.stringify(['rev-parse', 'HEAD'])
        ) {
          result = {
            exitCode: 0,
            stdout: `${commitSha}\n`,
            stderr: '',
            durationMs: 1,
            truncated: false,
          };
        }
        response.statusCode = result === undefined ? 500 : 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result ?? { code: 'unexpected_no_op_commit_request' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Test server did not bind');
    const activities = await composeProductionActivities({
      env: loadRunWorkerEnv({
        ...VALID_ENV,
        SANDBOX_SERVICE_URL: `http://127.0.0.1:${String(address.port)}`,
      }),
      database: {} as never,
    });

    try {
      await expect(
        activities.commitAndPush({
          runId: RUN_INPUT.runId,
          organizationId: RUN_INPUT.organizationId,
          projectId: RUN_INPUT.projectId,
          workspaceId: `ws_${'4'.repeat(26)}`,
          message: 'Verify existing project',
          idempotencyKey: 'no-op-builder-run',
        }),
      ).resolves.toEqual({ commitSha, diffstat: [] });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });

  it('retires an unhealthy reusable workspace before provisioning its replacement', async () => {
    const staleWorkspaceId = `ws_${'1'.repeat(26)}`;
    const replacementWorkspaceId = `ws_${'3'.repeat(26)}`;
    const runSelection = {
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() =>
              Promise.resolve([
                { name: 'main', startedAt: new Date('2026-08-14T12:00:00.000Z') },
              ]),
            ),
          })),
        })),
      })),
    };
    const workspaceSelection = {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([{ id: staleWorkspaceId }])),
          })),
        })),
      })),
    };
    const select = vi
      .fn()
      .mockReturnValueOnce(runSelection)
      .mockReturnValueOnce(workspaceSelection);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspace: { id: staleWorkspaceId, status: 'ready' },
            providerStatus: 'started',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workspace: { id: staleWorkspaceId } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workspace: { id: replacementWorkspaceId } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const activities = await composeProductionActivities({
      env: loadRunWorkerEnv(VALID_ENV),
      database: { select } as never,
      fetchImpl,
    });

    await expect(
      activities.ensureWorkspace({
        runId: RUN_INPUT.runId,
        organizationId: RUN_INPUT.organizationId,
        projectId: RUN_INPUT.projectId,
        branchId: RUN_INPUT.branchId,
        appType: RUN_INPUT.appType,
        idempotencyKey: 'replace-unhealthy-workspace',
      }),
    ).resolves.toEqual({ workspaceId: replacementWorkspaceId });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      `${VALID_ENV.SANDBOX_SERVICE_URL}/internal/workspaces/${staleWorkspaceId}/terminate`,
    );
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      `${VALID_ENV.SANDBOX_SERVICE_URL}/internal/workspaces`,
    );
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ method: 'POST' });
    const replacementInit = fetchImpl.mock.calls[2]?.[1] as RequestInit | undefined;
    const replacementRequest = JSON.parse(requestBodyText(replacementInit?.body)) as {
      workspace: { provider: string };
    };
    expect(replacementRequest.workspace.provider).toBe('docker');
  });

  it('propagates only classified sandbox bootstrap diagnostics', async () => {
    const secret = 'repository-token-that-must-not-cross-the-boundary';
    const failure = await responseErrorFromResponse(
      'Sandbox workspace provisioning',
      new Response(
        JSON.stringify({
          code: 'workspace_git_bootstrap_failed',
          message: 'The sandbox operation failed.',
          details: {
            stage: 'clone',
            exitCode: 128,
            reason: 'dns_resolution_failed',
          },
          secret,
        }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      ),
    );

    expect(failure.message).toContain(
      'workspace_git_bootstrap_failed: clone/dns_resolution_failed/128',
    );
    expect(failure.message).not.toContain(secret);
  });

  it('requires every worker boundary and accepts only explicit development m1', () => {
    expect(loadRunWorkerEnv(VALID_ENV)).toMatchObject({
      nodeEnv: 'development',
      sandboxProvider: 'docker',
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
    expect(() => loadRunWorkerEnv({ ...VALID_ENV, SANDBOX_PROVIDER: undefined })).toThrow(
      /SANDBOX_PROVIDER/,
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
  it('composes an explicit disabled feature-flag activity for the local M1 worker', async () => {
    const connection = { close: vi.fn(() => Promise.resolve()) };
    const database = {
      db: {} as never,
      sql: {} as never,
      close: vi.fn(() => Promise.resolve()),
    };
    const worker = {
      run: vi.fn(() => Promise.resolve()),
      getState: vi.fn(() => 'STOPPED'),
      shutdown: vi.fn(),
    };
    const createWorker = vi.fn(async (input: { activities: Record<string, unknown> }) => {
      expect(typeof input.activities['evaluateFeatureFlag']).toBe('function');
      const evaluate = input.activities['evaluateFeatureFlag'] as (
        value: unknown,
      ) => Promise<unknown>;
      await expect(
        evaluate({
          organizationId: `org_${'0'.repeat(26)}`,
          distinctId: 'local-m1-worker',
          flag: 'autonomous-mode',
        }),
      ).resolves.toEqual({ enabled: false });
      return worker;
    });

    const runtime = await composeRunWorker(loadRunWorkerEnv(VALID_ENV), {
      createDatabase: vi.fn(() => database),
      connectTemporal: vi.fn(() => Promise.resolve(connection as never)),
      createWorker: createWorker as never,
    });

    await runtime.shutdown();
    expect(createWorker).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });

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
