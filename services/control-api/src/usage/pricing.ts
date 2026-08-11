import { readFile } from 'node:fs/promises';

import { USAGE_CATEGORIES } from '@zapp/db';
import { z } from 'zod';

const DecimalSchema = z
  .string()
  .regex(/^\d+(?:\.\d{1,6})?$/u, 'must be a positive decimal string')
  .refine((value) => decimalUnits(value, 6) > 0n, 'must be greater than zero');

const ModelRateSchema = z
  .object({
    inputUsdPerMillion: DecimalSchema,
    outputUsdPerMillion: DecimalSchema,
    cacheReadUsdPerMillion: DecimalSchema,
    cacheWriteUsdPerMillion: DecimalSchema,
  })
  .strict();

const UnitRateSchema = z.object({ usdPerUnit: DecimalSchema }).strict();

const NonModelUsageCategorySchema = z.enum([
  'sandbox_cpu_seconds',
  'sandbox_mem_gib_seconds',
  'storage_gib_hours',
  'deploy_provider',
  'artifact_storage',
]);

export const PricingConfigSchema = z
  .object({
    version: z.string().trim().min(1),
    defaultRunCreditCeiling: DecimalSchema,
    creditsPerUsd: DecimalSchema,
    models: z.record(z.string().regex(/^[a-z0-9-]+\/[a-z0-9][a-z0-9.-]*$/u), ModelRateSchema),
    usageRates: z.record(NonModelUsageCategorySchema, UnitRateSchema).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value.models).length > 0, {
    message: 'models must contain at least one rate',
    path: ['models'],
  });

export type PricingConfig = z.infer<typeof PricingConfigSchema>;

const RouteAttemptSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    maxInputTokens: z.number().int().nonnegative(),
    maxOutputTokens: z.number().int().positive(),
  })
  .strict();

export type PricedRouteAttempt = z.infer<typeof RouteAttemptSchema>;

const TokenUsageSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadInputTokens: z.number().int().nonnegative(),
    cacheWriteInputTokens: z.number().int().nonnegative(),
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

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

interface PricedQuantity {
  readonly quantity: string;
  readonly costUsd: string;
  readonly credits: string;
}

export interface PricedTokenUsage {
  readonly input: PricedQuantity;
  readonly output: PricedQuantity;
  readonly cacheRead: PricedQuantity;
  readonly cacheWrite: PricedQuantity;
  readonly totalCredits: string;
}

const UsageEstimateInputSchema = z
  .object({
    category: z.enum(USAGE_CATEGORIES),
    quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/u),
    unit: z.string().trim().min(1),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1).optional(),
  })
  .strict();

export type UsageEstimateInput = z.infer<typeof UsageEstimateInputSchema>;

export interface UsageEstimate {
  readonly quantity: string;
  readonly costUsd: string;
  readonly credits: string;
}

const USD_SCALE = 6;
const CREDIT_SCALE = 4;
const PER_MILLION = 1_000_000n;

export function loadPricingConfig(input: unknown): PricingConfig {
  return PricingConfigSchema.parse(input);
}

export async function loadPricingFile(url: URL): Promise<PricingConfig> {
  return loadPricingConfig(JSON.parse(await readFile(url, 'utf8')) as unknown);
}

export function priceTokenUsage(config: PricingConfig, input: TokenUsage): PricedTokenUsage {
  const usage = TokenUsageSchema.parse(input);
  const rate = rateFor(config, usage.provider, usage.model);
  const uncached = usage.inputTokens - usage.cacheReadInputTokens - usage.cacheWriteInputTokens;
  const [pricedInput, output, cacheRead, cacheWrite] = priceQuantities(config, [
    { quantity: uncached, usdPerMillion: rate.inputUsdPerMillion },
    { quantity: usage.outputTokens, usdPerMillion: rate.outputUsdPerMillion },
    { quantity: usage.cacheReadInputTokens, usdPerMillion: rate.cacheReadUsdPerMillion },
    { quantity: usage.cacheWriteInputTokens, usdPerMillion: rate.cacheWriteUsdPerMillion },
  ]);
  if (
    pricedInput === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    throw new Error('pricing allocation did not return every token category');
  }
  const total = [pricedInput, output, cacheRead, cacheWrite].reduce(
    (sum, part) => sum + decimalUnits(part.credits, CREDIT_SCALE),
    0n,
  );
  return {
    input: pricedInput,
    output,
    cacheRead,
    cacheWrite,
    totalCredits: fixed(total, CREDIT_SCALE),
  };
}

