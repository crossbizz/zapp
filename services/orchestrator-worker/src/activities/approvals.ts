import { createHash } from 'node:crypto';

import {
  BudgetApprovalReasonSchema,
  CreditDecimalSchema,
  RunModeSchema,
  idSchema,
} from '@zapp/contracts';
import { agentRuns, approvals, type Database } from '@zapp/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

const IdempotencyKeySchema = z.string().min(1).max(512);
const WorkspaceIdSchema = z.string().min(1).max(512);

export const EstimateRunCostInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    mode: RunModeSchema,
    prompt: z.string().min(1).max(20_000),
    maxCredits: z.number().int().positive().max(1_000_000),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const RunCostEstimateSchema = z
  .object({ estimatedCredits: CreditDecimalSchema })
  .strict();

export const RequestBudgetIncreaseInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    workspaceId: WorkspaceIdSchema.nullable(),
    currentCeiling: CreditDecimalSchema,
    absoluteCeiling: CreditDecimalSchema,
    reason: BudgetApprovalReasonSchema,
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict()
  .superRefine((input, context) => {
    const current = creditUnits(input.currentCeiling);
    const requested = creditUnits(input.absoluteCeiling);
    const valid = input.reason === 'organization_credit_exhausted'
      ? requested === current
      : requested > current;
    if (!valid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: input.reason === 'organization_credit_exhausted'
          ? 'organization credit approval must preserve the immutable ceiling'
          : 'run budget approval must strictly increase the ceiling',
        path: ['absoluteCeiling'],
      });
    }
  });
export const BudgetIncreaseRequestSchema = z
  .object({
    approvalId: idSchema('appr'),
    absoluteCeiling: CreditDecimalSchema,
  })
  .strict();

export const CheckpointBudgetStopInputSchema = z
  .object({
    runId: idSchema('run'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    workspaceId: WorkspaceIdSchema,
    approvalId: idSchema('appr'),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const BudgetStopCheckpointSchema = z
  .object({ checkpointRef: z.string().min(1).max(2_048) })
  .strict();

export type EstimateRunCostInput = z.infer<typeof EstimateRunCostInputSchema>;
export type RequestBudgetIncreaseInput = z.infer<typeof RequestBudgetIncreaseInputSchema>;
export type CheckpointBudgetStopInput = z.infer<typeof CheckpointBudgetStopInputSchema>;

function decodeRequestBudgetIncreaseActivityInput(value: unknown): RequestBudgetIncreaseInput {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, 'reason')
  ) {
    return RequestBudgetIncreaseInputSchema.parse({
      ...value,
      reason: 'run_budget_exhausted',
    });
  }
  return RequestBudgetIncreaseInputSchema.parse(value);
}

export interface ApprovalActivityPort {
  estimateRunCost(input: EstimateRunCostInput): Promise<unknown>;
  requestBudgetIncrease(input: RequestBudgetIncreaseInput): Promise<unknown>;
  checkpointBudgetStop(input: CheckpointBudgetStopInput): Promise<unknown>;
}

export interface ApprovalActivities {
  estimateRunCost(input: EstimateRunCostInput): Promise<z.infer<typeof RunCostEstimateSchema>>;
  requestBudgetIncrease(
    input: RequestBudgetIncreaseInput,
  ): Promise<z.infer<typeof BudgetIncreaseRequestSchema>>;
  checkpointBudgetStop(
    input: CheckpointBudgetStopInput,
  ): Promise<z.infer<typeof BudgetStopCheckpointSchema>>;
}

export function createApprovalActivities(port: ApprovalActivityPort): ApprovalActivities {
  return {
    async estimateRunCost(inputValue) {
      const input = EstimateRunCostInputSchema.parse(inputValue);
      return RunCostEstimateSchema.parse(await port.estimateRunCost(input));
    },
    async requestBudgetIncrease(inputValue) {
      const input = decodeRequestBudgetIncreaseActivityInput(inputValue);
      return BudgetIncreaseRequestSchema.parse(await port.requestBudgetIncrease(input));
    },
    async checkpointBudgetStop(inputValue) {
      const input = CheckpointBudgetStopInputSchema.parse(inputValue);
      return BudgetStopCheckpointSchema.parse(await port.checkpointBudgetStop(input));
    },
  };
}

function stableApprovalId(idempotencyKey: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = createHash('sha256').update(idempotencyKey).digest();
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 26) {
      bits -= 5;
      output += alphabet[(value >>> bits) & 31] ?? '';
    }
    if (output.length === 26) break;
  }
  return idSchema('appr').parse(`appr_${output}`);
}

/** Production approval persistence; estimate and checkpoint remain explicit service ports. */
export function createDatabaseApprovalActivities(options: {
  readonly database: Database;
  readonly estimateRunCost: ApprovalActivityPort['estimateRunCost'];
  readonly checkpointBudgetStop: ApprovalActivityPort['checkpointBudgetStop'];
}): ApprovalActivities {
  return createApprovalActivities({
    estimateRunCost: options.estimateRunCost,
    checkpointBudgetStop: options.checkpointBudgetStop,
    async requestBudgetIncrease(input) {
      const approvalId = stableApprovalId(input.idempotencyKey);
      const requestJson = {
        currentCeiling: input.currentCeiling,
        absoluteCeiling: input.absoluteCeiling,
        workspaceId: input.workspaceId,
        reason: input.reason,
      };
      return await options.database.transaction(async (tx) => {
        const [run] = await tx
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, input.runId),
              eq(agentRuns.organizationId, input.organizationId),
              eq(agentRuns.projectId, input.projectId),
            ),
          )
          .limit(1);
        if (run === undefined) throw new Error('run was not found in the approval tenant scope');
        await tx
          .insert(approvals)
          .values({
            id: approvalId,
            organizationId: input.organizationId,
            runId: input.runId,
            taskId: null,
            type: 'budget_increase',
            status: 'pending',
            requestJson,
            responseJson: null,
            resolvedAt: null,
            resolvedBy: null,
          })
          .onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.id, approvalId),
              eq(approvals.organizationId, input.organizationId),
              eq(approvals.runId, input.runId),
            ),
          )
          .limit(1);
        if (
          row === undefined ||
          row.type !== 'budget_increase' ||
          JSON.stringify(row.requestJson) !== JSON.stringify(requestJson)
        ) {
          throw new Error('approval idempotency key conflicts with another request');
        }
        return { approvalId, absoluteCeiling: input.absoluteCeiling };
      });
    },
  });
}

function creditUnits(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
}
