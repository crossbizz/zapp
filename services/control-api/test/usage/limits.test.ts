import { describe, expect, it } from 'vitest';

import {
  CreditBalanceExhaustedError,
  PlanLimitConcurrentRunsError,
  assertConcurrentRunAdmission,
  clampResourceProfile,
  createBudgetThresholdAlerts,
  createPlanLimitsAdapter,
  createCachedCreditBalanceGate,
  createFlexpriceWalletClient,
  loadPlanLimitsConfig,
  resolveRunBudget,
} from '../../src/usage/limits.js';

const organizationId = 'org_01J00000000000000000000000';
const runId = 'run_01J00000000000000000000000';

const plans = loadPlanLimitsConfig({
  trial: {
    concurrentAutonomousRuns: 1,
    concurrentSandboxes: 1,
    maxResourceProfile: 'small',
    maxRunBudgetCredits: '10.0000',
    maxPreviewLifetimeHours: 1,
    artifactRetentionDays: 7,
    monthlyCredits: '10.0000',
    seats: 1,
  },
  builder: {
    concurrentAutonomousRuns: 3,
    concurrentSandboxes: 3,
    maxResourceProfile: 'standard',
    maxRunBudgetCredits: '100.0000',
    maxPreviewLifetimeHours: 24,
    artifactRetentionDays: 30,
    monthlyCredits: '100.0000',
    seats: 3,
  },
  studio: {
    concurrentAutonomousRuns: 10,
    concurrentSandboxes: 10,
    maxResourceProfile: 'large',
    maxRunBudgetCredits: '1000.0000',
    maxPreviewLifetimeHours: 168,
    artifactRetentionDays: 90,
    monthlyCredits: '1000.0000',
    seats: 10,
  },
});

