import { z } from 'zod';

export const PolicyBudgetSchema = z
  .object({
    remainingToolCalls: z.number().int().nonnegative(),
    remainingConsequentialToolCalls: z.number().int().nonnegative(),
  })
  .strict();

export type PolicyBudget = z.infer<typeof PolicyBudgetSchema>;
