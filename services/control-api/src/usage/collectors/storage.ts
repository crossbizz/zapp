import { createHash } from 'node:crypto';

import { idSchema } from '@zapp/contracts';
import { accountingLeaderLeases, projects, type Database } from '@zapp/db';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { UsageEntry } from '../ledger.js';
import { estimateUsage, type PricingConfig } from '../pricing.js';

const BYTES_PER_GIB = 1024n ** 3n;
const QUANTITY_SCALE = 1_000_000n;
const DAILY_STORAGE_HOURS = 24n;
const DAY_MS = 86_400_000;

export const STORAGE_USAGE_CATEGORIES = ['artifact_storage', 'storage_gib_hours'] as const;

const MeteredProjectSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
  })
  .strict();

const ByteCountSchema = z
  .string()
  .regex(/^\d+$/u)
  .transform((value) => BigInt(value));

const SandboxStorageBytesSchema = z
  .object({
    snapshotBytes: ByteCountSchema,
    volumeBytes: ByteCountSchema,
  })
  .strict();

export interface MeteredProjectPort {
  listMeteredProjects(): Promise<unknown>;
}

export interface ArtifactStorageMeasurementPort {
  /** Measures every object under the tenant/project R2 prefix. */
  measurePrefixBytes(project: z.infer<typeof MeteredProjectSchema>): Promise<unknown>;
}

export interface SandboxStorageMeasurementPort {
  /** Sandbox-service is the sole boundary allowed to inspect Modal snapshots and volumes. */
  measureProjectBytes(project: z.infer<typeof MeteredProjectSchema>): Promise<unknown>;
}

interface StorageUsageLedgerPort {
  recordUsage(entry: UsageEntry): Promise<unknown>;
  findByOperationKey?(organizationId: string, operationKey: string): Promise<unknown>;
}

export interface DailyStorageClaimPort {
  claim(
    bucket: { readonly from: string; readonly to: string },
  ): Promise<'acquired' | 'completed' | 'busy'>;
  complete(bucket: { readonly from: string; readonly to: string }): Promise<void>;
}

export interface DailyStorageCollector {
  collect(instant: Date): Promise<{ projects: number; recorded: number }>;
}

/**
 * Produces one retry-stable daily gauge for R2 bytes and one daily integral for
 * snapshot/volume GiB-hours. Provider reads stay behind narrow ports so this
 * control-plane job never imports the Modal SDK.
 */
export function createDailyStorageCollector(options: {
  readonly projects: MeteredProjectPort;
  readonly artifactStorage: ArtifactStorageMeasurementPort;
  readonly sandboxStorage: SandboxStorageMeasurementPort;
  readonly ledger: StorageUsageLedgerPort;
  readonly claims?: DailyStorageClaimPort;
  readonly pricing: PricingConfig;
}): DailyStorageCollector {
  return {
    async collect(rawInstant) {
      const instant = validDate(rawInstant);
      const bucketToDate = new Date(
        Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
      );
      const bucketFromDate = new Date(bucketToDate.getTime() - DAY_MS);
      const bucket = { from: bucketFromDate.toISOString(), to: bucketToDate.toISOString() };
      const claim = await options.claims?.claim(bucket);
      if (claim === 'completed' || claim === 'busy') {
        return { projects: 0, recorded: 0 };
      }
      const day = bucket.from.slice(0, 10);
      const occurredAt = new Date(bucketToDate.getTime() - 1).toISOString();
      const projects = z
        .array(MeteredProjectSchema)
        .parse(await options.projects.listMeteredProjects());
      let recorded = 0;

      for (const project of projects) {
        const artifactOperationKey = stableOperationKey('artifact', project, day);
        const priorArtifact = await options.ledger.findByOperationKey?.(
          project.organizationId,
          artifactOperationKey,
        );
        if (priorArtifact === undefined) {
          const artifactBytes = ByteCountSchema.parse(
            await options.artifactStorage.measurePrefixBytes(project),
          );
          const artifactQuantity = bytesToScaledGib(artifactBytes);
          if (artifactQuantity > 0n) {
            await options.ledger.recordUsage(
              storageEntry({
                project,
                operationKey: artifactOperationKey,
                category: STORAGE_USAGE_CATEGORIES[0],
                provider: 'r2',
                quantity: formatScaled(artifactQuantity),
                occurredAt,
                pricing: options.pricing,
              }),
            );
            recorded += 1;
          }
        }

        const sandboxOperationKey = stableOperationKey('sandbox', project, day);
        const priorSandbox = await options.ledger.findByOperationKey?.(
          project.organizationId,
          sandboxOperationKey,
        );
        if (priorSandbox === undefined) {
          const sandbox = SandboxStorageBytesSchema.parse(
            await options.sandboxStorage.measureProjectBytes(project),
          );
          const storageQuantity = bytesToScaledGib(
            (sandbox.snapshotBytes + sandbox.volumeBytes) * DAILY_STORAGE_HOURS,
          );
          if (storageQuantity > 0n) {
            await options.ledger.recordUsage(
              storageEntry({
                project,
                operationKey: sandboxOperationKey,
                category: STORAGE_USAGE_CATEGORIES[1],
                provider: 'modal',
                quantity: formatScaled(storageQuantity),
                occurredAt,
                pricing: options.pricing,
              }),
            );
            recorded += 1;
          }
        }
      }

      await options.claims?.complete(bucket);
      return { projects: projects.length, recorded };
    },
  };
}

