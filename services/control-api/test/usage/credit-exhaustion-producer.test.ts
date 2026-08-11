import { expect, it, vi } from 'vitest';

import { CreditBalanceExhaustedError } from '../../src/usage/limits.js';
import {
  createCreditBalanceExhaustionLifecycle,
  createCreditBalanceExhaustionProducer,
  type ActiveCreditRun,
  type CreditExhaustionStore,
} from '../../src/usage/reconciliation.js';

const organizationId = 'org_01J00000000000000000000000';

function makeStore(runs: readonly ActiveCreditRun[] = [
  { runId: 'run_01J00000000000000000000000', temporalWorkflowId: 'wf_1', mode: 'build' as const },
]): CreditExhaustionStore & {
  readonly opened: string[];
  readonly advanced: string[];
  readonly claimedLimits: number[];
} {
  const opened: string[] = [];
  const advanced: string[] = [];
  const claimedLimits: number[] = [];
  let episode: string | undefined;
  let episodeCursor: string | null = null;
  let sequence = 0;
  return {
    opened,
    advanced,
    claimedLimits,
    claimOrganizations: (limit) => {
      claimedLimits.push(limit);
      return Promise.resolve({
        acquired: true as const,
        leaseToken: 'lease-test',
        renewAfterMs: 10_000,
        organizationIds: [organizationId],
      });
    },
    renewLease: () => Promise.resolve(true),
    releaseLease: () => Promise.resolve(),
    getOrOpenEpisode: () => {
      episode ??= `op_episode_${String(++sequence)}`;
      opened.push(episode);
      return Promise.resolve({ operationKey: episode, cursorRunId: episodeCursor });
    },
    closeEpisode: () => { episode = undefined; episodeCursor = null; return Promise.resolve(); },
    listActiveRuns: (_leaseToken, _organizationId, _cursor, limit) => Promise.resolve(runs.slice(0, limit)),
    advanceEpisode: (_leaseToken, _operationKey, cursor) => {
      advanced.push(cursor);
      episodeCursor = cursor;
      return Promise.resolve();
    },
  };
}

it('uses the durable episode key, actual workflow id, and mode, then creates a new key after recovery', async () => {
  const signals: unknown[] = [];
  const store = makeStore();
  let exhausted = true;
  const producer = createCreditBalanceExhaustionProducer({
    store,
    creditBalance: {
      availableCredits: () => Promise.reject(new Error('not used')),
      requireRunAdmission: () => exhausted
        ? Promise.reject(new CreditBalanceExhaustedError())
        : Promise.resolve(),
    },
    orchestrator: {
      startRun: () => Promise.resolve(),
      signalRun: (input) => { signals.push(input); return Promise.resolve({ applied: true }); },
    },
    batchSize: 10,
    signalConcurrency: 2,
  });

  await producer.runOnce();
  await producer.runOnce();
  exhausted = false;
  await producer.runOnce();
  exhausted = true;
  await producer.runOnce();

  const delivered = signals as Array<{ workflowId: string; mode: string; operationKey: string }>;
  expect(delivered[0]).toMatchObject({ workflowId: 'wf_1', mode: 'build', operationKey: 'op_episode_1' });
  expect(delivered[1]?.operationKey).toBe('op_episode_1');
  expect(delivered[2]?.operationKey).toBe('op_episode_2');
});

