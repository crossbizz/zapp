import { z } from 'zod';

export const APP_TYPES = ['web', 'mobile'] as const;

export const AppTypeSchema = z.enum(APP_TYPES);
export type AppType = z.infer<typeof AppTypeSchema>;

export const ModelIdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export type ModelIdentifier = z.infer<typeof ModelIdentifierSchema>;
