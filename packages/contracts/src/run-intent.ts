import { z } from 'zod';
import { idSchema } from './id-schema.js';
import { CommitShaSchema, HttpsUrlSchema } from './primitives.js';

export const APP_TYPES = ['web', 'mobile'] as const;

export const AppTypeSchema = z.enum(APP_TYPES);
export type AppType = z.infer<typeof AppTypeSchema>;

export const ModelIdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export type ModelIdentifier = z.infer<typeof ModelIdentifierSchema>;

const FixPreviewEvidenceSchema = z
  .object({
    kind: z.enum(['preview_console', 'preview_network', 'failed_check', 'user_report']),
    artifactId: idSchema('art'),
    summary: z.string().trim().min(1).max(2_000),
  })
  .strict();
const FixGrafanaEvidenceSchema = z
  .object({
    kind: z.enum(['grafana_faro', 'grafana_loki']),
    url: HttpsUrlSchema.max(4_096),
    summary: z.string().trim().min(1).max(2_000),
  })
  .strict();

/** Immutable evidence references accepted by the public Fix run boundary. */
export const FixEvidenceSchema = z.discriminatedUnion('kind', [
  FixPreviewEvidenceSchema,
  FixGrafanaEvidenceSchema,
]);
export type FixEvidence = z.infer<typeof FixEvidenceSchema>;

export const FixRequestSchema = z
  .object({
    source: z.enum(['error_report', 'failed_check', 'user_bug']),
    summary: z.string().trim().min(1).max(10_000),
    relevantCommitSha: CommitShaSchema,
    reproductionRef: z.string().trim().min(1).max(4_096),
    evidence: z.array(FixEvidenceSchema).min(1).max(100),
  })
  .strict();
export type FixRequest = z.infer<typeof FixRequestSchema>;
