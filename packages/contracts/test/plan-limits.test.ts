import { describe, expect, it } from 'vitest';

import { PlanLimitsConfigSchema } from '../src/index.js';

const validPlan = {
  concurrentAutonomousRuns: 1,
  concurrentSandboxes: 1,
  maxResourceProfile: 'small',
  maxRunBudgetCredits: '10.0000',
  maxPreviewLifetimeHours: 1,
  artifactRetentionDays: 7,
  monthlyCredits: '10.0000',
  seats: 1,
};

describe('plan policy contract', () => {
  it('accepts all contractual tiers and rejects fractional run-budget maxima', () => {
    expect(
      PlanLimitsConfigSchema.parse({
        trial: validPlan,
        builder: { ...validPlan, maxResourceProfile: 'standard', maxRunBudgetCredits: '100.0000' },
        studio: { ...validPlan, maxResourceProfile: 'large', maxRunBudgetCredits: '1000.0000' },
      }),
    ).toHaveProperty('builder.maxResourceProfile', 'standard');
    expect(() =>
      PlanLimitsConfigSchema.parse({
        trial: { ...validPlan, maxRunBudgetCredits: '10.5000' },
        builder: validPlan,
        studio: validPlan,
      }),
    ).toThrow();
  });
});