it('bounds cursor batches and signal concurrency', async () => {
  let concurrent = 0;
  let maximum = 0;
  const releases: Array<() => void> = [];
  const store = makeStore(Array.from({ length: 100 }, (_, index) => ({
    runId: `run_${String(index).padStart(26, '0')}`,
    temporalWorkflowId: `wf_${String(index)}`,
    mode: 'autonomous' as const,
  })));
  const producer = createCreditBalanceExhaustionProducer({
    store,
    creditBalance: {
      availableCredits: () => Promise.reject(new Error('not used')),
      requireRunAdmission: () => Promise.reject(new CreditBalanceExhaustedError()),
    },
    orchestrator: {
      startRun: () => Promise.resolve(),
      signalRun: async () => {
        concurrent += 1;
        maximum = Math.max(maximum, concurrent);
        await new Promise<void>((resolve) => releases.push(resolve));
        concurrent -= 1;
        return { applied: true };
      },
    },
    batchSize: 5,
    signalConcurrency: 2,
  });

  const active = producer.runOnce();
  await vi.waitFor(() => {
    expect(concurrent).toBe(2);
  });
  while (releases.length > 0) {
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await active;
  expect(maximum).toBe(2);
  expect(store.claimedLimits).toEqual([1]);
  expect(store.advanced).toEqual(['run_00000000000000000000000004']);
});

it('advances a partial batch so failed signals retry on cursor wrap', async () => {
  const store = makeStore();
  let fail = true;
  const signalRun = vi.fn(() => {
    if (fail) return Promise.reject(new Error('temporal unavailable'));
    return Promise.resolve({ applied: true });
  });
  const producer = createCreditBalanceExhaustionProducer({
    store,
    creditBalance: {
      availableCredits: () => Promise.reject(new Error('not used')),
      requireRunAdmission: () => Promise.reject(new CreditBalanceExhaustedError()),
    },
    orchestrator: { startRun: () => Promise.resolve(), signalRun },
    batchSize: 5,
    signalConcurrency: 1,
  });

  await producer.runOnce();
  fail = false;
  await producer.runOnce();
  expect(signalRun).toHaveBeenCalledTimes(2);
  expect(store.advanced).toHaveLength(2);
});

it('cycles past a permanent early failure so later pages deliver and the failure retries on wrap', async () => {
  const runs = Array.from({ length: 6 }, (_, index) => ({
    runId: `run_${String(index).padStart(26, '0')}`,
    temporalWorkflowId: `wf_${String(index)}`,
    mode: 'build' as const,
  }));
  const store = makeStore(runs);
  store.listActiveRuns = (_leaseToken, _organizationId, cursor, limit) => {
    const start = cursor === null
      ? 0
      : (runs.findIndex(({ runId }) => runId === cursor) + 1) % runs.length;
    return Promise.resolve(
      Array.from({ length: Math.min(limit, runs.length) }, (_, offset) =>
        runs[(start + offset) % runs.length] as ActiveCreditRun),
    );
  };
  const attempted: string[] = [];
  const producer = createCreditBalanceExhaustionProducer({
    store,
    creditBalance: {
      availableCredits: () => Promise.reject(new Error('not used')),
      requireRunAdmission: () => Promise.reject(new CreditBalanceExhaustedError()),
    },
    orchestrator: {
      startRun: () => Promise.resolve(),
      signalRun: ({ runId }) => {
        attempted.push(runId);
        return runId === runs[0]?.runId
          ? Promise.reject(new Error('permanent first-run failure'))
          : Promise.resolve({ applied: true });
      },
    },
    batchSize: 2,
    signalConcurrency: 2,
  });

  await producer.runOnce();
  await producer.runOnce();
  await producer.runOnce();
  await producer.runOnce();

  expect(attempted).toEqual([
    runs[0]?.runId, runs[1]?.runId,
    runs[2]?.runId, runs[3]?.runId,
    runs[4]?.runId, runs[5]?.runId,
    runs[0]?.runId, runs[1]?.runId,
  ]);
});

it('aborts without advancing when lease renewal is lost during signal delivery', async () => {
  const store = makeStore();
  store.claimOrganizations = () => Promise.resolve({
    acquired: true as const,
    leaseToken: 'lease-lost',
    renewAfterMs: 1,
    organizationIds: [organizationId],
  });
  const renewLease = vi.fn(() => Promise.resolve(false));
  store.renewLease = renewLease;
  const producer = createCreditBalanceExhaustionProducer({
    store,
    creditBalance: {
      availableCredits: () => Promise.reject(new Error('not used')),
      requireRunAdmission: () => Promise.reject(new CreditBalanceExhaustedError()),
    },
    orchestrator: {
      startRun: () => Promise.resolve(),
      signalRun: () => new Promise(() => undefined),
    },
    batchSize: 5,
    signalConcurrency: 1,
    signalTimeoutMs: 50,
  });

  await expect(producer.runOnce()).resolves.toBeUndefined();
  expect(renewLease).toHaveBeenCalledOnce();
  expect(store.advanced).toEqual([]);
});

it('bounds a hung Temporal signal and advances so it retries on cursor wrap', async () => {
  const store = makeStore();
  const producer = createCreditBalanceExhaustionProducer({
    store,
    creditBalance: {
      availableCredits: () => Promise.reject(new Error('not used')),
      requireRunAdmission: () => Promise.reject(new CreditBalanceExhaustedError()),
    },
    orchestrator: {
      startRun: () => Promise.resolve(),
      signalRun: () => new Promise(() => undefined),
    },
    batchSize: 5,
    signalConcurrency: 1,
    signalTimeoutMs: 5,
  });

  await expect(producer.runOnce()).resolves.toBeUndefined();
  expect(store.advanced).toEqual(['run_01J00000000000000000000000']);
});

it('caps late Temporal transports and drains them for a bounded time on close', async () => {
  const store = makeStore(Array.from({ length: 100 }, (_, index) => ({
    runId: `run_${String(index).padStart(26, '0')}`,
    temporalWorkflowId: `wf_${String(index)}`,
    mode: 'build' as const,
  })));
  const signalRun = vi.fn(() => new Promise<{ applied: boolean }>(() => undefined));
  const producer = createCreditBalanceExhaustionProducer({
    store,
    creditBalance: {
      availableCredits: () => Promise.reject(new Error('not used')),
      requireRunAdmission: () => Promise.reject(new CreditBalanceExhaustedError()),
    },
    orchestrator: { startRun: () => Promise.resolve(), signalRun },
    batchSize: 100,
    signalConcurrency: 2,
    signalTimeoutMs: 5,
  });

  await producer.runOnce();
  expect(signalRun).toHaveBeenCalledTimes(2);
  await expect(producer.close()).resolves.toBeUndefined();
});

it('aborts and joins a production poll even when the wallet never settles', async () => {
  const walletCalled = vi.fn();
  const producer = createCreditBalanceExhaustionProducer({
    store: makeStore(),
    creditBalance: {
      availableCredits: () => Promise.reject(new Error('not used')),
      requireRunAdmission: () => {
        walletCalled();
        return new Promise<void>(() => undefined);
      },
    },
    orchestrator: { startRun: () => Promise.resolve(), signalRun: () => Promise.resolve({ applied: true }) },
    batchSize: 5,
    signalConcurrency: 1,
    balanceTimeoutMs: 10_000,
  });
  const lifecycle = createCreditBalanceExhaustionLifecycle({ producer, intervalMs: 100 });

  await lifecycle.start();
  await vi.waitFor(() => {
    expect(walletCalled).toHaveBeenCalledOnce();
  });
  await expect(lifecycle.close()).resolves.toBeUndefined();
});

it('starts without awaiting a slow poll, prevents overlap, and aborts and joins on close', async () => {
  let polls = 0;
  let overlaps = 0;
  let active = false;
  let release: (() => void) | undefined;
  const lifecycle = createCreditBalanceExhaustionLifecycle({
    producer: {
      runOnce: async (signal) => {
        if (active) overlaps += 1;
        active = true;
        polls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener('abort', () => {
            resolve();
          }, { once: true });
        });
        active = false;
      },
    },
    intervalMs: 1,
  });

  await expect(lifecycle.start()).resolves.toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(polls).toBe(1);
  expect(overlaps).toBe(0);
  const closed = lifecycle.close();
  release?.();
  await closed;
  expect(active).toBe(false);
});

it('shields lifecycle close from a throwing error reporter', async () => {
  const lifecycle = createCreditBalanceExhaustionLifecycle({
    producer: { runOnce: () => Promise.reject(new Error('poll failed')) },
    intervalMs: 100,
    onError: () => { throw new Error('reporter failed'); },
  });
  await lifecycle.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(lifecycle.close()).resolves.toBeUndefined();
});
