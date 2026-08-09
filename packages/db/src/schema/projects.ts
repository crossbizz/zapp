import { SupportLevelSchema } from '@zapp/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { oneOf, organizationId } from './columns.js';
import { users } from './identity.js';

/**
 * PRD §23.2 — project state. Columns are the PRD's list, in the PRD's order,
 * with the denormalized `organization_id` (see `./columns.ts`) directly after
 * `id`, which is where the PRD itself puts it on the tables that declare one.
 *
 * Value vocabularies the PRD does not fix (`source_type`, `sync_policy`,
 * environment `type`, branch `status`) stay plain `text`: plan 02 (CP-6) owns
 * those, and inventing a CHECK here would make its first migration a rewrite.
 * The sets the PRD *does* fix are constrained — `support_level` below.
 */

/** PRD §7.1 support tiers; the project's tier gates which verification gates are required (PRD §24.2). */
const SUPPORT_LEVELS = SupportLevelSchema.options;

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(), // proj_*
    organizationId: organizationId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    /** How the project entered zapp: a prompt, a GitHub import, an upload (PRD §10.1–10.2). */
    sourceType: text('source_type').notNull(),
    supportLevel: text('support_level', { enum: SUPPORT_LEVELS }).notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Archived projects stay readable and billable-free; deletion is a separate flow (plan 02 CP-17). */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    // The slug is the tenant-facing handle in URLs, so it is unique per
    // organization rather than globally: two tenants may both own "checkout".
    uniqueIndex('projects_org_slug_idx').on(t.organizationId, t.slug),
    // Redundant on its own — `id` is already the primary key — and that is the
    // point: a composite foreign key needs a unique index on exactly the columns
    // it targets. This is what makes `projectTenantForeignKey` below possible.
    uniqueIndex('projects_id_org_idx').on(t.id, t.organizationId),
    // The keyset order the project list actually pages in (plan 02 CP-6):
    // `where organization_id = $1 [and id < $cursor] order by id desc`. Without
    // the descending `id` the planner sorts every one of a tenant's projects to
    // return twenty, and the cursor's whole promise is that it does not.
    index('projects_org_id_idx').on(t.organizationId, t.id.desc()),
    check('projects_support_level_check', oneOf('support_level', SUPPORT_LEVELS)),
  ],
);

/**
 * `(project_id, organization_id) -> projects (id, organization_id)`, carried by
 * every project-owned table in addition to its plain `project_id` key.
 *
 * Without it `organization_id` is a denormalized copy nothing checks, so one
 * buggy writer can file another tenant's project under this tenant — and every
 * `forOrg` query would then happily hand it over. With it, the mismatch is a
 * foreign-key violation at insert time. `MATCH SIMPLE` (Postgres's default)
 * skips the check when `project_id` is null, which is exactly what keeps
 * organization-level rows (`secret_metadata`, `integration_connections`) legal.
 *
 * The constraint name is explicit because Drizzle's generated one — table, both
 * columns, target table, both target columns — runs past Postgres's
 * 63-character identifier limit and would be silently truncated.
 */
export function projectTenantForeignKey(
  table: string,
  projectIdColumn: AnyPgColumn,
  organizationIdColumn: AnyPgColumn,
): ReturnType<typeof foreignKey> {
  return foreignKey({
    name: `${table}_project_tenant_fk`,
    columns: [projectIdColumn, organizationIdColumn],
    foreignColumns: [projects.id, projects.organizationId],
  });
}

export const repositories = pgTable(
  'repositories',
  {
    id: text('id').primaryKey(), // repo_*
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    /** `internal` (Forgejo) or `github` — plan 06 owns the provider list. */
    provider: text('provider').notNull(),
    /** Always set: internal git is the source of truth, GitHub is a mirror (PRD §19.1). */
    internalRepoRef: text('internal_repo_ref').notNull(),
    /** Null until the project is linked to a GitHub repository (PRD §19.2). */
    externalRepoRef: text('external_repo_ref'),
    defaultBranch: text('default_branch').notNull().default('main'),
    /** PRD §19.3 sync rules; plan 06 (GIT-6) fixes the vocabulary. */
    syncPolicy: text('sync_policy').notNull(),
    /**
     * When the repository was actually created in the internal Git instance —
     * null while only the *record* exists.
     *
     * Not a PRD §23.2 column (declared with its reason in
     * `packages/db/test/prd-schema-conformance.test.ts`), and it exists because
     * the two states are genuinely different and nothing else distinguishes
     * them: plan 02 CP-6 ships a record-only git service that names the
     * repository and contacts nothing, so every row it writes leaves this null.
     * Plan 06's GIT-2 sets it when Forgejo confirms, and can then tell a row it
     * still has to provision from one it must not create twice — which without
     * this column it would have to guess at by cloning and seeing what happens.
     */
    provisionedAt: timestamp('provisioned_at', { withTimezone: true }),
  },
  (t) => [
    index('repositories_project_idx').on(t.projectId),
    /**
     * One repository per ref, per tenant.
     *
     * `internal_repo_ref` is where a clone, a push and a release all point, so
     * two rows sharing one is two projects writing to the same Git repository —
     * one project's code landing in another's history. That was reachable while
     * the ref was derived from the mutable slug: renaming `checkout` freed the
     * name, and the next project to take it minted a second row with the same
     * ref (plan 02 CP-6 review). The derivation now uses the immutable project
     * id (`services/control-api/src/git/port.ts`), and this index is what makes
     * the property hold for refs this service did not derive — an import, a
     * migration, a hand-written row.
     */
    uniqueIndex('repositories_org_internal_ref_idx').on(t.organizationId, t.internalRepoRef),
    projectTenantForeignKey('repositories', t.projectId, t.organizationId),
  ],
);

