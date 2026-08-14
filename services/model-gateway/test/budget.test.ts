import { describe, expect, it, vi } from 'vitest';

import type { CompletionBackend } from '../src/app.js';
import type { BackendStreamEvent, CompleteRequest } from '../src/schemas.js';
import { createRoutingCompletion } from '../src/routing.js';
import { createAnthropicAdapter } from '../src/providers/anthropic.js';
import { ProviderAttemptError } from '../src/providers/types.js';
import { createModelAttemptTelemetry } from '../src/telemetry.js';
import {
  CompletionControlError,
  CompletionCommitIndeterminateError,
  createControlPlaneUsageClient,
  createUsageAccountedCompletion,
  type CompletionUsageClient,
  type ReservableCompletionBackend,
} from '../src/usage-client.js';

const request = {
  completionId: `cmp_${'a'.repeat(64)}`,
  organizationId: 'org_01KZKM6HJR5EQHCY8XJWE6B7A6',
  projectId: 'proj_01KZKM6HJR5EQHCY8XJWE6B7A7',
  runId: 'run_01KZKM6HJR5EQHCY8XJWE6B7A8',
  taskId: 'task_01KZKM6HJR5EQHCY8XJWE6B7A9',
  agentRole: 'builder',
  messages: [
    { role: 'system', content: 'stable builder prompt' },
    { role: 'user', content: 'assembled project context' },
  ],
  cacheBreakpointMessageIndexes: [0, 1],
  maxInputTokens: 120,
  maxOutputTokens: 80,
} as const satisfies CompleteRequest;

const route = [
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    maxInputTokens: request.maxInputTokens,
    maxOutputTokens: request.maxOutputTokens,
  },
] as const;

const usage = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  inputTokens: 120,
  outputTokens: 12,
  cacheReadInputTokens: 100,
  cacheWriteInputTokens: 0,
  occurredAt: '2026-08-09T16:00:00.000Z',
} as const;

function completedRecord() {
  return {
    completionId: request.completionId,
    organizationId: request.organizationId,
    projectId: request.projectId,
    runId: request.runId,
    taskId: request.taskId,
    requestFingerprint: '',
    events: [
      { type: 'text-delta' as const, text: 'hello' },
      {
        type: 'usage' as const,
        provider: usage.provider,
        model: usage.model,
        finishReason: 'stop',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
        cachedInputTokens: usage.cacheReadInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
      },
    ],
    terminal: { type: 'done' as const },
    usage: [usage],
  };
}

function backend(events: readonly unknown[]): ReservableCompletionBackend & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    prepare: () =>
      Promise.resolve({
        route: [...route],
        stream: () => createStream(),
      }),
    stream: () => {
      return createStream();
    },
  };

  function createStream() {
    calls += 1;
    return (async function* () {
      await Promise.resolve();
      for (const event of events) yield event as never;
    })();
  }
}

