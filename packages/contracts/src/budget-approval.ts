import { z } from 'zod';

export const BudgetApprovalReasonSchema = z.enum([
  'run_budget_exhausted',
  'organization_credit_exhausted',
]);
export type BudgetApprovalReason = z.infer<typeof BudgetApprovalReasonSchema>;

export const RunApprovalKindSchema = z.enum([
  'budget_increase',
  'specification',
  'plan',
  'plan_diff',
  'migration',
  'deploy',
]);
export type RunApprovalKind = z.infer<typeof RunApprovalKindSchema>;
