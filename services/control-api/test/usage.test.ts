import { newId } from '@zapp/contracts';
import { describe, expect, it } from 'vitest';

import {
  createUsageService,
  UsageEntrySchema,
  type UsageEntry,
  type UsageStore,
} from '../src/usage/ledger.js';
import {
  FLEXPRICE_USAGE_CATEGORIES,
  syncFlexpriceCatalog,
  type FlexpriceCatalogPort,
  type FlexpriceUsageEvent,
} from '../src/usage/flexprice.js';
import { estimateUsage, loadPricingConfig } from '../src/usage/pricing.js';
import { SERVICE_TOKEN_HEADER } from '../src/internal/service-auth.js';
import type { TenantDbFactory } from '../src/tenant/db.js';
import { buildHarness } from './support/harness.js';

const NOW = '2026-08-11T12:00:00.000Z';

class MemoryUsageStore implements UsageStore {
  readonly records = new Map<
    string,
    { readonly entry: UsageEntry; readonly event: FlexpriceUsageEvent }
  >();

  record(entry: UsageEntry, event: FlexpriceUsageEvent) {
    const existing = this.records.get(entry.id);
    if (existing !== undefined) return Promise.resolve({ ...existing, created: false as const });
    const record = { entry, event };
    this.records.set(entry.id, record);
    return Promise.resolve({ ...record, created: true as const });
  }

  summary(organizationId: string, window: { readonly start: Date; readonly end: Date }) {
    const groups = new Map<
      string,
      {
        category: UsageEntry['category'];
        projectId: string | null;
        runId: string | null;
        quantity: number;
        costUsd: number;
        creditsCharged: number;
      }
    >();
    for (const { entry } of this.records.values()) {
      const occurredAt = new Date(entry.occurredAt);
      if (
        entry.organizationId !== organizationId ||
        occurredAt < window.start ||
        occurredAt >= window.end
      )
        continue;
      const key = `${entry.category}:${entry.projectId ?? ''}:${entry.runId ?? ''}`;
      const current = groups.get(key) ?? {
        category: entry.category,
        projectId: entry.projectId,
        runId: entry.runId,
        quantity: 0,
        costUsd: 0,
        creditsCharged: 0,
      };
      current.quantity += Number(entry.quantity);
      current.costUsd += Number(entry.costUsd);
      current.creditsCharged += Number(entry.creditsCharged);
      groups.set(key, current);
    }
    return Promise.resolve(
      [...groups.values()].map((row) => ({
        ...row,
        quantity: row.quantity.toFixed(6),
        costUsd: row.costUsd.toFixed(6),
        creditsCharged: row.creditsCharged.toFixed(4),
      })),
    );
  }
}

function usage(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return UsageEntrySchema.parse({
    id: `usage_${'a'.repeat(64)}_sandbox_cpu_seconds`,
    organizationId: newId('org'),
    projectId: newId('proj'),
    runId: newId('run'),
    taskId: newId('task'),
    category: 'sandbox_cpu_seconds',
    provider: 'modal',
    quantity: '60.000000',
    unit: 'cpu_second',
    costUsd: '0.120000',
    creditsCharged: '12.0000',
    occurredAt: NOW,
    ...overrides,
  });
}

