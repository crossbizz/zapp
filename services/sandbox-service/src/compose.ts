import { readFile } from 'node:fs/promises';

import { PlanLimitsConfigSchema, type PlanLimitsConfig } from '@zapp/contracts';
import { organizations, type Database } from '@zapp/db';
import { eq } from 'drizzle-orm';

import './instrumentation.js';
import {
  createRunawayComputeGovernor,
  type GovernorCapacityPort,
  type RunawayComputeGovernor,
  type RunawayComputeGovernorDependencies,
} from './lifecycle/governor.js';
import { createSandboxPlanLimitsAdapter } from './lifecycle/plan-limits.js';
import { buildApp, type BuildAppOptions } from './app.js';
import type { SandboxTelemetryRelay } from './routes/telemetry.js';
import { createSandboxCapacityRepository } from './state/capacity.js';

type WithoutGovernor<T> = T extends unknown ? Omit<T, 'governor'> : never;
type DeployableSandboxAppOptions = WithoutGovernor<BuildAppOptions> & {
  readonly telemetryRelay: SandboxTelemetryRelay;
};

/**
 * Deployment composition for the durable sandbox governor. Keeping this join in
 * sandbox-service prevents a process-local counter or a Flexprice dependency
 * from ever becoming the quota authority.
 */
export function composeSandboxGovernor(
  options: Omit<RunawayComputeGovernorDependencies, 'limits'> & {
    readonly plans: PlanLimitsConfig;
    readonly organizations: {
      findById(organizationId: string): Promise<{ readonly plan: string } | undefined>;
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

export async function loadSandboxPlanLimits(
  source = new URL('../../../config/plans.json', import.meta.url),
): Promise<PlanLimitsConfig> {
  return PlanLimitsConfigSchema.parse(JSON.parse(await readFile(source, 'utf8')));
}

export function createDatabaseSandboxOrganizationSource(database: Database) {
  return {
    async findById(organizationId: string) {
      const [organization] = await database
        .select({ plan: organizations.plan })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      return organization;
    },
  };
}

/** Deployable sandbox assembly: strict local policy + database tenant plan + durable governor. */
export async function composeSandboxApp(options: {
  readonly app: DeployableSandboxAppOptions;
  readonly database: Database;
  readonly governor: Omit<RunawayComputeGovernorDependencies, 'limits' | 'capacity'>;
  readonly plansUrl?: URL;
  readonly testOnlyCapacity?: GovernorCapacityPort;
}) {
  if (options.testOnlyCapacity !== undefined && process.env['NODE_ENV'] !== 'test') {
    throw new Error('testOnlyCapacity may only be used when NODE_ENV=test');
  }
  const plans = await loadSandboxPlanLimits(options.plansUrl);
  return buildApp({
    ...options.app,
    governor: composeSandboxGovernor({
      ...options.governor,
      capacity:
        options.testOnlyCapacity ?? createSandboxCapacityRepository(options.database),
      plans,
      organizations: createDatabaseSandboxOrganizationSource(options.database),
    }),
  });
}
