import {
  createFeatureFlagEvaluator,
  type FeatureFlagEvaluator,
  type FeatureFlagProvider,
} from '@zapp/config';
import { idSchema } from '@zapp/contracts';
import { PostHog } from 'posthog-node';
import { z } from 'zod';

const RiskFeatureFlagSchema = z.enum([
  'browser-agent-enabled',
  'auto-repair-enabled',
  'autonomous-mode',
]);

export const EvaluateFeatureFlagInputSchema = z
  .object({
    organizationId: idSchema('org'),
    distinctId: z.string().trim().min(1).max(200),
    flag: RiskFeatureFlagSchema,
  })
  .strict();

export const EvaluateFeatureFlagResultSchema = z.object({ enabled: z.boolean() }).strict();

export type EvaluateFeatureFlagInput = z.infer<typeof EvaluateFeatureFlagInputSchema>;
export type EvaluateFeatureFlagResult = z.infer<typeof EvaluateFeatureFlagResultSchema>;

export interface FeatureFlagActivities {
  evaluateFeatureFlag(input: EvaluateFeatureFlagInput): Promise<EvaluateFeatureFlagResult>;
}

export function createFeatureFlagActivities(
  evaluator: FeatureFlagEvaluator,
): FeatureFlagActivities {
  return {
    async evaluateFeatureFlag(inputValue) {
      const input = EvaluateFeatureFlagInputSchema.parse(inputValue);
      const enabled = await evaluator.evaluate(input.flag, {
        organizationId: input.organizationId,
        distinctId: input.distinctId,
        // A workflow phase boundary is a safety decision. It must not inherit a
        // prior phase's cached allow after an operator flips a kill switch.
        refresh: true,
      });
      return EvaluateFeatureFlagResultSchema.parse({ enabled });
    },
  };
}

export interface PostHogFeatureFlagRuntime {
  readonly activities: FeatureFlagActivities;
  shutdown(): Promise<void>;
}

/** Production PostHog Node binding for the agent-runs worker composition. */
export function createPostHogFeatureFlagRuntime(config: {
  readonly projectKey: string;
  readonly host: string;
}): PostHogFeatureFlagRuntime {
  const client = new PostHog(config.projectKey, { host: config.host });
  const provider: FeatureFlagProvider = {
    async evaluate(input) {
      const result = await client.evaluateFlags(input.distinctId, {
        flagKeys: [input.flag],
        groups: input.groups,
      });
      return result.getFlag(input.flag);
    },
  };
  return {
    activities: createFeatureFlagActivities(createFeatureFlagEvaluator({ provider })),
    shutdown: async () => {
      await client.shutdown();
    },
  };
}
