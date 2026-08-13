import { CheckpointKindSchema, idSchema } from '@zapp/contracts';
import { sandboxSnapshotMeasurements, type Database } from '@zapp/db';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
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
    readonly kind: z.infer<typeof CheckpointKindSchema>;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<void>;
  sumActiveBytes(scope: z.infer<typeof ProjectScopeSchema>, at: Date): Promise<unknown>;
}

export interface SnapshotDeletionStore {
  listProject(scope: z.infer<typeof ProjectScopeSchema>, limit: number): Promise<unknown>;
  removeVerified(
    scope: z.infer<typeof ProjectScopeSchema>,
    providerSnapshotId: string,
  ): Promise<boolean>;
}

export interface SnapshotDeletionProvider {
  deleteSnapshot(providerSnapshotId: string): Promise<void>;
  snapshotExists(providerSnapshotId: string): Promise<boolean>;
}

export interface ProjectVolumeMeasurementPort {
  measureProjectVolumeBytes(scope: z.infer<typeof ProjectScopeSchema>): Promise<unknown>;
}

export function createDatabaseSnapshotMeasurementStore(
  database: Database,
): SnapshotMeasurementStore & SnapshotDeletionStore {
  return {
    async record(rawInput) {
      const input = z
        .object({
          providerSnapshotId: z.string().trim().min(1).max(500),
          organizationId: idSchema('org'),
          projectId: idSchema('proj'),
          logicalBytes: BytesSchema,
          kind: CheckpointKindSchema,
          createdAt: z.string().datetime({ offset: true }),
          expiresAt: z.string().datetime({ offset: true }),
        })
        .strict()
        .parse(rawInput);
      const [inserted] = await database
        .insert(sandboxSnapshotMeasurements)
        .values({
          ...input,
          createdAt: new Date(input.createdAt),
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
        existing.kind !== input.kind ||
        existing.createdAt.toISOString() !== input.createdAt ||
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
    async listProject(rawScope, rawLimit) {
      const scope = ProjectScopeSchema.parse(rawScope);
      const limit = z.number().int().min(1).max(500).parse(rawLimit);
      const rows = await database
        .select({ providerSnapshotId: sandboxSnapshotMeasurements.providerSnapshotId })
        .from(sandboxSnapshotMeasurements)
        .where(
          and(
            eq(sandboxSnapshotMeasurements.organizationId, scope.organizationId),
            eq(sandboxSnapshotMeasurements.projectId, scope.projectId),
          ),
        )
        .orderBy(asc(sandboxSnapshotMeasurements.providerSnapshotId))
        .limit(limit);
      return rows.map((row) => row.providerSnapshotId);
    },
    async removeVerified(rawScope, rawProviderSnapshotId) {
      const scope = ProjectScopeSchema.parse(rawScope);
      const providerSnapshotId = z.string().trim().min(1).max(500).parse(rawProviderSnapshotId);
      const rows = await database
        .delete(sandboxSnapshotMeasurements)
        .where(
          and(
            eq(sandboxSnapshotMeasurements.providerSnapshotId, providerSnapshotId),
            eq(sandboxSnapshotMeasurements.organizationId, scope.organizationId),
            eq(sandboxSnapshotMeasurements.projectId, scope.projectId),
          ),
        )
        .returning({ providerSnapshotId: sandboxSnapshotMeasurements.providerSnapshotId });
      return rows.length === 1;
    },
  };
}

export function createProjectSnapshotDeletionService(options: {
  readonly snapshots: SnapshotDeletionStore;
  readonly provider: SnapshotDeletionProvider;
}) {
  return {
    async remove(rawScope: z.input<typeof ProjectScopeSchema>): Promise<void> {
      const scope = ProjectScopeSchema.parse(rawScope);
      for (;;) {
        const ids = z
          .array(z.string().trim().min(1).max(500))
          .max(500)
          .parse(await options.snapshots.listProject(scope, 500));
        if (ids.length === 0) return;
        for (const providerSnapshotId of ids) {
          await options.provider.deleteSnapshot(providerSnapshotId);
          if (await options.provider.snapshotExists(providerSnapshotId)) {
            throw new Error('snapshot remained after deletion');
          }
          if (!(await options.snapshots.removeVerified(scope, providerSnapshotId))) {
            throw new Error('snapshot measurement deletion lost its scope');
          }
        }
      }
    },
    async absent(rawScope: z.input<typeof ProjectScopeSchema>): Promise<boolean> {
      const scope = ProjectScopeSchema.parse(rawScope);
      const ids = z
        .array(z.string().trim().min(1).max(500))
        .max(1)
        .parse(await options.snapshots.listProject(scope, 1));
      return ids.length === 0;
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
