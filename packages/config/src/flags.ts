import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

const BooleanFlagSchema = z
  .object({
    type: z.literal('boolean'),
    default: z.boolean(),
    owner: z.string().trim().min(1),
    expiryReview: z.string().date(),
    client: z.boolean(),
    risk: z.enum(['ordinary', 'kill-switch']),
    rollout: z.enum(['global', 'organization']),
  })
  .strict();
const MultivariateFlagSchema = z
  .object({
    type: z.literal('multivariate'),
    default: z.string().trim().min(1),
    owner: z.string().trim().min(1),
    expiryReview: z.string().date(),
    client: z.boolean(),
    risk: z.literal('ordinary'),
    rollout: z.enum(['global', 'organization']),
  })
  .strict();
const FeatureFlagDefinitionSchema = z.discriminatedUnion('type', [
  BooleanFlagSchema,
  MultivariateFlagSchema,
]);

export const FEATURE_FLAGS = {
  'voice-input': {
    type: 'boolean', default: false, owner: 'web', expiryReview: '2026-12-15',
    client: true, risk: 'ordinary', rollout: 'global',
  },
  'mobile-app-tab': {
    type: 'boolean', default: false, owner: 'product', expiryReview: '2026-12-15',
    client: true, risk: 'ordinary', rollout: 'global',
  },
  'visual-editing': {
    type: 'boolean', default: false, owner: 'builder', expiryReview: '2026-12-15',
    client: true, risk: 'ordinary', rollout: 'organization',
  },
  'browser-agent-enabled': {
    type: 'boolean', default: true, owner: 'agent-runtime', expiryReview: '2026-12-15',
    client: false, risk: 'kill-switch', rollout: 'organization',
  },
  'auto-repair-enabled': {
    type: 'boolean', default: true, owner: 'verification', expiryReview: '2026-12-15',
    client: false, risk: 'kill-switch', rollout: 'organization',
  },
  'autonomous-mode': {
    type: 'boolean', default: false, owner: 'agent-runtime', expiryReview: '2026-12-15',
    client: false, risk: 'kill-switch', rollout: 'organization',
  },
  'model-default-override': {
    type: 'multivariate', default: 'control', owner: 'model-routing', expiryReview: '2026-12-15',
    client: false, risk: 'ordinary', rollout: 'organization',
  },
} as const satisfies Readonly<Record<string, z.input<typeof FeatureFlagDefinitionSchema>>>;

for (const definition of Object.values(FEATURE_FLAGS)) {
  FeatureFlagDefinitionSchema.parse(definition);
}

export const FeatureFlagNameSchema = z.enum(
  Object.keys(FEATURE_FLAGS) as [keyof typeof FEATURE_FLAGS, ...(keyof typeof FEATURE_FLAGS)[]],
);
export type FeatureFlagName = z.infer<typeof FeatureFlagNameSchema>;

export const ClientFeatureFlagsResponseSchema = z
  .object({
    flags: z
      .object({
        'voice-input': z.boolean(),
        'mobile-app-tab': z.boolean(),
        'visual-editing': z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ClientFeatureFlagsResponse = z.infer<typeof ClientFeatureFlagsResponseSchema>;

type FeatureFlagValue<TName extends FeatureFlagName> =
  (typeof FEATURE_FLAGS)[TName]['default'];

const EvaluationContextSchema = z
  .object({
    organizationId: idSchema('org'),
    distinctId: z.string().trim().min(1).max(200).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();
export type FeatureFlagEvaluationContext = z.infer<typeof EvaluationContextSchema>;

export interface FeatureFlagProvider {
  evaluate(input: {
    readonly distinctId: string;
    readonly flag: FeatureFlagName;
    readonly groups: Readonly<Record<'organization', string>>;
  }): Promise<unknown>;
}

export interface FeatureFlagEvaluator {
  evaluate<TName extends FeatureFlagName>(
    flag: TName,
    context: FeatureFlagEvaluationContext,
  ): Promise<FeatureFlagValue<TName>>;
}

interface CachedFlag {
  readonly value: boolean | string;
  readonly expiresAt: number;
}

const CACHE_TTL_MS = 60_000;

function validProviderValue<TName extends FeatureFlagName>(
  flag: TName,
  value: unknown,
): FeatureFlagValue<TName> | undefined {
  const definition = FEATURE_FLAGS[flag];
  if (definition.type === 'boolean') {
    return typeof value === 'boolean' ? value : undefined;
  }
  return (typeof value === 'string' && value.length > 0 ? value : undefined) as
    | FeatureFlagValue<TName>
    | undefined;
}

export function createFeatureFlagEvaluator(options: {
  readonly provider?: FeatureFlagProvider;
  readonly now?: () => number;
}): FeatureFlagEvaluator {
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedFlag>();
  return {
    async evaluate(rawFlag, rawContext) {
      const flag = FeatureFlagNameSchema.parse(rawFlag);
      const context = EvaluationContextSchema.parse(rawContext);
      const cacheKey = `${context.organizationId}:${flag}`;
      const cached = cache.get(cacheKey);
      const currentTime = now();
      if (context.refresh !== true && cached !== undefined && cached.expiresAt > currentTime) {
        return cached.value as FeatureFlagValue<typeof flag>;
      }

      const fallback = FEATURE_FLAGS[flag].default;
      let value: FeatureFlagValue<typeof flag> = fallback;
      try {
        const providerValue = await options.provider?.evaluate({
          distinctId: context.distinctId ?? context.organizationId,
          flag,
          groups: { organization: context.organizationId },
        });
        value = validProviderValue(flag, providerValue) ?? fallback;
      } catch {
        value = fallback;
      }
      cache.set(cacheKey, { value, expiresAt: currentTime + CACHE_TTL_MS });
      return value;
    },
  };
}

export function clientFeatureFlagDefaults(): Readonly<Record<string, boolean | string>> {
  return Object.fromEntries(
    Object.entries(FEATURE_FLAGS)
      .filter(([, definition]) => definition.client)
      .map(([name, definition]) => [name, definition.default]),
  );
}

export function staleFeatureFlags(now: Date = new Date()): FeatureFlagName[] {
  const today = now.toISOString().slice(0, 10);
  return Object.entries(FEATURE_FLAGS)
    .filter(([, definition]) => definition.expiryReview < today)
    .map(([name]) => FeatureFlagNameSchema.parse(name));
}
