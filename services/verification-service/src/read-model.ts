import { GetObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  MAX_PUBLIC_TEST_CASES,
  MAX_PUBLIC_TEST_RUNS,
  VerificationArtifactRecordSchema,
  VerificationTestRunSchema,
  type EvidenceReadSigner,
  type VerificationEvidenceKind,
  type VerificationReadStore,
} from '@zapp/verification-engine';
import { artifacts, testCases, testRuns, type Database } from '@zapp/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

const ArtifactMetadataSchema = z.object({
  testRunId: z.string().optional(),
  testCaseId: z.string().optional(),
  criterionIds: z.array(z.string()).optional(),
  description: z.string().optional(),
  attachmentName: z.string().optional(),
  contentType: z.string().optional(),
  byteSize: z.number().int().positive().optional(),
}).passthrough();

function criterionIds(name: string): string[] {
  const match = /^\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\](?:\s|$)/u.exec(name);
  return match?.[1] === undefined ? [] : [match[1]];
}

function artifactKind(type: string): VerificationEvidenceKind {
  const explicit: Readonly<Record<string, VerificationEvidenceKind>> = {
    playwright_screenshot: 'screenshot',
    playwright_trace: 'trace',
    playwright_video: 'video',
    playwright_json_report: 'report',
    browser_console: 'console',
    browser_network: 'network',
    browser_accessibility: 'accessibility',
    browser_dom: 'dom',
  };
  return explicit[type] ?? 'attachment';
}

export function createDrizzleVerificationReadStore(db: Database): VerificationReadStore {
  return {
    async listForRun(input) {
      const runs = await db.select().from(testRuns).where(and(
        eq(testRuns.organizationId, input.organizationId), eq(testRuns.runId, input.runId),
      )).orderBy(desc(testRuns.startedAt), desc(testRuns.id)).limit(MAX_PUBLIC_TEST_RUNS + 1);
      const runIds = runs.slice(0, MAX_PUBLIC_TEST_RUNS).map(({ id }) => id);
      if (runIds.length === 0) return [];
      const [cases, evidence] = await Promise.all([
        db.select().from(testCases).where(and(
          eq(testCases.organizationId, input.organizationId), inArray(testCases.testRunId, runIds),
        )).orderBy(testCases.id).limit(MAX_PUBLIC_TEST_RUNS * (MAX_PUBLIC_TEST_CASES + 1)),
        db.select().from(artifacts).where(and(
          eq(artifacts.organizationId, input.organizationId), eq(artifacts.runId, input.runId),
        )).orderBy(artifacts.id).limit(MAX_PUBLIC_TEST_RUNS * MAX_PUBLIC_TEST_CASES),
      ]);
      const artifactIdsByCase = new Map<string, string[]>();
      for (const artifact of evidence) {
        const metadata = ArtifactMetadataSchema.safeParse(artifact.metadataJson);
        if (!metadata.success || metadata.data.testCaseId === undefined) continue;
        const values = artifactIdsByCase.get(metadata.data.testCaseId) ?? [];
        if (values.length < 100) values.push(artifact.id);
        artifactIdsByCase.set(metadata.data.testCaseId, values);
      }
      return runs.slice(0, MAX_PUBLIC_TEST_RUNS).map((run) => {
        const ownCases = cases.filter(({ testRunId }) => testRunId === run.id);
        return VerificationTestRunSchema.parse({
          id: run.id,
          organizationId: run.organizationId,
          runId: run.runId,
          taskId: run.taskId,
          commitSha: run.commitSha,
          type: run.type,
          status: run.status,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
          summary: run.summaryJson,
          cases: ownCases.slice(0, MAX_PUBLIC_TEST_CASES).map((testCase) => ({
            id: testCase.id,
            testRunId: testCase.testRunId,
            name: testCase.name,
            status: testCase.status,
            durationMs: testCase.durationMs,
            criterionIds: criterionIds(testCase.name),
            evidenceArtifactIds: artifactIdsByCase.get(testCase.id) ??
              (testCase.evidenceArtifactId === null ? [] : [testCase.evidenceArtifactId]),
            error: testCase.errorJson,
          })),
          casesTruncated: ownCases.length > MAX_PUBLIC_TEST_CASES,
        });
      });
    },

    async getArtifact(input) {
      const [artifact] = await db.select().from(artifacts).where(and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.organizationId, input.organizationId),
        eq(artifacts.runId, input.runId),
      )).limit(1);
      if (artifact === undefined) return undefined;
      const metadata = ArtifactMetadataSchema.safeParse(artifact.metadataJson);
      if (
        !metadata.success || metadata.data.testRunId === undefined ||
        metadata.data.contentType === undefined || metadata.data.byteSize === undefined
      ) return undefined;
      const kind = artifactKind(artifact.type);
      return VerificationArtifactRecordSchema.parse({
        id: artifact.id,
        organizationId: artifact.organizationId,
        projectId: artifact.projectId,
        runId: artifact.runId,
        taskId: artifact.taskId,
        testRunId: metadata.data.testRunId,
        testCaseId: metadata.data.testCaseId ?? null,
        criterionIds: metadata.data.criterionIds ?? [],
        kind,
        description: metadata.data.description ?? metadata.data.attachmentName ?? null,
        contentType: metadata.data.contentType,
        byteSize: metadata.data.byteSize,
        contentHash: artifact.contentHash,
        storageRef: artifact.storageRef,
        createdAt: artifact.createdAt.toISOString(),
      });
    },
  };
}

export function createR2EvidenceReadSigner(options: {
  readonly client: S3Client;
  readonly bucket: string;
  readonly now?: () => Date;
  readonly presign?: (
    client: S3Client,
    command: GetObjectCommand,
    expiresIn: number,
  ) => Promise<string>;
}): EvidenceReadSigner {
  const now = options.now ?? (() => new Date());
  const presign = options.presign ?? ((client, command, expiresIn) =>
    getSignedUrl(client, command, { expiresIn }));
  return {
    async signRead(input) {
      const url = await presign(
        options.client,
        new GetObjectCommand({ Bucket: options.bucket, Key: input.storageRef }),
        input.expiresInSeconds,
      );
      return {
        url,
        expiresAt: new Date(now().getTime() + input.expiresInSeconds * 1_000).toISOString(),
      };
    },
  };
}

export function createEvidenceReadObjectClient(config: S3ClientConfig): S3Client {
  return new S3Client(config);
}
