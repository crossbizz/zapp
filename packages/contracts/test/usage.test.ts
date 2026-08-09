import { describe, expect, it } from 'vitest';

import {
  ModelCompletionClaimRequestSchema,
  ModelCompletionCommitRequestSchema,
} from '../src/usage.js';

const identity = {
  completionId: `cmp_${'a'.repeat(64)}`,
  organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
  projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
  runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
  requestFingerprint: 'b'.repeat(64),
} as const;

describe('OPS-1A model-completion boundaries', () => {
  it('accepts a strict claim for the full retry/fallback reservation route', () => {
    expect(
      ModelCompletionClaimRequestSchema.parse({
        ...identity,
        claimOwner: 'gateway-replica-1',
        leaseMs: 30_000,
        route: [
          {
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            maxInputTokens: 10_000,
            maxOutputTokens: 2_000,
          },
        ],
      }),
    ).toBeDefined();
  });

  it('requires attributed usage even when the terminal outcome is an error', () => {
    expect(
      ModelCompletionCommitRequestSchema.parse({
        ...identity,
        claimOwner: 'gateway-replica-1',
        events: [{ type: 'text-delta', text: 'partial' }],
        usage: [
          {
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 10,
            cacheWriteInputTokens: 5,
            occurredAt: '2026-08-09T12:00:00.000Z',
          },
        ],
        terminal: {
          type: 'error',
          code: 'provider_error',
          message: 'The model provider request failed.',
        },
      }),
    ).toBeDefined();
  });

  it('rejects unknown claim fields and cache totals larger than input', () => {
    expect(() =>
      ModelCompletionClaimRequestSchema.parse({
        ...identity,
        claimOwner: 'gateway-replica-1',
        leaseMs: 30_000,
        route: [],
        bypass: true,
      }),
    ).toThrow();
    expect(() =>
      ModelCompletionCommitRequestSchema.parse({
        ...identity,
        claimOwner: 'gateway-replica-1',
        events: [],
        usage: [
          {
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            inputTokens: 1,
            outputTokens: 0,
            cacheReadInputTokens: 2,
            cacheWriteInputTokens: 0,
            occurredAt: '2026-08-09T12:00:00.000Z',
          },
        ],
        terminal: { type: 'done' },
      }),
    ).toThrow('cached input tokens');
  });
});
