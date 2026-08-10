import { SupportLevelSchema, type SupportLevel } from '@zapp/contracts';
import { z } from 'zod';

import {
  PolicyLocationSchema,
  policySignal,
  severityByLevel,
  type PolicySignal,
} from './placeholder.js';

const BroadRewriteInputSchema = z
  .object({
    supportLevel: SupportLevelSchema,
    changedLines: z.number().int().nonnegative().max(10_000_000),
    estimatedLines: z.number().int().positive().max(10_000_000),
    thresholdMultiplier: z.number().positive().max(100),
    locations: z.array(PolicyLocationSchema).min(1).max(2_000),
  })
  .strict();

export function detectBroadRewrite(input: {
  readonly supportLevel: SupportLevel;
  readonly changedLines: number;
  readonly estimatedLines: number;
  readonly thresholdMultiplier: number;
  readonly locations: readonly z.infer<typeof PolicyLocationSchema>[];
}): PolicySignal[] {
  const parsed = BroadRewriteInputSchema.parse(input);
  if (parsed.changedLines <= parsed.estimatedLines * parsed.thresholdMultiplier) return [];
  return policySignal(
    'diff-size',
    severityByLevel(parsed.supportLevel, {
      compatible: 'warning',
      verified: 'warning',
      managed: 'warning',
    }),
    parsed.locations,
    false,
  );
}
