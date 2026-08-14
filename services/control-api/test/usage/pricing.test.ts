import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadPlanLimitsConfig } from '../../src/usage/limits.js';
import {
  estimateUsage,
  loadPricingConfig,
  priceTokenUsage,
  worstCaseReservation,
} from '../../src/usage/pricing.js';

const config = {
  version: 'm1-test',
  defaultRunCreditCeiling: '100.0000',
  creditsPerUsd: '100.0000',
  usageRates: {
    sandbox_cpu_seconds: { unit: 'cpu_seconds', usdPerUnit: '0.000010' },
    sandbox_mem_gib_seconds: { unit: 'gib_seconds', usdPerUnit: '0.000005' },
  },
  models: {
    'anthropic/claude-sonnet-5': {
      inputUsdPerMillion: '3.000000',
      outputUsdPerMillion: '15.000000',
      cacheReadUsdPerMillion: '0.300000',
      cacheWriteUsdPerMillion: '3.750000',
    },
    'openai/gpt-5': {
      inputUsdPerMillion: '1.250000',
      outputUsdPerMillion: '10.000000',
      cacheReadUsdPerMillion: '0.125000',
      cacheWriteUsdPerMillion: '1.250000',
    },
  },
} as const;

describe('OPS-1A pricing snapshot', () => {
  it('keeps the trial run ceiling above eight productive Builder turns', async () => {
    const [pricingJson, plansJson, modelsJson] = await Promise.all([
      readFile(new URL('../../../../config/pricing.json', import.meta.url), 'utf8'),
      readFile(new URL('../../../../config/plans.json', import.meta.url), 'utf8'),
      readFile(
        new URL('../../../model-gateway/config/models.json', import.meta.url),
        'utf8',
      ),
    ]);
    const configuredPricing = loadPricingConfig(JSON.parse(pricingJson) as unknown);
    const plans = loadPlanLimitsConfig(JSON.parse(plansJson) as unknown);
    const models = JSON.parse(modelsJson) as {
      roles: { builder: { primary: string; fallbacks: string[] } };
    };
    const route = [models.roles.builder.primary, ...models.roles.builder.fallbacks].flatMap(
      (reference) => {
        const [provider, model] = reference.split('/');
        if (provider === undefined || model === undefined) throw new Error('invalid model route');
        return Array.from({ length: 2 }, () => ({
          provider,
          model,
          maxInputTokens: 10_000,
          maxOutputTokens: 8_192,
        }));
      },
    );
    const required = Number(worstCaseReservation(configuredPricing, route)) * 8;

    expect(Number(plans.trial.maxRunBudgetCredits)).toBeGreaterThanOrEqual(required);
  });

  it.each([
    {
      name: 'tokens',
      input: {
        category: 'model_input_tokens' as const,
        quantity: '1000000',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      },
      expected: { costUsd: '3.000000', credits: '300.0000' },
    },
    {
      name: 'CPU-seconds',
      input: { category: 'sandbox_cpu_seconds' as const, quantity: '10.000000' },
      expected: { costUsd: '0.000100', credits: '0.0100' },
    },
    {
      name: 'GiB-seconds',
      input: { category: 'sandbox_mem_gib_seconds' as const, quantity: '10.000000' },
      expected: { costUsd: '0.000050', credits: '0.0050' },
    },
  ])('estimates $name with exact decimal arithmetic', ({ input, expected }) => {
    expect(estimateUsage(loadPricingConfig(config), input)).toEqual(expected);
  });

  it('prices uncached, cache-read, cache-write and output tokens exactly', () => {
    const pricing = loadPricingConfig(config);
    expect(
      priceTokenUsage(pricing, {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadInputTokens: 200_000,
        cacheWriteInputTokens: 100_000,
      }),
    ).toEqual({
      input: { quantity: '700000', costUsd: '2.100000', credits: '210.0000' },
      output: { quantity: '100000', costUsd: '1.500000', credits: '150.0000' },
      cacheRead: { quantity: '200000', costUsd: '0.060000', credits: '6.0000' },
      cacheWrite: { quantity: '100000', costUsd: '0.375000', credits: '37.5000' },
      totalCredits: '403.5000',
    });
  });

  it('reserves the whole configured retry and fallback route before dispatch', () => {
    const pricing = loadPricingConfig(config);
    expect(
      worstCaseReservation(pricing, [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          maxInputTokens: 10_000,
          maxOutputTokens: 2_000,
        },
        {
          provider: 'openai',
          model: 'gpt-5',
          maxInputTokens: 10_000,
          maxOutputTokens: 2_000,
        },
      ]),
    ).toBe('10.0000');
  });

  it('reserves at least every allowed cache split despite credit-unit rounding', () => {
    const pricing = loadPricingConfig(config);
    const reservation = worstCaseReservation(pricing, [
      {
        provider: 'openai',
        model: 'gpt-5',
        maxInputTokens: 4,
        maxOutputTokens: 1,
      },
    ]);
    const actual = priceTokenUsage(pricing, {
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 4,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 2,
    });

    expect(reservation).toBe('0.0015');
    expect(actual.totalCredits).toBe('0.0015');
  });

  it.each([
    [{ ...config, defaultRunCreditCeiling: '0' }, 'defaultRunCreditCeiling'],
    [{ ...config, creditsPerUsd: '-1' }, 'creditsPerUsd'],
    [
      {
        ...config,
        creditPacks: { starter: { credits: '499.0000', amountUsd: '5.00' } },
      },
      'creditPacks',
    ],
    [
      {
        ...config,
        models: {
          'anthropic/claude-sonnet-5': {
            inputUsdPerMillion: '3',
            outputUsdPerMillion: '15',
            cacheReadUsdPerMillion: '0.3',
          },
        },
      },
      'cacheWriteUsdPerMillion',
    ],
  ])('fails closed on an invalid or incomplete pricing boundary', (input, field) => {
    expect(() => loadPricingConfig(input)).toThrow(field);
  });
});
