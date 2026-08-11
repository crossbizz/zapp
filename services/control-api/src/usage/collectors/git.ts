import { createHash } from 'node:crypto';

import { idSchema } from '@zapp/contracts';
import type { UsageCategory } from '@zapp/db';
import { z } from 'zod';

import type { UsageEntry, UsageLedgerRepository } from '../ledger.js';
import { estimateUsage, type PricingConfig } from '../pricing.js';

const DeploymentUsageSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    runId: idSchema('run').nullable(),
    taskId: idSchema('task').nullable(),
    deploymentId: idSchema('dep'),
    provider: z.string().trim().min(1).max(200),
    buildSeconds: z.number().finite().nonnegative().optional(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

interface DeploymentUsageLedgerPort {
  recordUsage(entry: UsageEntry): Promise<unknown>;
}

export const DEPLOYMENT_USAGE_CATEGORIES = ['deploy_provider'] as const;

export interface DeploymentUsagePort {
  record(input: z.input<typeof DeploymentUsageSchema>): Promise<void>;
}

/**
 * The filename is retained from the locked OPS-2 file list. The collector owns
 * provider deployment metering; Git/release workflows call this seam once the
 * provider returns a deployment identity and optional measured build duration.
 */
export function createDeploymentUsageCollector(options: {
  readonly ledger: DeploymentUsageLedgerPort | Pick<UsageLedgerRepository, 'recordUsage'>;
  readonly pricing: PricingConfig;
}): DeploymentUsagePort {
  return {
    async record(rawInput: z.input<typeof DeploymentUsageSchema>): Promise<void> {
      const input = DeploymentUsageSchema.parse(rawInput);
      const quantity = '1.000000';
      const estimate = estimateUsage(options.pricing, {
        category: DEPLOYMENT_USAGE_CATEGORIES[0],
        quantity,
      });
      await options.ledger.recordUsage({
        operationKey: `ops2-deploy-${createHash('sha256')
          .update(`${input.organizationId}:${input.deploymentId}`)
          .digest('hex')}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        runId: input.runId,
        taskId: input.taskId,
        category: DEPLOYMENT_USAGE_CATEGORIES[0],
        provider: input.provider,
        quantity,
        unit: 'deployment',
        costUsd: estimate.costUsd,
        creditsCharged: estimate.credits,
        occurredAt: input.occurredAt,
        metadata:
          input.buildSeconds === undefined ? {} : { build_seconds: input.buildSeconds.toFixed(6) },
      });
    },
  };
}

export interface MeteringCoverageEntry {
  readonly source:
    | 'model_input_tokens'
    | 'model_output_tokens'
    | 'model_cached_tokens'
    | 'modal_cpu_seconds'
    | 'modal_memory_gib_seconds'
    | 'modal_gpu_usage_if_enabled'
    | 'snapshot_and_volume_storage'
    | 'deployment_provider_usage'
    | 'artifact_storage';
  readonly enabled: boolean;
  readonly emitter: 'model-gateway' | 'sandbox-service' | 'control-api';
  readonly category: UsageCategory | null;
}

/** PRD §30.1 provider-cost inventory; the conditional GPU row remains explicit. */
export const PRD_METERING_COVERAGE = [
  {
    source: 'model_input_tokens',
    enabled: true,
    emitter: 'model-gateway',
    category: 'model_input_tokens',
  },
  {
    source: 'model_output_tokens',
    enabled: true,
    emitter: 'model-gateway',
    category: 'model_output_tokens',
  },
  {
    source: 'model_cached_tokens',
    enabled: true,
    emitter: 'model-gateway',
    category: 'model_cached_tokens',
  },
  {
    source: 'modal_cpu_seconds',
    enabled: true,
    emitter: 'sandbox-service',
    category: 'sandbox_cpu_seconds',
  },
  {
    source: 'modal_memory_gib_seconds',
    enabled: true,
    emitter: 'sandbox-service',
    category: 'sandbox_mem_gib_seconds',
  },
  {
    source: 'modal_gpu_usage_if_enabled',
    enabled: false,
    emitter: 'sandbox-service',
    category: null,
  },
  {
    source: 'snapshot_and_volume_storage',
    enabled: true,
    emitter: 'control-api',
    category: 'storage_gib_hours',
  },
  {
    source: 'deployment_provider_usage',
    enabled: true,
    emitter: 'control-api',
    category: DEPLOYMENT_USAGE_CATEGORIES[0],
  },
  {
    source: 'artifact_storage',
    enabled: true,
    emitter: 'control-api',
    category: 'artifact_storage',
  },
] as const satisfies readonly MeteringCoverageEntry[];
