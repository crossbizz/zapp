import { z } from 'zod';

import { idSchema } from './ids.js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const CompletionIdSchema = z.string().regex(/^cmp_[a-f0-9]{64}$/u);
export const CompletionFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const CreditDecimalSchema = z.string().regex(/^\d+(?:\.\d{1,4})?$/u);

export const CompletionRouteAttemptSchema = z
  .object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    maxInputTokens: z.number().int().nonnegative(),
    maxOutputTokens: z.number().int().positive(),
  })
  .strict();

const CompletionIdentityShape = {
  completionId: CompletionIdSchema,
  organizationId: idSchema('org'),
  projectId: idSchema('proj'),
  runId: idSchema('run'),
  taskId: idSchema('task').optional(),
  requestFingerprint: CompletionFingerprintSchema,
} as const;

export const ModelCompletionClaimRequestSchema = z
  .object({
    ...CompletionIdentityShape,
    claimOwner: z.string().trim().min(1).max(200),
    leaseMs: z.number().int().min(1_000).max(300_000),
    route: z.array(CompletionRouteAttemptSchema).min(1).max(16),
  })
  .strict();

export const CompletionUsageSchema = z
  .object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadInputTokens: z.number().int().nonnegative(),
    cacheWriteInputTokens: z.number().int().nonnegative(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.cacheReadInputTokens + usage.cacheWriteInputTokens > usage.inputTokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cached input tokens cannot exceed input tokens',
        path: ['cacheReadInputTokens'],
      });
    }
  });

const CompletionTextEventSchema = z
  .object({ type: z.literal('text-delta'), text: z.string() })
  .strict();
const CompletionToolEventSchema = z
  .object({
    type: z.literal('tool-call'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.record(JsonValueSchema),
  })
  .strict();
const CompletionUsageEventSchema = z
  .object({
    type: z.literal('usage'),
    provider: z.string().min(1),
    model: z.string().min(1),
    finishReason: z.string().min(1),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cacheWriteInputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

export const CompletionReplayEventSchema = z.discriminatedUnion('type', [
  CompletionTextEventSchema,
  CompletionToolEventSchema,
  CompletionUsageEventSchema,
]);

export const CompletionTerminalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('done') }).strict(),
  z
    .object({
      type: z.literal('error'),
      code: z.enum([
        'provider_error',
        'content_filter',
        'output_limit_exceeded',
        'unknown_finish_reason',
      ]),
      message: z.string().min(1),
    })
    .strict(),
]);

export const ModelCompletionCommitRequestSchema = z
  .object({
    ...CompletionIdentityShape,
    claimOwner: z.string().trim().min(1).max(200),
    events: z.array(CompletionReplayEventSchema).max(20_000),
    usage: z.array(CompletionUsageSchema).min(1).max(16),
    terminal: CompletionTerminalSchema,
  })
  .strict();

export const CompletionRecordSchema = z
  .object({
    completionId: CompletionIdSchema,
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    runId: idSchema('run'),
    taskId: idSchema('task').optional(),
    requestFingerprint: CompletionFingerprintSchema,
    events: z.array(CompletionReplayEventSchema),
    terminal: CompletionTerminalSchema,
    usage: z.array(CompletionUsageSchema),
  })
  .strict();

export const CreditStateSchema = z
  .object({
    used: CreditDecimalSchema,
    reserved: CreditDecimalSchema,
    ceiling: CreditDecimalSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();

export const ModelCompletionClaimResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('claimed'),
      claimExpiresAt: z.string().datetime({ offset: true }),
      reservedCredits: CreditDecimalSchema,
      credits: CreditStateSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('completed'),
      completion: CompletionRecordSchema,
      credits: CreditStateSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('leased'),
      retryAfterMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      status: z.literal('budget_exceeded'),
      requiredCredits: CreditDecimalSchema,
      credits: CreditStateSchema,
    })
    .strict(),
]);

export const ModelCompletionCommitResponseSchema = z
  .object({
    completion: CompletionRecordSchema,
    credits: CreditStateSchema,
    ledgerRowIds: z.array(z.string().min(1)),
  })
  .strict();

export const ModelCompletionGetResponseSchema = z
  .object({ completion: CompletionRecordSchema })
  .strict();

export const CreditCeilingIncreaseRequestSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    runId: idSchema('run'),
    approvalId: idSchema('appr'),
    operationKey: z.string().trim().min(1).max(200),
    absoluteCeiling: CreditDecimalSchema,
  })
  .strict();

export const CreditCeilingIncreaseResponseSchema = z
  .object({ credits: CreditStateSchema })
  .strict();

export type ModelCompletionClaimRequest = z.infer<typeof ModelCompletionClaimRequestSchema>;
export type ModelCompletionClaimResponse = z.infer<typeof ModelCompletionClaimResponseSchema>;
export type ModelCompletionCommitRequest = z.infer<typeof ModelCompletionCommitRequestSchema>;
export type ModelCompletionCommitResponse = z.infer<typeof ModelCompletionCommitResponseSchema>;
export type CompletionRouteAttempt = z.infer<typeof CompletionRouteAttemptSchema>;
export type CompletionRecord = z.infer<typeof CompletionRecordSchema>;
export type CompletionUsage = z.infer<typeof CompletionUsageSchema>;
export type CreditState = z.infer<typeof CreditStateSchema>;
export type CreditCeilingIncreaseRequest = z.infer<typeof CreditCeilingIncreaseRequestSchema>;