export interface R2ListSender {
  send(command: ListObjectsV2Command): Promise<unknown>;
}

export function createR2ArtifactStorageMeasurement(
  config: {
    readonly bucket: string;
    readonly endpoint?: string;
    readonly region?: string;
    readonly accessKeyId?: string;
    readonly secretAccessKey?: string;
  },
  sender: R2ListSender = new S3Client({
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
): ArtifactStorageMeasurementPort {
  const bucket = z.string().trim().min(1).parse(config.bucket);
  return {
    async measurePrefixBytes(rawProject) {
      const project = MeteredProjectSchema.parse(rawProject);
      const prefix = `${project.organizationId}/${project.projectId}/`;
      let continuationToken: string | undefined;
      let bytes = 0n;
      do {
        const page = z
          .object({
            Contents: z
              .array(z.object({ Size: z.number().int().nonnegative().optional() }).passthrough())
              .optional(),
            NextContinuationToken: z.string().min(1).optional(),
          })
          .passthrough()
          .parse(
            await sender.send(
              new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ...(continuationToken === undefined
                  ? {}
                  : { ContinuationToken: continuationToken }),
              }),
            ),
          );
        for (const object of page.Contents ?? []) bytes += BigInt(object.Size ?? 0);
        continuationToken = page.NextContinuationToken;
      } while (continuationToken !== undefined);
      return String(bytes);
    },
  };
}

export function createDatabaseMeteredProjectPort(database: Database): MeteredProjectPort {
  return {
    async listMeteredProjects() {
      return await database
        .select({ organizationId: projects.organizationId, projectId: projects.id })
        .from(projects)
        .orderBy(asc(projects.organizationId), asc(projects.id));
    },
  };
}

export function createDatabaseDailyStorageClaim(options: {
  readonly database: Database;
  readonly owner: string;
  readonly now?: () => Date;
  readonly leaseMs?: number;
}): DailyStorageClaimPort {
  const now = options.now ?? ((): Date => new Date());
  const leaseMs = options.leaseMs ?? 3_600_000;
  const nameFor = (bucket: { readonly from: string; readonly to: string }): string =>
    `daily-storage-${createHash('sha256').update(`${bucket.from}:${bucket.to}`).digest('hex')}`;
  return {
    async claim(bucket) {
      const instant = now();
      const name = nameFor(bucket);
      const [claimed] = await options.database
        .insert(accountingLeaderLeases)
        .values({
          name,
          owner: options.owner,
          expiresAt: new Date(instant.getTime() + leaseMs),
        })
        .onConflictDoUpdate({
          target: accountingLeaderLeases.name,
          set: { owner: options.owner, expiresAt: new Date(instant.getTime() + leaseMs) },
          setWhere: sql`${accountingLeaderLeases.expiresAt} <= ${instant.toISOString()}::timestamptz and ${accountingLeaderLeases.owner} <> 'completed'`,
        })
        .returning({ owner: accountingLeaderLeases.owner });
      if (claimed?.owner === options.owner) return 'acquired';
      const [existing] = await options.database
        .select({ owner: accountingLeaderLeases.owner })
        .from(accountingLeaderLeases)
        .where(eq(accountingLeaderLeases.name, name));
      return existing?.owner === 'completed' ? 'completed' : 'busy';
    },
    async complete(bucket) {
      const [completed] = await options.database
        .update(accountingLeaderLeases)
        .set({ owner: 'completed', expiresAt: new Date('9999-12-31T23:59:59.999Z') })
        .where(
          and(
            eq(accountingLeaderLeases.name, nameFor(bucket)),
            eq(accountingLeaderLeases.owner, options.owner),
          ),
        )
        .returning({ name: accountingLeaderLeases.name });
      if (completed === undefined) throw new Error('daily storage lease ownership was lost');
    },
  };
}

