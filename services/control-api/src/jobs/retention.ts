import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { idSchema } from '@zapp/contracts';
import {
  artifactRetention,
  artifacts,
  testCases,
  type Database,
} from '@zapp/db';
import { and, eq, lte } from 'drizzle-orm';
import { z } from 'zod';

const DAY_MS = 86_400_000;
const RETENTION_LIMIT = 500;
const ArtifactClassSchema = z.enum(['test', 'diagnostic']);
export type ArtifactRetentionClass = z.infer<typeof ArtifactClassSchema>;

const ExpiredArtifactSchema = z
  .object({
    artifactId: idSchema('art'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    retentionClass: ArtifactClassSchema,
    storageRef: z.string().min(1),
    expiresAt: z.string().datetime(),
  })
  .strict();

export interface ArtifactRetentionDatabase {
  listExpired(now: Date, limit: number): Promise<unknown>;
  /** Clears optional evidence links and removes the row in one transaction. */
  removeVerified(artifactId: string): Promise<boolean>;
}

export interface ArtifactRetentionObjectStore {
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export interface ArtifactRetentionJob {
  run(now: Date): Promise<{ readonly deleted: number; readonly failed: number }>;
}

export interface ArtifactRetentionS3Sender {
  send(command: DeleteObjectCommand | HeadObjectCommand): Promise<unknown>;
}

interface RetentionTimers {
  setInterval(callback: () => void, delayMs: number): number | object;
  clearInterval(handle: number | object): void;
}

export function artifactExpiry(retentionClass: ArtifactRetentionClass, createdAt: Date): Date {
  const instant = validDate(createdAt);
  const days = ArtifactClassSchema.parse(retentionClass) === 'diagnostic' ? 7 : 30;
  return new Date(instant.getTime() + days * DAY_MS);
}

export function createArtifactRetentionJob(options: {
  readonly database: ArtifactRetentionDatabase;
  readonly objects: ArtifactRetentionObjectStore;
}): ArtifactRetentionJob {
  return {
    async run(rawNow) {
      const now = validDate(rawNow);
      const candidates = z
        .array(ExpiredArtifactSchema)
        .max(RETENTION_LIMIT)
        .parse(await options.database.listExpired(now, RETENTION_LIMIT));
      let deleted = 0;
      let failed = 0;
      for (const candidate of candidates) {
        const prefix = `org/${candidate.organizationId}/project/${candidate.projectId}/`;
        if (!candidate.storageRef.startsWith(prefix)) {
          throw new Error(`artifact storage prefix mismatch: ${candidate.artifactId}`);
        }
        try {
          await options.objects.delete(candidate.storageRef);
          if (await options.objects.exists(candidate.storageRef)) {
            failed += 1;
            continue;
          }
          if (await options.database.removeVerified(candidate.artifactId)) deleted += 1;
        } catch {
          failed += 1;
        }
      }
      return { deleted, failed };
    },
  };
}

export function createDatabaseArtifactRetention(database: Database): ArtifactRetentionDatabase {
  return {
    async listExpired(now, rawLimit) {
      const limit = z.number().int().min(1).max(RETENTION_LIMIT).parse(rawLimit);
      return await database
        .select({
          artifactId: artifactRetention.artifactId,
          organizationId: artifactRetention.organizationId,
          projectId: artifactRetention.projectId,
          retentionClass: artifactRetention.retentionClass,
          storageRef: artifacts.storageRef,
          expiresAt: artifactRetention.expiresAt,
        })
        .from(artifactRetention)
        .innerJoin(artifacts, eq(artifacts.id, artifactRetention.artifactId))
        .where(lte(artifactRetention.expiresAt, validDate(now)))
        .orderBy(artifactRetention.expiresAt, artifactRetention.artifactId)
        .limit(limit)
        .then((rows) =>
          rows.map((row) => ({ ...row, expiresAt: row.expiresAt.toISOString() })),
        );
    },
    async removeVerified(artifactId) {
      const id = idSchema('art').parse(artifactId);
      return await database.transaction(async (tx) => {
        await tx
          .update(testCases)
          .set({ evidenceArtifactId: null })
          .where(eq(testCases.evidenceArtifactId, id));
        const removed = await tx
          .delete(artifacts)
          .where(
            and(
              eq(artifacts.id, id),
              // A row can only expire while its explicit classification still exists.
              eq(
                artifacts.id,
                tx
                  .select({ artifactId: artifactRetention.artifactId })
                  .from(artifactRetention)
                  .where(eq(artifactRetention.artifactId, id)),
              ),
            ),
          )
          .returning({ id: artifacts.id });
        return removed.length === 1;
      });
    },
  };
}

export function createS3ArtifactRetentionObjectStore(
  config: {
    readonly bucket: string;
    readonly endpoint?: string;
    readonly region?: string;
    readonly accessKeyId?: string;
    readonly secretAccessKey?: string;
  },
  sender: ArtifactRetentionS3Sender = new S3Client({
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.region === undefined ? {} : { region: config.region }),
    ...(config.accessKeyId === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey ?? '',
          },
        }),
    forcePathStyle: true,
  }),
): ArtifactRetentionObjectStore {
  const bucket = z.string().trim().min(1).parse(config.bucket);
  return {
    async delete(key) {
      await sender.send(new DeleteObjectCommand({ Bucket: bucket, Key: z.string().min(1).parse(key) }));
    },
    async exists(key) {
      try {
        await sender.send(new HeadObjectCommand({ Bucket: bucket, Key: z.string().min(1).parse(key) }));
        return true;
      } catch (error) {
        if (httpStatus(error) === 404) return false;
        throw error;
      }
    },
  };
}

/** Daily and single-flight; OPS-14 independently owns the event archive lifecycle. */
export function createArtifactRetentionLifecycle(options: {
  readonly job: ArtifactRetentionJob;
  readonly now?: () => Date;
  readonly onError?: (error: Error) => void;
  readonly timers?: RetentionTimers;
}) {
  const now = options.now ?? (() => new Date());
  const timers =
    options.timers ??
    ({
      setInterval: (callback, delayMs) => setInterval(callback, delayMs),
      clearInterval: (handle) => {
        clearInterval(handle as ReturnType<typeof setInterval>);
      },
    } satisfies RetentionTimers);
  let handle: number | object | undefined;
  let active: Promise<void> | undefined;
  let closed = false;
  const poll = (): void => {
    if (closed || active !== undefined) return;
    active = options.job
      .run(now())
      .then(() => undefined)
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        active = undefined;
      });
  };
  return {
    start(): Promise<void> {
      if (closed) throw new Error('artifact retention lifecycle is closed');
      handle = timers.setInterval(poll, DAY_MS);
      poll();
      return Promise.resolve();
    },
    async close(): Promise<void> {
      closed = true;
      if (handle !== undefined) timers.clearInterval(handle);
      handle = undefined;
      await active;
    },
  };
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid retention clock');
  }
  return value;
}

function httpStatus(error: unknown): number | undefined {
  return z
    .object({ $metadata: z.object({ httpStatusCode: z.number().int().optional() }).passthrough() })
    .passthrough()
    .safeParse(error).data?.$metadata.httpStatusCode;
}
