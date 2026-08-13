import { defineEnv, type ServiceTokenConfig } from '@zapp/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4300),
});

export type ServiceEnv = z.infer<typeof EnvSchema>;

export function loadEnv(source: unknown = process.env): ServiceEnv {
  return defineEnv(EnvSchema, source);
}

const ServiceTokenEnvSchema = z.object({
  SERVICE_TOKEN_SECRET: z.string().min(32),
  SERVICE_TOKEN_SECRET_PREVIOUS: z.union([z.string().min(32), z.literal('')]).optional(),
});

export function loadServiceTokenConfig(source: unknown = process.env): ServiceTokenConfig {
  const value = defineEnv(ServiceTokenEnvSchema, source);
  return {
    secret: value.SERVICE_TOKEN_SECRET,
    ...(value.SERVICE_TOKEN_SECRET_PREVIOUS === undefined ||
    value.SERVICE_TOKEN_SECRET_PREVIOUS === ''
      ? {}
      : { previousSecret: value.SERVICE_TOKEN_SECRET_PREVIOUS }),
  };
}
