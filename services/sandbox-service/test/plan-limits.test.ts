import { expect, it } from 'vitest';

import { createSandboxPlanLimitsAdapter } from '../src/lifecycle/plan-limits.js';

it('provides the shared organization plan quota to the production governor port', async () => {
  const limits = createSandboxPlanLimitsAdapter({
    plans: {
      trial: { concurrentAutonomousRuns: 1, concurrentSandboxes: 1, maxResourceProfile: 'small', maxRunBudgetCredits: '10.0000', maxPreviewLifetimeHours: 1, artifactRetentionDays: 7, monthlyCredits: '10.0000', seats: 1 },
      builder: { concurrentAutonomousRuns: 3, concurrentSandboxes: 3, maxResourceProfile: 'standard', maxRunBudgetCredits: '100.0000', maxPreviewLifetimeHours: 24, artifactRetentionDays: 30, monthlyCredits: '100.0000', seats: 3 },
      studio: { concurrentAutonomousRuns: 10, concurrentSandboxes: 10, maxResourceProfile: 'large', maxRunBudgetCredits: '1000.0000', maxPreviewLifetimeHours: 168, artifactRetentionDays: 90, monthlyCredits: '1000.0000', seats: 10 },
    },
    organizations: { findById: () => Promise.resolve({ plan: 'builder' }) },
  });

  await expect(limits.getOrganizationLimits('org_01J00000000000000000000000')).resolves.toEqual({
    concurrentSandboxes: 3,
  });
});
