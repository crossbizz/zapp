import { z } from 'zod';

import { idSchema } from './ids.js';
const PreviewUrlSchema = z.string().url().superRefine((value, context) => {
  const isLoopbackHttp =
    /^http:\/\/(?:localhost|(?:[a-z0-9-]+\.)+localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/iu.test(
      value,
    );

  if (!value.startsWith('https://') && !isLoopbackHttp) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'URL must use https outside loopback development hosts',
    });
  }
});

export const PreviewShareLocatorSchema = z.string().regex(/^[0-9a-hjkmnp-tv-z]{26}$/u);
export const PreviewSharePolicySchema = z.enum(['org', 'anyone_with_link']);

export const PreviewHandleSchema = z
  .object({
    id: PreviewShareLocatorSchema,
    url: PreviewUrlSchema,
    expiresAt: z.string().datetime(),
    policy: PreviewSharePolicySchema,
  })
  .strict();

export const PreviewShareSchema = z
  .object({
    id: PreviewShareLocatorSchema,
    workspaceId: idSchema('ws'),
    projectId: idSchema('proj'),
    url: PreviewUrlSchema,
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
    previewOrigin: PreviewUrlSchema,
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
