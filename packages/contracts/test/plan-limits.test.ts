import { describe, expect, it } from 'vitest';

import { IntegralCreditDecimalSchema, PlanLimitsConfigSchema } from '../src/index.js';

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
  it.each([
    ['0.0000', false],
    ['1', true],
    ['1000000.0000', true],
    ['1000001.0000', false],
    ['1.5000', false],
  ] as const)('accepts only integral workflow-domain run maxima: %s', (value, accepted) => {
    expect(IntegralCreditDecimalSchema.safeParse(value).success).toBe(accepted);
  });

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
