import { SupportLevelSchema, type SupportLevel } from '@zapp/contracts';
import { z } from 'zod';

import {
  PolicyLocationSchema,
  policySignal,
  severityByLevel,
  type PolicySignal,
} from './placeholder.js';

const ActiveMockSchema = z
  .object({
    name: z.string().min(1).max(200),
    locations: z.array(PolicyLocationSchema).min(1).max(500),
  })
  .strict();

const ActivePrototypeMocksInputSchema = z
  .object({
    supportLevel: SupportLevelSchema,
    activeMocks: z.array(ActiveMockSchema).max(500),
  })
  .strict();

export function detectActivePrototypeMocks(input: {
  readonly supportLevel: SupportLevel;
  readonly activeMocks: readonly z.infer<typeof ActiveMockSchema>[];
}): PolicySignal[] {
  const parsed = ActivePrototypeMocksInputSchema.parse(input);
  return policySignal(
    'mock-detect',
    severityByLevel(parsed.supportLevel, {
      compatible: 'warning',
      verified: 'warning',
      managed: 'blocking',
    }),
    parsed.activeMocks.flatMap(({ locations }) => locations),
    false,
  );
}
