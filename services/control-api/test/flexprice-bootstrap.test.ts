import { describe, expect, it } from 'vitest';
import { METERED_USAGE_CATEGORIES } from '@zapp/db';

import {
  createFlexpriceHttpBootstrapPort,
  reconcileFlexpriceBootstrap,
  runFlexpriceBootstrapCli,
  USAGE_CATEGORIES as BOOTSTRAP_CATEGORIES,
  type FlexpriceBootstrapPort,
} from '../../../scripts/flexprice-bootstrap.js';

describe('OPS-1B Flexprice bootstrap', () => {
  it('converges every metered feature, SUM meter, plan, and entitlement then returns no diff', async () => {
    const resources = new Map<string, unknown>();
    const port: FlexpriceBootstrapPort = {
      get: (kind, id) => Promise.resolve(resources.get(`${kind}:${id}`)),
      put: (kind, id, value) => {
        resources.set(`${kind}:${id}`, value);
        return Promise.resolve();
      },
    };
    expect(BOOTSTRAP_CATEGORIES).toEqual(METERED_USAGE_CATEGORIES);
    const input = {
      categories: BOOTSTRAP_CATEGORIES,
      plans: {
        trial: { monthlyCredits: '10.0000', seats: 1 },
        builder: { monthlyCredits: '100.0000', seats: 3 },
        studio: { monthlyCredits: '1000.0000', seats: 10 },
      },
    };

    const first = await reconcileFlexpriceBootstrap(port, input);
    expect(first).toHaveLength(35);
    expect(resources.get('feature:sandbox_cpu_seconds')).toEqual({
      lookupKey: 'sandbox_cpu_seconds',
      type: 'metered',
      meter: {
        aggregation: 'SUM',
        eventName: 'sandbox_cpu_seconds',
        resetUsage: 'BILLING_PERIOD',
        valueProperty: 'quantity',
      },
    });
    await expect(reconcileFlexpriceBootstrap(port, input)).resolves.toEqual([]);
  });

  it('maps logical resources onto current Flexprice search/create APIs and provider ids', async () => {
    const fake = createFakeFlexpriceApi();
    const port = createFlexpriceHttpBootstrapPort({
      apiKey: 'test-api-key',
      baseUrl: 'https://flexprice.example/v1/',
      fetch: fake.fetch,
    });
    const input = {
      categories: BOOTSTRAP_CATEGORIES,
      plans: { trial: { monthlyCredits: '10.0000', seats: 1 } },
    };

    await expect(reconcileFlexpriceBootstrap(port, input)).resolves.toHaveLength(17);
    await expect(reconcileFlexpriceBootstrap(port, input)).resolves.toEqual([]);

    expect(fake.createdFeature('sandbox_cpu_seconds')).toEqual({
      lookup_key: 'sandbox_cpu_seconds',
      meter: {
        aggregation: { field: 'quantity', type: 'SUM' },
        event_name: 'sandbox_cpu_seconds',
        name: 'sandbox_cpu_seconds usage',
        reset_usage: 'BILLING_PERIOD',
      },
      name: 'sandbox_cpu_seconds',
      type: 'metered',
      unit_plural: 'units',
      unit_singular: 'unit',
    });
    expect(fake.createdPlan('trial')).toEqual({
      lookup_key: 'trial',
      metadata: { monthlyCredits: '10.0000', seats: '1' },
      name: 'trial',
    });
    expect(fake.createdEntitlement('plan_trial', 'feature_sandbox_cpu_seconds')).toEqual({
      entity_id: 'plan_trial',
      entity_type: 'PLAN',
      feature_id: 'feature_sandbox_cpu_seconds',
      feature_type: 'metered',
      is_enabled: true,
      is_soft_limit: true,
      plan_id: 'plan_trial',
      usage_reset_period: 'MONTHLY',
    });
    expect(fake.paths()).toContain('/v1/features/search');
    expect(fake.paths()).toContain('/v1/plans/search');
    expect(fake.paths()).toContain('/v1/entitlements/search');
    expect(fake.apiKeys()).toEqual(['test-api-key']);
  });

  it('runs from environment configuration and never leaks its API key on HTTP failure', async () => {
    const secret = 'never-print-this-key';
    const failedFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: `provider echoed ${secret}` } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await expect(
      runFlexpriceBootstrapCli({
        env: {
          FLEXPRICE_API_KEY: secret,
          FLEXPRICE_BASE_URL: 'https://flexprice.example/v1',
        },
        fetch: failedFetch,
        writeOutput: () => undefined,
      }),
    ).rejects.toThrow('Flexprice POST /features/search failed with status 500');
    await expect(
      runFlexpriceBootstrapCli({
        env: { FLEXPRICE_API_KEY: secret },
        fetch: failedFetch,
        writeOutput: () => undefined,
      }),
    ).rejects.not.toThrow(secret);
  });

  it('executes the environment-configured CLI and makes its second process-style run a no-op', async () => {
    const fake = createFakeFlexpriceApi();
    const output: string[] = [];
    const options = {
      env: {
        FLEXPRICE_API_KEY: 'test-api-key',
        FLEXPRICE_BASE_URL: 'https://flexprice.example/v1',
      },
      fetch: fake.fetch,
      writeOutput: (value: string): void => {
        output.push(value);
      },
    };

    await expect(runFlexpriceBootstrapCli(options)).resolves.toHaveLength(35);
    await expect(runFlexpriceBootstrapCli(options)).resolves.toEqual([]);
    expect(JSON.parse(output[0] ?? 'null')).toHaveLength(35);
    expect(output[1]).toBe('[]\n');
  });
});

