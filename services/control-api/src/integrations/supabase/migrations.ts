import { createHash } from 'node:crypto';

import { evaluateToolCall } from '@zapp/agent-policies';
import {
  MigrationValidationReceiptSchema,
  MigrationValidationRequestSchema,
  type MigrationValidationAdapter,
} from '@zapp/verification-engine';
import { z } from 'zod';

const SqlSchema = z.string().min(1).max(2_000_000);
const SqlIdentifierSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z_][a-z0-9_]*$/u);
const EnvironmentScopeSchema = z.enum(['preview', 'staging', 'production']);
const MigrationInputSchema = z
  .object({ environmentId: z.string().min(1), migration: SqlSchema })
  .strict();
const MutationContextSchema = z
  .object({
    organizationId: z.string().min(1),
    projectId: z.string().min(1),
    runId: z.string().min(1),
    taskId: z.string().min(1),
    step: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();
const ConnectionRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .strict();
const ConnectionSchema = z
  .object({
    projectRef: z.string().trim().min(1).max(200),
    accessToken: z.string().trim().min(1).max(10_000),
    scope: EnvironmentScopeSchema,
  })
  .strict();
const MigrationResultSchema = z
  .object({
    migrationId: z.string().min(1),
    status: z.enum(['applied', 'rejected']),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const OwnerScopedTableSchema = z
  .object({
    schema: SqlIdentifierSchema,
    table: SqlIdentifierSchema,
    ownerColumn: SqlIdentifierSchema,
  })
  .strict();
const PolicyTableSchema = OwnerScopedTableSchema.pick({ schema: true, table: true }).strict();
const RlsTemplatesSchema = z
  .object({ policy: z.string().min(1), test: z.string().min(1) })
  .strict();
const RlsRenderInputSchema = z
  .object({
    tables: z.array(OwnerScopedTableSchema).min(1).max(1_000),
    templates: RlsTemplatesSchema,
    fixtureOwnerId: z.string().uuid(),
    otherUserId: z.string().uuid(),
  })
  .strict()
  .superRefine((input, context) => {
    const keys = input.tables.map(tableKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'managed_rls_duplicate_table' });
    }
    if (input.fixtureOwnerId === input.otherUserId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'managed_rls_users_must_differ' });
    }
  });

const FileEntrySchema = z
  .object({ path: z.string().min(1), type: z.enum(['file', 'directory', 'symlink']) })
  .strict();
const MigrationFileSchema = z.object({ path: z.string().min(1), sql: SqlSchema }).strict();
const PendingPathsSchema = z
  .array(z.string().min(1))
  .max(1_000)
  .superRefine((paths, context) => {
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'migration_history_duplicate_path',
      });
    }
  });
const ShadowReceiptSchema = z
  .object({
    reference: z.string().min(1).max(1_024),
    applyStatus: z.enum(['passed', 'failed']),
    smokeStatus: z.enum(['passed', 'failed']),
    cleanupStatus: z.enum(['passed', 'failed']),
    reversibility: z.enum(['reversible', 'compensating', 'unavailable']),
  })
  .strict();

interface ExecInput {
  readonly cmd: string;
  readonly args: string[];
  readonly env?: Record<string, string>;
  readonly timeoutMs: number;
}

interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SupabaseMigrationRuntime {
  exec(input: ExecInput): Promise<ExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFilesAtomically(
    files: readonly { readonly path: string; readonly data: Uint8Array }[],
  ): Promise<void>;
  listFiles(
    path: string,
    opts?: { readonly glob?: string; readonly maxDepth?: number },
  ): Promise<unknown>;
}

