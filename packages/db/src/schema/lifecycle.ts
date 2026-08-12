import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { organizationId } from './columns.js';
import { artifacts } from './execution.js';
import { users } from './identity.js';
import { projects } from './projects.js';

export const DELETION_STATUSES = ['queued', 'running', 'failed', 'completed'] as const;
export const DELETION_TARGET_STATUSES = ['pending', 'verified'] as const;
export const EXPIRABLE_ARTIFACT_CLASSES = ['test', 'diagnostic'] as const;

/**
 * Durable CP-17 deletion progress. `project_id` deliberately has no project FK:
 * the record is the proof and polling surface after that project row is gone.
 */
export const projectDeletions = pgTable(
  'project_deletions',
  {
    projectId: text('project_id').primaryKey(),
    organizationId: organizationId(),
    requestedBy: text('requested_by')
      .notNull()
      .references(() => users.id),
    operationKey: text('operation_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    status: text('status', { enum: DELETION_STATUSES }).notNull().default('queued'),
    snapshotsStatus: text('snapshots_status', { enum: DELETION_TARGET_STATUSES })
      .notNull()
      .default('pending'),
    gitStatus: text('git_status', { enum: DELETION_TARGET_STATUSES })
      .notNull()
      .default('pending'),
    objectsStatus: text('objects_status', { enum: DELETION_TARGET_STATUSES })
      .notNull()
      .default('pending'),
    postgresStatus: text('postgres_status', { enum: DELETION_TARGET_STATUSES })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('project_deletions_org_operation_idx').on(
      table.organizationId,
      table.operationKey,
    ),
    index('project_deletions_poll_idx').on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
    check(
      'project_deletions_status_check',
      sql`${table.status} in ('queued', 'running', 'failed', 'completed')`,
    ),
    check(
      'project_deletions_targets_check',
      sql`${table.snapshotsStatus} in ('pending', 'verified') and ${table.gitStatus} in ('pending', 'verified') and ${table.objectsStatus} in ('pending', 'verified') and ${table.postgresStatus} in ('pending', 'verified')`,
    ),
    check(
      'project_deletions_lease_check',
      sql`(${table.leaseOwner} is null) = (${table.leaseExpiresAt} is null)`,
    ),
    check(
      'project_deletions_completion_check',
      sql`(${table.status} = 'completed') = (${table.snapshotsStatus} = 'verified' and ${table.gitStatus} = 'verified' and ${table.objectsStatus} = 'verified' and ${table.postgresStatus} = 'verified' and ${table.completedAt} is not null) and (${table.status} = 'completed' or ${table.completedAt} is null)`,
    ),
  ],
);

/**
 * Only artifacts present here may expire automatically. Release evidence and
 * project-lifetime artifacts cannot be selected because their class is absent
 * from the closed column enum.
 */
export const artifactRetention = pgTable(
  'artifact_retention',
  {
    artifactId: text('artifact_id')
      .primaryKey()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    projectId: text('project_id').notNull(),
    retentionClass: text('retention_class', { enum: EXPIRABLE_ARTIFACT_CLASSES }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('artifact_retention_expiry_idx').on(table.expiresAt, table.artifactId),
    foreignKey({
      name: 'artifact_retention_project_tenant_fk',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete('cascade'),
  ],
);

export type ProjectDeletion = typeof projectDeletions.$inferSelect;
export type NewProjectDeletion = typeof projectDeletions.$inferInsert;
export type ArtifactRetention = typeof artifactRetention.$inferSelect;
export type NewArtifactRetention = typeof artifactRetention.$inferInsert;
