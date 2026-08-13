import { METERED_USAGE_CATEGORIES } from '@zapp/db';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { USAGE_CATEGORIES as FLEXPRICE_CATEGORIES } from '../../../../scripts/flexprice-bootstrap.js';
import { SANDBOX_USAGE_CATEGORIES } from '../../../sandbox-service/src/cost/recorder.js';
import {
  createDeploymentUsageCollector,
  DEPLOYMENT_USAGE_CATEGORIES,
  PRD_METERING_COVERAGE,
} from '../../src/usage/collectors/git.js';
import {
  createDailyStorageCollector,
  createDailyStorageCollectorLifecycle,
  createR2ArtifactStorageMeasurement,
  STORAGE_USAGE_CATEGORIES,
} from '../../src/usage/collectors/storage.js';
import type { UsageEntry } from '../../src/usage/ledger.js';
import { MODEL_COMPLETION_USAGE_CATEGORIES } from '../../src/usage/model-completions.js';
import {
  createFlexpriceUsageAggregateClient,
  createCoordinatedUsageReconciliationJob,
  createThreeWayUsageReconciler,
  createUsageReconciliationLifecycle,
} from '../../src/usage/reconciliation.js';
import { loadPricingConfig } from '../../src/usage/pricing.js';

const ids = {
  organizationId: 'org_01J00000000000000000000000',
  projectId: 'proj_01J00000000000000000000000',
  runId: 'run_01J00000000000000000000000',
} as const;

const pricing = loadPricingConfig({
  version: 'ops-2-test',
  defaultRunCreditCeiling: '100.0000',
  creditsPerUsd: '100.0000',
  usageRates: {
    storage_gib_hours: { unit: 'gib_hours', usdPerUnit: '0.000100' },
    deploy_provider: { unit: 'deployment', usdPerUnit: '0.010000' },
    artifact_storage: { unit: 'gib', usdPerUnit: '0.000100' },
  },
  models: {
    'openai/gpt-5-mini': {
      inputUsdPerMillion: '0.250000',
      outputUsdPerMillion: '2.000000',
      cacheReadUsdPerMillion: '0.025000',
      cacheWriteUsdPerMillion: '0.250000',
    },
  },
});

