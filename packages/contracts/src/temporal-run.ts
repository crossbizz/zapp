import { z } from 'zod';

import { MessageUserPayloadSchema } from './events.js';
import { BudgetApprovalReasonSchema } from './budget-approval.js';
import { idSchema } from './id-schema.js';
import { AppTypeSchema, FixRequestSchema, ModelIdentifierSchema } from './run-intent.js';
import { RunModeSchema } from './run.js';

export const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
export const WorkflowCreditCapSchema = z.number().int().min(1).max(1_000_000);
export const RunBudgetSchema = z.object({ maxCredits: WorkflowCreditCapSchema }).strict();

const StartRunIdentityShape = {
  runId: idSchema('run'),
  workflowId: z.string().min(1).max(255),
  organizationId: idSchema('org'),
  projectId: idSchema('proj'),
  branchId: idSchema('br').nullable(),
  appType: AppTypeSchema,
  model: ModelIdentifierSchema.nullable(),
  prompt: z.string().trim().min(1).max(20_000),
  budget: RunBudgetSchema.nullable(),
  planMaxCredits: WorkflowCreditCapSchema,
  operationKey: OperationKeySchema,
} as const;

export const StartRunInputSchema = z.discriminatedUnion('mode', [
  z.object({ ...StartRunIdentityShape, mode: z.literal('fix'), fixRequest: FixRequestSchema }).strict(),
  z.object({ ...StartRunIdentityShape, mode: RunModeSchema.exclude(['fix']) }).strict(),
]);
export type StartRunInput = z.infer<typeof StartRunInputSchema>;

export const RunWorkflowStartInputSchema = z
  .object({ ...StartRunIdentityShape, mode: z.enum(['ask', 'prototype', 'build']) })
  .strict();
export const FixWorkflowStartInputSchema = z
  .object({
    ...StartRunIdentityShape,
    mode: z.literal('fix'),
    fixRequest: FixRequestSchema,
  })
  .strict();
export const AutonomousWorkflowStartInputSchema = z
  .object({
    workflowId: z.string().min(1).max(255),
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    prompt: z.string().trim().min(1).max(20_000),
    model: ModelIdentifierSchema.nullable(),
    budget: RunBudgetSchema.nullable(),
    planMaxCredits: WorkflowCreditCapSchema,
    maxConcurrency: z.number().int().min(1).max(100),
  })
  .strict();

export const TEMPORAL_RUN_WORKFLOW_TYPES = {
  ask: 'runWorkflow',
  prototype: 'runWorkflow',
  build: 'buildWorkflow',
  fix: 'fixWorkflow',
  autonomous: 'autonomousWorkflow',
} as const satisfies Readonly<Record<z.infer<typeof RunModeSchema>, string>>;

export const TemporalRunStartProjectionSchema = z.discriminatedUnion('workflowType', [
  z.object({ workflowType: z.literal('runWorkflow'), input: RunWorkflowStartInputSchema }).strict(),
  z.object({ workflowType: z.literal('buildWorkflow'), input: RunWorkflowStartInputSchema }).strict(),
  z.object({ workflowType: z.literal('fixWorkflow'), input: FixWorkflowStartInputSchema }).strict(),
  z.object({ workflowType: z.literal('autonomousWorkflow'), input: AutonomousWorkflowStartInputSchema }).strict(),
]);
export type TemporalRunStartProjection = z.infer<typeof TemporalRunStartProjectionSchema>;

export function projectTemporalRunStart(value: unknown): TemporalRunStartProjection {
  const input = StartRunInputSchema.parse(value);
  if (input.mode === 'autonomous') {
    return TemporalRunStartProjectionSchema.parse({
      workflowType: TEMPORAL_RUN_WORKFLOW_TYPES.autonomous,
      input: {
        workflowId: input.workflowId,
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        prompt: input.prompt,
        model: input.model,
        budget: input.budget,
        planMaxCredits: input.planMaxCredits,
        maxConcurrency: 3,
      },
    });
  }
  return TemporalRunStartProjectionSchema.parse({
    workflowType: TEMPORAL_RUN_WORKFLOW_TYPES[input.mode],
    input,
  });
}

const SignalIdentityShape = {
  runId: idSchema('run'),
  workflowId: z.string().min(1).max(255),
  mode: RunModeSchema,
  operationKey: OperationKeySchema,
} as const;

export const SignalRunInputSchema = z.union([
  z.object({ ...SignalIdentityShape, signal: z.literal('credit_balance_exhausted') }).strict(),
  z.object({ ...SignalIdentityShape, signal: z.enum(['pause', 'resume', 'cancel']) }).strict(),
  z.object({
    ...SignalIdentityShape,
    signal: z.literal('redirect'),
    prompt: z.string().trim().min(1).max(20_000),
  }).strict(),
  z.object({ ...SignalIdentityShape, signal: z.literal('message'), message: MessageUserPayloadSchema }).strict(),
  z.object({
    ...SignalIdentityShape,
    signal: z.literal('budget_approval'),
    approvalId: idSchema('appr'),
    decision: z.literal('approved'),
    absoluteCeiling: z.string().regex(/^\d+\.\d{4}$/u),
    reason: BudgetApprovalReasonSchema,
  }).strict(),
  z.object({
    ...SignalIdentityShape,
    signal: z.literal('budget_approval'),
    approvalId: idSchema('appr'),
    decision: z.literal('rejected'),
    reason: BudgetApprovalReasonSchema,
  }).strict(),
]);
export type SignalRunInput = z.infer<typeof SignalRunInputSchema>;

export const SignalRunResultSchema = z.object({ applied: z.boolean() }).strict();

export interface TemporalRunSignalProjection {
  readonly signalName: 'creditBalanceExhausted' | 'pause' | 'resume' | 'cancel' | 'redirect' | 'message' | 'budgetApprovalResolved';
  readonly payload: Record<string, unknown>;
}

export function projectTemporalRunSignal(value: unknown): TemporalRunSignalProjection {
  const input = SignalRunInputSchema.parse(value);
  if (input.signal === 'message' && (input.mode === 'autonomous' || input.mode === 'fix')) {
    throw new TypeError(`${input.signal} is not supported by the ${input.mode} workflow`);
  }
  if (input.signal === 'budget_approval') {
    return {
      signalName: 'budgetApprovalResolved',
      payload: {
        approvalId: input.approvalId,
        decision: input.decision,
        reason: input.reason,
        ...(input.decision === 'approved' ? { absoluteCeiling: input.absoluteCeiling } : {}),
      },
    };
  }
  if (input.signal === 'message') {
    return {
      signalName: 'message',
      payload: { runId: input.runId, message: input.message, operationKey: input.operationKey },
    };
  }
  if (input.signal === 'redirect') {
    return {
      signalName: 'redirect',
      payload: { runId: input.runId, instruction: input.prompt, operationKey: input.operationKey },
    };
  }
  return {
    signalName: input.signal === 'credit_balance_exhausted' ? 'creditBalanceExhausted' : input.signal,
    payload: { runId: input.runId, operationKey: input.operationKey },
  };
}