describe('OPS-3 plan limits', () => {
  it.each([
    ['trial', 'small', 10],
    ['builder', 'standard', 100],
    ['studio', 'large', 1000],
  ] as const)('clamps $0 resources and defaults the $0 run budget', (plan, profile, budget) => {
    expect(clampResourceProfile(plans[plan], 'large')).toBe(profile);
    expect(resolveRunBudget(plans[plan])).toEqual({ maxCredits: budget });
  });

  it('exposes the same parsed sandbox limit to the durable governor adapter', async () => {
    const adapter = createPlanLimitsAdapter({
      plans,
      organizations: { findById: () => Promise.resolve({ plan: 'builder' }) },
    });

    await expect(adapter.getOrganizationLimits(organizationId)).resolves.toEqual({
      concurrentSandboxes: 3,
    });
  });

  it.each([
    ['trial', 1],
    ['builder', 3],
    ['studio', 10],
  ] as const)('rejects a new autonomous run at the $0 concurrency limit', (plan, active) => {
    expect(() => {
      assertConcurrentRunAdmission({ limit: plans[plan].concurrentAutonomousRuns, active, replay: false });
    }).toThrow(PlanLimitConcurrentRunsError);
    expect(() => {
      assertConcurrentRunAdmission({ limit: plans[plan].concurrentAutonomousRuns, active, replay: true });
    }).not.toThrow();
  });

  it('uses a validated active prepaid Flexprice wallet balance and subtracts only active reservations', async () => {
    const requests: URL[] = [];
    const wallets = createFlexpriceWalletClient({
      baseUrl: 'https://flexprice.example/v1',
      apiKey: 'test-key',
      fetch: (input) => {
        if (!(input instanceof URL)) throw new Error('wallet client did not request a URL');
        requests.push(input);
        return Promise.resolve(
          Response.json([
              {
                id: 'wallet_postpaid',
                wallet_type: 'POST_PAID',
                wallet_status: 'active',
              },
              {
                id: 'wallet_1',
                wallet_type: 'PRE_PAID',
                wallet_status: 'active',
                real_time_credit_balance: '12.0000',
              },
            ]),
        );
      },
    });
    const redis = memoryRedis({
      [`run:${runId}:credits`]: JSON.stringify({
        used: '8.0000',
        reserved: '2.0000',
        ceiling: '10.0000',
        version: 1,
      }),
    });
    const gate = createCachedCreditBalanceGate({
      wallets,
      redis,
      activeRuns: { list: () => Promise.resolve([runId]) },
      graceFloorCredits: '5.0000',
      alerts: { emit: () => Promise.resolve() },
    });

    await expect(gate.availableCredits(organizationId)).resolves.toEqual({
      availableCredits: '10.0000',
      walletBalance: '12.0000',
      reservedCredits: '2.0000',
      source: 'wallet',
    });
    expect(requests[0]?.pathname).toBe('/v1/customers/wallets');
    expect(requests[0]?.searchParams).toEqual(
      new URLSearchParams({
        lookup_key: organizationId,
        include_real_time_balance: 'true',
      }),
    );
  });

  it('uses the grace floor and alerts when Flexprice and the cache are unavailable', async () => {
    const alerts: unknown[] = [];
    const gate = createCachedCreditBalanceGate({
      wallets: { getActivePrepaidBalance: () => Promise.reject(new Error('offline')) },
      redis: memoryRedis(),
      activeRuns: { list: () => Promise.resolve([]) },
      graceFloorCredits: '5.0000',
      alerts: { emit: (alert) => { alerts.push(alert); return Promise.resolve(); } },
    });

    await expect(gate.availableCredits(organizationId)).resolves.toMatchObject({
      availableCredits: '5.0000',
      source: 'grace',
    });
    expect(alerts).toEqual([{ type: 'flexprice_wallet_unavailable', organizationId }]);
  });

  it('uses a retained validated zero balance after a provider outage instead of inflating it to grace', async () => {
    const redis = memoryRedis({
      [`organization:${organizationId}:wallet:credits:lkg`]: JSON.stringify({ balance: '0.0000' }),
    });
    const gate = createCachedCreditBalanceGate({
      wallets: { getActivePrepaidBalance: () => Promise.reject(new Error('offline')) },
      redis,
      activeRuns: { list: () => Promise.resolve([]) },
      graceFloorCredits: '5.0000',
      alerts: { emit: () => Promise.reject(new Error('alerts must not block')) },
    });

    await expect(gate.availableCredits(organizationId)).resolves.toMatchObject({
      availableCredits: '0.0000',
      source: 'cache',
    });
    await expect(gate.requireRunAdmission(organizationId)).rejects.toBeInstanceOf(
      CreditBalanceExhaustedError,
    );
  });

  it('blocks a new run when the wallet less reservations is exhausted', async () => {
    const gate = createCachedCreditBalanceGate({
      wallets: { getActivePrepaidBalance: () => Promise.resolve('2.0000') },
      redis: memoryRedis({
        [`run:${runId}:credits`]: JSON.stringify({
          used: '0.0000', reserved: '2.0000', ceiling: '10.0000', version: 1,
        }),
      }),
      activeRuns: { list: () => Promise.resolve([runId]) },
      graceFloorCredits: '5.0000',
      alerts: { emit: () => Promise.resolve() },
    });

    await expect(gate.requireRunAdmission(organizationId)).rejects.toBeInstanceOf(
      CreditBalanceExhaustedError,
    );
  });

  it('emits each 50/80/100 budget threshold once from the durable credit state', async () => {
    const alerts: unknown[] = [];
    const gate = createBudgetThresholdAlerts({
      redis: memoryRedis(),
      alerts: { emit: (alert) => { alerts.push(alert); return Promise.resolve(); } },
    });

    await gate.notify({
      organizationId,
      runId,
      credits: { used: '8.0000', reserved: '0.0000', ceiling: '10.0000', version: 1 },
    });
    await gate.notify({
      organizationId,
      runId,
      credits: { used: '10.0000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
    });

    expect(alerts).toEqual([
      { type: 'run_budget_threshold', organizationId, runId, threshold: 50 },
      { type: 'run_budget_threshold', organizationId, runId, threshold: 80 },
      { type: 'run_budget_threshold', organizationId, runId, threshold: 100 },
    ]);
  });
});

function memoryRedis(values: Record<string, string> = {}) {
  const entries = new Map(Object.entries(values));
  return {
    get: (key: string) => Promise.resolve(entries.get(key) ?? null),
    set: (key: string, value: string) => { entries.set(key, value); return Promise.resolve(); },
    setIfAbsent: (key: string, value: string) => {
      if (entries.has(key)) return Promise.resolve(false);
      entries.set(key, value);
      return Promise.resolve(true);
    },
    exists: () => Promise.resolve(false),
    delete: () => Promise.resolve(),
    eval: () => Promise.resolve(null),
  };
}
