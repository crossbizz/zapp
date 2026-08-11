import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { newId } from '@zapp/contracts';
import { CompleteAsyncError } from '@temporalio/activity';
import { ActivityCancelledError, ActivityNotFoundError, type Client } from '@temporalio/client';
import { MockActivityEnvironment, TestWorkflowEnvironment } from '@temporalio/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { EventBatchClient } from '../../src/activities/events.js';
import {
  createSessionActivities,
  type RunBuilderSessionInput,
} from '../../src/activities/session.js';
import { createTestTemporalOrchestrator } from '../../src/worker.js';
import { runWorkflow } from '../../src/workflows/run.js';

interface DurableFixtureState {
  readonly statuses: string[];
  readonly events: Array<{
    readonly sequence: number;
    readonly type: string;
    readonly runId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly payload: Record<string, unknown>;
  }>;
  readonly eventBatches: Record<string, true>;
  readonly commits: Record<string, string>;
  commitAttempts: number;
  commitResponseLost: boolean;
  transcriptCheckpoint: {
    readonly completionId: string;
    readonly requestFingerprint: string;
    readonly maxOutputTokens: number;
    readonly reservedTokens: number;
  } | null;
}

function waitForLine(child: ChildProcess, expected: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8');
      if (stdout.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(
        new Error(
          `Worker exited before ${expected}: code=${String(code)} signal=${String(signal)} ${stderr}`,
        ),
      );
    };
    const cleanup = (): void => {
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function workerProgram(): string {
  const dist = join(process.cwd(), 'dist');
  const urls = {
    worker: pathToFileURL(join(dist, 'worker.js')).href,
    events: pathToFileURL(join(dist, 'activities/events.js')).href,
    session: pathToFileURL(join(dist, 'activities/session.js')).href,
    workspace: pathToFileURL(join(dist, 'activities/workspace.js')).href,
  };
  return `
    import { readFile, writeFile } from 'node:fs/promises';
    import { NativeConnection } from '@temporalio/worker';
    import { createRunWorker } from ${JSON.stringify(urls.worker)};
    import { createEventActivities, EventBatchClient } from ${JSON.stringify(urls.events)};
    import { createSessionActivities } from ${JSON.stringify(urls.session)};
    import { createWorkspaceActivities } from ${JSON.stringify(urls.workspace)};

    const statePath = process.env.AR8_STATE_PATH;
    const runId = process.env.AR8_RUN_ID;
    const organizationId = process.env.AR8_ORGANIZATION_ID;
    const projectId = process.env.AR8_PROJECT_ID;
    const taskQueue = process.env.AR8_TASK_QUEUE;
    const address = process.env.AR8_TEMPORAL_ADDRESS;
    if (!statePath || !runId || !organizationId || !projectId || !taskQueue || !address) {
      throw new Error('Missing AR-8 child worker configuration');
    }
    const load = async () => JSON.parse(await readFile(statePath, 'utf8'));
    const save = async (state) => writeFile(statePath, JSON.stringify(state));
    const update = async (mutate) => {
      const state = await load();
      const result = mutate(state);
      await save(state);
      return result;
    };

    const eventClient = new EventBatchClient({
      flushIntervalMs: 5,
      publish: async (batch) => update((state) => {
        if (state.eventBatches[batch.idempotencyKey]) return;
        state.eventBatches[batch.idempotencyKey] = true;
        for (const event of batch.events) {
          state.events.push({
            sequence: state.events.length,
            type: event.type,
            runId: event.runId,
            organizationId: event.organizationId,
            projectId: event.projectId,
            payload: event.payload,
          });
        }
      }),
    });
    const eventActivities = createEventActivities({
      client: eventClient,
      assistantContent: {
        store: ({ artifactId, contentHash }) => Promise.resolve({ artifactId, contentHash }),
      },
      transitionStatus: async ({ status, idempotencyKey }) => update((state) => {
        const marker = 'status:' + idempotencyKey;
        if (state.eventBatches[marker]) return;
        state.eventBatches[marker] = true;
        state.statuses.push(status);
      }),
    });
    const workspaceActivities = createWorkspaceActivities({
      ensureWorkspace: async ({ idempotencyKey }) => ({ workspaceId: 'workspace:' + idempotencyKey }),
      commitAndPush: async ({ idempotencyKey }) => {
        let loseResponse = false;
        const commitSha = await update((state) => {
          state.commitAttempts += 1;
          const existing = state.commits[idempotencyKey];
          if (existing) return existing;
          const created = '0123456789abcdef0123456789abcdef01234567';
          state.commits[idempotencyKey] = created;
          if (!state.commitResponseLost) {
            state.commitResponseLost = true;
            loseResponse = true;
          }
          return created;
        });
        if (loseResponse) throw new Error('simulated response loss after durable commit');
        return {
          commitSha,
          diffstat: [{ path: 'src/app.ts', additions: 12, deletions: 3 }],
        };
      },
    });
    const sessionActivities = createSessionActivities(
      {
        run: async (_input, context) => {
          const key = { runId, taskId: 'm1-builder' };
          const durableTranscript = await context.transcripts.load(key);
          if (durableTranscript === undefined) {
            const completionId = 'cmp_' + 'c'.repeat(64);
            const requestFingerprint = 'd'.repeat(64);
            await context.transcripts.save(null, {
              key,
              role: 'builder',
              mode: 'build',
              tools: [],
              budgets: { maxTurns: 4, maxTokens: 1000, maxWallClockMs: 30000 },
              startedAtMs: Date.now(),
              provenance: [],
              messages: [{ role: 'user', content: 'Durable provider request.' }],
              turns: 0,
              tokensUsed: 12,
              inFlightCompletion: {
                completionId,
                requestFingerprint,
                requestTokens: 4,
                reservedTokens: 12,
                request: {
                  completionId,
                  organizationId,
                  projectId,
                  runId,
                  taskId: 'm1-builder',
                  agentRole: 'builder',
                  messages: [{ role: 'user', content: 'Durable provider request.' }],
                  cacheBreakpointMessageIndexes: [],
                  maxInputTokens: 4,
                  tools: [],
                  maxOutputTokens: 8,
                },
              },
              completedToolCallIds: [],
              pendingToolCalls: [],
              activeToolCallId: null,
              executionLease: null,
              nextFence: 1,
              eventOutbox: [],
              commits: [],
              artifacts: [],
              summary: '',
              terminalStatus: null,
              terminalErrorCode: null,
            });
            console.log('AR8_SESSION_CHECKPOINTED');
            await new Promise(() => undefined);
          }
          await update((state) => {
            state.transcriptCheckpoint = {
              completionId: durableTranscript.inFlightCompletion.completionId,
              requestFingerprint: durableTranscript.inFlightCompletion.requestFingerprint,
              maxOutputTokens: durableTranscript.inFlightCompletion.request.maxOutputTokens,
              reservedTokens: durableTranscript.inFlightCompletion.reservedTokens,
            };
          });
          await eventClient.emit({
            eventKey: runId + ':task-m1:call-1:completed',
            runId,
            organizationId,
            projectId,
            occurredAt: '2026-08-07T12:00:00.000Z',
            type: 'tool.completed',
            visibility: 'user',
            payload: {
              toolCallId: 'call-1',
              tool: 'write_file',
              userSummary: 'Edited a file',
            },
          });
          return {
            status: 'completed',
            commits: [],
            artifacts: [],
            summary: 'Builder resumed from its durable transcript.',
          };
        },
      },
      { heartbeatIntervalMs: 1 },
    );
    const connection = await NativeConnection.connect({ address });
    const worker = await createRunWorker({
      connection,
      taskQueue,
      activities: { ...eventActivities, ...workspaceActivities, ...sessionActivities },
      testOnlyBypassActivityIdempotency: true,
    });
    const running = worker.run();
    console.log('AR8_WORKER_READY');
    await running;
  `;
}

function startWorkerProcess(input: {
  readonly address: string;
  readonly taskQueue: string;
  readonly statePath: string;
  readonly runId: string;
  readonly organizationId: string;
  readonly projectId: string;
}): ChildProcess {
  return spawn(process.execPath, ['--input-type=module', '--eval', workerProgram()], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AR8_TEMPORAL_ADDRESS: input.address,
      AR8_TASK_QUEUE: input.taskQueue,
      AR8_STATE_PATH: input.statePath,
      AR8_RUN_ID: input.runId,
      AR8_ORGANIZATION_ID: input.organizationId,
      AR8_PROJECT_ID: input.projectId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('AR-8 M1 durable Temporal run', () => {
  let environment: TestWorkflowEnvironment | undefined;
  let fixtureDirectory: string | undefined;
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await environment?.teardown();
    if (fixtureDirectory !== undefined) await rm(fixtureDirectory, { recursive: true });
    children.length = 0;
    environment = undefined;
    fixtureDirectory = undefined;
  });

  it('latches cancellation before releasing an already-queued durable heartbeat', async () => {
    const cancellationTokens: Uint8Array[] = [];
    let heartbeatCalls = 0;
    let rejectFirstHeartbeat: ((error: Error) => void) | undefined;
    let resolveFirstHeartbeatStarted: (() => void) | undefined;
    const firstHeartbeatStarted = new Promise<void>((resolve) => {
      resolveFirstHeartbeatStarted = resolve;
    });
    const firstHeartbeat = new Promise<void>((_resolve, reject) => {
      rejectFirstHeartbeat = reject;
    });
    const client = {
      withAbortSignal: <T>(_signal: AbortSignal, operation: () => T): T => operation(),
      activity: {
        heartbeat: () => {
          heartbeatCalls += 1;
          if (heartbeatCalls === 1) {
            resolveFirstHeartbeatStarted?.();
            return firstHeartbeat;
          }
          return Promise.reject(new ActivityNotFoundError('activity already cancelled'));
        },
        reportCancellation: (taskToken: Uint8Array) => {
          cancellationTokens.push(taskToken);
          return Promise.resolve();
        },
      },
    } as unknown as Client;
    const activityEnvironment = new MockActivityEnvironment(undefined, { client });
    let runnerObservedCancellation = false;
    const activities = createSessionActivities(
      {
        run: async (_input, context) => {
          if (!context.signal.aborted) {
            await new Promise<void>((resolve) => {
              context.signal.addEventListener(
                'abort',
                () => {
                  resolve();
                },
                { once: true },
              );
            });
          }
          runnerObservedCancellation = true;
          return { status: 'cancelled', commits: [], artifacts: [], summary: 'cancelled' };
        },
      },
      { heartbeatIntervalMs: 1 },
    );

    const activityInput: RunBuilderSessionInput = {
      runId: newId('run'),
      organizationId: newId('org'),
      projectId: newId('proj'),
      workspaceId: 'workspace-cancel',
      mode: 'build',
      model: null,
      prompt: 'Cancel the durable activity.',
      allowedTools: [],
      modeInstructions: 'Complete the verified Build task.',
      budget: null,
      idempotencyKey: 'cancel-durable-activity',
    };
    const running = activityEnvironment.run(
      (activityInputValue: RunBuilderSessionInput) =>
        activities.runBuilderSession(activityInputValue),
      activityInput,
    );
    await firstHeartbeatStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    rejectFirstHeartbeat?.(new ActivityCancelledError('cancelled'));

    await expect(running).rejects.toBeInstanceOf(CompleteAsyncError);
    expect(runnerObservedCancellation).toBe(true);
    expect(heartbeatCalls).toBe(1);
    expect(cancellationTokens).toEqual([Buffer.from('test')]);
  });

  it(
    'resumes a CP-9 run after worker process loss without duplicating its commit or ordered events',
    async () => {
      environment = await TestWorkflowEnvironment.createLocal();
      fixtureDirectory = await mkdtemp(join(tmpdir(), 'zapp-ar8-'));
      const statePath = join(fixtureDirectory, 'durable-state.json');
      const runId = newId('run');
      const organizationId = newId('org');
      const projectId = newId('proj');
      const taskQueue = `ar8-${runId}`;
      const initialState: DurableFixtureState = {
        statuses: ['queued'],
        events: [],
        eventBatches: {},
        commits: {},
        commitAttempts: 0,
        commitResponseLost: false,
        transcriptCheckpoint: null,
      };
      await writeFile(statePath, JSON.stringify(initialState));
      const childInput = {
        address: environment.address,
        taskQueue,
        statePath,
        runId,
        organizationId,
        projectId,
      };

      const firstWorker = startWorkerProcess(childInput);
      children.push(firstWorker);
      await waitForLine(firstWorker, 'AR8_WORKER_READY');
      const orchestrator = createTestTemporalOrchestrator({
        client: environment.client,
        taskQueue,
      });
      await orchestrator.startRun({
        runId,
        workflowId: runId,
        organizationId,
        projectId,
        branchId: null,
        mode: 'build',
        appType: 'web',
        model: null,
        prompt: 'Create a durable app.',
        budget: null,
        planMaxCredits: 1000,
        operationKey: `op_${'a'.repeat(64)}`,
      });
      const handle = environment.client.workflow.getHandle<typeof runWorkflow>(runId);

      await waitForLine(firstWorker, 'AR8_SESSION_CHECKPOINTED');
      firstWorker.kill('SIGKILL');
      await new Promise<void>((resolve) =>
        firstWorker.once('exit', () => {
          resolve();
        }),
      );

      const secondWorker = startWorkerProcess(childInput);
      children.push(secondWorker);
      await waitForLine(secondWorker, 'AR8_WORKER_READY');
      const result = await handle.result();
      const state = JSON.parse(await readFile(statePath, 'utf8')) as DurableFixtureState;

      expect(result).toEqual({
        status: 'completed',
        commitSha: '0123456789abcdef0123456789abcdef01234567',
      });
      expect(state.transcriptCheckpoint).toEqual({
        completionId: `cmp_${'c'.repeat(64)}`,
        requestFingerprint: 'd'.repeat(64),
        maxOutputTokens: 8,
        reservedTokens: 12,
      });
      expect(Object.keys(state.commits)).toHaveLength(1);
      expect(state.commitAttempts).toBe(2);
      expect(state.statuses).toEqual(['queued', 'running', 'completed']);
      expect(state.events.map((event) => event.type)).toEqual([
        'run.started',
        'phase.created',
        'phase.started',
        'message.user',
        'agent.started',
        'tool.completed',
        'message.assistant',
        'phase.completed',
        'commit.created',
        'run.completed',
      ]);
      expect(state.events.map((event) => event.sequence)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
      expect(state.events.find((event) => event.type === 'message.assistant')?.payload).toMatchObject(
        {
          content: 'Builder resumed from its durable transcript.',
          model: 'policy/default',
        },
      );
      expect(state.events.find((event) => event.type === 'commit.created')?.payload).toEqual({
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        message: 'Complete M1 builder task',
        mode: 'build',
        diffstat: [{ path: 'src/app.ts', additions: 12, deletions: 3 }],
      });
      expect(state.events.every((event) => event.runId === runId)).toBe(true);
      expect(state.events.every((event) => event.organizationId === organizationId)).toBe(true);
      expect(state.events.every((event) => event.projectId === projectId)).toBe(true);
    },
    90_000,
  );

  it('flushes event batches at twenty events or within the one-second deadline per run', async () => {
    const batches: Array<{ readonly runIds: string[]; readonly carriesEventKey: boolean }> = [];
    const client = new EventBatchClient({
      flushIntervalMs: 25,
      publish: ({ events }) => {
        batches.push({
          runIds: events.map((event) => event.runId),
          carriesEventKey: events.some((event) => 'eventKey' in event),
        });
        return Promise.resolve();
      },
    });
    const event = {
      eventKey: 'event-key',
      runId: newId('run'),
      organizationId: newId('org'),
      projectId: newId('proj'),
      occurredAt: '2026-08-07T12:00:00.000Z',
      type: 'tool.completed' as const,
      visibility: 'user' as const,
      payload: { userSummary: 'Completed a tool action' },
    };

    await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        client.emit({ ...event, eventKey: `${event.eventKey}-${String(index)}` }),
      ),
    );
    await Promise.all([
      client.emit({ ...event, eventKey: 'run-a', runId: newId('run') }),
      client.emit({ ...event, eventKey: 'run-b', runId: newId('run') }),
    ]);

    expect(batches.map((batch) => batch.runIds.length)).toEqual([20, 1, 1, 1]);
    expect(batches.every((batch) => new Set(batch.runIds).size === 1)).toBe(true);
    expect(batches.every((batch) => !batch.carriesEventKey)).toBe(true);
  });
});
