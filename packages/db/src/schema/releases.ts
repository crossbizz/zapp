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
import { sql } from 'drizzle-orm';

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

/** Append-only, deployment-scoped public progress stream (DEP-14). */
export const deploymentEvents = pgTable(
  'deployment_events',
  {
    id: text('id').primaryKey(), // evt_*
    organizationId: organizationId(),
    deploymentId: text('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    stage: text('stage').notNull(),
    status: text('status').notNull(),
    elapsedMs: integer('elapsed_ms').notNull(),
    summary: text('summary').notNull(),
    evidenceArtifactId: text('evidence_artifact_id').references(() => artifacts.id),
    terminalSuccessJson: jsonb('terminal_success_json'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('deployment_events_deployment_sequence_idx').on(
      t.organizationId,
      t.deploymentId,
      t.sequence,
    ),
    index('deployment_events_replay_idx').on(t.organizationId, t.deploymentId, t.sequence),
    check('deployment_events_sequence_check', sql`${t.sequence} >= 0`),
    check('deployment_events_elapsed_ms_check', sql`${t.elapsedMs} >= 0`),
    check(
      'deployment_events_stage_check',
      sql`${t.stage} in ('readiness_check','build_artifact','configure_secrets','apply_migrations','provision_runtime','start_services','production_health_check','go_live')`,
    ),
    check('deployment_events_status_check', sql`${t.status} in ('running','passed','failed')`),
  ],
);

/** Durable keyed action request; dispatchers must also honor operation_key idempotently. */
export const deploymentActionRequests = pgTable(
  'deployment_action_requests',
  {
    organizationId: organizationId(),
    operationKey: text('operation_key').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    action: text('action').notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('deployment_action_requests_org_operation_idx').on(
      t.organizationId,
      t.operationKey,
    ),
    index('deployment_action_requests_resource_idx').on(
      t.organizationId,
      t.resourceType,
      t.resourceId,
    ),
    check('deployment_action_requests_resource_check', sql`${t.resourceType} in ('release','deployment')`),
    check('deployment_action_requests_status_check', sql`${t.status} in ('pending','dispatched')`),
  ],
);

/** Provider-neutral durable environment-domain state consumed by DEP-10's service. */
export const environmentDomains = pgTable(
  'environment_domains',
  {
    organizationId: organizationId(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
    hostname: text('hostname').notNull(),
    operationKey: text('operation_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    providerId: text('provider_id').notNull(),
    providerDomainReference: text('provider_domain_reference'),
    status: text('status').notNull(),
    dnsInstructionsJson: jsonb('dns_instructions_json').notNull(),
    routingJson: jsonb('routing_json').notNull(),
    detail: text('detail'),
    verificationAttempt: integer('verification_attempt').notNull(),
  },
  (t) => [
    uniqueIndex('environment_domains_environment_hostname_idx').on(
      t.organizationId,
      t.environmentId,
      t.hostname,
    ),
    uniqueIndex('environment_domains_operation_idx').on(t.organizationId, t.operationKey),
    index('environment_domains_project_idx').on(t.organizationId, t.projectId, t.environmentId),
    projectTenantForeignKey('environment_domains', t.projectId, t.organizationId),
    check('environment_domains_status_check', sql`${t.status} in ('pending_dns','verifying','active','failed')`),
    check('environment_domains_attempt_check', sql`${t.verificationAttempt} >= 0`),
  ],
);

/** Append-only production health evidence used by the public project dashboard. */
export const productionHealthResults = pgTable(
  'production_health_results',
  {
    id: text('id').primaryKey(), // vr_*
    organizationId: organizationId(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
    releaseId: text('release_id').notNull().references(() => releases.id, { onDelete: 'cascade' }),
    deploymentId: text('deployment_id').notNull().references(() => deployments.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    evidenceArtifactId: text('evidence_artifact_id').notNull().references(() => artifacts.id),
    resultJson: jsonb('result_json').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('production_health_results_deployment_evidence_idx').on(t.organizationId, t.deploymentId, t.evidenceArtifactId),
    index('production_health_results_project_occurred_idx').on(t.organizationId, t.projectId, t.occurredAt),
    projectTenantForeignKey('production_health_results', t.projectId, t.organizationId),
    check('production_health_results_status_check', sql`${t.status} in ('healthy','failed')`),
  ],
);

/** Immutable synthetic execution history; the mutable synthetic_checks row remains the latest index. */
export const syntheticCheckResults = pgTable(
  'synthetic_check_results',
  {
    id: text('id').primaryKey(), // trun_*
    organizationId: organizationId(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
    releaseId: text('release_id').notNull().references(() => releases.id, { onDelete: 'cascade' }),
    syntheticCheckId: text('synthetic_check_id')
      .notNull()
      .references((): AnyPgColumn => syntheticChecks.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    summary: text('summary').notNull(),
    evidenceArtifactIdsJson: jsonb('evidence_artifact_ids_json').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('synthetic_check_results_check_completed_idx').on(t.organizationId, t.syntheticCheckId, t.completedAt),
    index('synthetic_check_results_project_completed_idx').on(t.organizationId, t.projectId, t.completedAt),
    projectTenantForeignKey('synthetic_check_results', t.projectId, t.organizationId),
    check('synthetic_check_results_status_check', sql`${t.status} in ('passed','failed')`),
  ],
);

/** Durable links for Grafana/PostHog annotations emitted for a release/deployment. */
export const releaseAnnotations = pgTable(
  'release_annotations',
  {
    id: text('id').primaryKey(), // aud_*
    organizationId: organizationId(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    releaseId: text('release_id').notNull().references(() => releases.id, { onDelete: 'cascade' }),
    deploymentId: text('deployment_id').references(() => deployments.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    kind: text('kind').notNull(),
    link: text('link').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('release_annotations_provider_kind_release_idx').on(t.organizationId, t.releaseId, t.provider, t.kind),
    index('release_annotations_project_occurred_idx').on(t.organizationId, t.projectId, t.occurredAt),
    projectTenantForeignKey('release_annotations', t.projectId, t.organizationId),
    check('release_annotations_provider_check', sql`${t.provider} in ('grafana','posthog')`),
  ],
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
export type DeploymentEvent = typeof deploymentEvents.$inferSelect;
export type NewDeploymentEvent = typeof deploymentEvents.$inferInsert;
export type DeploymentActionRequest = typeof deploymentActionRequests.$inferSelect;
export type EnvironmentDomain = typeof environmentDomains.$inferSelect;
export type ProductionHealthResult = typeof productionHealthResults.$inferSelect;
export type SyntheticCheckResult = typeof syntheticCheckResults.$inferSelect;
export type ReleaseAnnotation = typeof releaseAnnotations.$inferSelect;
export type SyntheticCheck = typeof syntheticChecks.$inferSelect;
export type NewSyntheticCheck = typeof syntheticChecks.$inferInsert;