export function worstCaseReservation(
  config: PricingConfig,
  attempts: readonly PricedRouteAttempt[],
): string {
  const parsed = z.array(RouteAttemptSchema).min(1).parse(attempts);
  let credits = 0n;
  for (const attempt of parsed) {
    const rate = rateFor(config, attempt.provider, attempt.model);
    const worstInputRate = [
      rate.inputUsdPerMillion,
      rate.cacheReadUsdPerMillion,
      rate.cacheWriteUsdPerMillion,
    ].reduce((highest, candidate) =>
      decimalUnits(candidate, USD_SCALE) > decimalUnits(highest, USD_SCALE) ? candidate : highest,
    );
    for (const part of priceQuantities(config, [
      { quantity: attempt.maxInputTokens, usdPerMillion: worstInputRate },
      { quantity: attempt.maxOutputTokens, usdPerMillion: rate.outputUsdPerMillion },
    ])) {
      credits += decimalUnits(part.credits, CREDIT_SCALE);
    }
  }
  return fixed(credits, CREDIT_SCALE);
}

export function estimateUsage(config: PricingConfig, rawInput: UsageEstimateInput): UsageEstimate {
  const input = UsageEstimateInputSchema.parse(rawInput);
  const quantityUnits = signedDecimalUnits(input.quantity, 6);
  let costMicroUsd: bigint;
  if (
    input.category === 'model_input_tokens' ||
    input.category === 'model_output_tokens' ||
    input.category === 'model_cached_tokens'
  ) {
    if (input.model === undefined) throw new Error(`model is required for ${input.category}`);
    const rate = rateFor(config, input.provider, input.model);
    const usdPerMillion =
      input.category === 'model_input_tokens'
        ? rate.inputUsdPerMillion
        : input.category === 'model_output_tokens'
          ? rate.outputUsdPerMillion
          : input.unit === 'cache_write_input_tokens'
            ? rate.cacheWriteUsdPerMillion
            : rate.cacheReadUsdPerMillion;
    costMicroUsd = divideRounded(
      quantityUnits * decimalUnits(usdPerMillion, USD_SCALE),
      10n ** 12n,
    );
  } else {
    const rate = config.usageRates?.[input.category];
    if (rate === undefined) throw new Error(`pricing rate missing for ${input.category}`);
    costMicroUsd = divideRounded(
      quantityUnits * decimalUnits(rate.usdPerUnit, USD_SCALE),
      10n ** 6n,
    );
  }
  const creditUnits = divideRounded(
    costMicroUsd * decimalUnits(config.creditsPerUsd, CREDIT_SCALE),
    10n ** BigInt(USD_SCALE),
  );
  return {
    quantity: input.quantity,
    costUsd: fixed(costMicroUsd, USD_SCALE),
    credits: fixed(creditUnits, CREDIT_SCALE),
  };
}

function rateFor(config: PricingConfig, provider: string, model: string) {
  const reference = `${provider}/${model}`;
  const rate = config.models[reference];
  if (rate === undefined) throw new Error(`pricing rate missing for ${reference}`);
  return rate;
}

function priceQuantities(
  config: PricingConfig,
  quantities: readonly { readonly quantity: number; readonly usdPerMillion: string }[],
): PricedQuantity[] {
  let weightedRateUnits = 0n;
  let priorCostMicroUsd = 0n;
  let priorCreditUnits = 0n;
  const creditsPerUsd = decimalUnits(config.creditsPerUsd, CREDIT_SCALE);
  return quantities.map(({ quantity, usdPerMillion }) => {
    weightedRateUnits += BigInt(quantity) * decimalUnits(usdPerMillion, USD_SCALE);
    const cumulativeCostMicroUsd = divideRounded(weightedRateUnits, PER_MILLION);
    const cumulativeCreditUnits = divideRounded(
      weightedRateUnits * creditsPerUsd,
      PER_MILLION * 10n ** BigInt(USD_SCALE),
    );
    const priced = {
      quantity: String(quantity),
      costUsd: fixed(cumulativeCostMicroUsd - priorCostMicroUsd, USD_SCALE),
      credits: fixed(cumulativeCreditUnits - priorCreditUnits, CREDIT_SCALE),
    };
    priorCostMicroUsd = cumulativeCostMicroUsd;
    priorCreditUnits = cumulativeCreditUnits;
    return priced;
  });
}

function decimalUnits(value: string, scale: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new Error(`decimal has more than ${String(scale)} places`);
  return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
}

function signedDecimalUnits(value: string, scale: number): bigint {
  const parsed = z
    .string()
    .regex(/^\d+(?:\.\d+)?$/u)
    .parse(value);
  return decimalUnits(parsed, scale);
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function fixed(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
