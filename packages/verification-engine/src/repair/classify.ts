import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

import { GateIdSchema } from '../policy-matrix.js';

const BoundedTextSchema = z.string().max(1_000_000);
export const RepairEvidenceArtifactIdSchema = z.string().min(1).max(128);
export const RepairRepositoryPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (path) =>
      path === path.normalize('NFC') &&
      !path.startsWith('/') &&
      !path.endsWith('/') &&
      !path.includes('\\') &&
      !/[\u0000-\u001f\u007f]/u.test(path) &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'repair_related_file_path_invalid',
  );

export const FailureClassificationSchema = z.enum([
  'product_code',
  'test_code',
  'environment',
  'flaky_dependency',
  'infrastructure',
]);
export type FailureClassification = z.infer<typeof FailureClassificationSchema>;

export const ProtectedFailureSchema = z.enum(['security', 'destructive_migration']).nullable();
export type ProtectedFailure = z.infer<typeof ProtectedFailureSchema>;

export const RepairCriterionSchema = z
  .object({
    id: z.string().min(1).max(256),
    text: z.string().trim().min(1).max(10_000),
  })
  .strict();
export type RepairCriterion = z.infer<typeof RepairCriterionSchema>;

export const RepairRelatedFilesSchema = z.array(RepairRepositoryPathSchema).max(1_000);

export const RepairFailureSchema = z
  .object({
    failureId: z.string().min(1).max(256),
    gateId: GateIdSchema,
    fingerprint: z.string().min(1).max(512),
    output: BoundedTextSchema,
    evidenceArtifactIds: z.array(RepairEvidenceArtifactIdSchema).min(1).max(50),
    relatedFiles: RepairRelatedFilesSchema,
    criterion: RepairCriterionSchema,
    diff: z
      .object({
        changedFiles: z.array(RepairRepositoryPathSchema).max(1_000),
        summary: z.string().max(100_000),
      })
      .strict(),
    retriedPass: z.boolean(),
    knownFlakeFingerprints: z.array(z.string().min(1).max(512)).max(10_000),
    protectedFailure: ProtectedFailureSchema,
  })
  .strict()
  .superRefine((failure, context) => {
    const collections = [
      failure.evidenceArtifactIds,
      failure.relatedFiles,
      failure.diff.changedFiles,
      failure.knownFlakeFingerprints,
    ];
    if (collections.some((values) => new Set(values).size !== values.length)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'repair_failure_collections_must_be_unique',
      });
    }
  });
export type RepairFailure = z.infer<typeof RepairFailureSchema>;

export const FailureModelClassificationRequestSchema = z
  .object({
    failureId: z.string().min(1).max(256),
    gateId: GateIdSchema,
    output: BoundedTextSchema,
    relatedFiles: RepairRelatedFilesSchema,
    criterion: RepairCriterionSchema,
    diff: z
      .object({
        changedFiles: z.array(RepairRepositoryPathSchema).max(1_000),
        summary: z.string().max(100_000),
      })
      .strict(),
  })
  .strict();
export type FailureModelClassificationRequest = z.infer<
  typeof FailureModelClassificationRequestSchema
>;

export const FailureModelClassificationResponseSchema = z
  .object({
    classification: FailureClassificationSchema,
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type FailureModelClassificationResponse = z.infer<
  typeof FailureModelClassificationResponseSchema
>;

export const FailureClassificationResultSchema = FailureModelClassificationResponseSchema.extend({
  source: z.enum(['infrastructure_signature', 'flake_record', 'model', 'safe_fallback']),
}).strict();
export type FailureClassificationResult = z.infer<typeof FailureClassificationResultSchema>;

export interface FailureModelClassifier {
  classify(
    input: FailureModelClassificationRequest,
    scope: FailureClassificationScope,
  ): Promise<unknown>;
}

export const FailureClassificationScopeSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    runId: idSchema('run'),
    taskId: idSchema('task'),
  })
  .strict();
export type FailureClassificationScope = z.infer<typeof FailureClassificationScopeSchema>;

const INFRASTRUCTURE_SIGNATURES = [
  /\b(?:timed?\s*out|timeout)\b/iu,
  /\b(?:out\s+of\s+memory|oom|exit(?:\s+code)?\s*137|sigkill)\b/iu,
  /\b(?:sandbox|workspace)\b.{0,80}\b(?:unavailable|lost|terminated|not\s+found|failed\s+to\s+(?:start|create|restore))\b/iu,
] as const;

function hasInfrastructureSignature(output: string): boolean {
  return INFRASTRUCTURE_SIGNATURES.some((signature) => signature.test(output));
}

function modelRequest(failure: RepairFailure): FailureModelClassificationRequest {
  return FailureModelClassificationRequestSchema.parse({
    failureId: failure.failureId,
    gateId: failure.gateId,
    output: failure.output,
    relatedFiles: failure.relatedFiles,
    criterion: failure.criterion,
    diff: failure.diff,
  });
}

export async function classifyFailure(
  failureValue: unknown,
  classifier: FailureModelClassifier,
  scopeValue: unknown,
): Promise<FailureClassificationResult> {
  const failure = RepairFailureSchema.parse(failureValue);
  const scope = FailureClassificationScopeSchema.parse(scopeValue);
  if (hasInfrastructureSignature(failure.output)) {
    return FailureClassificationResultSchema.parse({
      classification: 'infrastructure',
      reason: 'A sandbox, timeout, or out-of-memory infrastructure signature was present.',
      source: 'infrastructure_signature',
    });
  }
  if (
    failure.retriedPass ||
    new Set(failure.knownFlakeFingerprints).has(failure.fingerprint)
  ) {
    return FailureClassificationResultSchema.parse({
      classification: 'flaky_dependency',
      reason: failure.retriedPass
        ? 'The same check passed on its recorded retry.'
        : 'The failure fingerprint is present in the known flake list.',
      source: 'flake_record',
    });
  }

  let rawResponse: unknown;
  try {
    rawResponse = await classifier.classify(modelRequest(failure), scope);
  } catch {
    return FailureClassificationResultSchema.parse({
      classification: 'environment',
      reason: 'The model classifier was unavailable; automation stopped at the safe fallback.',
      source: 'safe_fallback',
    });
  }
  const response = FailureModelClassificationResponseSchema.safeParse(rawResponse);
  if (!response.success) {
    return FailureClassificationResultSchema.parse({
      classification: 'environment',
      reason: 'The model classifier returned an invalid response; automation stopped at the safe fallback.',
      source: 'safe_fallback',
    });
  }
  if (
    response.data.classification === 'infrastructure' ||
    response.data.classification === 'flaky_dependency'
  ) {
    return FailureClassificationResultSchema.parse({
      classification: 'environment',
      reason: 'Code rejected a model-only transient classification without structural retry evidence.',
      source: 'safe_fallback',
    });
  }
  return FailureClassificationResultSchema.parse({
    ...response.data,
    source: 'model',
  });
}
