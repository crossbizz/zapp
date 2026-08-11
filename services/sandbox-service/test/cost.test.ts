import { newId } from '@zapp/contracts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  createCostRecorder,
  loadSandboxPricing,
  type CostRecorderDependencies,
  type UsageLedgerRow,
} from '../src/cost/recorder.js';
import { getResourceProfile } from '../src/provider/profiles.js';
import { createMemoryCostRecordingStateStore } from '../src/cost/state.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('resource profiles and sandbox cost recording', () => {
  test.each([
    ['small', { cpu: { requested: 0.5, limit: 2 }, memoryGib: { requested: 1, limit: 4 } }],
    ['standard', { cpu: { requested: 1, limit: 4 }, memoryGib: { requested: 2, limit: 8 } }],
    ['large', { cpu: { requested: 2, limit: 8 }, memoryGib: { requested: 4, limit: 16 } }],
  ] as const)('applies the %s profile to its requested and limit resources', (name, expected) => {
    expect(getResourceProfile(name)).toEqual(expected);
  });

  test('records hand-calculated requested-or-observed usage with complete attribution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zapp-cost-'));
    temporaryDirectories.push(directory);
    const pricingPath = join(directory, 'pricing.json');
    await writeFile(
      pricingPath,
      JSON.stringify({
        sandbox: {
          cpuSecondUsd: 0.002,
          memoryGibSecondUsd: 0.0005,
          creditsPerUsd: 100,
        },
      }),
      'utf8',
    );

    const rows: UsageLedgerRow[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    let nowMs = 0;
    const gibibyte = 1024 ** 3;
    const metrics = [
      metric(1_000_000, 0.5 * gibibyte),
      metric(5_000_000, 3 * gibibyte),
      metric(105_000_000, 1 * gibibyte),
    ];

    const dependencies: CostRecorderDependencies = {
      nowMs: () => nowMs,
      metrics: {
        sample: () => {
          const sample = metrics.shift();
          if (sample === undefined) throw new Error('unexpected metrics sample');
          return Promise.resolve(sample);
        },
      },
      ledger: {
        appendIfAbsent: (row) => {
          rows.push(row);
          return Promise.resolve();
        },
      },
      scheduler: {
        setInterval: (callback, intervalMs) => {
          expect(intervalMs).toBe(30_000);
          scheduled.push(callback);
          return callback;
        },
        clearInterval: () => undefined,
      },
    };

    const workspaceId = newId('ws');
    const organizationId = newId('org');
    const projectId = newId('proj');
    const runId = newId('run');
    const taskId = newId('task');
    const recorder = createCostRecorder(dependencies);
    const active = await recorder.start({
      workspaceId,
      organizationId,
      projectId,
      runId,
      taskId,
      operationKey: `op_${'a'.repeat(64)}`,
      profile: 'standard',
      pricing: await loadSandboxPricing(pricingPath),
    });

    nowMs = 30_000;
    await scheduled[0]?.();
    nowMs = 45_000;
    await active.terminate();

    expect(rows).toEqual([
      {
        id: `usage_${'a'.repeat(64)}_sandbox_cpu_seconds`,
        organizationId,
        projectId,
        runId,
        taskId,
        category: 'sandbox_cpu_seconds',
        provider: 'modal',
        quantity: '130',
        unit: 'cpu_second',
        costUsd: '0.260000',
        creditsCharged: '26.0000',
        occurredAt: '1970-01-01T00:00:45.000Z',
      },
      {
        id: `usage_${'a'.repeat(64)}_sandbox_mem_gib_seconds`,
        organizationId,
        projectId,
        runId,
        taskId,
        category: 'sandbox_mem_gib_seconds',
        provider: 'modal',
        quantity: '120',
        unit: 'gib_second',
        costUsd: '0.060000',
        creditsCharged: '6.0000',
        occurredAt: '1970-01-01T00:00:45.000Z',
      },
    ]);
  });

  test('recovers after a transient metrics failure and preserves the full billing window', async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const rows: UsageLedgerRow[] = [];
    const gibibyte = 1024 ** 3;
    let nowMs = 0;
    let sampleIndex = 0;
    const recorder = createCostRecorder({
      nowMs: () => nowMs,
      metrics: {
        sample: () => {
          sampleIndex += 1;
          if (sampleIndex === 2) return Promise.reject(new Error('metrics temporarily unavailable'));
          return Promise.resolve(
            sampleIndex === 1 ? metric(0, gibibyte) : metric(60_000_000, 2 * gibibyte),
          );
        },
      },
      ledger: {
        appendIfAbsent: (row) => {
          rows.push(row);
          return Promise.resolve();
        },
      },
      scheduler: {
        setInterval: (callback) => {
          scheduled.push(callback);
          return callback;
        },
        clearInterval: () => undefined,
      },
    });
    const active = await recorder.start(recordingInput('b', 'small'));

    nowMs = 30_000;
    await expect(scheduled[0]?.()).resolves.toBeUndefined();
    nowMs = 60_000;
    await scheduled[0]?.();
    await active.terminate();

    expect(rows.map(({ category, quantity }) => ({ category, quantity }))).toEqual([
      { category: 'sandbox_cpu_seconds', quantity: '60' },
      { category: 'sandbox_mem_gib_seconds', quantity: '120' },
    ]);
  });

  test('retries only the undelivered ledger category after a partial terminate failure', async () => {
    const appended: string[] = [];
    let nowMs = 0;
    let memoryAttempts = 0;
    const recorder = createCostRecorder({
      nowMs: () => nowMs,
      metrics: { sample: () => Promise.resolve(metric(0, 0)) },
      ledger: {
        appendIfAbsent: (row) => {
          appended.push(row.category);
          if (row.category === 'sandbox_mem_gib_seconds' && memoryAttempts++ === 0) {
            return Promise.reject(new Error('ledger temporarily unavailable'));
          }
          return Promise.resolve();
        },
      },
      scheduler: {
        setInterval: (callback) => callback,
        clearInterval: () => undefined,
      },
    });
    const active = await recorder.start(recordingInput('c', 'small'));
    nowMs = 30_000;

    await expect(active.terminate()).rejects.toThrow('ledger temporarily unavailable');
    await expect(active.terminate()).resolves.toHaveLength(2);
    expect(appended).toEqual([
      'sandbox_cpu_seconds',
      'sandbox_mem_gib_seconds',
      'sandbox_mem_gib_seconds',
    ]);
  });

  test('replays the stable undelivered row after a crash between category appends', async () => {
    const state = createMemoryCostRecordingStateStore();
    const appended: UsageLedgerRow[] = [];
    let nowMs = 0;
    let failMemory = true;
    const dependencies = {
      nowMs: () => nowMs,
      metrics: { sample: () => Promise.resolve(metric(0, 0)) },
      ledger: {
        appendIfAbsent(row: UsageLedgerRow) {
          appended.push(row);
          if (row.category === 'sandbox_mem_gib_seconds' && failMemory) {
            failMemory = false;
            return Promise.reject(new Error('crash after CPU append'));
          }
          return Promise.resolve();
        },
      },
      state,
      scheduler: { setInterval: () => ({}), clearInterval: () => undefined },
    } satisfies CostRecorderDependencies;
    const original = recordingInput('d', 'small');
    const first = await createCostRecorder(dependencies).start(original);
    nowMs = 30_000;
    await expect(first.terminate()).rejects.toThrow('crash after CPU append');

    const resumed = await createCostRecorder(dependencies).start({
      ...original,
      operationKey: undefined,
    });
    await expect(resumed.terminate()).resolves.toHaveLength(2);

    expect(appended.map(({ id }) => id)).toEqual([
      `usage_${'d'.repeat(64)}_sandbox_cpu_seconds`,
      `usage_${'d'.repeat(64)}_sandbox_mem_gib_seconds`,
      `usage_${'d'.repeat(64)}_sandbox_mem_gib_seconds`,
    ]);
    expect(new Set(appended.map(({ occurredAt }) => occurredAt))).toEqual(
      new Set(['1970-01-01T00:00:30.000Z']),
    );
  });

  test('serializes two active replica samples without double-counting the interval', async () => {
    const state = createMemoryCostRecordingStateStore();
    const scheduled: Array<() => Promise<void>> = [];
    const rows: UsageLedgerRow[] = [];
    let nowMs = 0;
    const dependencies: CostRecorderDependencies = {
      nowMs: () => nowMs,
      metrics: { sample: () => Promise.resolve(metric(0, 0)) },
      ledger: {
        appendIfAbsent(row) {
          rows.push(row);
          return Promise.resolve();
        },
      },
      state,
      scheduler: {
        setInterval(callback) {
          scheduled.push(callback);
          return callback;
        },
        clearInterval: () => undefined,
      },
    };
    const input = recordingInput('e', 'small');
    const [first, second] = await Promise.all([
      createCostRecorder(dependencies).start(input),
      createCostRecorder(dependencies).start(input),
    ]);
    nowMs = 30_000;
    await Promise.all(scheduled.map(async (sample) => sample()));
    await first.terminate();
    await second.close();

    expect(rows.map(({ category, quantity }) => ({ category, quantity }))).toEqual([
      { category: 'sandbox_cpu_seconds', quantity: '15' },
      { category: 'sandbox_mem_gib_seconds', quantity: '30' },
    ]);
  });

  test('canonicalizes durable decimal state before returning it to a ledger writer', async () => {
    const state = createMemoryCostRecordingStateStore();
    const workspaceId = newId('ws');
    const stored = await state.mutate(workspaceId, () => ({
      workspaceId,
      operationKey: `op_${'f'.repeat(64)}`,
      lastSampleAtMs: 1,
      lastCpuMicros: 1,
      cpuSeconds: 0.1234567,
      memoryGibSeconds: 0.7654321,
      cpuSecondUsd: 0.0000001234567,
      memoryGibSecondUsd: 0.0000007654321,
      creditsPerUsd: 100.1234567,
      finalizedAtMs: 1,
      cpuDeliveredAtMs: null,
      memoryDeliveredAtMs: null,
    }));

    expect(stored).toMatchObject({
      cpuSeconds: 0.123457,
      memoryGibSeconds: 0.765432,
      cpuSecondUsd: 0.000000123457,
      memoryGibSecondUsd: 0.000000765432,
      creditsPerUsd: 100.123457,
    });
  });
});

function recordingInput(operationCharacter: string, profile: 'small' | 'standard' | 'large') {
  return {
    workspaceId: newId('ws'),
    organizationId: newId('org'),
    projectId: newId('proj'),
    runId: newId('run'),
    taskId: newId('task'),
    operationKey: `op_${operationCharacter.repeat(64)}`,
    profile,
    pricing: { cpuSecondUsd: 0.002, memoryGibSecondUsd: 0.0005, creditsPerUsd: 100 },
  };
}

function metric(cpuMicros: number, rssBytes: number) {
  return {
    at: '2026-08-08T00:00:00.000Z',
    activeChildren: 1,
    cpu: { userMicros: cpuMicros, systemMicros: 0 },
    memory: {
      rssBytes,
      heapTotalBytes: 0,
      heapUsedBytes: 0,
      externalBytes: 0,
      arrayBuffersBytes: 0,
    },
  };
}
