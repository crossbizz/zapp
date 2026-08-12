import { index, pgTable, text, timestamp, type AnyPgColumn } from 'drizzle-orm/pg-core';

import { organizationId } from './columns.js';
import { artifacts } from './execution.js';
import { users } from './identity.js';
import { specifications } from './planning.js';
import { environments, projectTenantForeignKey, projects } from './projects.js';

/**
 * PRD §23.5 — release state: the immutable record of what was shipped, the
 * provider-side deployments that carried it, and the checks watching it after.
 *
 * Columns follow PRD §23.5 in order, with `organization_id` after `id`
 * (`./columns.ts`). Release and deployment statuses stay unconstrained text:
 * plan 07 owns the release flow (PRD §27.3) and the provider state machine
 * (`DeploymentStateSchema` in `@zapp/contracts`) is the provider's, not ours.
 */

export const releases = pgTable(
  'releases',
  {
    id: text('id').primaryKey(), // rel_*
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id),
    /** Exact commit, resolved — a release never points at a moving ref (PRD §27.3). */
    commitSha: text('commit_sha').notNull(),
    /** The specification version this release claims to satisfy; null for projects with none. */
    specificationId: text('specification_id').references(() => specifications.id),
    status: text('status').notNull(),
    /** The PRD §27.4 evidence manifest, stored as an artifact so it is immutable and citable. */
    evidenceManifestArtifactId: text('evidence_manifest_artifact_id').references(
      () => artifacts.id,
    ),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('releases_project_created_at_idx').on(t.projectId, t.createdAt),
    index('releases_environment_idx').on(t.environmentId),
    projectTenantForeignKey('releases', t.projectId, t.organizationId),
  ],
);

export const deployments = pgTable(
  'deployments',
  {
    id: text('id').primaryKey(), // dep_*
    organizationId: organizationId(),
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    /** `vercel`, `cloudflare`, … (PRD §27.2). */
    provider: text('provider').notNull(),
    /** Null between "we asked" and "the provider answered" — that gap is where reconciliation lives. */
    providerDeploymentId: text('provider_deployment_id'),
    status: text('status').notNull(),
    /** Null until the provider assigns one. */
    url: text('url'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * Set on a deployment that exists to undo another one (PRD §27.5), which is
     * what makes a rollback auditable rather than just another deploy.
     * Drizzle's self-reference form.
     */
    rollbackOfDeploymentId: text('rollback_of_deployment_id').references(
      (): AnyPgColumn => deployments.id,
    ),
  },
  (t) => [index('deployments_release_idx').on(t.releaseId)],
);

export const syntheticChecks = pgTable(
  'synthetic_checks',
  {
    id: text('id').primaryKey(), // syn_*
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id),
    name: text('name').notNull(),
    /** Cron expression; the scheduler owns interpretation (plan 10 OPS-9). */
    schedule: text('schedule').notNull(),
    status: text('status').notNull(),
    /** Null until the check has run once. */
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  },
  (t) => [
    index('synthetic_checks_project_environment_idx').on(t.projectId, t.environmentId),
    projectTenantForeignKey('synthetic_checks', t.projectId, t.organizationId),
  ],
);

export type Release = typeof releases.$inferSelect;
export type NewRelease = typeof releases.$inferInsert;
export type Deployment = typeof deployments.$inferSelect;
export type NewDeployment = typeof deployments.$inferInsert;
export type SyntheticCheck = typeof syntheticChecks.$inferSelect;
export type NewSyntheticCheck = typeof syntheticChecks.$inferInsert;
