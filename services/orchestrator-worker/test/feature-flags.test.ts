import { createFeatureFlagEvaluator } from '@zapp/config';
import { describe, expect, it, vi } from 'vitest';

import { createFeatureFlagActivities } from '../src/activities/feature-flags.js';

describe('OPS-6 orchestrator feature flag activity', () => {
  it('evaluates a fresh organization-scoped kill switch and returns its local default on outage', async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error('PostHog unavailable'));
    const activities = createFeatureFlagActivities(
      createFeatureFlagEvaluator({ provider: { evaluate } }),
    );
    const organizationId = 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NC';

    await expect(
      activities.evaluateFeatureFlag({
        organizationId,
        distinctId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
        flag: 'autonomous-mode',
      }),
    ).resolves.toEqual({ enabled: false });
    expect(evaluate).toHaveBeenCalledWith({
      distinctId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
      flag: 'autonomous-mode',
      groups: { organization: organizationId },
    });
  });
});
