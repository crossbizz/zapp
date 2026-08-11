import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createEventActivities, EventBatchClient } from '../../src/activities/events.js';
import { createRunWorker, createTemporalOrchestrator, type RunActivities } from '../../src/worker.js';
import {
  getRunStatusQuery,
  messageRunSignal,
  runWorkflow,
  type RunWorkflowInput,
} from '../../src/workflows/run.js';

const id = (prefix: 'run' | 'org' | 'proj'): string =>
  `${prefix}_01J00000000000000000000000`;

function operationKey(character: string): string {
  return `op_${character.repeat(64)}`;
}

function workflowInput(runId: string): RunWorkflowInput {
  return {
    runId,
    workflowId: runId,
    organizationId: id('org'),
    projectId: id('proj'),
    branchId: null,
    mode: 'build',
    appType: 'web',
    model: 'anthropic/claude-sonnet-4',
    prompt: 'Build the first screen.',
    budget: null,
    operationKey: operationKey('a'),
  };
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
  return Promise.reject(new Error('budget approval is not expected in AR-22'));
}

describe('AR-22 public conversation events', () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
  }, 30_000);

  afterAll(async () => {
    await environment.teardown();
  });

  it('maps CP-20 message input to the strict continuation signal', async () => {
    const signal = vi.fn(() => Promise.resolve());
    const orchestrator = createTemporalOrchestrator({
      client: { workflow: { getHandle: () => ({ signal }) } } as never,
    });
    const message = {
      messageId: 'msg_01J00000000000000000000001',
      content: 'Use this reference image.',
      attachments: [
        {
          attachmentId: 'art_01J00000000000000000000001',
          kind: 'image' as const,
          name: 'reference.png',
          byteSize: 123,
          contentType: 'image/png' as const,
        },
      ],
      source: 'api' as const,
    };

    await expect(
      orchestrator.signalRun({
        runId: id('run'),
        workflowId: id('run'),
        signal: 'message',
        message,
        operationKey: operationKey('b'),
      }),
    ).resolves.toEqual({ applied: true });
    expect(signal).toHaveBeenCalledWith(messageRunSignal, {
      runId: id('run'),
      message,
      operationKey: operationKey('b'),
    });
  });

  it('stores assistant overflow with a content-addressed, idempotent receipt', async () => {
    const stored: Array<Record<string, unknown>> = [];
    const activities = createEventActivities({
      client: new EventBatchClient({ publish: () => Promise.resolve() }),
      assistantContent: {
        store: (input) => {
          stored.push(input);
          return Promise.resolve({
            artifactId: input.artifactId,
            contentHash: input.contentHash,
          });
        },
      },
      transitionStatus: () => Promise.resolve(),
    });

    const receipt = await activities.storeAssistantContent({
      artifactId: 'art_01J00000000000000000000003',
      organizationId: id('org'),
      projectId: id('proj'),
      runId: id('run'),
      content: 'overflow assistant content',
      idempotencyKey: 'assistant-overflow-test',
    });
    expect(receipt.artifactId).toBe('art_01J00000000000000000000003');
    expect(receipt.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.['contentHash']).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('refuses to compose event activities without assistant overflow storage', () => {
    expect(() =>
      createEventActivities({
        client: new EventBatchClient({ publish: () => Promise.resolve() }),
        transitionStatus: () => Promise.resolve(),
      } as never),
    ).toThrow('Assistant content storage is required');
  });

  it('emits ordered initial and continued turns, artifacts oversized replies, and replays one assistant event', async () => {
    const firstTurn = deferred<{
      status: 'completed';
      commits: never[];
      artifacts: never[];
      summary: string;
      model: string;
      turn: number;
    }>();
    const oversizedReply = '🧱'.repeat(25_000);
    const sessionInputs: Array<Record<string, unknown>> = [];
    const storedArtifacts: Array<{ readonly artifactId: string; readonly content: string }> = [];
    const published: Array<{ readonly type: string; readonly payload: Record<string, unknown> }> = [];
    const storedEventKeys = new Set<string>();
    let assistantResponseLost = false;
    const activities = {
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-ar22' }),
      runBuilderSession: (input: Record<string, unknown>) => {
        sessionInputs.push(input);
        if (sessionInputs.length === 1) return firstTurn.promise;
        if (sessionInputs.length === 2) {
          return Promise.resolve({
            status: 'yielded' as const,
            commits: [],
            artifacts: [],
            summary: 'The first screen is ready.',
            model: 'anthropic/claude-sonnet-4',
            turn: 1,
            messageApplied: true,
          });
        }
        return Promise.resolve({
          status: 'completed' as const,
          commits: [],
          artifacts: [],
          summary: oversizedReply,
          model: 'anthropic/claude-sonnet-4',
          turn: 2,
          messageApplied: true,
        });
      },
      commitAndPush: () => Promise.resolve({ commitSha: 'e'.repeat(40), diffstat: [] }),
      emitEvents: ({ events }: { events: Array<Record<string, unknown>> }) => {
        let carriesNewAssistant = false;
        for (const event of events) {
          const eventKey = String(event['eventKey']);
          if (storedEventKeys.has(eventKey)) continue;
          storedEventKeys.add(eventKey);
          const stored = {
            type: String(event['type']),
            payload: event['payload'] as Record<string, unknown>,
          };
          published.push(stored);
          if (stored.type === 'message.assistant') carriesNewAssistant = true;
        }
        if (carriesNewAssistant && !assistantResponseLost) {
          assistantResponseLost = true;
          throw new Error('simulated response loss after durable event ingest');
        }
        return Promise.resolve();
      },
      storeAssistantContent: (input: { artifactId: string; content: string }) => {
        storedArtifacts.push(input);
        return Promise.resolve({ artifactId: input.artifactId, contentHash: 'f'.repeat(64) });
      },
      transitionRunStatus: () => Promise.resolve(),
      estimateRunCost: approvalActivityNotExpected,
      requestBudgetIncrease: approvalActivityNotExpected,
      checkpointBudgetStop: approvalActivityNotExpected,
    } as unknown as RunActivities;
    const taskQueue = `ar22-${Date.now().toString(36)}`;
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const input = workflowInput('run_01J00000000000000000000022');
      const handle = await environment.client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: input.workflowId,
        args: [input],
      });
      await vi.waitFor(() => {
        expect(sessionInputs, JSON.stringify(published)).toHaveLength(1);
      }, { timeout: 5_000 });
      const continuation = {
        runId: input.runId,
        operationKey: operationKey('c'),
        message: {
          messageId: 'msg_01J00000000000000000000002',
          content: 'Now use the reference image.',
          attachments: [
            {
              attachmentId: 'art_01J00000000000000000000002',
              kind: 'image' as const,
              name: 'reference.png',
              byteSize: 123,
              contentType: 'image/png' as const,
            },
          ],
          source: 'api' as const,
        },
      };
      // CP-20 durably ingests this user event before signalling the workflow.
      published.push({ type: 'message.user', payload: continuation.message });
      await handle.signal(messageRunSignal, continuation);
      expect((await handle.query(getRunStatusQuery)).pendingMessageCount).toBe(1);
      firstTurn.resolve({
        status: 'completed',
        commits: [],
        artifacts: [],
        summary: 'The first screen is ready.',
        model: 'anthropic/claude-sonnet-4',
        turn: 1,
      });
      await expect(handle.result()).resolves.toEqual({
        status: 'completed',
        commitSha: 'e'.repeat(40),
      });
    });

    expect(sessionInputs).toHaveLength(3);
    expect(sessionInputs[1]?.['control']).toMatchObject({
      message: {
        operationKey: operationKey('c'),
        content: 'Now use the reference image.',
        attachments: [{ attachmentId: 'art_01J00000000000000000000002' }],
      },
    });
    expect(published.map(({ type }) => type)).toEqual([
      'run.started',
      'phase.created',
      'phase.started',
      'message.user',
      'agent.started',
      'message.user',
      'message.assistant',
      'agent.started',
      'agent.started',
      'artifact.created',
      'message.assistant',
      'phase.completed',
      'commit.created',
      'run.completed',
    ]);
    const assistantMessages = published.filter(({ type }) => type === 'message.assistant');
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]?.payload).toMatchObject({
      content: 'The first screen is ready.',
      model: 'anthropic/claude-sonnet-4',
    });
    expect(assistantMessages[1]?.payload).toMatchObject({
      contentArtifactId: storedArtifacts[0]?.artifactId,
      model: 'anthropic/claude-sonnet-4',
    });
    expect(assistantMessages[1]?.payload).not.toHaveProperty('content');
    expect(storedArtifacts).toHaveLength(1);
    expect(storedArtifacts[0]?.content).toBe(oversizedReply);
  }, 30_000);

  it('returns a message accepted during commit to the active session before completing', async () => {
    const firstCommit = deferred<{ commitSha: string; diffstat: never[] }>();
    const sessionInputs: Array<Record<string, unknown>> = [];
    const commitInputs: Array<Record<string, unknown>> = [];
    const activities = {
      ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-ar22-commit' }),
      runBuilderSession: (input: Record<string, unknown>) => {
        sessionInputs.push(input);
        return Promise.resolve({
          status: 'completed' as const,
          commits: [],
          artifacts: [],
          summary: sessionInputs.length === 1 ? 'First turn.' : 'Continuation turn.',
          model: 'anthropic/claude-sonnet-4',
          turn: sessionInputs.length,
          messageApplied: sessionInputs.length > 1,
        });
      },
      commitAndPush: (input: Record<string, unknown>) => {
        commitInputs.push(input);
        return commitInputs.length === 1
          ? firstCommit.promise
          : Promise.resolve({ commitSha: 'f'.repeat(40), diffstat: [] });
      },
      emitEvents: () => Promise.resolve(),
      storeAssistantContent: () => Promise.reject(new Error('overflow is not expected')),
      transitionRunStatus: () => Promise.resolve(),
      estimateRunCost: approvalActivityNotExpected,
      requestBudgetIncrease: approvalActivityNotExpected,
      checkpointBudgetStop: approvalActivityNotExpected,
    } as unknown as RunActivities;
    const taskQueue = `ar22-commit-${Date.now().toString(36)}`;
    const worker = await createRunWorker({
      connection: environment.nativeConnection,
      taskQueue,
      activities,
      testOnlyBypassActivityIdempotency: true,
    });

    await worker.runUntil(async () => {
      const input = workflowInput('run_01J00000000000000000000023');
      const handle = await environment.client.workflow.start(runWorkflow, {
        taskQueue,
        workflowId: input.workflowId,
        args: [input],
      });
      await vi.waitFor(() => {
        expect(commitInputs).toHaveLength(1);
      }, { timeout: 5_000 });
      await handle.signal(messageRunSignal, {
        runId: input.runId,
        operationKey: operationKey('d'),
        message: {
          messageId: 'msg_01J00000000000000000000004',
          content: 'One more change.',
          attachments: [],
          source: 'api',
        },
      });
      expect((await handle.query(getRunStatusQuery)).pendingMessageCount).toBe(1);
      firstCommit.resolve({ commitSha: 'e'.repeat(40), diffstat: [] });
      await expect(handle.result()).resolves.toEqual({
        status: 'completed',
        commitSha: 'f'.repeat(40),
      });
    });

    expect(sessionInputs).toHaveLength(2);
    expect(sessionInputs[1]?.['control']).toMatchObject({
      message: {
        operationKey: operationKey('d'),
        content: 'One more change.',
      },
    });
    expect(commitInputs).toHaveLength(2);
    expect(commitInputs[0]?.['idempotencyKey']).not.toBe(commitInputs[1]?.['idempotencyKey']);
  }, 30_000);
});
