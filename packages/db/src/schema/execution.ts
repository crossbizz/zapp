import {
  AGENT_EVENT_TYPES,
  AgentEventVisibilitySchema,
  WorkspacePurposeSchema,
  WorkspaceStatusSchema,
} from '@zapp/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { oneOf, organizationId } from './columns.js';
import { agentPhases, agentRuns, agentTasks } from './planning.js';
import { branches, projectTenantForeignKey, projects } from './projects.js';

/**
 * PRD §23.4 — execution and evidence: where work ran, what it emitted, and the
 * proof a release later cites. Columns follow PRD §23.4 in order, with
 * `organization_id` after `id` (`./columns.ts`).
 *
 * Two vocabularies are contractual and constrained in the database as well:
 * the workspace lifecycle (PRD §18.9) and event visibility (PRD §14.4).
 */

const WORKSPACE_STATUSES = WorkspaceStatusSchema.options;
const WORKSPACE_PURPOSES = WorkspacePurposeSchema.options;
const EVENT_VISIBILITIES = AgentEventVisibilitySchema.options;

/** PRD §14.4 payload ceiling: 64 KiB. Anything larger belongs in `artifacts` + object storage (master plan §5.2). */
export const MAX_EVENT_PAYLOAD_BYTES = 65_536;

export const workspaces = pgTable(
  'workspaces',
  {
    id: text('id').primaryKey(), // ws_*
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Null for workspaces that scan or preview without checking out a branch. */
    branchId: text('branch_id').references(() => branches.id),
    /** `modal` in P0 (PRD §18.1); the column exists so a second provider needs no migration. */
    provider: text('provider').notNull(),
    /** Null while `requested`: the provider assigns it at creation (PRD §18.9). */
    providerWorkspaceId: text('provider_workspace_id'),
    status: text('status', { enum: WORKSPACE_STATUSES }).notNull(),
    /** `small` | `standard` | `large` (PRD §18.10) — also the billing floor (plan 03 WS-8). */
    resourceProfile: text('resource_profile').notNull(),
    /** Durable provider attachment attribution; populated atomically when sandbox-service claims creation. */
    runId: text('run_id'),
    taskId: text('task_id'),
    purpose: text('purpose', { enum: WORKSPACE_PURPOSES }),
    environment: text('environment', { enum: ['zapp-dev', 'zapp-staging', 'zapp-prod'] }),
    imageTag: text('image_tag'),
    /** A durable intent plus renewable owner lease makes preview failure observation single-owner across replicas. */
    previewMonitorEnabled: boolean('preview_monitor_enabled').notNull().default(false),
    previewMonitorOwnerId: text('preview_monitor_owner_id'),
    previewMonitorLeaseExpiresAt: timestamp('preview_monitor_lease_expires_at', {
      withTimezone: true,
    }),
    /** Latest provider snapshot; null when none exists or it has expired (PRD §18.8). */
    snapshotRef: text('snapshot_ref'),
    /** Durable usage baseline/accumulators; the sandbox process is never the accounting source. */
    usageOperationKey: text('usage_operation_key'),
    usageLastSampleAt: timestamp('usage_last_sample_at', { withTimezone: true }),
    usageLastCpuMicros: bigint('usage_last_cpu_micros', { mode: 'number' }),
    usageCpuSeconds: numeric('usage_cpu_seconds', { precision: 24, scale: 6 }),
    usageMemoryGibSeconds: numeric('usage_memory_gib_seconds', { precision: 24, scale: 6 }),
    usageCpuSecondUsd: numeric('usage_cpu_second_usd', { precision: 18, scale: 12 }),
    usageMemoryGibSecondUsd: numeric('usage_memory_gib_second_usd', {
      precision: 18,
      scale: 12,
    }),
    usageCreditsPerUsd: numeric('usage_credits_per_usd', { precision: 18, scale: 6 }),
    usageFinalizedAt: timestamp('usage_finalized_at', { withTimezone: true }),
    usageCpuDeliveredAt: timestamp('usage_cpu_delivered_at', { withTimezone: true }),
    usageMemoryDeliveredAt: timestamp('usage_memory_delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    terminatedAt: timestamp('terminated_at', { withTimezone: true }),
  },
  (t) => [
    check('workspaces_status_check', oneOf('status', WORKSPACE_STATUSES)),
    check(
      'workspaces_attachment_complete_check',
      sql`num_nonnulls(${t.runId}, ${t.taskId}, ${t.purpose}, ${t.environment}, ${t.imageTag}) in (0, 5)`,
    ),
    check(
      'workspaces_preview_monitor_lease_check',
      sql`(${t.previewMonitorOwnerId} is null) = (${t.previewMonitorLeaseExpiresAt} is null)`,
    ),
    check(
      'workspaces_preview_monitor_disabled_check',
      sql`${t.previewMonitorEnabled} or (${t.previewMonitorOwnerId} is null and ${t.previewMonitorLeaseExpiresAt} is null)`,
    ),
    check(
      'workspaces_usage_state_complete_check',
      sql`((${t.usageOperationKey} is null and num_nonnulls(${t.usageLastSampleAt}, ${t.usageLastCpuMicros}, ${t.usageCpuSeconds}, ${t.usageMemoryGibSeconds}, ${t.usageCpuSecondUsd}, ${t.usageMemoryGibSecondUsd}, ${t.usageCreditsPerUsd}, ${t.usageFinalizedAt}, ${t.usageCpuDeliveredAt}, ${t.usageMemoryDeliveredAt}) = 0) or (${t.usageOperationKey} is not null and num_nonnulls(${t.usageLastSampleAt}, ${t.usageLastCpuMicros}, ${t.usageCpuSeconds}, ${t.usageMemoryGibSeconds}, ${t.usageCpuSecondUsd}, ${t.usageMemoryGibSecondUsd}, ${t.usageCreditsPerUsd}) = 7)) and (num_nonnulls(${t.usageCpuDeliveredAt}, ${t.usageMemoryDeliveredAt}) = 0 or ${t.usageFinalizedAt} is not null)`,
    ),
    // The reaper and the reconciler both sweep by (tenant, status); the project
    // index serves "which sandboxes does this project have running".
    index('workspaces_org_status_idx').on(t.organizationId, t.status),
    index('workspaces_project_idx').on(t.projectId),
    index('workspaces_preview_monitor_idx').on(
      t.previewMonitorEnabled,
      t.previewMonitorLeaseExpiresAt,
    ),
    projectTenantForeignKey('workspaces', t.projectId, t.organizationId),
  ],
);

/**
 * PRD §14.4 event log — the hot table, and the one Mission Control replays from.
 *
 * This object maps the **parent** of a range-partitioned table: the physical
 * `PARTITION BY RANGE (occurred_at)` clause, the monthly partitions and the
 * per-partition `unique (run_id, sequence)` indexes live in the hand-written
 * half of `0001_prd23_schema_and_event_partitioning.sql`, because drizzle-kit
 * cannot author partitioning. Two consequences are visible here:
 *
 * - the primary key is `(id, occurred_at)`, since Postgres requires every
 *   unique constraint on a partitioned table to contain the partition key;
 * - `(run_id, sequence)` is therefore unique *per partition*. Globally it is
 *   upheld by `run_event_counters`, the single allocator of sequence numbers
 *   ({@link nextEventSequence} in `../events.ts`).
 *
 * Append-only (master plan §Global Constraints): this package exports no update
 * or delete helper for it, and plan 02 (CP-1) revokes those grants from the
 * application role. Retention is partition-drop, not `DELETE` (plan 10 OPS-14).
 */
export const agentEvents = pgTable(
  'agent_events',
  {
    id: text('id').notNull(), // evt_*
    organizationId: organizationId(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    /** 1-based, gapless per run, allocated by `nextEventSequence` — clients resume from it (plan 02 CP-15). */
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    /**
     * Typed in TypeScript, unconstrained in the database on purpose: the 34-value
     * PRD §14.4 vocabulary is owned by `AGENT_EVENT_TYPES` in `@zapp/contracts`,
     * plan 04 extends it as the runtime grows, and a CHECK on the hottest table
     * would turn each addition into an `ALTER TABLE` on every partition. The five
     * value sets that *are* enforced here are the ones a wrong value would let
     * through silently — states and visibility, not an event's name.
     */
    type: text('type', { enum: AGENT_EVENT_TYPES }).notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    visibility: text('visibility', { enum: EVENT_VISIBILITIES }).notNull(),
    /**
     * The partition key. No default on purpose: an event happened when the
     * producer says it happened, and a late-arriving batch must not be stamped
     * with its insert time — that would file it under the wrong partition.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** CP-13 replay context (PRD §14.4); physical column absent from conceptual PRD §23.4 row. */
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** CP-13 replay context; nullable for run-level events. */
    phaseId: text('phase_id').references(() => agentPhases.id, { onDelete: 'cascade' }),
    /** CP-13 replay context; nullable for non-task events. */
    taskId: text('task_id').references(() => agentTasks.id, { onDelete: 'cascade' }),
    /** CP-13 replay context; an agent role string, not an entity foreign key. */
    agentId: text('agent_id'),
  },
  (t) => [
    primaryKey({ name: 'agent_events_pk', columns: [t.id, t.occurredAt] }),
    check('agent_events_visibility_check', oneOf('visibility', EVENT_VISIBILITIES)),
    // Keeps one oversized payload from being written at all, rather than
    // discovering it when the stream stalls. `pg_column_size` measures the
    // datum, so this is the same 64 KiB the ingest API rejects (PRD §14.4).
    check(
      'agent_events_payload_size_check',
      sql.raw(`pg_column_size(payload_json) <= ${String(MAX_EVENT_PAYLOAD_BYTES)}`),
    ),
    // Master plan §5.2: the tenant-scoped, time-bounded read, and what lets the
    // planner prune partitions instead of scanning every month.
    index('agent_events_org_occurred_at_idx').on(t.organizationId, t.occurredAt),
    index('agent_events_org_project_occurred_at_idx').on(
      t.organizationId,
      t.projectId,
      t.occurredAt.desc(),
    ),
    projectTenantForeignKey('agent_events', t.projectId, t.organizationId),
  ],
);

/**
 * One row per run: the allocator behind `agent_events.sequence`.
 *
 * Not a PRD §23 table — it is the mechanism that makes `sequence` gapless under
 * concurrency, which the PRD §14.4 replay contract needs and a partitioned
 * unique index cannot provide on its own. See `nextEventSequence`.
 */
export const runEventCounters = pgTable('run_event_counters', {
  runId: text('run_id')
    .primaryKey()
    .references(() => agentRuns.id, { onDelete: 'cascade' }),
  /** Highest sequence handed out for this run; 0 means none yet. */
  lastSequence: bigint('last_sequence', { mode: 'number' }).notNull().default(0),
});

const ACTIVITY_IDEMPOTENCY_STATUSES = ['running', 'completed'] as const;

/**
 * AR-9's durable activity fence. Temporal can redeliver an activity after any
 * worker/process failure; this row distinguishes an owned attempt from an exact
 * completed replay without relying on process memory.
 */
export const activityIdempotency = pgTable(
  'activity_idempotency',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    activityType: text('activity_type').notNull(),
    inputHash: text('input_hash').notNull(),
    status: text('status', { enum: ACTIVITY_IDEMPOTENCY_STATUSES }).notNull(),
    ownerId: text('owner_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    resultHash: text('result_hash'),
    resultJson: jsonb('result_json'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'activity_idempotency_input_hash_check',
      sql`${t.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'activity_idempotency_result_hash_check',
      sql`${t.resultHash} is null or ${t.resultHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'activity_idempotency_state_check',
      sql`(
        (${t.status} = 'running' and ${t.ownerId} is not null and ${t.leaseExpiresAt} is not null and ${t.resultHash} is null and ${t.resultJson} is null)
        or
        (${t.status} = 'completed' and ${t.ownerId} is null and ${t.leaseExpiresAt} is null and ${t.resultHash} is not null and ${t.resultJson} is not null)
      )`,
    ),
    index('activity_idempotency_lease_idx').on(t.status, t.leaseExpiresAt),
  ],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').primaryKey(), // art_*
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Null for artifacts that belong to the project rather than to one run (imports, scans). */
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => agentTasks.id, { onDelete: 'cascade' }),
    /** Screenshot, trace, log bundle, evidence manifest… plan 05 owns the vocabulary. */
    type: text('type').notNull(),
    /** Tenant-prefixed object-storage key (master plan §5.2), never a public URL. */
    storageRef: text('storage_ref').notNull(),
    /** Content hash of the stored object: what makes evidence citable and de-duplicable. */
    contentHash: text('content_hash').notNull(),
    metadataJson: jsonb('metadata_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('artifacts_project_created_at_idx').on(t.projectId, t.createdAt),
    index('artifacts_run_idx').on(t.runId),
    uniqueIndex('artifacts_capability_scan_operation_idx')
      .on(t.organizationId, t.projectId, sql`(${t.metadataJson}->>'scanId')`)
      .where(sql`${t.type} = 'capability_scan_report'`),
    projectTenantForeignKey('artifacts', t.projectId, t.organizationId),
  ],
);

export const testRuns = pgTable(
  'test_runs',
  {
    id: text('id').primaryKey(), // trun_*
    organizationId: organizationId(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    /** Null for run-level gates that are not attributable to one task (release verification). */
    taskId: text('task_id').references(() => agentTasks.id, { onDelete: 'cascade' }),
    /** The exact commit the gate ran against — evidence is worthless without it (PRD §24.3). */
    commitSha: text('commit_sha').notNull(),
    /** PRD §24.2 gate category: unit, integration, browser, smoke… plan 05 owns the list. */
    type: text('type').notNull(),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Counts and timings; null while the run is still in flight. */
    summaryJson: jsonb('summary_json'),
  },
  (t) => [index('test_runs_run_idx').on(t.runId)],
);

export const testCases = pgTable(
  'test_cases',
  {
    id: text('id').primaryKey(), // tcase_*
    organizationId: organizationId(),
    testRunId: text('test_run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').notNull(),
    /** Null when the runner reports no timing (skipped cases). */
    durationMs: integer('duration_ms'),
    /** Screenshot or trace proving the result (PRD §24.4); null when the case produced none. */
    evidenceArtifactId: text('evidence_artifact_id').references(() => artifacts.id),
    /** Failure message and stack, already scrubbed; null when the case passed. */
    errorJson: jsonb('error_json'),
  },
  (t) => [index('test_cases_test_run_idx').on(t.testRunId)],
);

export const verificationResults = pgTable(
  'verification_results',
  {
    id: text('id').primaryKey(), // vr_*
    organizationId: organizationId(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    /** Null for a release-level verdict covering the whole run. */
    taskId: text('task_id').references(() => agentTasks.id, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    /** The verifier's verdict; plan 05 (VF-10) fixes the vocabulary. */
    decision: text('decision').notNull(),
    /** Per-criterion outcome, each pointing at the evidence that settled it (PRD §24.3). */
    criteriaResultsJson: jsonb('criteria_results_json').notNull(),
    /** Residual risks the verifier wants a human to see (PRD §24.6). */
    risksJson: jsonb('risks_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verification_results_run_idx').on(t.runId)],
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type AgentEventRow = typeof agentEvents.$inferSelect;
export type NewAgentEventRow = typeof agentEvents.$inferInsert;
export type RunEventCounter = typeof runEventCounters.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
export type TestRun = typeof testRuns.$inferSelect;
export type NewTestRun = typeof testRuns.$inferInsert;
export type TestCase = typeof testCases.$inferSelect;
export type NewTestCase = typeof testCases.$inferInsert;
export type VerificationResult = typeof verificationResults.$inferSelect;
export type NewVerificationResult = typeof verificationResults.$inferInsert;