interface StorageCollectorTimers {
  setInterval(callback: () => void, delayMs: number): number | object;
  clearInterval(handle: number | object): void;
}

/** Daily single-flight lifecycle used by the service composition/cron worker. */
export function createDailyStorageCollectorLifecycle(options: {
  readonly collector: DailyStorageCollector;
  readonly now?: () => Date;
  readonly onError?: (error: Error) => void;
  readonly timers?: StorageCollectorTimers;
}) {
  const now = options.now ?? ((): Date => new Date());
  const timers =
    options.timers ??
    ({
      setInterval: (callback, delayMs) => setInterval(callback, delayMs),
      clearInterval: (handle) => {
        clearInterval(handle as ReturnType<typeof setInterval>);
      },
    } satisfies StorageCollectorTimers);
  let handle: number | object | undefined;
  let active: Promise<void> | undefined;
  let closed = false;

  const poll = (): void => {
    if (closed || active !== undefined) return;
    active = options.collector
      .collect(now())
      .then(() => undefined)
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        active = undefined;
      });
  };

  return {
    async start(): Promise<void> {
      if (closed) throw new Error('daily storage collector lifecycle is closed');
      await options.collector.collect(now());
      handle = timers.setInterval(poll, DAY_MS);
    },
    async close(): Promise<void> {
      closed = true;
      if (handle !== undefined) timers.clearInterval(handle);
      handle = undefined;
      await active;
    },
  };
}

function storageEntry(input: {
  readonly project: z.infer<typeof MeteredProjectSchema>;
  readonly operationKey: string;
  readonly category: (typeof STORAGE_USAGE_CATEGORIES)[number];
  readonly provider: 'r2' | 'modal';
  readonly quantity: string;
  readonly occurredAt: string;
  readonly pricing: PricingConfig;
}): UsageEntry {
  const estimate = estimateUsage(input.pricing, {
    category: input.category,
    quantity: input.quantity,
  });
  return {
    operationKey: input.operationKey,
    organizationId: input.project.organizationId,
    projectId: input.project.projectId,
    runId: null,
    taskId: null,
    category: input.category,
    provider: input.provider,
    quantity: input.quantity,
    unit: input.category === STORAGE_USAGE_CATEGORIES[0] ? 'gib' : 'gib_hours',
    costUsd: estimate.costUsd,
    creditsCharged: estimate.credits,
    occurredAt: input.occurredAt,
    metadata: {},
  };
}

function bytesToScaledGib(bytes: bigint): bigint {
  return (bytes * QUANTITY_SCALE + BYTES_PER_GIB / 2n) / BYTES_PER_GIB;
}

function formatScaled(value: bigint): string {
  const whole = value / QUANTITY_SCALE;
  const fraction = String(value % QUANTITY_SCALE).padStart(6, '0');
  return `${String(whole)}.${fraction}`;
}

function stableOperationKey(
  kind: 'artifact' | 'sandbox',
  project: z.infer<typeof MeteredProjectSchema>,
  day: string,
): string {
  return `ops2-${kind}-${createHash('sha256')
    .update(`${project.organizationId}:${project.projectId}:${day}`)
    .digest('hex')}`;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('storage collection instant must be a valid Date');
  }
  return value;
}
