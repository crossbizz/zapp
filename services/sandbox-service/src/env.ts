import {
  SERVICE_TOKEN_ISSUER,
  defineEnv,
  type ServiceTokenConfig,
} from '@zapp/config';
import { z } from 'zod';

const placeholderSafeSecret = (minimumLength = 1) =>
  z
    .string()
    .trim()
    .min(minimumLength)
    .refine((value) => !/^replace-me(?:$|-)/u.test(value), 'Placeholder values are forbidden');

const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//u.test(value), 'Expected an HTTP or HTTPS URL')
  .transform((value) => value.replace(/\/+$/u, ''));

const RawSandboxServiceEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  SANDBOX_HOST: z.string().trim().min(1),
  SANDBOX_PORT: z.coerce.number().int().min(1).max(65_535),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => /^postgres(?:ql)?:\/\//u.test(value), 'Expected a PostgreSQL URL'),
  CONTROL_API_INTERNAL_URL: HttpUrlSchema,
  GIT_SERVICE_URL: HttpUrlSchema,
  SERVICE_TOKEN_SECRET: placeholderSafeSecret(32),
  SERVICE_TOKEN_SECRET_PREVIOUS: z
    .union([placeholderSafeSecret(32), z.literal('')])
    .optional(),
  SERVICE_TOKEN_ISSUER: z.literal(SERVICE_TOKEN_ISSUER),
  MODAL_TOKEN_ID: placeholderSafeSecret(),
  MODAL_TOKEN_SECRET: placeholderSafeSecret(),
  MODAL_ENVIRONMENT: z.enum(['dev', 'staging', 'prod']),
  SANDBOX_GLOBAL_LIMIT: z.coerce.number().int().positive(),
  SANDBOX_OWNER_ID: z.string().trim().min(1).max(200),
  GRAFANA_OTLP_ENDPOINT: z.string().url().optional(),
  GRAFANA_OTLP_TOKEN: z.string().trim().min(1).optional(),
});

export interface SandboxServiceEnv {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly controlApiInternalUrl: string;
  readonly gitServiceUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly serviceTokenIssuer: typeof SERVICE_TOKEN_ISSUER;
  readonly modal: {
    readonly environment: 'dev' | 'staging' | 'prod';
    readonly credentials: { readonly tokenId: string; readonly tokenSecret: string };
  };
  readonly globalLimit: number;
  readonly ownerId: string;
  readonly telemetryEnv: Readonly<Record<string, string | undefined>>;
}

export const SandboxServiceEnvSchema: z.ZodType<
  SandboxServiceEnv,
  z.ZodTypeDef,
  z.input<typeof RawSandboxServiceEnvSchema>
> =
  RawSandboxServiceEnvSchema.transform((env) => {
    const previousSecret = env.SERVICE_TOKEN_SECRET_PREVIOUS;
    return {
      nodeEnv: env.NODE_ENV,
      host: env.SANDBOX_HOST,
      port: env.SANDBOX_PORT,
      databaseUrl: env.DATABASE_URL,
      controlApiInternalUrl: env.CONTROL_API_INTERNAL_URL,
      gitServiceUrl: env.GIT_SERVICE_URL,
      serviceTokens: {
        secret: env.SERVICE_TOKEN_SECRET,
        ...(previousSecret === undefined || previousSecret === ''
          ? {}
          : { previousSecret }),
      },
      serviceTokenIssuer: env.SERVICE_TOKEN_ISSUER,
      modal: {
        environment: env.MODAL_ENVIRONMENT,
        credentials: {
          tokenId: env.MODAL_TOKEN_ID,
          tokenSecret: env.MODAL_TOKEN_SECRET,
        },
      },
      globalLimit: env.SANDBOX_GLOBAL_LIMIT,
      ownerId: env.SANDBOX_OWNER_ID,
      telemetryEnv: {
        GRAFANA_OTLP_ENDPOINT: env.GRAFANA_OTLP_ENDPOINT,
        GRAFANA_OTLP_TOKEN: env.GRAFANA_OTLP_TOKEN,
        NODE_ENV: env.NODE_ENV,
      },
    };
  });

export function loadSandboxServiceEnv(source: unknown = process.env): SandboxServiceEnv {
  return defineEnv(SandboxServiceEnvSchema, source);
}
