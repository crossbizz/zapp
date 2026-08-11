import {
  MigrationReversibilitySchema,
  MigrationValidationReceiptSchema,
  MigrationValidationRequestSchema,
  type MigrationValidationAdapter,
} from '@zapp/verification-engine';
import { z } from 'zod';

import type { NeonSqlFactory, NeonValidationBranchPort } from './branches.js';

const NeonResourceIdSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9-]+$/u);
const ApiKeySchema = z.string().trim().min(1).max(10_000);
const RunIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/u);
const DatabaseNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z_][a-z0-9_]*$/u);
const SqlSchema = z.string().min(1).max(2_000_000);
const MigrationSchema = z
  .object({ path: z.string().trim().min(1).max(1_024), sql: SqlSchema })
  .strict();
const MigrationListSchema = z
  .array(MigrationSchema)
  .max(1_000)
  .superRefine((migrations, context) => {
    const paths = migrations.map(({ path }) => path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'neon_migration_duplicate_path' });
    }
  });

export interface NeonMigrationHistoryPort {
  pendingMigrations(input: {
    readonly projectId: string;
    readonly commitSha: string;
    readonly workspaceRoot: string;
  }): Promise<unknown>;
}

export interface NeonMigrationReversibilityPort {
  classify(
    migrations: readonly z.infer<typeof MigrationSchema>[],
  ): Promise<z.input<typeof MigrationReversibilitySchema>>;
}

export function createNeonMigrationValidationAdapter(input: {
  readonly projectId: string;
  readonly apiKey: string;
  readonly parentBranchId: string;
  readonly databaseName: string;
  readonly runId: string;
  readonly history: NeonMigrationHistoryPort;
  readonly branches: NeonValidationBranchPort;
  readonly sql: NeonSqlFactory;
  readonly reversibility: NeonMigrationReversibilityPort;
  readonly smokeQueries?: readonly string[];
  readonly ttlMs?: number;
  readonly now?: () => Date;
}): MigrationValidationAdapter {
  const projectId = NeonResourceIdSchema.parse(input.projectId);
  const apiKey = ApiKeySchema.parse(input.apiKey);
  const parentBranchId = NeonResourceIdSchema.parse(input.parentBranchId);
  const databaseName = DatabaseNameSchema.parse(input.databaseName);
  const runId = RunIdSchema.parse(input.runId);
  const ttlMs = z
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1_000)
    .parse(input.ttlMs ?? 60 * 60 * 1_000);
  const smokeQueries = z
    .array(SqlSchema)
    .min(1)
    .max(100)
    .parse(input.smokeQueries ?? ['select 1']);
  const now = input.now ?? (() => new Date());

  return {
    async validatePendingMigrations(rawRequest) {
      const request = MigrationValidationRequestSchema.parse(rawRequest);
      const migrations = MigrationListSchema.parse(
        await input.history.pendingMigrations({
          projectId,
          commitSha: request.commitSha,
          workspaceRoot: request.workspaceRoot,
        }),
      );
      if (migrations.length === 0) {
        return MigrationValidationReceiptSchema.parse({
          kind: 'no_pending_migrations',
          provider: 'neon',
        });
      }

      let reversibility: z.infer<typeof MigrationReversibilitySchema> = 'unavailable';
      try {
        reversibility = MigrationReversibilitySchema.parse(
          await input.reversibility.classify(migrations),
        );
      } catch {
        reversibility = 'unavailable';
      }

      const branch = await input.branches.createValidationBranch({
        projectId,
        apiKey,
        parentBranchId,
        databaseName,
        name: `verify/run-${runId}`,
        expiresAt: new Date(now().getTime() + ttlMs),
      });
      let applyStatus: 'passed' | 'failed' = 'passed';
      let smokeStatus: 'passed' | 'failed' = 'failed';
      let cleanupStatus: 'passed' | 'failed' = 'passed';
      let sql: Awaited<ReturnType<NeonSqlFactory['open']>> | undefined;
      try {
        try {
          sql = await input.sql.open(branch.migrationConnectionString);
          for (const migration of migrations) await sql.execute(migration.sql);
        } catch {
          applyStatus = 'failed';
        }
        if (applyStatus === 'passed' && sql !== undefined) {
          smokeStatus = 'passed';
          try {
            for (const query of smokeQueries) await sql.execute(query);
          } catch {
            smokeStatus = 'failed';
          }
        }
      } finally {
        if (sql !== undefined) {
          try {
            await sql.close();
          } catch {
            cleanupStatus = 'failed';
          }
        }
        try {
          await input.branches.deleteBranch({ projectId, apiKey, branchId: branch.branchId });
        } catch {
          cleanupStatus = 'failed';
        }
      }

      return MigrationValidationReceiptSchema.parse({
        kind: 'validated',
        provider: 'neon',
        isolatedTarget: { kind: 'neon_branch', reference: branch.branchId },
        migrations,
        applyStatus,
        smokeStatus,
        cleanupStatus,
        reversibility,
      });
    },
  };
}