async function collect(
  completion: CompletionBackend,
  input: CompleteRequest = request,
): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of completion.stream(input, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

function trackedBackend(events: readonly BackendStreamEvent[]) {
  const preparedRequests: CompleteRequest[] = [];
  let providerCalls = 0;
  const provider: ReservableCompletionBackend = {
    prepare(value) {
      preparedRequests.push(value);
      return Promise.resolve({
        route: [...route],
        stream: () => {
          providerCalls += 1;
          return (async function* () {
            await Promise.resolve();
            yield* events;
          })();
        },
      });
    },
    stream: () => {
      throw new Error('The accounted path must use prepare().');
    },
  };
  return {
    provider,
    preparedRequests,
    get providerCalls() {
      return providerCalls;
    },
  };
}

describe('durable completion accounting', () => {
  it('accepts a structurally identical committed tool input after JSONB key reordering', async () => {
    const providerEvents = [
      {
        type: 'tool-call' as const,
        toolCallId: 'toolu_order_independent',
        toolName: 'search_code',
        input: { query: 'plan', path: '.' },
      },
      completedRecord().events[1],
    ];
    const provider = backend(providerEvents);
    const completion = createUsageAccountedCompletion({
      backend: provider,
      accounting: {
        claim: () =>
          Promise.resolve({
            status: 'claimed',
            claimExpiresAt: '2026-08-09T16:05:00.000Z',
            reservedCredits: '1.0000',
            credits: { used: '0.0000', reserved: '1.0000', ceiling: '10.0000', version: 1 },
          }),
        commit: (input) =>
          Promise.resolve({
            completion: {
              completionId: input.completionId,
              organizationId: input.organizationId,
              projectId: input.projectId,
              runId: input.runId,
              ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
              requestFingerprint: input.requestFingerprint,
              events: input.events.map((event) =>
                event.type === 'tool-call'
                  ? { ...event, input: { path: '.', query: 'plan' } }
                  : event,
              ),
              terminal: input.terminal,
              usage: input.usage,
            },
            credits: { used: '0.1000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
            ledgerRowIds: ['usage-input'],
          }),
      },
      claimOwner: 'gateway-one',
      now: () => new Date('2026-08-09T16:00:00.000Z'),
    });

    await expect(collect(completion)).resolves.toEqual([
      ...providerEvents,
      expect.objectContaining({ type: 'usage.recorded' }),
    ]);
  });

  it('replays a committed version-one request after response loss without a second provider execution', async () => {
    const legacyRequest = {
      ...request,
      messages: [
        { role: 'system', content: 'legacy original registered-secret' },
        request.messages[1],
      ],
    } as const satisfies CompleteRequest;
    const tracked = trackedBackend(completedRecord().events);
    let originalFingerprint: string | undefined;
    let committed: ReturnType<typeof completedRecord> | undefined;
    const claim = vi.fn((input: Parameters<CompletionUsageClient['claim']>[0]) => {
      if (committed === undefined) {
        originalFingerprint ??= input.requestFingerprint;
        if (input.requestFingerprint !== originalFingerprint) {
          return Promise.reject(new Error('immutable legacy fingerprint changed before commit'));
        }
        return Promise.resolve({
          status: 'claimed' as const,
          claimExpiresAt: '2026-08-09T16:05:00.000Z',
          reservedCredits: '1.0000',
          credits: { used: '0.0000', reserved: '1.0000', ceiling: '10.0000', version: 1 },
        });
      }
      if (input.requestFingerprint !== originalFingerprint) {
        return Promise.reject(new Error('immutable legacy fingerprint changed on replay'));
      }
      return Promise.resolve({
        status: 'completed' as const,
        completion: committed,
        credits: { used: '0.1000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
      });
    });
    const commit = vi.fn((input: Parameters<CompletionUsageClient['commit']>[0]) => {
      committed = { ...completedRecord(), requestFingerprint: input.requestFingerprint };
      return Promise.reject(new Error('response lost after durable commit'));
    });
    const accounting: CompletionUsageClient = {
      claim,
      commit,
    };
    const completion = createUsageAccountedCompletion({
      backend: tracked.provider,
      accounting,
      claimOwner: 'gateway-one',
      now: () => new Date('2026-08-09T16:00:00.000Z'),
    });

    await expect(collect(completion, legacyRequest)).rejects.toBeInstanceOf(
      CompletionCommitIndeterminateError,
    );
    if (originalFingerprint === undefined) throw new Error('Expected original accounting claim');
    const replay = {
      ...legacyRequest,
      messages: [
        { role: 'system', content: 'legacy original [REDACTED]' },
        legacyRequest.messages[1],
      ],
      accountingReplay: { version: 1, requestFingerprint: originalFingerprint },
    } as const satisfies CompleteRequest;

    await expect(collect(completion, replay)).resolves.toEqual([
      ...completedRecord().events,
      {
        type: 'usage.recorded',
        completionId: request.completionId,
        usage: [usage],
        credits: { used: '0.1000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
      },
    ]);
    expect(tracked.providerCalls).toBe(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        completionId: request.completionId,
        requestFingerprint: originalFingerprint,
      }),
    );
    expect(claim).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        completionId: request.completionId,
        requestFingerprint: originalFingerprint,
      }),
    );
    expect(tracked.preparedRequests).toHaveLength(2);
    expect(JSON.stringify(tracked.preparedRequests[1])).not.toContain('registered-secret');
    expect(tracked.preparedRequests[1]).not.toHaveProperty('accountingReplay');
  });

  it('reclaims an expired version-one reservation under its original fingerprint once', async () => {
    const legacyRequest = {
      ...request,
      messages: [
        { role: 'system', content: 'expired legacy registered-secret' },
        request.messages[1],
      ],
    } as const satisfies CompleteRequest;
    const tracked = trackedBackend(completedRecord().events);
    let originalFingerprint: string | undefined;
    let abandoned = false;
    const claim = vi.fn((input: Parameters<CompletionUsageClient['claim']>[0]) => {
      if (!abandoned) {
        abandoned = true;
        originalFingerprint = input.requestFingerprint;
        return Promise.reject(new Error('gateway lost after the durable accounting claim'));
      }
      if (input.requestFingerprint !== originalFingerprint) {
        return Promise.reject(new Error('expired legacy reservation fingerprint conflict'));
      }
      return Promise.resolve({
        status: 'claimed' as const,
        claimExpiresAt: '2026-08-09T16:05:00.000Z',
        reservedCredits: '1.0000',
        credits: { used: '0.0000', reserved: '1.0000', ceiling: '10.0000', version: 1 },
      });
    });
    const commit = vi.fn((input: Parameters<CompletionUsageClient['commit']>[0]) =>
      Promise.resolve({
        completion: { ...completedRecord(), requestFingerprint: input.requestFingerprint },
        credits: { used: '0.1000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
        ledgerRowIds: ['usage-input'],
      }),
    );
    const accounting: CompletionUsageClient = {
      claim,
      commit,
    };
    const completion = createUsageAccountedCompletion({
      backend: tracked.provider,
      accounting,
      claimOwner: 'gateway-one',
      now: () => new Date('2026-08-09T16:00:00.000Z'),
    });

    await expect(collect(completion, legacyRequest)).rejects.toThrow(
      'gateway lost after the durable accounting claim',
    );
    if (originalFingerprint === undefined) throw new Error('Expected abandoned accounting claim');
    const replay = {
      ...legacyRequest,
      messages: [
        { role: 'system', content: 'expired legacy [REDACTED]' },
        legacyRequest.messages[1],
      ],
      accountingReplay: { version: 1, requestFingerprint: originalFingerprint },
    } as const satisfies CompleteRequest;

    await expect(collect(completion, replay)).resolves.toHaveLength(3);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        completionId: request.completionId,
        requestFingerprint: originalFingerprint,
      }),
    );
    expect(claim).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        completionId: request.completionId,
        requestFingerprint: originalFingerprint,
      }),
    );
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        completionId: request.completionId,
        requestFingerprint: originalFingerprint,
      }),
    );
    expect(tracked.providerCalls).toBe(1);
    expect(tracked.preparedRequests).toHaveLength(2);
    expect(JSON.stringify(tracked.preparedRequests[1])).not.toContain('registered-secret');
    expect(tracked.preparedRequests[1]).not.toHaveProperty('accountingReplay');
  });

  it('uses only the strict service-authenticated control-plane accounting boundary', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = createControlPlaneUsageClient({
      baseUrl: 'https://control.internal',
      serviceTokens: { secret: 's'.repeat(64) },
      fetch: (url, init) => {
        requests.push({ url, init });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'claimed',
              claimExpiresAt: '2026-08-09T16:05:00.000Z',
              reservedCredits: '1.0000',
              credits: { used: '0.0000', reserved: '1.0000', ceiling: '10.0000', version: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });

    await expect(
      client.claim({
        completionId: request.completionId,
        organizationId: request.organizationId,
        projectId: request.projectId,
        runId: request.runId,
        taskId: request.taskId,
        requestFingerprint: 'f'.repeat(64),
        claimOwner: 'gateway-one',
        leaseMs: 300_000,
        route: [...route],
      }),
    ).resolves.toMatchObject({ status: 'claimed' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://control.internal/internal/model-completions/claim');
    expect(new Headers(requests[0]?.init.headers).get('x-zapp-service-token')).toMatch(/^ey/u);
    expect(requests[0]?.init.method).toBe('POST');

    const invalidClient = createControlPlaneUsageClient({
      baseUrl: 'https://control.internal',
      serviceTokens: { secret: 's'.repeat(64) },
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'leased',
              retryAfterMs: 250,
              unexpected: 'must be rejected',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
    });
    await expect(
      invalidClient.claim({
        completionId: request.completionId,
        organizationId: request.organizationId,
        projectId: request.projectId,
        runId: request.runId,
        taskId: request.taskId,
        requestFingerprint: 'f'.repeat(64),
        claimOwner: 'gateway-one',
        leaseMs: 300_000,
        route: [...route],
      }),
    ).rejects.toThrow();
  });

  it('replays a completed journal byte-for-byte without a provider call', async () => {
    const provider = backend([]);
    const record = completedRecord();
    const commit = vi.fn();
    const accounting: CompletionUsageClient = {
      claim: vi.fn().mockResolvedValue({
        status: 'completed',
        completion: record,
        credits: { used: '8.0000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
      }),
      commit,
    };
    const completion = createUsageAccountedCompletion({
      backend: provider,
      accounting,
      claimOwner: 'gateway-one',
      now: () => new Date('2026-08-09T16:00:00.000Z'),
    });

    await expect(collect(completion)).resolves.toEqual([
      ...record.events,
      {
        type: 'usage.recorded',
        completionId: request.completionId,
        usage: record.usage,
        credits: { used: '8.0000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
      },
    ]);
    expect(provider.calls).toBe(0);
    expect(commit).not.toHaveBeenCalled();
  });

  it('reserves before dispatch and commits before usage.recorded', async () => {
    const provider = backend([
      { type: 'text-delta', text: 'hello' },
      {
        type: 'usage',
        provider: usage.provider,
        model: usage.model,
        finishReason: 'stop',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
        cachedInputTokens: usage.cacheReadInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
      },
    ]);
    const order: string[] = [];
    const claim = vi.fn(() => {
      order.push('claim');
      return Promise.resolve({
        status: 'claimed' as const,
        claimExpiresAt: '2026-08-09T16:05:00.000Z',
        reservedCredits: '1.0000',
        credits: { used: '0.0000', reserved: '1.0000', ceiling: '10.0000', version: 1 },
      });
    });
    const accounting: CompletionUsageClient = {
      claim,
      commit: vi.fn((input: Parameters<CompletionUsageClient['commit']>[0]) => {
        order.push('commit');
        return Promise.resolve({
          completion: { ...completedRecord(), requestFingerprint: input.requestFingerprint },
          credits: { used: '0.1000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
          ledgerRowIds: ['usage-input', 'usage-output', 'usage-cache-read'],
        });
      }),
    };
    const completion = createUsageAccountedCompletion({
      backend: provider,
      accounting,
      claimOwner: 'gateway-one',
      now: () => new Date('2026-08-09T16:00:00.000Z'),
      observe: (event) => order.push(event.type),
    });

    const events = await collect(completion);
    expect(order).toEqual(['claim', 'commit', 'usage.recorded']);
    expect(events.at(-1)).toEqual({
      type: 'usage.recorded',
      completionId: request.completionId,
      usage: [usage],
      credits: { used: '0.1000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
    });
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({ route, completionId: request.completionId }),
    );
  });

  it('recovers a commit response loss by replaying once and never dispatching twice', async () => {
    const provider = backend(completedRecord().events);
    let stored: ReturnType<typeof completedRecord> | undefined;
    const commit = vi.fn((input: Parameters<CompletionUsageClient['commit']>[0]) => {
      stored = { ...completedRecord(), requestFingerprint: input.requestFingerprint };
      return Promise.reject(new Error('response lost after durable commit'));
    });
    const accounting: CompletionUsageClient = {
      claim: vi.fn(() =>
        Promise.resolve(
          stored === undefined
            ? {
                status: 'claimed' as const,
                claimExpiresAt: '2026-08-09T16:05:00.000Z',
                reservedCredits: '1.0000',
                credits: { used: '0.0000', reserved: '1.0000', ceiling: '10.0000', version: 1 },
              }
            : {
                status: 'completed' as const,
                completion: stored,
                credits: { used: '0.1000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
              },
        ),
      ),
      commit,
    };
    const completion = createUsageAccountedCompletion({
      backend: provider,
      accounting,
      claimOwner: 'gateway-one',
      now: () => new Date('2026-08-09T16:00:00.000Z'),
    });

    await expect(collect(completion)).rejects.toBeInstanceOf(CompletionCommitIndeterminateError);
    await expect(collect(completion)).resolves.toEqual([
      ...completedRecord().events,
      {
        type: 'usage.recorded',
        completionId: request.completionId,
        usage: [usage],
        credits: { used: '0.1000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
      },
    ]);
    expect(provider.calls).toBe(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('uses a distinct claim owner for concurrent retries handled by one gateway process', async () => {
    let streamCalls = 0;
    let releaseFirst: (() => void) | undefined;
    let signalFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const provider: ReservableCompletionBackend = {
      prepare: () => Promise.resolve({ route: [...route], stream: () => providerStream() }),
      stream: () => providerStream(),
    };
    const providerStream = () =>
      (async function* () {
        streamCalls += 1;
        if (streamCalls === 1) {
          signalFirstStarted?.();
          await firstBlocked;
        }
        yield completedRecord().events[1] as never;
      })();
    let activeOwner: string | undefined;
    const accounting: CompletionUsageClient = {
      claim: (input) => {
        if (activeOwner === undefined) {
          activeOwner = input.claimOwner;
        } else if (input.claimOwner !== activeOwner) {
          return Promise.resolve({ status: 'leased', retryAfterMs: 250 });
        }
        return Promise.resolve({
          status: 'claimed',
          claimExpiresAt: '2026-08-09T16:05:00.000Z',
          reservedCredits: '1.0000',
          credits: { used: '0.0000', reserved: '1.0000', ceiling: '10.0000', version: 1 },
        });
      },
      commit: (input) =>
        Promise.resolve({
          completion: {
            completionId: input.completionId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            runId: input.runId,
            ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
            requestFingerprint: input.requestFingerprint,
            events: input.events,
            terminal: input.terminal,
            usage: input.usage,
          },
          credits: { used: '0.1000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
          ledgerRowIds: ['usage-input'],
        }),
    };
    const completion = createUsageAccountedCompletion({
      backend: provider,
      accounting,
      claimOwner: 'gateway-process',
      now: () => new Date('2026-08-09T16:00:00.000Z'),
    });

    const first = collect(completion);
    await firstStarted;
    const second = await collect(completion).catch((caught: unknown) => caught);
    expect(second).toBeInstanceOf(CompletionControlError);
    expect(second).toMatchObject({ code: 'completion_leased' });
    expect(streamCalls).toBe(1);
    releaseFirst?.();
    await expect(first).resolves.toEqual([
      completedRecord().events[1],
      expect.objectContaining({ type: 'usage.recorded' }),
    ]);
  });

  it('renews a live completion claim before its lease can expire', async () => {
    let releaseProvider: (() => void) | undefined;
    const providerBlocked = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider: ReservableCompletionBackend = {
      prepare: () =>
        Promise.resolve({
          route: [...route],
          stream: () =>
            (async function* () {
              await providerBlocked;
              yield completedRecord().events[1] as BackendStreamEvent;
            })(),
        }),
      stream: () => {
        throw new Error('The accounted path must use prepare().');
      },
    };
    let claimCalls = 0;
    const accounting: CompletionUsageClient = {
      claim: () => {
        claimCalls += 1;
        return Promise.resolve({
          status: 'claimed',
          claimExpiresAt: '2026-08-09T16:05:00.000Z',
          reservedCredits: '1.0000',
          credits: { used: '0.0000', reserved: '1.0000', ceiling: '10.0000', version: 1 },
        });
      },
      commit: (input) =>
        Promise.resolve({
          completion: {
            completionId: input.completionId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            runId: input.runId,
            ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
            requestFingerprint: input.requestFingerprint,
            events: input.events,
            terminal: input.terminal,
            usage: input.usage,
          },
          credits: { used: '0.1000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
          ledgerRowIds: ['usage-input'],
        }),
    };
    const completion = createUsageAccountedCompletion({
      backend: provider,
      accounting,
      claimOwner: 'gateway-one',
      leaseMs: 1_000,
      leaseRenewalIntervalMs: 5,
      now: () => new Date('2026-08-09T16:00:00.000Z'),
    });

    const collecting = collect(completion);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const callsBeforeCompletion = claimCalls;
    releaseProvider?.();
    await collecting;

    expect(callsBeforeCompletion).toBeGreaterThanOrEqual(2);
  });

  it('classifies an indeterminate lease renewal as a retryable completion', async () => {
    let claimCalls = 0;
    const provider: ReservableCompletionBackend = {
      prepare: () =>
        Promise.resolve({
          route: [...route],
          stream: (signal) =>
            (async function* () {
              await new Promise<void>((resolve) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    resolve();
                  },
                  { once: true },
                );
                if (signal.aborted) resolve();
              });
              throw new ProviderAttemptError(
                'anthropic',
                'claude-sonnet-5',
                new Error('lease renewal stopped provider'),
              );
            })(),
        }),
      stream: () => {
        throw new Error('The accounted path must use prepare().');
      },
    };
    const completion = createUsageAccountedCompletion({
      backend: provider,
      accounting: {
        claim: () => {
          claimCalls += 1;
          if (claimCalls === 1) {
            return Promise.resolve({
              status: 'claimed' as const,
              claimExpiresAt: '2026-08-09T16:05:00.000Z',
              reservedCredits: '1.0000',
              credits: { used: '0.0000', reserved: '1.0000', ceiling: '10.0000', version: 1 },
            });
          }
          return Promise.reject(new Error('control plane renewal unavailable'));
        },
        commit: () => Promise.reject(new Error('commit must not run after a lost lease')),
      },
      claimOwner: 'gateway-one',
      leaseMs: 1_000,
      leaseRenewalIntervalMs: 1,
    });

    await expect(collect(completion)).rejects.toBeInstanceOf(CompletionCommitIndeterminateError);
    expect(claimCalls).toBeGreaterThanOrEqual(2);
  });

  it('settles incurred provider work when the stream consumer disconnects', async () => {
    let nextCalls = 0;
    const provider: ReservableCompletionBackend = {
      prepare: () =>
        Promise.resolve({
          route: [...route],
          stream: () => ({
            [Symbol.asyncIterator]() {
              return {
                next() {
                  nextCalls += 1;
                  return nextCalls === 1
                    ? Promise.resolve({
                        done: false as const,
                        value: { type: 'text-delta' as const, text: 'started' },
                      })
                    : Promise.reject(
                        new ProviderAttemptError(
                          'anthropic',
                          'claude-sonnet-5',
                          new Error('client disconnected'),
                        ),
                      );
                },
              };
            },
          }),
        }),
      stream: () => {
        throw new Error('The accounted path must use prepare().');
      },
    };
    const commit = vi.fn((input: Parameters<CompletionUsageClient['commit']>[0]) =>
      Promise.resolve({
        completion: {
          completionId: input.completionId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          runId: input.runId,
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          requestFingerprint: input.requestFingerprint,
          events: input.events,
          terminal: input.terminal,
          usage: input.usage,
        },
        credits: { used: '0.0000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
        ledgerRowIds: [],
      }),
    );
    const completion = createUsageAccountedCompletion({
      backend: provider,
      accounting: {
        claim: () =>
          Promise.resolve({
            status: 'claimed',
            claimExpiresAt: '2026-08-09T16:05:00.000Z',
            reservedCredits: '1.0000',
            credits: { used: '0.0000', reserved: '1.0000', ceiling: '10.0000', version: 1 },
          }),
        commit,
      },
      claimOwner: 'gateway-one',
      now: () => new Date('2026-08-09T16:00:00.000Z'),
    });
    const iterator = completion
      .stream(request, new AbortController().signal)
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'text-delta', text: 'started' },
    });
    await iterator.return?.();

    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      events: [{ type: 'text-delta', text: 'started' }],
      terminal: { type: 'error', code: 'provider_error' },
      usage: [expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-5' })],
    });
  });

  it.each([
    {
      result: {
        status: 'leased' as const,
        retryAfterMs: 250,
      },
      code: 'completion_leased',
      retryable: true,
    },
    {
      result: {
        status: 'budget_exceeded' as const,
        requiredCredits: '2.0000',
        credits: { used: '9.0000', reserved: '0.0000', ceiling: '10.0000', version: 4 },
      },
      code: 'budget_exceeded',
      retryable: false,
    },
  ])('makes $code a zero-provider-call control outcome', async ({ result, code, retryable }) => {
    const provider = backend([]);
    const accounting: CompletionUsageClient = {
      claim: vi.fn().mockResolvedValue(result),
      commit: vi.fn(),
    };
    const completion = createUsageAccountedCompletion({
      backend: provider,
      accounting,
      claimOwner: 'gateway-one',
      now: () => new Date('2026-08-09T16:00:00.000Z'),
    });

    const error = await collect(completion).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CompletionControlError);
    expect(error).toMatchObject({ code, retryable });
    expect(provider.calls).toBe(0);
  });

  it('journals an attributed terminal provider failure before surfacing the error', async () => {
    const provider: ReservableCompletionBackend = {
      prepare: () => Promise.resolve({ route: [...route], stream: () => providerStream() }),
      stream: () => providerStream(),
    };
    const providerStream = () =>
      (async function* () {
        await Promise.resolve();
        throw new ProviderAttemptError(
          'anthropic',
          'claude-sonnet-5',
          new Error('provider transport failed'),
        );
      })();
    let committedInput: Parameters<CompletionUsageClient['commit']>[0] | undefined;
    const commit = vi.fn((input: Parameters<CompletionUsageClient['commit']>[0]) => {
      committedInput = input;
      return Promise.resolve({
        completion: {
          ...completedRecord(),
          requestFingerprint: input.requestFingerprint,
          events: [],
          terminal: input.terminal,
          usage: input.usage,
        },
        credits: { used: '0.0000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
        ledgerRowIds: [],
      });
    });
    const completion = createUsageAccountedCompletion({
      backend: provider,
      accounting: {
        claim: () =>
          Promise.resolve({
            status: 'claimed',
            claimExpiresAt: '2026-08-09T16:05:00.000Z',
            reservedCredits: '1.0000',
            credits: { used: '0.0000', reserved: '1.0000', ceiling: '10.0000', version: 1 },
          }),
        commit,
      },
      claimOwner: 'gateway-one',
      now: () => new Date('2026-08-09T16:00:00.000Z'),
    });

    await expect(collect(completion)).rejects.toMatchObject({ code: 'provider_error' });
    expect(committedInput?.terminal).toMatchObject({ type: 'error', code: 'provider_error' });
    expect(committedInput?.usage[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe('reserved routing and attempt telemetry', () => {
  const models = {
    roles: {
      planner: { primary: 'anthropic/claude-sonnet-5', fallbacks: ['openai/gpt-5'] },
      builder: { primary: 'anthropic/claude-sonnet-5', fallbacks: ['openai/gpt-5'] },
      verifier: { primary: 'anthropic/claude-sonnet-5', fallbacks: ['openai/gpt-5'] },
      summarizer: { primary: 'anthropic/claude-sonnet-5', fallbacks: ['openai/gpt-5'] },
    },
    providers: {
      anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      openai: { apiKeyEnv: 'OPENAI_API_KEY' },
      google: { apiKeyEnv: 'GOOGLE_API_KEY' },
      compatible: {
        apiKeyEnv: 'COMPATIBLE_API_KEY',
        baseUrlEnv: 'COMPATIBLE_BASE_URL',
        name: 'compatible',
      },
    },
  };

  it('reserves the exact configured provider/model fallback route', async () => {
    const completion = createRoutingCompletion({ models, providers: {} });
    await expect(completion.prepare(request).then((prepared) => prepared.route)).resolves.toEqual([
      ...Array.from({ length: 3 }, () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        maxInputTokens: 120,
        maxOutputTokens: 80,
      })),
      ...Array.from({ length: 3 }, () => ({
        provider: 'openai',
        model: 'gpt-5',
        maxInputTokens: 120,
        maxOutputTokens: 80,
      })),
    ]);
  });

  it('isolates every OpenTelemetry exporter failure from completion accounting', () => {
    const end = vi.fn();
    const telemetry = createModelAttemptTelemetry({
      tracer: {
        startSpan: () => ({
          setAttributes: () => {
            throw new Error('attributes exporter failed');
          },
          setAttribute: () => {
            throw new Error('latency exporter failed');
          },
          setStatus: () => {
            throw new Error('status exporter failed');
          },
          recordException: () => {
            throw new Error('exception exporter failed');
          },
          end,
        }),
      } as never,
      now: () => 100,
    });
    const span = telemetry.start({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      attempt: 1,
      organizationId: request.organizationId,
      runId: request.runId,
      taskId: request.taskId,
    });

    expect(() => {
      span.recordUsage(completedRecord().events[1] as never);
    }).not.toThrow();
    expect(() => {
      span.end('error', new Error('provider failure'));
    }).not.toThrow();
    expect(end).toHaveBeenCalledOnce();
  });

  it('pins one organization policy route for both reservation and provider dispatch', async () => {
    let policyReads = 0;
    let anthropicCalls = 0;
    let openaiCalls = 0;
    const completion = createRoutingCompletion({
      models,
      providers: {
        anthropic: {
          provider: 'anthropic',
          stream: () =>
            (async function* () {
              anthropicCalls += 1;
              await Promise.resolve();
              yield completedRecord().events[1] as BackendStreamEvent;
            })(),
        },
        openai: {
          provider: 'openai',
          stream: () =>
            (async function* () {
              openaiCalls += 1;
              await Promise.resolve();
              yield {
                ...completedRecord().events[1],
                provider: 'openai',
                model: 'gpt-5',
              } as BackendStreamEvent;
            })(),
        },
      },
      routing: {
        organizationPolicies: {
          getPolicy: () => {
            policyReads += 1;
            return policyReads === 1
              ? {
                  roles: {
                    builder: {
                      primary: 'anthropic/claude-sonnet-5',
                      fallbacks: ['openai/gpt-5'],
                    },
                  },
                }
              : {
                  roles: {
                    builder: {
                      primary: 'openai/gpt-5',
                      fallbacks: ['anthropic/claude-sonnet-5'],
                    },
                  },
                };
          },
        },
      },
    });
    const prepared = await (
      completion as unknown as {
        prepare(value: CompleteRequest): Promise<{
          route: readonly unknown[];
          stream(signal: AbortSignal): AsyncIterable<BackendStreamEvent>;
        }>;
      }
    ).prepare(request);

    const events: BackendStreamEvent[] = [];
    for await (const event of prepared.stream(new AbortController().signal)) events.push(event);

    expect(prepared.route).toEqual([
      ...Array.from({ length: 3 }, () => route[0]),
      ...Array.from({ length: 3 }, () => ({
        provider: 'openai',
        model: 'gpt-5',
        maxInputTokens: 120,
        maxOutputTokens: 80,
      })),
    ]);
    expect(policyReads).toBe(1);
    expect(anthropicCalls).toBe(1);
    expect(openaiCalls).toBe(0);
    expect(events).toHaveLength(1);
  });

  it('closes one provider/model latency and token span for every retry and fallback', async () => {
    const spans: Array<{
      provider: string;
      model: string;
      attempt: number;
      outcome?: string;
      usage?: unknown;
    }> = [];
    const telemetry = {
      start(input: { provider: string; model: string; attempt: number }) {
        const span: (typeof spans)[number] = { ...input };
        spans.push(span);
        return {
          recordUsage(value: unknown) {
            span.usage = value;
          },
          end(outcome: 'ok' | 'error') {
            span.outcome = outcome;
          },
        };
      },
    };
    const anthropic = {
      provider: 'anthropic' as const,
      stream: () =>
        (async function* () {
          await Promise.resolve();
          throw Object.assign(new Error('temporary'), { status: 503 });
        })(),
    };
    const openai = {
      provider: 'openai' as const,
      stream: () =>
        (async function* () {
          await Promise.resolve();
          yield {
            type: 'usage' as const,
            provider: 'openai',
            model: 'gpt-5',
            finishReason: 'stop',
            inputTokens: 120,
            outputTokens: 12,
            totalTokens: 132,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
          };
        })(),
    };
    const completion = createRoutingCompletion({
      models,
      providers: { anthropic, openai },
      routing: {
        sleep: () => Promise.resolve(),
        jitter: () => 0,
        telemetry,
      },
    });

    await expect(collect(completion)).resolves.toHaveLength(1);
    expect(spans).toEqual([
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        attempt: 1,
        outcome: 'error',
      }),
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        attempt: 2,
        outcome: 'error',
      }),
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        attempt: 3,
        outcome: 'error',
      }),
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5',
        attempt: 1,
        outcome: 'ok',
      }),
    ]);
    expect(spans.at(-1)?.usage).toMatchObject({ inputTokens: 120, outputTokens: 12 });
  });
});

describe('Anthropic prompt-cache boundaries', () => {
  it('marks the stable role prompt and assembled project context as cache breakpoints', async () => {
    let instructions: unknown;
    let messages: unknown;
    const adapter = createAnthropicAdapter({
      apiKey: 'configured-in-test',
      dependencies: {
        createProvider: () => () => ({ provider: 'anthropic', modelId: 'test' }) as never,
        streamText: (options) => {
          instructions = options.instructions;
          messages = options.messages;
          return {
            totalUsage: Promise.resolve({
              inputTokens: 120,
              inputTokenDetails: {
                noCacheTokens: 20,
                cacheReadTokens: 0,
                cacheWriteTokens: 100,
              },
              outputTokens: 2,
              outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
              totalTokens: 122,
            }),
            stream: (async function* () {
              await Promise.resolve();
              yield {
                type: 'finish',
                finishReason: 'stop',
                rawFinishReason: 'end_turn',
                totalUsage: {
                  inputTokens: 120,
                  inputTokenDetails: {
                    noCacheTokens: 20,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 100,
                  },
                  outputTokens: 2,
                  outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
                  totalTokens: 122,
                },
              };
            })() as never,
          };
        },
      },
    });

    const events: unknown[] = [];
    for await (const event of adapter.stream({
      modelId: 'claude-sonnet-5',
      request,
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(instructions).toEqual([
      {
        role: 'system',
        content: 'stable builder prompt',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
    ]);
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'assembled project context',
            providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
          },
        ],
      },
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'usage',
        cachedInputTokens: 0,
        cacheWriteInputTokens: 100,
      }),
    ]);
  });
});
