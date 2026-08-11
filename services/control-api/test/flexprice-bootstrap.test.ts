import { describe, expect, it } from 'vitest';
import { USAGE_CATEGORIES } from '@zapp/db';

import {
  reconcileFlexpriceBootstrap,
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
    expect(BOOTSTRAP_CATEGORIES).toEqual(USAGE_CATEGORIES);
    const input = {
      categories: BOOTSTRAP_CATEGORIES,
      plans: {
        trial: { monthlyCredits: '10.0000', seats: 1 },
        builder: { monthlyCredits: '100.0000', seats: 3 },
        studio: { monthlyCredits: '1000.0000', seats: 10 },
      },
    };

    const first = await reconcileFlexpriceBootstrap(port, input);
    expect(first).toHaveLength(43);
    expect(resources.get('meter:sandbox_cpu_seconds')).toEqual({
      aggregation: 'SUM',
      eventName: 'sandbox_cpu_seconds',
      valueProperty: 'properties.quantity',
    });
    await expect(reconcileFlexpriceBootstrap(port, input)).resolves.toEqual([]);
  });
});
