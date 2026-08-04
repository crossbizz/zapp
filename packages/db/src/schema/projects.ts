import { SupportLevelSchema } from '@zapp/contracts';
import {
  check,
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
    check('projects_support_level_check', oneOf('support_level', SUPPORT_LEVELS)),
  ],
);

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
  },
  (t) => [index('repositories_project_idx').on(t.projectId)],
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
  (t) => [uniqueIndex('branches_project_name_idx').on(t.projectId, t.name)],
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
  (t) => [uniqueIndex('environments_project_name_idx').on(t.projectId, t.name)],
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
  (t) => [uniqueIndex('project_contracts_project_version_idx').on(t.projectId, t.version)],
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
