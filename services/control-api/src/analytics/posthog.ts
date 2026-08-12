import {
  createFeatureFlagEvaluator,
  createProductAnalytics,
  type FeatureFlagEvaluator,
  type FeatureFlagProvider,
  type ProductAnalytics,
  type ProductAnalyticsProvider,
} from '@zapp/config';
import { PostHog } from 'posthog-node';

import type { PostHogEnv } from '../env.js';

interface PostHogFlagResult {
  getFlag(key: string): unknown;
}

export interface PostHogClientPort {
  capture(input: Parameters<ProductAnalyticsProvider['capture']>[0]): void;
  evaluateFlags(
    distinctId: string,
    options: {
      readonly flagKeys: readonly string[];
      readonly groups: Readonly<Record<'organization', string>>;
    },
  ): Promise<PostHogFlagResult>;
}

/**
 * Keeps provider-specific shapes at the service composition edge. The rest of
 * the control plane only sees the typed, privacy-filtered config package ports.
 */
export function createPostHogAdapters(client: PostHogClientPort): {
  readonly analytics: ProductAnalyticsProvider;
  readonly flags: FeatureFlagProvider;
} {
  return {
    analytics: {
      capture(input) {
        client.capture(input);
      },
    },
    flags: {
      async evaluate(input) {
        const result = await client.evaluateFlags(input.distinctId, {
          flagKeys: [input.flag],
          groups: input.groups,
        });
        return result.getFlag(input.flag);
      },
    },
  };
}

export interface PostHogRuntime {
  readonly analytics: ProductAnalytics;
  readonly flags: FeatureFlagEvaluator;
  shutdown(): Promise<void>;
}

export function createPostHogRuntime(config: PostHogEnv): PostHogRuntime {
  const client = new PostHog(config.projectKey, { host: config.host });
  const adapters = createPostHogAdapters({
    capture: (input) => {
      client.capture(input);
    },
    evaluateFlags: async (distinctId, options) =>
      await client.evaluateFlags(distinctId, {
        flagKeys: [...options.flagKeys],
        groups: options.groups,
      }),
  });
  return {
    analytics: createProductAnalytics(adapters.analytics),
    flags: createFeatureFlagEvaluator({ provider: adapters.flags }),
    shutdown: async () => {
      await client.shutdown();
    },
  };
}
