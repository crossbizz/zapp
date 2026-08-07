import { z } from 'zod';

export const ProviderIdSchema = z.enum(['anthropic', 'openai', 'google', 'compatible']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

const ModelReferenceSchema = z.string().refine(
  (value) => {
    const separator = value.indexOf('/');
    return (
      separator > 0 &&
      separator < value.length - 1 &&
      ProviderIdSchema.safeParse(value.slice(0, separator)).success
    );
  },
  { message: 'model references must be <provider>/<model>' },
);

const RoleModelSchema = z
  .object({
    primary: ModelReferenceSchema,
    fallbacks: z.array(ModelReferenceSchema),
  })
  .strict()
  .superRefine((role, context) => {
    const transports = new Set(
      [role.primary, ...role.fallbacks].map((reference) =>
        reference.slice(0, reference.indexOf('/')),
      ),
    );
    if (transports.size < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'role primary and fallbacks must use at least two transports',
        path: ['fallbacks'],
      });
    }
  });

const StandardProviderSchema = z
  .object({
    apiKeyEnv: z.string().min(1),
    baseUrlEnv: z.string().min(1).optional(),
  })
  .strict();

const CompatibleProviderSchema = z
  .object({
    apiKeyEnv: z.string().min(1),
    baseUrlEnv: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const ModelsConfigSchema = z
  .object({
    roles: z
      .object({
        planner: RoleModelSchema,
        builder: RoleModelSchema,
        verifier: RoleModelSchema,
        summarizer: RoleModelSchema,
      })
      .strict(),
    providers: z
      .object({
        anthropic: StandardProviderSchema,
        openai: StandardProviderSchema,
        google: StandardProviderSchema,
        compatible: CompatibleProviderSchema,
      })
      .strict(),
  })
  .strict();

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type ProviderConfig = ModelsConfig['providers'];

export function loadModelsConfig(input: unknown): ModelsConfig {
  return ModelsConfigSchema.parse(input);
}
