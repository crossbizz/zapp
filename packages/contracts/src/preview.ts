import { z } from 'zod';

import { idSchema } from './ids.js';
import { HttpsUrlSchema } from './primitives.js';

export const PreviewShareLocatorSchema = z.string().regex(/^[0-9a-hjkmnp-tv-z]{26}$/u);
export const PreviewSharePolicySchema = z.enum(['org', 'anyone_with_link']);

export const PreviewHandleSchema = z
  .object({
    id: PreviewShareLocatorSchema,
    url: HttpsUrlSchema,
    expiresAt: z.string().datetime(),
    policy: PreviewSharePolicySchema,
  })
  .strict();

export const PreviewShareSchema = z
  .object({
    id: PreviewShareLocatorSchema,
    workspaceId: idSchema('ws'),
    projectId: idSchema('proj'),
    url: HttpsUrlSchema,
    expiresAt: z.string().datetime(),
    policy: PreviewSharePolicySchema,
    createdAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict();

export const CreatePreviewShareBodySchema = z
  .object({
    policy: PreviewSharePolicySchema,
    expiresInSeconds: z.number().int().min(60).max(604_800),
  })
  .strict();
export const CreatePreviewShareResultSchema = z
  .object({ share: PreviewHandleSchema })
  .strict();
export const ListPreviewSharesResultSchema = z
  .object({ shares: z.array(PreviewShareSchema) })
  .strict();
export const RevokePreviewShareResultSchema = z
  .object({ revoked: z.literal(true) })
  .strict();

export const PreviewSessionExchangeBodySchema = z
  .object({ bearer: z.string().regex(/^psb_[A-Za-z0-9_-]{43}$/u) })
  .strict();
export const PreviewSessionExchangeResultSchema = z
  .object({
    previewOrigin: HttpsUrlSchema,
    grant: z.string().regex(/^pbg_[A-Za-z0-9_-]{43}$/u),
    expiresAt: z.string().datetime(),
  })
  .strict();
export const PreviewSessionRedeemBodySchema = z
  .object({
    organizationId: idSchema('org'),
    shareId: PreviewShareLocatorSchema,
    grant: z.string().regex(/^pbg_[A-Za-z0-9_-]{43}$/u),
  })
  .strict();
export const PreviewSessionRedeemResultSchema = z
  .object({ expiresAt: z.string().datetime() })
  .strict();

export type PreviewHandle = z.infer<typeof PreviewHandleSchema>;
export type PreviewShare = z.infer<typeof PreviewShareSchema>;
export type PreviewSharePolicy = z.infer<typeof PreviewSharePolicySchema>;
