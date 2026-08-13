import { readFile } from 'node:fs/promises';

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

const UsageRateSchema = z
  .object({
    unit: z.string().trim().min(1),
    usdPerUnit: DecimalSchema,
  })
  .strict();

const CreditPackSchema = z
  .object({
    credits: z.string().regex(/^\d+(?:\.\d{1,4})?$/u),
    amountUsd: z.string().regex(/^\d+(?:\.\d{1,6})?$/u),
  })
  .strict();

export const CreditPackCatalogSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/u), CreditPackSchema)
  .refine((packs) => Object.keys(packs).length > 0, 'at least one credit pack is required');
export type CreditPackCatalog = z.infer<typeof CreditPackCatalogSchema>;

export const PricingConfigSchema = z
  .object({
    version: z.string().trim().min(1),
    defaultRunCreditCeiling: DecimalSchema,
    walletBalanceGraceFloor: DecimalSchema.optional(),
    creditsPerUsd: DecimalSchema,
    // Optional so immutable OPS-1A pricing snapshots written before OPS-5
    // remain readable. Deployment composition requires it for the top-up API.
    creditPacks: CreditPackCatalogSchema.optional(),
    models: z.record(z.string().regex(/^[a-z0-9-]+\/[a-z0-9][a-z0-9.-]*$/u), ModelRateSchema),
    usageRates: z
      .object({
        sandbox_cpu_seconds: UsageRateSchema,
        sandbox_mem_gib_seconds: UsageRateSchema,
        storage_gib_hours: UsageRateSchema,
        deploy_provider: UsageRateSchema,
        artifact_storage: UsageRateSchema,
      })
      .partial()
      .strict()
      // OPS-1A persisted immutable model-only snapshots before OPS-1B added
      // non-model estimates. They must remain readable through their run.
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.models).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'models must contain at least one rate',
        path: ['models'],
      });
    }
    for (const [packId, pack] of Object.entries(value.creditPacks ?? {})) {
      const usdUnits = decimalUnits(pack.amountUsd, 6);
      const creditsPerUsdUnits = decimalUnits(value.creditsPerUsd, 6);
      const configuredCreditsUnits = decimalUnits(pack.credits, 6);
      if (
        (usdUnits * creditsPerUsdUnits) % 1_000_000n !== 0n ||
        (usdUnits * creditsPerUsdUnits) / 1_000_000n !== configuredCreditsUnits
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'pack credits must equal amountUsd multiplied by creditsPerUsd',
          path: ['creditPacks', packId],
        });
      }
    }
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

export const UsageEstimateInputSchema = z
  .object({
    category: z.enum([
      'model_input_tokens',
      'model_output_tokens',
      'model_cached_tokens',
      'sandbox_cpu_seconds',
      'sandbox_mem_gib_seconds',
      'storage_gib_hours',
      'deploy_provider',
      'artifact_storage',
    ]),
    quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/u),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.category.startsWith('model_') &&
      (input.provider === undefined || input.model === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'model usage estimates require provider and model',
      });
    }
  });

export type UsageEstimateInput = z.infer<typeof UsageEstimateInputSchema>;

export interface UsageEstimate {
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

/**
 * Produces exact local estimates for Mission Control and pre-run decisions.
 * Flexprice remains the wallet/rating authority; this config snapshot is the
 * local, versioned arithmetic source and intentionally never uses JS floats.
 */
export function estimateUsage(config: PricingConfig, rawInput: UsageEstimateInput): UsageEstimate {
  const input = UsageEstimateInputSchema.parse(rawInput);
  if (input.category.startsWith('model_')) {
    const provider = input.provider;
    const model = input.model;
    if (provider === undefined || model === undefined) throw new Error('model rate is required');
    const rate = rateFor(config, provider, model);
    const usdPerMillion =
      input.category === 'model_input_tokens'
        ? rate.inputUsdPerMillion
        : input.category === 'model_output_tokens'
          ? rate.outputUsdPerMillion
          : rate.cacheReadUsdPerMillion;
    return priceDecimalQuantity(
      config,
      input.quantity,
      usdPerMillion,
      PER_MILLION * 10n ** BigInt(USD_SCALE),
    );
  }
  const rate =
    config.usageRates?.[input.category as keyof NonNullable<PricingConfig['usageRates']>];
  if (rate === undefined) throw new Error(`pricing rate missing for ${input.category}`);
  return priceDecimalQuantity(config, input.quantity, rate.usdPerUnit, 10n ** BigInt(USD_SCALE));
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

function priceDecimalQuantity(
  config: PricingConfig,
  quantity: string,
  usdRate: string,
  denominator: bigint,
): UsageEstimate {
  const quantityUnits = decimalUnits(quantity, USD_SCALE);
  const rateUnits = decimalUnits(usdRate, USD_SCALE);
  const costUsdUnits = divideRounded(quantityUnits * rateUnits, denominator);
  const creditUnits = divideRounded(
    costUsdUnits * decimalUnits(config.creditsPerUsd, CREDIT_SCALE),
    10n ** BigInt(USD_SCALE),
  );
  return {
    costUsd: fixed(costUsdUnits, USD_SCALE),
    credits: fixed(creditUnits, CREDIT_SCALE),
  };
}

function decimalUnits(value: string, scale: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new Error(`decimal has more than ${String(scale)} places`);
  return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function fixed(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
