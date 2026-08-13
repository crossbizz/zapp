import { describe, expect, it, vi } from 'vitest';

import {
  FEATURE_FLAGS,
  clientFeatureFlagDefaults,
  createFeatureFlagEvaluator,
  staleFeatureFlags,
} from '../src/flags.js';

const ORGANIZATION_ID = 'org_01J00000000000000000000000';

describe('typed feature flags', () => {
  it('publishes the binding catalog with lifecycle metadata and safe defaults', () => {
    expect(Object.keys(FEATURE_FLAGS)).toEqual([
      'voice-input',
      'mobile-app-tab',
      'visual-editing',
      'browser-agent-enabled',
      'auto-repair-enabled',
      'autonomous-mode',
      'model-default-override',
    ]);
    expect(FEATURE_FLAGS['voice-input']).toMatchObject({ type: 'boolean', default: false });
    expect(FEATURE_FLAGS['browser-agent-enabled']).toMatchObject({
      type: 'boolean',
      default: true,
      risk: 'kill-switch',
    });
    expect(FEATURE_FLAGS['auto-repair-enabled']).toMatchObject({
      type: 'boolean',
      default: true,
      risk: 'kill-switch',
    });
    expect(FEATURE_FLAGS['autonomous-mode']).toMatchObject({
      type: 'boolean',
      default: false,
      rollout: 'organization',
    });
    expect(FEATURE_FLAGS['model-default-override']).toMatchObject({
      type: 'multivariate',
      default: 'control',
    });
    for (const entry of Object.values(FEATURE_FLAGS)) {
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(entry.expiryReview).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
    expect(clientFeatureFlagDefaults()).toEqual({
      'mobile-app-tab': false,
      'visual-editing': false,
      'voice-input': false,
    });
  });

  it('returns the catalog default when PostHog is unavailable', async () => {
    const evaluator = createFeatureFlagEvaluator({
      provider: {
        evaluate: vi.fn().mockRejectedValue(new Error('PostHog unavailable')),
      },
    });

    await expect(evaluator.evaluate('browser-agent-enabled', {
      organizationId: ORGANIZATION_ID,
    })).resolves.toBe(true);
    await expect(evaluator.evaluate('autonomous-mode', {
      organizationId: ORGANIZATION_ID,
    })).resolves.toBe(false);
  });

  it('evaluates organization-targeted rollout with the organization group key', async () => {
    const evaluate = vi.fn().mockResolvedValue(true);
    const evaluator = createFeatureFlagEvaluator({ provider: { evaluate } });

    await expect(evaluator.evaluate('autonomous-mode', {
      organizationId: ORGANIZATION_ID,
      distinctId: 'user_01J00000000000000000000000',
    })).resolves.toBe(true);

    expect(evaluate).toHaveBeenCalledWith({
      distinctId: 'user_01J00000000000000000000000',
      flag: 'autonomous-mode',
      groups: { organization: ORGANIZATION_ID },
    });
  });

  it('caches evaluations for 60 seconds and permits a phase boundary refresh', async () => {
    let now = 1_000;
    const evaluate = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const evaluator = createFeatureFlagEvaluator({
      provider: { evaluate },
      now: () => now,
    });

    await expect(evaluator.evaluate('browser-agent-enabled', {
      organizationId: ORGANIZATION_ID,
    })).resolves.toBe(true);
    now += 59_999;
    await expect(evaluator.evaluate('browser-agent-enabled', {
      organizationId: ORGANIZATION_ID,
    })).resolves.toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(1);

    await expect(evaluator.evaluate('browser-agent-enabled', {
      organizationId: ORGANIZATION_ID,
      refresh: true,
    })).resolves.toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(2);

    now += 60_000;
    await expect(evaluator.evaluate('browser-agent-enabled', {
      organizationId: ORGANIZATION_ID,
    })).resolves.toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it('reports catalog entries whose expiry-review date has passed', () => {
    expect(staleFeatureFlags(new Date('2026-08-11T00:00:00.000Z'))).toEqual([]);
    expect(staleFeatureFlags(new Date('2027-01-01T00:00:00.000Z'))).toEqual(
      Object.keys(FEATURE_FLAGS),
    );
  });

  it('keeps the production catalog inside its expiry-review window', () => {
    expect(
      staleFeatureFlags(),
      'feature flags past expiry-review must be removed or renewed by their owner',
    ).toEqual([]);
  });
});
