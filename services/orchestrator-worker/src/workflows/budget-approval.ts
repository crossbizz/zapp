import { defineSignal } from '@temporalio/workflow';
import { BudgetApprovalReasonSchema } from '@zapp/contracts/budget-approval';
import { z } from 'zod';

export const BudgetApprovalResolutionSchema = z.discriminatedUnion('decision', [
  z
    .object({
      approvalId: z.string().regex(/^appr_[0-9A-HJKMNP-TV-Z]{26}$/u),
      decision: z.literal('approved'),
      absoluteCeiling: z.string().regex(/^\d+\.\d{4}$/u),
      reason: BudgetApprovalReasonSchema,
    })
    .strict(),
  z
    .object({
      approvalId: z.string().regex(/^appr_[0-9A-HJKMNP-TV-Z]{26}$/u),
      decision: z.literal('rejected'),
      reason: BudgetApprovalReasonSchema,
    })
    .strict(),
]);
export type BudgetApprovalResolution = z.infer<typeof BudgetApprovalResolutionSchema>;

export const budgetApprovalResolvedSignal = defineSignal<[unknown]>('budgetApprovalResolved');

export function decodeBudgetApprovalResolution(value: unknown): BudgetApprovalResolution {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, 'reason')
  ) {
    return BudgetApprovalResolutionSchema.parse({
      ...value,
      reason: 'run_budget_exhausted',
    });
  }
  return BudgetApprovalResolutionSchema.parse(value);
}

export function immutableRunCeiling(input: {
  readonly budget: { readonly maxCredits: number } | null;
  readonly planMaxCredits: number;
}): string {
  return `${String(input.budget?.maxCredits ?? input.planMaxCredits)}.0000`;
}