describe('OPS-1B usage ledger service', () => {
  it('appends once and preserves the ledger row id as the Flexprice event id', async () => {
    const store = new MemoryUsageStore();
    const service = createUsageService({ store });
    const entry = usage();

    const first = await service.recordUsage(entry);
    const retry = await service.recordUsage(entry);

    expect(first).toEqual(retry);
    expect(store.records).toHaveLength(1);
    expect(first).toMatchObject({ ledgerRowId: entry.id, eventId: entry.id });
    expect([...store.records.values()][0]?.event).toEqual({
      event_name: 'sandbox_cpu_seconds',
      external_customer_id: entry.organizationId,
      event_id: entry.id,
      timestamp: NOW,
      properties: {
        project_id: entry.projectId,
        run_id: entry.runId,
        task_id: entry.taskId,
        quantity: 60,
        unit: 'cpu_second',
        provider: 'modal',
      },
    });
  });

  it('records a negative compensating event and nets it to zero in attribution summaries', async () => {
    const store = new MemoryUsageStore();
    const service = createUsageService({ store });
    const debit = usage();
    const correction = UsageEntrySchema.parse({
      ...debit,
      id: `usage_${'b'.repeat(64)}_sandbox_cpu_seconds`,
      quantity: '-60.000000',
      costUsd: '-0.120000',
      creditsCharged: '-12.0000',
      correctionOf: debit.id,
    });

    await service.recordUsage(debit);
    await service.recordUsage(correction);
    const summary = await service.getUsageSummary(debit.organizationId, {
      start: '2026-08-11T00:00:00.000Z',
      end: '2026-08-12T00:00:00.000Z',
    });

    expect(summary).toEqual([
      expect.objectContaining({
        category: 'sandbox_cpu_seconds',
        quantity: '0.000000',
        costUsd: '0.000000',
        creditsCharged: '0.0000',
      }),
    ]);
    expect([...store.records.values()][1]?.event).toMatchObject({
      event_id: correction.id,
      properties: { quantity: -60, correction_of: debit.id },
    });
  });

  it('rejects categories outside the FND-5 enum before persistence', async () => {
    const store = new MemoryUsageStore();
    const service = createUsageService({ store });
    await expect(
      service.recordUsage({ ...usage(), category: 'gpu_magic_seconds' }),
    ).rejects.toThrow(/category/u);
    expect(store.records).toHaveLength(0);
  });

  it('exposes only the service-token-authenticated internal ingestion route', async () => {
    const store = new MemoryUsageStore();
    const service = createUsageService({ store });
    const tenantDb = (() => ({})) as unknown as TenantDbFactory;
    const wired = buildHarness({ tenantDb, usage: service });
    const entry = usage();

    const anonymous = await wired.app.inject({
      method: 'POST',
      url: '/internal/usage',
      payload: entry,
    });
    expect(anonymous.statusCode).toBe(401);

    const accepted = await wired.app.inject({
      method: 'POST',
      url: '/internal/usage',
      headers: {
        [SERVICE_TOKEN_HEADER]: await wired.serviceTokens.issue('sandbox-service', {
          aud: 'control-api:usage.ingest',
        }),
      },
      payload: entry,
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toEqual({ ledgerRowId: entry.id, eventId: entry.id });
    expect(store.records).toHaveLength(1);
    await wired.app.close();
  });
});

describe('OPS-1B exact usage estimates', () => {
  const pricing = loadPricingConfig({
    version: 'm2-test',
    defaultRunCreditCeiling: '100.0000',
    creditsPerUsd: '100.0000',
    models: {
      'anthropic/claude-sonnet-5': {
        inputUsdPerMillion: '3.000000',
        outputUsdPerMillion: '15.000000',
        cacheReadUsdPerMillion: '0.300000',
        cacheWriteUsdPerMillion: '3.750000',
      },
    },
    usageRates: {
      sandbox_cpu_seconds: { usdPerUnit: '0.002000' },
      sandbox_mem_gib_seconds: { usdPerUnit: '0.000500' },
      storage_gib_hours: { usdPerUnit: '0.000100' },
      deploy_provider: { usdPerUnit: '0.001000' },
      artifact_storage: { usdPerUnit: '0.000100' },
    },
  });

  it.each([
    [
      'input tokens',
      {
        category: 'model_input_tokens',
        quantity: '1000',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        unit: 'input_tokens',
      },
      { costUsd: '0.003000', credits: '0.3000' },
    ],
    [
      'cpu seconds',
      { category: 'sandbox_cpu_seconds', quantity: '60', provider: 'modal', unit: 'cpu_second' },
      { costUsd: '0.120000', credits: '12.0000' },
    ],
    [
      'GiB seconds',
      {
        category: 'sandbox_mem_gib_seconds',
        quantity: '120',
        provider: 'modal',
        unit: 'gib_second',
      },
      { costUsd: '0.060000', credits: '6.0000' },
    ],
  ] as const)('prices %s without floating-point drift', (_name, input, expected) => {
    expect(estimateUsage(pricing, input)).toEqual({
      quantity: input.quantity,
      ...expected,
    });
  });
});

describe('OPS-1B Flexprice bootstrap convergence', () => {
  it('creates every usage feature, its SUM meter, plans and entitlements once', async () => {
    const features = new Map<string, { readonly id: string; readonly meterId: string }>();
    const plans = new Map<string, { readonly id: string }>();
    const entitlements = new Set<string>();
    const mutations: unknown[] = [];
    const catalog: FlexpriceCatalogPort = {
      featureByLookupKey: (lookupKey) => Promise.resolve(features.get(lookupKey)),
      createMeteredFeature: (input) => {
        mutations.push(input);
        const created = {
          id: `feature-${String(features.size + 1)}`,
          meterId: `meter-${String(features.size + 1)}`,
        };
        features.set(input.lookupKey, created);
        return Promise.resolve(created);
      },
      planByLookupKey: (lookupKey) => Promise.resolve(plans.get(lookupKey)),
      createPlan: (input) => {
        mutations.push(input);
        const created = { id: `plan-${String(plans.size + 1)}` };
        plans.set(input.lookupKey, created);
        return Promise.resolve(created);
      },
      hasEntitlement: (planId, featureId) =>
        Promise.resolve(entitlements.has(`${planId}:${featureId}`)),
      createEntitlement: (input) => {
        mutations.push(input);
        entitlements.add(`${input.planId}:${input.featureId}`);
        return Promise.resolve();
      },
    };
    const planConfig = {
      plans: {
        trial: {
          concurrentAutonomousRuns: 1,
          concurrentSandboxes: 1,
          maxResourceProfile: 'small',
          maxRunBudgetCredits: 100,
          maxPreviewLifetimeHours: 1,
          artifactRetentionDays: 7,
          monthlyCredits: 100,
          seats: 1,
        },
      },
    };

    await syncFlexpriceCatalog(catalog, planConfig);
    const firstMutationCount = mutations.length;
    await syncFlexpriceCatalog(catalog, planConfig);

    expect(features.size).toBe(FLEXPRICE_USAGE_CATEGORIES.length);
    for (const [index, category] of FLEXPRICE_USAGE_CATEGORIES.entries()) {
      expect(mutations[index]).toEqual(
        expect.objectContaining({
          lookupKey: `zapp_usage_${category}`,
          eventName: category,
          aggregation: { type: 'SUM', field: 'quantity' },
        }),
      );
    }
    expect(plans).toHaveLength(1);
    expect(entitlements.size).toBe(FLEXPRICE_USAGE_CATEGORIES.length);
    expect(mutations).toHaveLength(firstMutationCount);
  });
});
