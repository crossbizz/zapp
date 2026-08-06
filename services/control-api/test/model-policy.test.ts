import { describe, expect, it } from 'vitest';

import { allowedModelsFromPolicy } from '../src/orgs/model-policy.js';

describe('allowedModelsFromPolicy', () => {
  it('reads an array policy and removes duplicate model identifiers', () => {
    expect([
      ...allowedModelsFromPolicy([
        'anthropic/claude-sonnet-5',
        'openai/gpt-5',
        'anthropic/claude-sonnet-5',
      ]),
    ]).toEqual(['anthropic/claude-sonnet-5', 'openai/gpt-5']);
  });

  it('reads the allowedModels object policy', () => {
    expect([
      ...allowedModelsFromPolicy({
        allowedModels: ['google/gemini-2.5-pro', 'anthropic/claude-sonnet-5'],
      }),
    ]).toEqual(['google/gemini-2.5-pro', 'anthropic/claude-sonnet-5']);
  });

  it('drops blank, invalid, and non-string entries without widening the policy', () => {
    expect([
      ...allowedModelsFromPolicy([
        '',
        ' model with spaces ',
        false,
        42,
        null,
        { provider: 'anthropic' },
        'openai/gpt-5-mini',
      ]),
    ]).toEqual(['openai/gpt-5-mini']);
    expect([...allowedModelsFromPolicy({ allowedModels: 'openai/gpt-5' })]).toEqual([]);
    expect([...allowedModelsFromPolicy({ models: ['openai/gpt-5'] })]).toEqual([]);
  });

  it('treats a missing or malformed policy as an empty allowed set', () => {
    for (const policy of [undefined, null, true, 7, 'openai/gpt-5']) {
      expect([...allowedModelsFromPolicy(policy)]).toEqual([]);
    }
  });
});
