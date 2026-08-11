import { idSchema, PlanLimitsConfigSchema, type PlanLimitsConfig } from '@zapp/contracts';

/**
 * Production governor adapter: policy is parsed once at composition and tenant
 * plan ownership remains with the control-plane organization repository.
 */
export function createSandboxPlanLimitsAdapter(options: {
  readonly plans: PlanLimitsConfig;
  readonly organizations: {
    findById(organizationId: string): Promise<{ readonly plan: string } | undefined>;
  };
}): { readonly getOrganizationLimits: (organizationId: string) => Promise<{ readonly concurrentSandboxes: number }> } {
  const plans = PlanLimitsConfigSchema.parse(options.plans);
  return {
    async getOrganizationLimits(organizationId) {
      const organization = await options.organizations.findById(idSchema('org').parse(organizationId));
      if (organization === undefined) throw new Error('organization plan is unavailable');
      const plan = PlanLimitsConfigSchema.keyof().parse(organization.plan);
      return { concurrentSandboxes: plans[plan].concurrentSandboxes };
    },
  };
}
