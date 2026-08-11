import { z } from 'zod';

import { ResourceProfileSchema } from './sandbox.js';
import { CreditDecimalSchema } from './usage.js';

/** Fixed-point credits are stored with four decimal places across usage accounting. */
/** Run budgets are integer credits, so plan maxima must be exactly representable by CP-9. */
export const IntegralCreditDecimalSchema = z.string().regex(/^\d+(?:\.0{1,4})?$/u);

export const PlanLimitSchema = z
  .object({
    concurrentAutonomousRuns: z.number().int().positive(),
    concurrentSandboxes: z.number().int().positive(),
    maxResourceProfile: ResourceProfileSchema,
    maxRunBudgetCredits: IntegralCreditDecimalSchema,
    maxPreviewLifetimeHours: z.number().int().positive(),
    artifactRetentionDays: z.number().int().positive(),
    monthlyCredits: CreditDecimalSchema,
    seats: z.number().int().positive(),
  })
  .strict();

export const PlanLimitsConfigSchema = z
  .object({ trial: PlanLimitSchema, builder: PlanLimitSchema, studio: PlanLimitSchema })
  .strict();

export type PlanLimit = z.infer<typeof PlanLimitSchema>;
export type PlanLimitsConfig = z.infer<typeof PlanLimitsConfigSchema>;
