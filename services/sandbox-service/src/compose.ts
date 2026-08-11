import type { PlanLimitsConfig } from '@zapp/contracts';

import {
  createRunawayComputeGovernor,
  type RunawayComputeGovernor,
  type RunawayComputeGovernorDependencies,
} from './lifecycle/governor.js';
import { createSandboxPlanLimitsAdapter } from './lifecycle/plan-limits.js';

/**
 * Deployment composition for the durable sandbox governor. Keeping this join in
 * sandbox-service prevents a process-local counter or a Flexprice dependency
 * from ever becoming the quota authority.
 */
export function composeSandboxGovernor(
  options: Omit<RunawayComputeGovernorDependencies, 'limits'> & {
    readonly plans: PlanLimitsConfig;
    readonly organizations: {
      findById(organizationId: string): Promise<{ readonly plan: keyof PlanLimitsConfig } | undefined>;
    };
  },
): RunawayComputeGovernor {
  return createRunawayComputeGovernor({
    ...options,
    limits: createSandboxPlanLimitsAdapter({
      plans: options.plans,
      organizations: options.organizations,
    }),
  });
}