function createFakeFlexpriceApi(): {
  readonly fetch: typeof fetch;
  readonly createdFeature: (lookupKey: string) => unknown;
  readonly createdPlan: (lookupKey: string) => unknown;
  readonly createdEntitlement: (planId: string, featureId: string) => unknown;
  readonly paths: () => readonly string[];
  readonly apiKeys: () => readonly string[];
} {
  const features = new Map<string, Record<string, unknown>>();
  const plans = new Map<string, Record<string, unknown>>();
  const entitlements = new Map<string, Record<string, unknown>>();
  const createdFeatures = new Map<string, unknown>();
  const createdPlans = new Map<string, unknown>();
  const createdEntitlements = new Map<string, unknown>();
  const requests: { readonly apiKey: string | null; readonly path: string }[] = [];

  const fakeFetch: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    requests.push({ apiKey: new Headers(init?.headers).get('x-api-key'), path: url.pathname });

    if (url.pathname === '/v1/features/search') {
      const lookupKey = String(body.lookup_key);
      return Promise.resolve(
        json({ items: features.has(lookupKey) ? [features.get(lookupKey)] : [] }),
      );
    }
    if (url.pathname === '/v1/features') {
      const lookupKey = String(body.lookup_key);
      createdFeatures.set(lookupKey, body);
      const response = { ...body, id: `feature_${lookupKey}`, status: 'published' };
      features.set(lookupKey, response);
      return Promise.resolve(json(response, 201));
    }
    if (url.pathname === '/v1/plans/search') {
      const lookupKey = String(body.lookup_key);
      return Promise.resolve(json({ items: plans.has(lookupKey) ? [plans.get(lookupKey)] : [] }));
    }
    if (url.pathname === '/v1/plans') {
      const lookupKey = String(body.lookup_key);
      createdPlans.set(lookupKey, body);
      const response = { ...body, id: `plan_${lookupKey}`, status: 'published' };
      plans.set(lookupKey, response);
      return Promise.resolve(json(response, 201));
    }
    if (url.pathname === '/v1/entitlements/search') {
      const planId = String((body.plan_ids as unknown[])[0]);
      const featureId = String((body.feature_ids as unknown[])[0]);
      const key = `${planId}:${featureId}`;
      return Promise.resolve(json({ items: entitlements.has(key) ? [entitlements.get(key)] : [] }));
    }
    if (url.pathname === '/v1/entitlements') {
      const planId = String(body.plan_id);
      const featureId = String(body.feature_id);
      const key = `${planId}:${featureId}`;
      createdEntitlements.set(key, body);
      const response = { ...body, id: `entitlement_${planId}_${featureId}`, status: 'published' };
      entitlements.set(key, response);
      return Promise.resolve(json(response, 201));
    }
    return Promise.resolve(json({ error: { message: 'unexpected request' } }, 404));
  };

  return {
    fetch: fakeFetch,
    createdFeature: (lookupKey) => createdFeatures.get(lookupKey),
    createdPlan: (lookupKey) => createdPlans.get(lookupKey),
    createdEntitlement: (planId, featureId) => createdEntitlements.get(`${planId}:${featureId}`),
    paths: () => requests.map(({ path }) => path),
    apiKeys: () => [...new Set(requests.map(({ apiKey }) => apiKey ?? ''))],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