export const branches = pgTable(
  'branches',
  {
    id: text('id').primaryKey(), // br_*
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    /** Null on an unborn branch — the row exists before the first commit lands. */
    headCommitSha: text('head_commit_sha'),
    /**
     * Where the branch was cut from; null for the repository's default branch.
     * The return annotation is Drizzle's self-reference form — the table's own
     * type is still being inferred at this point.
     */
    baseBranchId: text('base_branch_id').references((): AnyPgColumn => branches.id),
    status: text('status').notNull(),
  },
  (t) => [
    uniqueIndex('branches_project_name_idx').on(t.projectId, t.name),
    projectTenantForeignKey('branches', t.projectId, t.organizationId),
  ],
);

export const environments = pgTable(
  'environments',
  {
    id: text('id').primaryKey(), // env_*
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    /** `preview`, `staging`, `production` in P0 (PRD §26A.3); plan 07 owns the list. */
    type: text('type').notNull(),
    /** Null until a deployment provider is chosen for this environment (PRD §27.2). */
    deploymentProvider: text('deployment_provider'),
    /** Supabase/Neon connection record this environment binds to (PRD §25.1); null when the project has no database. */
    databaseConnectionId: text('database_connection_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('environments_project_name_idx').on(t.projectId, t.name),
    projectTenantForeignKey('environments', t.projectId, t.organizationId),
  ],
);

export const projectContracts = pgTable(
  'project_contracts',
  {
    id: text('id').primaryKey(), // pc_*
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    /** Monotonic per project: detection re-runs append a version, never overwrite one (PRD §17.2). */
    version: integer('version').notNull(),
    /** Null when no adapter claimed the project and the generic Node fallback won (PRD §17.3). */
    detectedFramework: text('detected_framework'),
    /** An `ExecutionContract` (`@zapp/contracts`), stored whole: plan 05 reads it back through the Zod schema. */
    contractJson: jsonb('contract_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_contracts_project_version_idx').on(t.projectId, t.version),
    projectTenantForeignKey('project_contracts', t.projectId, t.organizationId),
  ],
);

/** WS-12 tenant-owned, revocable preview capability. Plaintext bearers never reach this table. */
export const previewShares = pgTable(
  'preview_shares',
  {
    /** Lowercase Crockford locator used in the isolated preview hostname. */
    id: text('id').primaryKey(),
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    workspaceId: text('workspace_id').notNull(),
    operationKey: text('operation_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    tokenHash: text('token_hash').notNull(),
    keyVersion: integer('key_version').notNull(),
    policy: text('policy', { enum: ['org', 'anyone_with_link'] }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('preview_shares_org_operation_idx').on(t.organizationId, t.operationKey),
    index('preview_shares_org_project_idx').on(t.organizationId, t.projectId, t.id),
    index('preview_shares_org_workspace_idx').on(t.organizationId, t.workspaceId, t.id),
    projectTenantForeignKey('preview_shares', t.projectId, t.organizationId),
    check('preview_shares_policy_check', oneOf('policy', ['org', 'anyone_with_link'])),
    check('preview_shares_key_version_check', sql`${t.keyVersion} > 0`),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
export type Environment = typeof environments.$inferSelect;
export type NewEnvironment = typeof environments.$inferInsert;
export type ProjectContract = typeof projectContracts.$inferSelect;
export type NewProjectContract = typeof projectContracts.$inferInsert;
export type PreviewShareRow = typeof previewShares.$inferSelect;
export type NewPreviewShareRow = typeof previewShares.$inferInsert;
