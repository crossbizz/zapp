import { defineEnv, SERVICE_TOKEN_ISSUER, type ServiceTokenConfig } from '@zapp/config';
import { z } from 'zod';

const RawRunWorkerEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    DATABASE_URL: z.string().url(),
    TEMPORAL_ADDRESS: z.string().trim().min(1),
    TEMPORAL_NAMESPACE: z.string().trim().min(1),
    CONTROL_API_INTERNAL_URL: z.string().url(),
    MODEL_GATEWAY_URL: z.string().url(),
    SANDBOX_SERVICE_URL: z.string().url(),
    GIT_SERVICE_URL: z.string().url(),
    SERVICE_TOKEN_SECRET: z.string().min(32),
    SERVICE_TOKEN_SECRET_PREVIOUS: z.union([z.string().min(32), z.literal('')]).optional(),
    SERVICE_TOKEN_ISSUER: z.literal(SERVICE_TOKEN_ISSUER),
    RUN_WORKFLOW_PROFILE: z.enum(['default', 'm1']),
  })
  .superRefine((env, context) => {
    if (env.RUN_WORKFLOW_PROFILE === 'm1' && env.NODE_ENV !== 'development') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RUN_WORKFLOW_PROFILE'],
        message: 'RUN_WORKFLOW_PROFILE=m1 is allowed only with NODE_ENV=development',
      });
    }
  });

export interface RunWorkerEnv {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly databaseUrl: string;
  readonly temporalAddress: string;
  readonly temporalNamespace: string;
  readonly controlApiInternalUrl: string;
  readonly modelGatewayUrl: string;
  readonly sandboxServiceUrl: string;
  readonly gitServiceUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly workflowProfile: 'default' | 'm1';
}

export const RunWorkerEnvSchema: z.ZodType<RunWorkerEnv, z.ZodTypeDef, unknown> =
  RawRunWorkerEnvSchema.transform(
    (env) => ({
      nodeEnv: env.NODE_ENV,
      databaseUrl: env.DATABASE_URL,
      temporalAddress: env.TEMPORAL_ADDRESS,
      temporalNamespace: env.TEMPORAL_NAMESPACE,
      controlApiInternalUrl: env.CONTROL_API_INTERNAL_URL.replace(/\/+$/u, ''),
      modelGatewayUrl: env.MODEL_GATEWAY_URL.replace(/\/+$/u, ''),
      sandboxServiceUrl: env.SANDBOX_SERVICE_URL.replace(/\/+$/u, ''),
      gitServiceUrl: env.GIT_SERVICE_URL.replace(/\/+$/u, ''),
      serviceTokens: {
        secret: env.SERVICE_TOKEN_SECRET,
        ...(env.SERVICE_TOKEN_SECRET_PREVIOUS === undefined ||
        env.SERVICE_TOKEN_SECRET_PREVIOUS === ''
          ? {}
          : { previousSecret: env.SERVICE_TOKEN_SECRET_PREVIOUS }),
      },
      workflowProfile: env.RUN_WORKFLOW_PROFILE,
    }),
  );

export function loadRunWorkerEnv(source: unknown = process.env): RunWorkerEnv {
  return defineEnv(RunWorkerEnvSchema, source);
}
