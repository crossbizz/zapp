import { z } from 'zod';
import { CommitShaSchema, idSchema } from '@zapp/contracts';
import { CriterionIdSchema } from './criteria.js';

export const MAX_PUBLIC_TEST_RUNS = 100;
export const MAX_PUBLIC_TEST_CASES = 1_000;
export const MAX_PUBLIC_CASE_EVIDENCE = 100;
export const MAX_PUBLIC_EVIDENCE_BYTES = 128 * 1024 * 1024;
export const PUBLIC_EVIDENCE_URL_TTL_SECONDS = 300;

export const VerificationEvidenceKindSchema = z.enum([
  'screenshot', 'trace', 'console', 'network', 'video', 'report', 'attachment',
  'accessibility', 'dom',
]);
export type VerificationEvidenceKind = z.infer<typeof VerificationEvidenceKindSchema>;

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema),
]));

export const VerificationTestCaseSchema = z.object({
  id: idSchema('tcase'),
  testRunId: idSchema('trun'),
  name: z.string().min(1).max(2_048),
  status: z.enum(['passed', 'failed', 'skipped', 'timed_out']),
  durationMs: z.number().int().nonnegative().nullable(),
  criterionIds: z.array(CriterionIdSchema).max(100),
  evidenceArtifactIds: z.array(idSchema('art')).max(MAX_PUBLIC_CASE_EVIDENCE),
  error: JsonValueSchema.nullable(),
}).strict();
export type VerificationTestCase = z.infer<typeof VerificationTestCaseSchema>;

export const VerificationTestRunSchema = z.object({
  id: idSchema('trun'),
  organizationId: idSchema('org'),
  runId: idSchema('run'),
  taskId: idSchema('task').nullable(),
  commitSha: CommitShaSchema,
  type: z.enum(['unit', 'integration', 'browser', 'smoke', 'build', 'typecheck', 'lint', 'security', 'migration']),
  status: z.enum(['running', 'passed', 'failed', 'skipped', 'timed_out', 'error']),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  summary: JsonValueSchema.nullable(),
  cases: z.array(VerificationTestCaseSchema).max(MAX_PUBLIC_TEST_CASES),
  casesTruncated: z.boolean().default(false),
}).strict();
export type VerificationTestRun = z.infer<typeof VerificationTestRunSchema>;

export const VerificationArtifactRecordSchema = z.object({
  id: idSchema('art'),
  organizationId: idSchema('org'),
  projectId: idSchema('proj'),
  runId: idSchema('run'),
  taskId: idSchema('task').nullable(),
  testRunId: idSchema('trun'),
  testCaseId: idSchema('tcase').nullable(),
  criterionIds: z.array(CriterionIdSchema).max(100),
  kind: VerificationEvidenceKindSchema,
  description: z.string().trim().min(1).max(2_048).nullable(),
  contentType: z.string().min(1).max(255),
  byteSize: z.number().int().positive().max(MAX_PUBLIC_EVIDENCE_BYTES),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  storageRef: z.string().min(1).max(2_048),
  createdAt: z.string().datetime(),
}).strict().superRefine((artifact, context) => {
  if (['screenshot', 'video'].includes(artifact.kind) && artifact.description === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['description'],
      message: 'Visual evidence requires an accessible description',
    });
  }
});
export type VerificationArtifactRecord = z.infer<typeof VerificationArtifactRecordSchema>;

export const PublicVerificationArtifactSchema = VerificationArtifactRecordSchema.innerType().omit({
  storageRef: true,
}).strict();
export const SignedVerificationArtifactSchema = z.object({
  artifact: PublicVerificationArtifactSchema,
  download: z.object({ url: z.string().url().startsWith('https://'), expiresAt: z.string().datetime() }).strict(),
}).strict();

export interface VerificationReadStore {
  listForRun(input: { readonly organizationId: string; readonly runId: string }): Promise<readonly unknown[]>;
  getArtifact(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly artifactId: string;
  }): Promise<unknown>;
}

export interface EvidenceReadSigner {
  signRead(input: { readonly storageRef: string; readonly expiresInSeconds: number }): Promise<{
    readonly url: string;
    readonly expiresAt: string;
  }>;
}

export class VerificationEvidenceNotFoundError extends Error {
  readonly code = 'verification_evidence_not_found' as const;
  constructor() {
    super('Verification evidence was not found.');
    this.name = 'VerificationEvidenceNotFoundError';
  }
}

export interface VerificationReadModel {
  listForRun(input: { readonly organizationId: string; readonly runId: string }): Promise<readonly VerificationTestRun[]>;
  signArtifact(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly taskId: string | null;
    readonly artifactId: string;
  }): Promise<z.infer<typeof SignedVerificationArtifactSchema>>;
}

export function createVerificationReadModel(options: {
  readonly store: VerificationReadStore;
  readonly signer: EvidenceReadSigner;
  readonly now?: () => Date;
}): VerificationReadModel {
  const now = options.now ?? (() => new Date());
  return {
    async listForRun(input: { readonly organizationId: string; readonly runId: string }) {
      const rows = await options.store.listForRun(input);
      return rows.slice(0, MAX_PUBLIC_TEST_RUNS).map((row) => {
        const value = row as { readonly cases?: readonly unknown[] };
        const cases = value.cases ?? [];
        return VerificationTestRunSchema.parse({
          ...(row as object),
          cases: cases.slice(0, MAX_PUBLIC_TEST_CASES),
          casesTruncated: cases.length > MAX_PUBLIC_TEST_CASES,
        });
      });
    },

    async signArtifact(input: {
      readonly organizationId: string;
      readonly runId: string;
      readonly taskId: string | null;
      readonly artifactId: string;
    }) {
      const raw = await options.store.getArtifact(input);
      if (raw === undefined) throw new VerificationEvidenceNotFoundError();
      const artifact = VerificationArtifactRecordSchema.parse(raw);
      if (
        artifact.organizationId !== input.organizationId ||
        artifact.runId !== input.runId ||
        artifact.taskId !== input.taskId ||
        artifact.id !== input.artifactId
      ) throw new VerificationEvidenceNotFoundError();
      const signed = await options.signer.signRead({
        storageRef: artifact.storageRef,
        expiresInSeconds: PUBLIC_EVIDENCE_URL_TTL_SECONDS,
      });
      const expiresAt = new Date(signed.expiresAt).getTime();
      const current = now().getTime();
      if (expiresAt <= current || expiresAt > current + PUBLIC_EVIDENCE_URL_TTL_SECONDS * 1_000) {
        throw new Error('Evidence signer returned an invalid expiry');
      }
      return SignedVerificationArtifactSchema.parse({
        artifact: {
          id: artifact.id,
          organizationId: artifact.organizationId,
          projectId: artifact.projectId,
          runId: artifact.runId,
          taskId: artifact.taskId,
          testRunId: artifact.testRunId,
          testCaseId: artifact.testCaseId,
          criterionIds: artifact.criterionIds,
          kind: artifact.kind,
          description: artifact.description,
          contentType: artifact.contentType,
          byteSize: artifact.byteSize,
          contentHash: artifact.contentHash,
          createdAt: artifact.createdAt,
        },
        download: signed,
      });
    },
  };
}
