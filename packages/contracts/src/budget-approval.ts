import { z } from 'zod';

export const BudgetApprovalReasonSchema = z.enum([
  'run_budget_exhausted',
  'organization_credit_exhausted',
]);
export type BudgetApprovalReason = z.infer<typeof BudgetApprovalReasonSchema>;
