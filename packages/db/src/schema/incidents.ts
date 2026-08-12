import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { organizationId, oneOf } from './columns.js';
import { agentRuns } from './planning.js';
import { projectTenantForeignKey, projects } from './projects.js';
import { releases } from './releases.js';

export const INCIDENT_SOURCES = [
  'grafana_faro',
  'grafana_loki',
  'synthetic_check',
  'user_report',
] as const;
export const INCIDENT_STATUSES = ['open', 'fix_in_progress', 'resolved'] as const;

/** OPS-11's durable link from production evidence through AR-19 to a resolving release. */
export const incidents = pgTable(
  'incidents',
  {
    id: text('id').primaryKey(), // inc_*
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id),
    source: text('source', { enum: INCIDENT_SOURCES }).notNull(),
    status: text('status', { enum: INCIDENT_STATUSES }).notNull(),
    summary: text('summary').notNull(),
    errorPayloadJson: jsonb('error_payload_json').notNull(),
    relevantCommitSha: text('relevant_commit_sha').notNull(),
    reproductionRef: text('reproduction_ref').notNull(),
    evidenceJson: jsonb('evidence_json').notNull(),
    operationKey: text('operation_key').notNull(),
    fixRunId: text('fix_run_id').references(() => agentRuns.id),
    resolutionReleaseId: text('resolution_release_id').references(() => releases.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('incidents_source_check', oneOf('source', INCIDENT_SOURCES)),
    check('incidents_status_check', oneOf('status', INCIDENT_STATUSES)),
    check('incidents_error_payload_size_check', sql`pg_column_size(error_payload_json) <= 65536`),
    check('incidents_evidence_size_check', sql`pg_column_size(evidence_json) <= 262144`),
    uniqueIndex('incidents_org_operation_idx').on(table.organizationId, table.operationKey),
    index('incidents_project_status_created_idx').on(
      table.projectId,
      table.status,
      table.createdAt.desc(),
    ),
    projectTenantForeignKey('incidents', table.projectId, table.organizationId),
  ],
);

export type IncidentRow = typeof incidents.$inferSelect;
export type NewIncidentRow = typeof incidents.$inferInsert;