describe('OPS-2 metering collectors', () => {
  it('paginates the real project R2 prefix and sums every object byte', async () => {
    const commands: ListObjectsV2Command[] = [];
    const measurement = createR2ArtifactStorageMeasurement(
      { bucket: 'artifacts' },
      {
        send(command) {
          if (!(command instanceof ListObjectsV2Command)) throw new Error('unexpected command');
          commands.push(command);
          return Promise.resolve(
            commands.length === 1
              ? { Contents: [{ Size: 5 }, { Size: 7 }], NextContinuationToken: 'page-2' }
              : { Contents: [{ Size: 11 }] },
          );
        },
      },
    );

    await expect(
      measurement.measurePrefixBytes({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
      }),
    ).resolves.toBe('23');
    expect(commands.map(({ input }) => input)).toEqual([
      {
        Bucket: 'artifacts',
        Prefix: `org/${ids.organizationId}/project/${ids.projectId}/`,
      },
      {
        Bucket: 'artifacts',
        Prefix: `org/${ids.organizationId}/project/${ids.projectId}/`,
        ContinuationToken: 'page-2',
      },
    ]);
  });

  it('claims and bills the previously closed UTC day instead of the mutable current day', async () => {
    const rows: UsageEntry[] = [];
    const claims: string[] = [];
    const collector = createDailyStorageCollector({
      projects: {
        listMeteredProjects: () =>
          Promise.resolve([{ organizationId: ids.organizationId, projectId: ids.projectId }]),
      },
      artifactStorage: { measurePrefixBytes: () => Promise.resolve(String(1024 ** 3)) },
      sandboxStorage: {
        measureProjectBytes: () => Promise.resolve({ snapshotBytes: '0', volumeBytes: '0' }),
      },
      claims: {
        claim(bucket) {
          claims.push(`${bucket.from}/${bucket.to}`);
          return Promise.resolve({
            status: 'acquired' as const,
            leaseToken: 'storage-lease-1',
            renewAfterMs: 10,
          });
        },
        renew: () => Promise.resolve(true),
        runFenced: (_bucket, _leaseToken, operation) => operation(),
        complete: () => Promise.resolve(),
      },
      ledger: {
        findByOperationKey: () => Promise.resolve(undefined),
        recordUsage(entry) {
          rows.push(entry);
          return Promise.resolve({});
        },
      },
      pricing,
    });

    await collector.collect(new Date('2026-08-11T18:00:00.000Z'));

    expect(claims).toEqual(['2026-08-10T00:00:00.000Z/2026-08-11T00:00:00.000Z']);
    expect(rows).toEqual([
      expect.objectContaining({ occurredAt: '2026-08-10T23:59:59.999Z' }),
    ]);
  });

  it('records one daily R2 prefix gauge and 24 hours of sandbox storage with stable identities', async () => {
    // Break caught: bytes are billed directly, snapshot/volume storage loses its
    // 24-hour conversion, or a retry invents a second immutable ledger identity.
    const rows = new Map<string, UsageEntry>();
    const recordUsage = vi.fn((entry: UsageEntry) => {
      const existing = rows.get(entry.operationKey);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) {
        throw new Error('conflicting operation');
      }
      rows.set(entry.operationKey, entry);
      return Promise.resolve({ ledgerRowId: entry.operationKey });
    });
    const collector = createDailyStorageCollector({
      projects: {
        listMeteredProjects: () =>
          Promise.resolve([{ organizationId: ids.organizationId, projectId: ids.projectId }]),
      },
      artifactStorage: {
        measurePrefixBytes: () => Promise.resolve(String(1024 ** 3)),
      },
      sandboxStorage: {
        measureProjectBytes: () =>
          Promise.resolve({
            snapshotBytes: String(512 * 1024 ** 2),
            volumeBytes: String(1536 * 1024 ** 2),
          }),
      },
      ledger: { recordUsage },
      pricing,
    });

    await expect(collector.collect(new Date('2026-08-11T23:55:00.000Z'))).resolves.toEqual({
      projects: 1,
      recorded: 2,
    });
    const first = [...rows.values()];
    await expect(collector.collect(new Date('2026-08-11T01:00:00.000Z'))).resolves.toEqual({
      projects: 1,
      recorded: 2,
    });

    expect(rows.size).toBe(2);
    expect([...rows.values()]).toEqual(first);
    expect(first).toEqual([
      expect.objectContaining({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        runId: null,
        taskId: null,
        category: 'artifact_storage',
        provider: 'r2',
        quantity: '1.000000',
        unit: 'gib',
        costUsd: '0.000100',
        creditsCharged: '0.0100',
        occurredAt: '2026-08-10T23:59:59.999Z',
        metadata: {},
      }),
      expect.objectContaining({
        category: 'storage_gib_hours',
        provider: 'modal',
        quantity: '48.000000',
        unit: 'gib_hours',
        costUsd: '0.004800',
        creditsCharged: '0.4800',
        occurredAt: '2026-08-10T23:59:59.999Z',
        metadata: {},
      }),
    ]);
    expect(first[0]?.operationKey).not.toBe(first[1]?.operationKey);
  });

  it('skips zero storage gauges instead of sending ledger-invalid zero rows', async () => {
    const recordUsage = vi.fn();
    const collector = createDailyStorageCollector({
      projects: {
        listMeteredProjects: () =>
          Promise.resolve([{ organizationId: ids.organizationId, projectId: ids.projectId }]),
      },
      artifactStorage: { measurePrefixBytes: () => Promise.resolve('0') },
      sandboxStorage: {
        measureProjectBytes: () => Promise.resolve({ snapshotBytes: '0', volumeBytes: '0' }),
      },
      ledger: { recordUsage },
      pricing,
    });

    await expect(collector.collect(new Date('2026-08-11T12:00:00.000Z'))).resolves.toEqual({
      projects: 1,
      recorded: 0,
    });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('runs storage collection on startup and a single-flight daily schedule', async () => {
    // Break caught: the collector exists but no daily production job invokes it,
    // or overlapping timer ticks double-meter a project-day.
    let intervalCallback: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const collect = vi
      .fn<(instant: Date) => Promise<{ projects: number; recorded: number }>>()
      .mockResolvedValueOnce({ projects: 1, recorded: 2 })
      .mockImplementationOnce(() => second.then(() => ({ projects: 1, recorded: 2 })));
    const clearInterval = vi.fn();
    const lifecycle = createDailyStorageCollectorLifecycle({
      collector: { collect },
      now: () => new Date('2026-08-11T12:00:00.000Z'),
      timers: {
        setInterval(callback, delayMs) {
          expect(delayMs).toBe(86_400_000);
          intervalCallback = callback;
          return { kind: 'daily-timer' };
        },
        clearInterval,
      },
    });

    await lifecycle.start();
    await vi.waitFor(() => {
      intervalCallback?.();
      expect(collect).toHaveBeenCalledTimes(2);
    });
    intervalCallback?.();
    expect(collect).toHaveBeenCalledTimes(2);
    releaseSecond?.();
    await lifecycle.close();
    expect(clearInterval).toHaveBeenCalledOnce();
  });

  it('does not block service readiness on the initial daily storage scan', async () => {
    // Break caught: Fastify's composite lifecycle awaits a slow R2/Modal scan
    // before the API can listen and report ready.
    let release: (() => void) | undefined;
    const initial = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onError = vi.fn();
    const lifecycle = createDailyStorageCollectorLifecycle({
      collector: {
        collect: () => initial.then(() => ({ projects: 0, recorded: 0 })),
      },
      onError,
      timers: { setInterval: () => ({ timer: 'daily' }), clearInterval: vi.fn() },
    });
    let ready = false;
    const started = lifecycle.start().then(() => {
      ready = true;
    });

    await Promise.resolve();
    expect(ready).toBe(true);
    release?.();
    await started;
    await lifecycle.close();
    expect(onError).not.toHaveBeenCalled();
  });

  it('renews the fenced lease while one provider probe exceeds the lease duration', async () => {
    // Break caught: a long Modal `du` probe lets another replica take over while
    // the first owner is still measuring the same project-day.
    let heartbeat: (() => void) | undefined;
    let releaseProbe: (() => void) | undefined;
    const probe = new Promise<string>((resolve) => {
      releaseProbe = () => {
        resolve('0');
      };
    });
    const renew = vi.fn(() => Promise.resolve(true));
    const complete = vi.fn(() => Promise.resolve());
    const collector = createDailyStorageCollector({
      projects: {
        listMeteredProjects: () =>
          Promise.resolve([{ organizationId: ids.organizationId, projectId: ids.projectId }]),
      },
      artifactStorage: { measurePrefixBytes: () => probe },
      sandboxStorage: {
        measureProjectBytes: () => Promise.resolve({ snapshotBytes: '0', volumeBytes: '0' }),
      },
      claims: {
        claim: () =>
          Promise.resolve({
            status: 'acquired' as const,
            leaseToken: 'fence-1',
            renewAfterMs: 5,
          }),
        renew,
        runFenced: (_bucket, _leaseToken, operation) => operation(),
        complete,
      },
      claimTimers: {
        setInterval(callback, delayMs) {
          expect(delayMs).toBe(5);
          heartbeat = callback;
          return { timer: 'lease' };
        },
        clearInterval: vi.fn(),
      },
      ledger: { recordUsage: () => Promise.resolve({}) },
      pricing,
    });

    const collecting = collector.collect(new Date('2026-08-11T12:00:00.000Z'));
    await vi.waitFor(() => {
      expect(heartbeat).toBeTypeOf('function');
    });
    heartbeat?.();
    await vi.waitFor(() => {
      expect(renew).toHaveBeenCalledWith(expect.any(Object), 'fence-1');
    });
    releaseProbe?.();
    await expect(collecting).resolves.toEqual({ projects: 1, recorded: 0 });
    expect(complete).toHaveBeenCalledWith(expect.any(Object), 'fence-1');
  });

  it('fails closed before recording when fenced storage ownership is lost mid-scan', async () => {
    let heartbeat: (() => void) | undefined;
    const recordUsage = vi.fn(() => Promise.resolve({}));
    const collector = createDailyStorageCollector({
      projects: {
        async listMeteredProjects() {
          heartbeat?.();
          await Promise.resolve();
          return [{ organizationId: ids.organizationId, projectId: ids.projectId }];
        },
      },
      artifactStorage: {
        measurePrefixBytes: () => Promise.resolve(String(1024 ** 3)),
      },
      sandboxStorage: {
        measureProjectBytes: () => Promise.resolve({ snapshotBytes: '0', volumeBytes: '0' }),
      },
      claims: {
        claim: () =>
          Promise.resolve({
            status: 'acquired' as const,
            leaseToken: 'fence-lost',
            renewAfterMs: 5,
          }),
        renew: () => Promise.resolve(false),
        runFenced: (_bucket, _leaseToken, operation) => operation(),
        complete: () => Promise.resolve(),
      },
      claimTimers: {
        setInterval(callback) {
          heartbeat = callback;
          return { timer: 'lease' };
        },
        clearInterval: vi.fn(),
      },
      ledger: { recordUsage },
      pricing,
    });

    await expect(
      collector.collect(new Date('2026-08-11T12:00:00.000Z')),
    ).rejects.toThrow('daily storage lease ownership was lost');
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('keeps renewing across a 1000-project daily scan', async () => {
    let heartbeat: (() => void) | undefined;
    const renew = vi.fn(() => Promise.resolve(true));
    let probes = 0;
    const projects = Array.from({ length: 1_000 }, (_, index) => ({
      organizationId: ids.organizationId,
      projectId: `proj_${String(index).padStart(26, '0')}`,
    }));
    const tickHalfway = async (): Promise<string> => {
      probes += 1;
      if (probes === 1_000) {
        heartbeat?.();
        await Promise.resolve();
      }
      return '0';
    };
    const collector = createDailyStorageCollector({
      projects: { listMeteredProjects: () => Promise.resolve(projects) },
      artifactStorage: { measurePrefixBytes: tickHalfway },
      sandboxStorage: {
        measureProjectBytes: async () => ({
          snapshotBytes: await tickHalfway(),
          volumeBytes: '0',
        }),
      },
      claims: {
        claim: () =>
          Promise.resolve({
            status: 'acquired' as const,
            leaseToken: 'fence-1000',
            renewAfterMs: 5,
          }),
        renew,
        runFenced: (_bucket, _leaseToken, operation) => operation(),
        complete: () => Promise.resolve(),
      },
      claimTimers: {
        setInterval(callback) {
          heartbeat = callback;
          return { timer: 'lease' };
        },
        clearInterval: vi.fn(),
      },
      ledger: { recordUsage: () => Promise.resolve({}) },
      pricing,
    });

    await expect(collector.collect(new Date('2026-08-11T12:00:00.000Z'))).resolves.toEqual({
      projects: 1_000,
      recorded: 0,
    });
    expect(renew).toHaveBeenCalled();
    expect(probes).toBe(2_000);
  });

  it('holds the durable fence while a ledger write triggers a competing ownership claim', async () => {
    // Break caught: a pre/post heartbeat detects a lost lease only after the
    // stale replica has already committed the immutable project-day row.
    let fenceLocked = false;
    let ownershipTransferred = false;
    const rows: UsageEntry[] = [];
    const collector = createDailyStorageCollector({
      projects: {
        listMeteredProjects: () =>
          Promise.resolve([{ organizationId: ids.organizationId, projectId: ids.projectId }]),
      },
      artifactStorage: { measurePrefixBytes: () => Promise.resolve(String(1024 ** 3)) },
      sandboxStorage: {
        measureProjectBytes: () => Promise.resolve({ snapshotBytes: '0', volumeBytes: '0' }),
      },
      claims: {
        claim: () =>
          Promise.resolve({
            status: 'acquired' as const,
            leaseToken: 'fence-write',
            renewAfterMs: 5,
          }),
        renew: () => Promise.resolve(!ownershipTransferred),
        async runFenced(_bucket, _leaseToken, operation) {
          if (ownershipTransferred) throw new Error('daily storage lease ownership was lost');
          fenceLocked = true;
          try {
            return await operation();
          } finally {
            fenceLocked = false;
          }
        },
        complete: () => {
          if (ownershipTransferred) {
            return Promise.reject(new Error('daily storage lease ownership was lost'));
          }
          return Promise.resolve();
        },
      },
      ledger: {
        recordUsage(entry) {
          if (!fenceLocked) ownershipTransferred = true;
          rows.push(entry);
          return Promise.resolve({});
        },
      },
      pricing,
    });

    await expect(collector.collect(new Date('2026-08-11T12:00:00.000Z'))).resolves.toEqual({
      projects: 1,
      recorded: 1,
    });
    expect(rows).toHaveLength(1);
    expect(ownershipTransferred).toBe(false);
  });

  it('records one deployment unit and preserves provider build seconds when measurable', async () => {
    // Break caught: provider deployment usage is never emitted, is double-counted
    // on retry, or measurable build duration disappears before Flexprice.
    const recorded: UsageEntry[] = [];
    const collector = createDeploymentUsageCollector({
      ledger: {
        recordUsage(entry) {
          recorded.push(entry);
          return Promise.resolve({ ledgerRowId: entry.operationKey });
        },
      },
      pricing,
    });

    await collector.record({
      ...ids,
      taskId: null,
      deploymentId: 'dep_01J00000000000000000000000',
      provider: 'fly',
      buildSeconds: 125.5,
      occurredAt: '2026-08-11T18:00:00.000Z',
    });

    expect(recorded).toEqual([
      expect.objectContaining({
        category: 'deploy_provider',
        provider: 'fly',
        quantity: '1.000000',
        unit: 'deployment',
        costUsd: '0.010000',
        creditsCharged: '1.0000',
        metadata: { build_seconds: '125.500000' },
      }),
    ]);
  });

  it('enumerates every PRD category and maps every enabled provider cost to ledger and Flexprice', () => {
    // Break caught: an emitter category is added without a persisted enum or
    // metered feature, or the conditional GPU row is accidentally billed before enablement.
    expect(PRD_METERING_COVERAGE.map(({ source }) => source)).toEqual([
      'model_input_tokens',
      'model_output_tokens',
      'model_cached_tokens',
      'modal_cpu_seconds',
      'modal_memory_gib_seconds',
      'modal_gpu_usage_if_enabled',
      'snapshot_and_volume_storage',
      'deployment_provider_usage',
      'artifact_storage',
    ]);
    expect(PRD_METERING_COVERAGE.find(({ source }) => source.includes('gpu'))).toEqual({
      source: 'modal_gpu_usage_if_enabled',
      enabled: false,
      emitter: 'sandbox-service',
      category: null,
    });

    const enabledCategories = PRD_METERING_COVERAGE.filter(({ enabled }) => enabled)
      .map(({ category }) => category)
      .sort();
    expect(enabledCategories).toEqual([...METERED_USAGE_CATEGORIES].sort());
    expect([...FLEXPRICE_CATEGORIES].sort()).toEqual([...METERED_USAGE_CATEGORIES].sort());
    expect([...MODEL_COMPLETION_USAGE_CATEGORIES].sort()).toEqual(
      ['model_cached_tokens', 'model_input_tokens', 'model_output_tokens'].sort(),
    );
    expect([...SANDBOX_USAGE_CATEGORIES].sort()).toEqual(
      ['sandbox_cpu_seconds', 'sandbox_mem_gib_seconds'].sort(),
    );
    expect(
      [
        ...MODEL_COMPLETION_USAGE_CATEGORIES,
        ...SANDBOX_USAGE_CATEGORIES,
        ...STORAGE_USAGE_CATEGORIES,
        ...DEPLOYMENT_USAGE_CATEGORIES,
      ].sort(),
    ).toEqual([...METERED_USAGE_CATEGORIES].sort());
  });
});

describe('OPS-2 three-way reconciliation', () => {
  it('alerts and heals only drift over one percent with the ledger as arbiter', async () => {
    // Break caught: exactly-one-percent noise heals, zero-ledger stale counters
    // survive, or a vendor/cache value overwrites the append-only ledger total.
    const redisWrites: unknown[] = [];
    const flexpriceHeals: unknown[] = [];
    const alerts: unknown[] = [];
    const healed: unknown[] = [];
    const order: string[] = [];
    const aggregateReads = vi.fn(() =>
      Promise.resolve({
        model_input_tokens: '98.9',
        model_output_tokens: '0',
        model_cached_tokens: '25',
        sandbox_cpu_seconds: '25',
        sandbox_mem_gib_seconds: '25',
        storage_gib_hours: '25',
        deploy_provider: '25',
        artifact_storage: '25',
      }),
    );
    const reconciler = createThreeWayUsageReconciler({
      scopes: { list: () => Promise.resolve([ids]) },
      ledger: {
        readTotal: (_scope, category) =>
          Promise.resolve(
            category === 'model_input_tokens'
              ? '100'
              : category === 'model_output_tokens'
                ? '0'
                : '25',
          ),
      },
      redis: {
        readTotal: (_scope, category) =>
          Promise.resolve(
            category === 'model_input_tokens'
              ? '99'
              : category === 'model_output_tokens'
                ? '1'
                : '25',
          ),
        writeTotal: (input) => {
          redisWrites.push(input);
          return Promise.resolve();
        },
      },
      flexprice: {
        readAggregates: aggregateReads,
      },
      corrections: {
        correct(input) {
          order.push('flexprice-write');
          flexpriceHeals.push(input);
          return Promise.resolve('submitted' as const);
        },
        confirm: () => Promise.resolve('none' as const),
      },
      alerts: {
        driftDetected(input) {
          order.push('detected');
          alerts.push(input);
          return Promise.resolve();
        },
        driftHealed(input) {
          order.push('healed');
          healed.push(input);
          return Promise.resolve();
        },
      },
    });

    await expect(
      reconciler.runOnce({
        from: '2026-08-11T00:00:00.000Z',
        to: '2026-08-12T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      scopes: 1,
      checked: 8,
      drifted: 2,
      redisHealed: 1,
      flexpriceHealed: 0,
    });
    expect(redisWrites).toEqual([
      expect.objectContaining({ category: 'model_output_tokens', quantity: '0.000000' }),
    ]);
    expect(flexpriceHeals).toEqual([
      expect.objectContaining({
        category: 'model_input_tokens',
        targetQuantity: '100.000000',
        deltaQuantity: '1.100000',
      }),
    ]);
    expect(alerts).toHaveLength(2);
    expect(healed).toEqual([
      expect.objectContaining({ category: 'model_output_tokens', redisDrifted: true }),
    ]);
    expect(aggregateReads).toHaveBeenCalledOnce();
    expect(order.indexOf('detected')).toBeLessThan(order.indexOf('flexprice-write'));
    expect(order.at(-1)).toBe('healed');
  });

  it('keeps an accepted correction pending until a later aggregate confirms its target', async () => {
    // Break caught: HTTP acceptance is logged as healed, or each minute submits
    // the same full delta while Flexprice analytics still lag the accepted event.
    let observed = '9';
    const corrections: unknown[] = [];
    const healed: unknown[] = [];
    let pending = false;
    const aggregate = (): Record<(typeof METERED_USAGE_CATEGORIES)[number], string> =>
      Object.fromEntries(
        METERED_USAGE_CATEGORIES.map((category) => [
          category,
          category === 'model_input_tokens' ? observed : '0',
        ]),
      ) as Record<(typeof METERED_USAGE_CATEGORIES)[number], string>;
    const reconciler = createThreeWayUsageReconciler({
      scopes: { list: () => Promise.resolve([ids]) },
      ledger: {
        readTotal: (_scope, category) =>
          Promise.resolve(category === 'model_input_tokens' ? '10' : '0'),
      },
      redis: {
        readTotal: (_scope, category) =>
          Promise.resolve(category === 'model_input_tokens' ? '10' : '0'),
        writeTotal: () => Promise.resolve(),
      },
      flexprice: { readAggregates: () => Promise.resolve(aggregate()) },
      corrections: {
        correct(input) {
          corrections.push(input);
          pending = true;
          return Promise.resolve(corrections.length === 1 ? ('submitted' as const) : ('pending' as const));
        },
        confirm(input) {
          if (input.category !== 'model_input_tokens' || !pending) {
            return Promise.resolve('none' as const);
          }
          pending = false;
          return Promise.resolve('confirmed' as const);
        },
      },
      alerts: {
        driftDetected: () => Promise.resolve(),
        driftHealed(input) {
          healed.push(input);
          return Promise.resolve();
        },
      },
    });
    const window = {
      from: '2026-08-11T00:00:00.000Z',
      to: '2026-08-12T00:00:00.000Z',
    };

    await expect(reconciler.runOnce(window)).resolves.toMatchObject({ flexpriceHealed: 0 });
    await expect(reconciler.runOnce(window)).resolves.toMatchObject({ flexpriceHealed: 0 });
    expect(corrections).toHaveLength(2);
    expect(healed).toEqual([]);

    observed = '10';
    await expect(reconciler.runOnce(window)).resolves.toMatchObject({ flexpriceHealed: 1 });
    expect(corrections).toHaveLength(2);
    expect(healed).toEqual([
      expect.objectContaining({
        category: 'model_input_tokens',
        ledgerQuantity: '10.000000',
        flexpriceQuantity: '10.000000',
      }),
    ]);
  });

  it('queries Flexprice analytics once for the nullable ledger attribution scope', async () => {
    const requests: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push({ path: url.pathname, body });
      const groupBy = body.group_by;
      const validGroupBy =
        Array.isArray(groupBy) &&
        groupBy.every(
          (field) =>
            field === 'source' ||
            field === 'feature_id' ||
            (typeof field === 'string' && field.startsWith('properties.')),
        );
      if (!validGroupBy) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid group_by' }), { status: 400 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              {
                feature_id: 'feature-model-input',
                meter_id: 'meter-model-input',
                meter: {
                  id: 'meter-model-input',
                  event_name: 'model_input_tokens',
                  name: 'model_input_tokens usage',
                  environment_id: 'env-test',
                  status: 'published',
                },
                properties: {
                  project_id: ids.projectId,
                  run_id: ids.runId,
                  task_id: null,
                },
                total_usage: '12.500000',
              },
              {
                feature_id: 'feature-model-output',
                meter_id: 'meter-model-output',
                meter: {
                  id: 'meter-model-output',
                  event_name: 'model_output_tokens',
                  name: 'model_output_tokens usage',
                  environment_id: 'env-test',
                  status: 'published',
                },
                properties: {
                  project_id: ids.projectId,
                  run_id: ids.runId,
                  task_id: null,
                },
                total_usage: '3',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const client = createFlexpriceUsageAggregateClient({
      baseUrl: 'https://flexprice.example/v1',
      apiKey: 'test-api-key',
      fetch: fakeFetch,
    });
    const scope = {
      ...ids,
      taskId: null,
      from: '2026-08-11T00:00:00.000Z',
      to: '2026-08-12T00:00:00.000Z',
    };

    await expect(client.readAggregates(scope)).resolves.toMatchObject({
      model_input_tokens: '12.500000',
      model_output_tokens: '3.000000',
    });

    expect(requests[0]).toEqual({
      path: '/v1/events/analytics',
      body: {
        start_time: scope.from,
        end_time: scope.to,
        external_customer_id: ids.organizationId,
        group_by: [
          'feature_id',
          'properties.project_id',
          'properties.run_id',
          'properties.task_id',
        ],
        expand: ['meter'],
        property_filters: {
          project_id: [ids.projectId],
          run_id: [ids.runId],
        },
      },
    });
    expect(requests).toHaveLength(1);
  });

  it('rejects an analytics item whose expanded meter lacks its event identity', async () => {
    // Break caught: a partial test fixture is accepted even though the documented
    // expanded meter cannot map the feature aggregate back to a ledger category.
    const client = createFlexpriceUsageAggregateClient({
      baseUrl: 'https://flexprice.example/v1',
      apiKey: 'test-api-key',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  event_name: 'model_input_tokens',
                  feature_id: 'feature-model-input',
                  meter_id: 'meter-model-input',
                  meter: {},
                  total_usage: '12.500000',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
    });

    await expect(
      client.readAggregates({
        ...ids,
        taskId: null,
        from: '2026-08-11T00:00:00.000Z',
        to: '2026-08-12T00:00:00.000Z',
      }),
    ).rejects.toThrow(/meter|event_name/u);
  });

  it('reconciles the previously closed UTC day at least once per minute without overlap', async () => {
    let intervalCallback: (() => void) | undefined;
    const runOnce = vi.fn(() =>
      Promise.resolve({ scopes: 0, checked: 0, drifted: 0, redisHealed: 0, flexpriceHealed: 0 }),
    );
    const lifecycle = createUsageReconciliationLifecycle({
      reconciler: { runOnce },
      now: () => new Date('2026-08-11T12:34:56.000Z'),
      timers: {
        setInterval(callback, delayMs) {
          expect(delayMs).toBe(60_000);
          intervalCallback = callback;
          return { kind: 'reconciliation-timer' };
        },
        clearInterval: vi.fn(),
      },
    });

    await lifecycle.start();
    expect(runOnce).toHaveBeenLastCalledWith({
      from: '2026-08-10T00:00:00.000Z',
      to: '2026-08-11T00:00:00.000Z',
    });
    intervalCallback?.();
    await lifecycle.close();
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it('reports an initial Flexprice outage without blocking control-api startup', async () => {
    let intervalCallback: (() => void) | undefined;
    const outage = new Error('Flexprice unavailable');
    const onError = vi.fn();
    const runOnce = vi.fn().mockRejectedValueOnce(outage).mockResolvedValueOnce({});
    const lifecycle = createUsageReconciliationLifecycle({
      reconciler: { runOnce },
      now: () => new Date('2026-08-11T12:34:56.000Z'),
      onError,
      timers: {
        setInterval(callback, delayMs) {
          expect(delayMs).toBe(60_000);
          intervalCallback = callback;
          return { kind: 'reconciliation-timer' };
        },
        clearInterval: vi.fn(),
      },
    });

    await expect(lifecycle.start()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(outage);
    intervalCallback?.();
    await lifecycle.close();
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it('reconciles only a leased closed window after every ledger outbox row is delivered', async () => {
    const order: string[] = [];
    let drained = false;
    const job = createCoordinatedUsageReconciliationJob({
      coordinator: {
        claim: () => Promise.resolve('acquired'),
        isOutboxDrained: () => Promise.resolve(drained),
        complete: () => {
          order.push('complete');
          return Promise.resolve();
        },
      },
      reconciler: {
        runOnce() {
          order.push('reconcile');
          return Promise.resolve({ ok: true });
        },
      },
    });
    const window = {
      from: '2026-08-10T00:00:00.000Z',
      to: '2026-08-11T00:00:00.000Z',
    };

    await expect(job.runOnce(window)).resolves.toEqual({ acquired: true, drained: false });
    expect(order).toEqual([]);
    drained = true;
    await expect(job.runOnce(window)).resolves.toEqual({ ok: true });
    expect(order).toEqual(['reconcile', 'complete']);
  });
});
