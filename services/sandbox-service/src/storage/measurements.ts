import { idSchema } from '@zapp/contracts';
import { sandboxSnapshotMeasurements, type Database } from '@zapp/db';
import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';

const ProjectScopeSchema = z
  .object({ organizationId: idSchema('org'), projectId: idSchema('proj') })
  .strict();
const BytesSchema = z.string().regex(/^\d+$/u);

export interface SnapshotMeasurementStore {
  record(input: {
    readonly providerSnapshotId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly logicalBytes: string;
    readonly expiresAt: string;
  }): Promise<void>;
  sumActiveBytes(scope: z.infer<typeof ProjectScopeSchema>, at: Date): Promise<unknown>;
}

export interface ProjectVolumeMeasurementPort {
  measureProjectVolumeBytes(scope: z.infer<typeof ProjectScopeSchema>): Promise<unknown>;
}

export function createDatabaseSnapshotMeasurementStore(
  database: Database,
): SnapshotMeasurementStore {
  return {
    async record(rawInput) {
      const input = z
        .object({
          providerSnapshotId: z.string().trim().min(1).max(500),
          organizationId: idSchema('org'),
          projectId: idSchema('proj'),
          logicalBytes: BytesSchema,
          expiresAt: z.string().datetime({ offset: true }),
        })
        .strict()
        .parse(rawInput);
      const [inserted] = await database
        .insert(sandboxSnapshotMeasurements)
        .values({
          ...input,
          expiresAt: new Date(input.expiresAt),
        })
        .onConflictDoNothing({ target: sandboxSnapshotMeasurements.providerSnapshotId })
        .returning({ providerSnapshotId: sandboxSnapshotMeasurements.providerSnapshotId });
      if (inserted !== undefined) return;
      const [existing] = await database
        .select()
        .from(sandboxSnapshotMeasurements)
        .where(eq(sandboxSnapshotMeasurements.providerSnapshotId, input.providerSnapshotId));
      if (
        existing === undefined ||
        existing.organizationId !== input.organizationId ||
        existing.projectId !== input.projectId ||
        existing.logicalBytes !== input.logicalBytes ||
        existing.expiresAt.toISOString() !== input.expiresAt
      ) {
        throw new Error('snapshot measurement identity conflicts with persisted logical bytes');
      }
    },
    async sumActiveBytes(rawScope, at) {
      const scope = ProjectScopeSchema.parse(rawScope);
      const [row] = await database
        .select({
          bytes: sql<string>`coalesce(sum(${sandboxSnapshotMeasurements.logicalBytes}), 0)::text`,
        })
        .from(sandboxSnapshotMeasurements)
        .where(
          and(
            eq(sandboxSnapshotMeasurements.organizationId, scope.organizationId),
            eq(sandboxSnapshotMeasurements.projectId, scope.projectId),
            gt(sandboxSnapshotMeasurements.expiresAt, at),
          ),
        );
      return row?.bytes ?? '0';
    },
  };
}

export function createProjectStorageMeasurementService(options: {
  readonly snapshots: SnapshotMeasurementStore;
  readonly volumes: ProjectVolumeMeasurementPort;
  readonly now?: () => Date;
}) {
  const now = options.now ?? ((): Date => new Date());
  return {
    async measureProjectBytes(rawScope: z.input<typeof ProjectScopeSchema>) {
      const scope = ProjectScopeSchema.parse(rawScope);
      const [snapshotBytes, volumeBytes] = await Promise.all([
        options.snapshots.sumActiveBytes(scope, now()),
        options.volumes.measureProjectVolumeBytes(scope),
      ]);
      return {
        snapshotBytes: BytesSchema.parse(snapshotBytes),
        volumeBytes: BytesSchema.parse(volumeBytes),
      };
    },
  };
}