export interface SupabaseMigrationConnectionPort {
  forEnvironment(
    input: z.infer<typeof ConnectionRequestSchema>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface SupabaseMigrationHistoryPort {
  pendingPaths(input: {
    readonly projectRef: string;
    readonly accessToken: string;
    readonly commitSha: string;
    readonly migrationPaths: readonly string[];
  }): Promise<unknown>;
}

export interface SupabaseShadowValidationPort {
  validate(input: {
    readonly projectRef: string;
    readonly accessToken: string;
    readonly commitSha: string;
    readonly migrations: readonly z.infer<typeof MigrationFileSchema>[];
  }): Promise<unknown>;
}

function tableKey(table: { readonly schema: string; readonly table: string }): string {
  return `${table.schema}.${table.table}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${SqlIdentifierSchema.parse(identifier)}"`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  let rendered = template;
  for (const [name, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${name}}}`, value);
  }
  const unresolved = /\{\{[^}]+\}\}/u.exec(rendered)?.[0];
  if (unresolved !== undefined) throw new Error(`supabase_rls_template_unresolved:${unresolved}`);
  return rendered.trimEnd();
}

function policyName(table: z.infer<typeof OwnerScopedTableSchema>): string {
  return `${table.table}_owner_all`;
}

export function assertManagedRlsCoverage(rawInput: {
  readonly managedTables: readonly z.input<typeof OwnerScopedTableSchema>[];
  readonly policyTables: readonly z.input<typeof PolicyTableSchema>[];
}): void {
  const managedTables = z.array(OwnerScopedTableSchema).max(1_000).parse(rawInput.managedTables);
  const policyTables = z.array(PolicyTableSchema).max(1_000).parse(rawInput.policyTables);
  const covered = new Set(policyTables.map(tableKey));
  const missing = managedTables
    .map(tableKey)
    .filter((key) => !covered.has(key))
    .sort();
  if (missing.length > 0) throw new Error(`managed_rls_policy_missing:${missing.join(',')}`);
}

export function renderOwnerScopedRlsArtifacts(rawInput: {
  readonly tables: readonly z.input<typeof OwnerScopedTableSchema>[];
  readonly templates: z.input<typeof RlsTemplatesSchema>;
  readonly fixtureOwnerId: string;
  readonly otherUserId: string;
}): {
  readonly policySql: string;
  readonly testSql: string;
  readonly policyTables: readonly z.infer<typeof PolicyTableSchema>[];
} {
  const input = RlsRenderInputSchema.parse(rawInput);
  const policyTables = input.tables.map(({ schema, table }) => ({ schema, table }));
  assertManagedRlsCoverage({ managedTables: input.tables, policyTables });
  const policySql = input.tables
    .map((table) => {
      const policy = policyName(table);
      return renderTemplate(input.templates.policy, {
        schema_ident: quoteIdentifier(table.schema),
        table_ident: quoteIdentifier(table.table),
        owner_column_ident: quoteIdentifier(table.ownerColumn),
        policy_ident: quoteIdentifier(policy),
      });
    })
    .join('\n\n');
  const tests = input.tables.map((table) => {
    const key = tableKey(table);
    const policy = policyName(table);
    return renderTemplate(input.templates.test, {
      schema_ident: quoteIdentifier(table.schema),
      table_ident: quoteIdentifier(table.table),
      owner_column_ident: quoteIdentifier(table.ownerColumn),
      schema_literal: sqlLiteral(table.schema),
      table_literal: sqlLiteral(table.table),
      policy_literal: sqlLiteral(policy),
      fixture_owner_literal: sqlLiteral(input.fixtureOwnerId),
      other_user_literal: sqlLiteral(input.otherUserId),
      fixture_present_message: sqlLiteral(`${key} fixture row exists before the denial check`),
      rls_enabled_message: sqlLiteral(`${key} has row-level security enabled`),
      policy_present_message: sqlLiteral(`${key} has its owner policy`),
      cross_user_message: sqlLiteral(`${key} denies another authenticated user`),
    });
  });
  const testSql = [
    'begin;',
    `select plan(${String(input.tables.length * 4)});`,
    ...tests,
    'select * from finish();',
    'rollback;',
  ].join('\n\n');
  return { policySql: `${policySql}\n`, testSql: `${testSql}\n`, policyTables };
}

export function analyzeSupabaseMigration(sqlValue: string):
  | {
      readonly destructive: true;
      readonly approvalRequired: true;
      readonly approvalReason: 'destructive_migration';
    }
  | { readonly destructive: false; readonly approvalRequired: false } {
  const sql = SqlSchema.parse(sqlValue);
  const decision = evaluateToolCall(
    {
      mode: 'build',
      provenance: [],
      environmentScope: 'preview',
      approvedReleaseId: null,
      approvedDeployment: null,
    },
    'execute_migration',
    { environmentId: 'supabase-migration-analysis', migration: sql },
  );
  return decision.action === 'require_approval' && decision.reason === 'destructive_migration'
    ? {
        destructive: true,
        approvalRequired: true,
        approvalReason: 'destructive_migration',
      }
    : { destructive: false, approvalRequired: false };
}

function migrationKey(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12);
}

function formatMigrationVersion(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error('migration_clock_invalid');
  return [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
    date.getUTCHours().toString().padStart(2, '0'),
    date.getUTCMinutes().toString().padStart(2, '0'),
    date.getUTCSeconds().toString().padStart(2, '0'),
  ].join('');
}

function parseMigrationVersion(version: string): Date | undefined {
  if (!/^\d{14}$/u.test(version)) return undefined;
  const parsed = new Date(
    Date.UTC(
      Number(version.slice(0, 4)),
      Number(version.slice(4, 6)) - 1,
      Number(version.slice(6, 8)),
      Number(version.slice(8, 10)),
      Number(version.slice(10, 12)),
      Number(version.slice(12, 14)),
    ),
  );
  return formatMigrationVersion(parsed) === version ? parsed : undefined;
}

function normalizedSql(sql: string): string {
  return `${sql.trimEnd()}\n`;
}

function isMissingFile(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return (error as { readonly code?: unknown }).code === 'ENOENT';
  }
  return error instanceof Error && error.message === 'file_not_found';
}

async function migrationEntries(runtime: SupabaseMigrationRuntime) {
  let rawEntries: unknown;
  try {
    rawEntries = await runtime.listFiles('supabase/migrations', {
      glob: '*.sql',
      maxDepth: 1,
    });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  return z
    .array(FileEntrySchema)
    .parse(rawEntries)
    .filter(
      (entry) =>
        entry.type === 'file' && /^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/u.test(entry.path),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function resolveMigrationPath(
  runtime: SupabaseMigrationRuntime,
  idempotencyKey: string,
  kind: 'agent' | 'owner_rls',
  now: () => Date,
): Promise<string> {
  const suffix = `${kind}_${migrationKey(idempotencyKey)}`;
  const entries = await migrationEntries(runtime);
  const existing = entries.filter((entry) => entry.path.endsWith(`_${suffix}.sql`));
  if (existing.length > 1) throw new Error(`migration_idempotency_ambiguous:${suffix}`);
  if (existing[0] !== undefined) return existing[0].path;

  const latest = entries
    .map((entry) => parseMigrationVersion(entry.path.split('/').at(-1)?.slice(0, 14) ?? ''))
    .filter((date): date is Date => date !== undefined)
    .at(-1);
  const clock = now();
  const candidate = new Date(Math.floor(clock.getTime() / 1_000) * 1_000);
  const next =
    latest !== undefined && latest >= candidate ? new Date(latest.getTime() + 1_000) : candidate;
  return `supabase/migrations/${formatMigrationVersion(next)}_${suffix}.sql`;
}

async function stageFile(
  runtime: SupabaseMigrationRuntime,
  path: string,
  body: string,
): Promise<'created' | 'existing'> {
  const data = new TextEncoder().encode(body);
  try {
    const existing = await runtime.readFile(path);
    if (new TextDecoder().decode(existing) !== body) {
      throw new Error(`migration_idempotency_conflict:${path}`);
    }
    return 'existing';
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  await runtime.writeFilesAtomically([{ path, data }]);
  return 'created';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason as unknown;
    throw reason instanceof Error ? reason : new Error('supabase_migration_cancelled');
  }
}

async function runCli(
  runtime: SupabaseMigrationRuntime,
  connection: z.infer<typeof ConnectionSchema>,
  args: string[],
  signal: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  const result = await runtime.exec({
    cmd: 'supabase',
    args,
    env: { SUPABASE_ACCESS_TOKEN: connection.accessToken },
    timeoutMs: 120_000,
  });
  return result.exitCode === 0;
}

export function createSupabaseMigrationPipeline(input: {
  readonly runtime: SupabaseMigrationRuntime;
  readonly connections: SupabaseMigrationConnectionPort;
  readonly now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async executeMigration(rawInput: unknown, rawContext: unknown, signal: AbortSignal) {
      const migration = MigrationInputSchema.parse(rawInput);
      const context = MutationContextSchema.parse(rawContext);
      const connectionRequest = ConnectionRequestSchema.parse({
        organizationId: context.organizationId,
        projectId: context.projectId,
        environmentId: migration.environmentId,
      });
      const connection = ConnectionSchema.parse(
        await input.connections.forEnvironment(connectionRequest, signal),
      );
      const path = await resolveMigrationPath(input.runtime, context.idempotencyKey, 'agent', now);
      const version = path.split('/').at(-1)?.slice(0, 14);
      if (version === undefined) throw new Error('migration_path_invalid');
      const id = `supabase:${version}:${migrationKey(context.idempotencyKey)}`;
      await stageFile(input.runtime, path, normalizedSql(migration.migration));
      analyzeSupabaseMigration(migration.migration);

      if (connection.scope === 'production') {
        return MigrationResultSchema.parse({
          migrationId: id,
          status: 'rejected',
          reason: 'production_release_pipeline_required',
        });
      }

      const linked = await runCli(
        input.runtime,
        connection,
        ['link', '--project-ref', connection.projectRef],
        signal,
      );
      if (!linked) {
        return MigrationResultSchema.parse({
          migrationId: id,
          status: 'rejected',
          reason: 'supabase_link_failed',
        });
      }
      const pushed = await runCli(
        input.runtime,
        connection,
        ['db', 'push', '--linked', '--include-all'],
        signal,
      );
      if (!pushed) {
        return MigrationResultSchema.parse({
          migrationId: id,
          status: 'rejected',
          reason: 'supabase_dev_migration_failed',
        });
      }
      const tested = await runCli(input.runtime, connection, ['test', 'db', '--linked'], signal);
      return MigrationResultSchema.parse(
        tested
          ? { migrationId: id, status: 'applied' }
          : {
              migrationId: id,
              status: 'rejected',
              reason: 'supabase_rls_tests_failed',
            },
      );
    },
  };
}

export async function writeOwnerScopedRlsArtifacts(input: {
  readonly runtime: SupabaseMigrationRuntime;
  readonly idempotencyKey: string;
  readonly tables: readonly z.input<typeof OwnerScopedTableSchema>[];
  readonly templates: z.input<typeof RlsTemplatesSchema>;
  readonly fixtureOwnerId: string;
  readonly otherUserId: string;
  readonly now?: () => Date;
}): Promise<{ readonly migrationPath: string; readonly testPath: string }> {
  const rendered = renderOwnerScopedRlsArtifacts(input);
  const policyPath = await resolveMigrationPath(
    input.runtime,
    input.idempotencyKey,
    'owner_rls',
    input.now ?? (() => new Date()),
  );
  const version = policyPath.split('/').at(-1)?.slice(0, 14);
  if (version === undefined) throw new Error('migration_path_invalid');
  const testPath = `supabase/tests/database/${version}_owner_rls.test.sql`;
  await stageFile(input.runtime, policyPath, rendered.policySql);
  await stageFile(input.runtime, testPath, rendered.testSql);
  return { migrationPath: policyPath, testPath };
}

async function migrationFiles(runtime: SupabaseMigrationRuntime) {
  const entries = await migrationEntries(runtime);
  return await Promise.all(
    entries.map(async ({ path }) =>
      MigrationFileSchema.parse({
        path,
        sql: new TextDecoder().decode(await runtime.readFile(path)),
      }),
    ),
  );
}

export function createSupabaseMigrationValidationAdapter(input: {
  readonly runtime: SupabaseMigrationRuntime;
  readonly projectRef: string;
  readonly accessToken: string;
  readonly history: SupabaseMigrationHistoryPort;
  readonly shadow: SupabaseShadowValidationPort;
}): MigrationValidationAdapter {
  const projectRef = ConnectionSchema.shape.projectRef.parse(input.projectRef);
  const accessToken = ConnectionSchema.shape.accessToken.parse(input.accessToken);
  return {
    async validatePendingMigrations(rawRequest) {
      const request = MigrationValidationRequestSchema.parse(rawRequest);
      const files = await migrationFiles(input.runtime);
      const pendingPaths = PendingPathsSchema.parse(
        await input.history.pendingPaths({
          projectRef,
          accessToken,
          commitSha: request.commitSha,
          migrationPaths: files.map(({ path }) => path),
        }),
      );
      const byPath = new Map(files.map((file) => [file.path, file]));
      const pending = pendingPaths.map((path) => {
        const file = byPath.get(path);
        if (file === undefined) throw new Error(`migration_history_unknown_path:${path}`);
        return file;
      });
      if (pending.length === 0) {
        return MigrationValidationReceiptSchema.parse({
          kind: 'no_pending_migrations',
          provider: 'supabase',
        });
      }
      const shadow = ShadowReceiptSchema.parse(
        await input.shadow.validate({
          projectRef,
          accessToken,
          commitSha: request.commitSha,
          migrations: pending,
        }),
      );
      return MigrationValidationReceiptSchema.parse({
        kind: 'validated',
        provider: 'supabase',
        isolatedTarget: { kind: 'supabase_shadow', reference: shadow.reference },
        migrations: pending,
        applyStatus: shadow.applyStatus,
        smokeStatus: shadow.smokeStatus,
        cleanupStatus: shadow.cleanupStatus,
        reversibility: shadow.reversibility,
      });
    },
  };
}
