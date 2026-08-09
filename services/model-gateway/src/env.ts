import { defineEnv, type ServiceTokenConfig } from '@zapp/config';
import { z } from 'zod';

const ServiceEnvSchema = z.object({
  SERVICE_TOKEN_SECRET: z.string().min(32),
  SERVICE_TOKEN_SECRET_PREVIOUS: z.union([z.string().min(32), z.literal('')]).optional(),
  MODEL_GATEWAY_PORT: z.coerce.number().int().positive().max(65_535).default(4100),
  CONTROL_API_URL: z.string().url().default('http://127.0.0.1:4000'),
});

export interface ModelGatewayEnv {
  readonly serviceTokens: ServiceTokenConfig;
  readonly port: number;
  readonly controlApiUrl: string;
}

export function loadModelGatewayEnv(source: unknown = process.env): ModelGatewayEnv {
  const env = defineEnv(ServiceEnvSchema, source);
  const previousSecret = env.SERVICE_TOKEN_SECRET_PREVIOUS;
  return {
    serviceTokens: {
      secret: env.SERVICE_TOKEN_SECRET,
      ...(previousSecret === undefined || previousSecret === ''
        ? {}
        : { previousSecret }),
    },
    port: env.MODEL_GATEWAY_PORT,
    controlApiUrl: env.CONTROL_API_URL,
  };
}
