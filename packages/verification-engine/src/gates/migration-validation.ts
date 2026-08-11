import { evaluateToolCall } from '@zapp/agent-policies';
import { CommitShaSchema } from '@zapp/contracts';
import { z } from 'zod';

import { GateResultSchema, type Gate, type GateContext, type GateResult } from './registry.js';
import { notApplicable } from './shared.js';

export const MigrationReversibilitySchema = z.enum([
  'reversible',
  'compensating',
  'unavailable',
]);
export type MigrationReversibility = z.infer<typeof MigrationReversibilitySchema>;

const MigrationProviderSchema = z.enum(['neon', 'supabase']);
const MigrationStageStatusSchema = z.enum(['passed', 'failed']);
const MigrationSchema = z
  .object({
    path: z.string().trim().min(1).max(1_024),
    sql: z.string().min(1).max(2_000_000),
  })
  .strict();

const NoPendingMigrationsReceiptSchema = z
  .object({
    kind: z.literal('no_pending_migrations'),
    provider: MigrationProviderSchema,
  })
  .strict();

const ValidatedReceiptFields = {
  kind: z.literal('validated'),
  migrations: z.array(MigrationSchema).min(1).max(1_000),
  applyStatus: MigrationStageStatusSchema,
  smokeStatus: MigrationStageStatusSchema,
  cleanupStatus: MigrationStageStatusSchema,
  reversibility: MigrationReversibilitySchema,
} as const;

const NeonValidationReceiptSchema = z
  .object({
    ...ValidatedReceiptFields,
    provider: z.literal('neon'),
    isolatedTarget: z
      .object({
        kind: z.literal('neon_branch'),
        reference: z.string().trim().min(1).max(1_024),
      })
      .strict(),
  })
  .strict();

const SupabaseValidationReceiptSchema = z
  .object({
    ...ValidatedReceiptFields,
    provider: z.literal('supabase'),
    isolatedTarget: z
      .object({
        kind: z.literal('supabase_shadow'),
        reference: z.string().trim().min(1).max(1_024),
      })
      .strict(),
  })
  .strict();

export const MigrationValidationReceiptSchema = z
  .union([
    NoPendingMigrationsReceiptSchema,
    NeonValidationReceiptSchema,
    SupabaseValidationReceiptSchema,
  ])
  .superRefine((receipt, context) => {
    if (receipt.kind !== 'validated') return;
    const paths = receipt.migrations.map(({ path }) => path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'migration_validation_duplicate_path',
      });
    }
  });
export type MigrationValidationReceipt = z.infer<typeof MigrationValidationReceiptSchema>;

export const MigrationValidationRequestSchema = z
  .object({
    commitSha: CommitShaSchema,
    workspaceRoot: z.string().trim().min(1).max(4_096),
  })
  .strict();
export type MigrationValidationRequest = z.infer<typeof MigrationValidationRequestSchema>;

export interface MigrationValidationAdapter {
  validatePendingMigrations(input: MigrationValidationRequest): Promise<unknown>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function failure(
  ctx: GateContext,
  reason: 'migration_validation_adapter_failed' | 'migration_validation_receipt_invalid',
  error: unknown,
): Promise<GateResult> {
  const artifactId = await ctx.artifacts.store({
    kind: 'migration_validation',
    body: new TextEncoder().encode(
      JSON.stringify({ reason, error: errorText(error), reversibility: 'unavailable' }),
    ),
  });
  return GateResultSchema.parse({
    status: 'failed',
    evidenceArtifactIds: [artifactId],
    details: { reason, reversibility: 'unavailable' },
  });
}

function migrationIsDestructive(sql: string): boolean {
  const decision = evaluateToolCall(
    {
      mode: 'build',
      provenance: [],
      environmentScope: 'preview',
      approvedReleaseId: null,
      approvedDeployment: null,
    },
    'execute_migration',
    { environmentId: 'verification-isolated', migration: sql },
  );
  return decision.action === 'require_approval' && decision.reason === 'destructive_migration';
}

export function createMigrationValidationGate(adapter?: MigrationValidationAdapter): Gate {
  return {
    id: 'migration_validation',
    async run(ctx) {
      if (adapter === undefined) return notApplicable('migration_validation_adapter_absent');
      const request = MigrationValidationRequestSchema.parse({
        commitSha: ctx.commit,
        workspaceRoot: ctx.contract.workspace_root,
      });
      let receiptValue: unknown;
      try {
        receiptValue = await adapter.validatePendingMigrations(request);
      } catch (error) {
        return failure(ctx, 'migration_validation_adapter_failed', error);
      }

      const parsed = MigrationValidationReceiptSchema.safeParse(receiptValue);
      if (!parsed.success) {
        return failure(ctx, 'migration_validation_receipt_invalid', parsed.error);
      }
      const receipt = parsed.data;
      if (receipt.kind === 'no_pending_migrations') {
        const evidence = {
          provider: receipt.provider,
          migrationCount: 0,
          migrations: [],
          destructiveMigrationCount: 0,
          approvalRequired: false,
          reversibility: 'reversible' as const,
        };
        const artifactId = await ctx.artifacts.store({
          kind: 'migration_validation',
          body: new TextEncoder().encode(JSON.stringify(evidence)),
        });
        return GateResultSchema.parse({
          status: 'passed',
          evidenceArtifactIds: [artifactId],
          details: evidence,
        });
      }

      const migrations = receipt.migrations.map(({ path, sql }) => ({
        path,
        destructive: migrationIsDestructive(sql),
      }));
      const destructiveMigrationCount = migrations.filter(({ destructive }) => destructive).length;
      const stagesPassed =
        receipt.applyStatus === 'passed' &&
        receipt.smokeStatus === 'passed' &&
        receipt.cleanupStatus === 'passed';
      const evidence = {
        provider: receipt.provider,
        isolatedTargetKind: receipt.isolatedTarget.kind,
        isolatedTargetReference: receipt.isolatedTarget.reference,
        migrationCount: migrations.length,
        migrations,
        destructiveMigrationCount,
        approvalRequired: destructiveMigrationCount > 0,
        applyStatus: receipt.applyStatus,
        smokeStatus: receipt.smokeStatus,
        cleanupStatus: receipt.cleanupStatus,
        reversibility: receipt.reversibility,
      };
      const artifactId = await ctx.artifacts.store({
        kind: 'migration_validation',
        body: new TextEncoder().encode(JSON.stringify(evidence)),
      });
      return GateResultSchema.parse({
        status: stagesPassed ? 'passed' : 'failed',
        evidenceArtifactIds: [artifactId],
        details: evidence,
      });
    },
  };
}
