import { APP_TYPES, RunModeSchema, TaskStateSchema } from '@zapp/contracts';
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
import { branches, projectTenantForeignKey, projects } from './projects.js';

/**
 * PRD §23.3 — specification and planning: what the user asked for, what was
 * decided along the way, and the run/phase/task graph that builds it.
 *
 * Columns follow PRD §23.3 in order, with `organization_id` after `id`
 * (`./columns.ts`). Two vocabularies are contractual and therefore constrained
 * in the database as well as in TypeScript: run modes (PRD §11) and task states
 * (PRD §13.2). Run, specification and approval *statuses* are not fixed by the
 * PRD, so they stay unconstrained text for plan 04 to define.
 */

const RUN_MODES = RunModeSchema.options;
const TASK_STATES = TaskStateSchema.options;

export const specifications = pgTable(
  'specifications',
  {
    id: text('id').primaryKey(), // spec_*
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    /** Monotonic per project. An approved version is immutable and every task and test cites one (PRD §12.3). */
    version: integer('version').notNull(),
    status: text('status').notNull(),
    /** The PRD §12.2 specification artifact, whole. */
    contentJson: jsonb('content_json').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    /** Null until a person approves it — the builder cannot approve itself (PRD §7.3). */
    approvedBy: text('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('specifications_project_version_idx').on(t.projectId, t.version),
    projectTenantForeignKey('specifications', t.projectId, t.organizationId),
  ],
);

export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(), // dec_*
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    /** Null when the question was settled before the specification existed. */
    specificationId: text('specification_id').references(() => specifications.id),
    question: text('question').notNull(),
    decision: text('decision').notNull(),
    rationale: text('rationale'),
    /**
     * Deliberately not a users foreign key: PRD §12.1 requires the agent to
     * record an assumption when the user delegates a decision, so this is an
     * actor reference (a `user_*` id or an agent role), like `audit_events`.
     */
    madeBy: text('made_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('decisions_project_specification_idx').on(t.projectId, t.specificationId),
    projectTenantForeignKey('decisions', t.projectId, t.organizationId),
  ],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(), // run_*
    organizationId: organizationId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    /** Null in ask mode, which answers questions without touching a branch (PRD §11.1). */
    branchId: text('branch_id').references(() => branches.id),
    mode: text('mode', { enum: RUN_MODES }).notNull(),
    appType: text('app_type', { enum: APP_TYPES }).notNull().default('web'),
    model: text('model'),
    /** SHA-256 of the scoped create request, used to reject changed-key reuse after dispatch failure. */
    requestFingerprint: text('request_fingerprint').notNull(),
    status: text('status').notNull(),
    /** Null in modes that build without a specification (ask, prototype). */
    specificationId: text('specification_id').references(() => specifications.id),
    /** Set when the durable workflow starts; the row exists before Temporal knows about it (plan 04 AR-8). */
    temporalWorkflowId: text('temporal_workflow_id'),
    startedBy: text('started_by')
      .notNull()
      .references(() => users.id),
    /** Token/credit ceiling for this run; null falls back to the organization's default (PRD §31). */
    budgetJson: jsonb('budget_json'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    check('agent_runs_mode_check', oneOf('mode', RUN_MODES)),
    check('agent_runs_app_type_check', oneOf('app_type', APP_TYPES)),
    // Mission Control reads a project's runs newest-first; the organization
    // index serves the cross-project dashboard and every tenant-scoped read.
    index('agent_runs_project_started_at_idx').on(t.projectId, t.startedAt),
    index('agent_runs_org_started_at_idx').on(t.organizationId, t.startedAt),
    projectTenantForeignKey('agent_runs', t.projectId, t.organizationId),
  ],
);

export const agentPhases = pgTable(
  'agent_phases',
  {
    id: text('id').primaryKey(), // phase_*
    organizationId: organizationId(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id),
    /** Position in the plan, 1-based. Unique per run: two phases cannot claim one slot. */
    sequence: integer('sequence').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    /** The phase's acceptance criteria, each traceable to a specification requirement (PRD §24.3). */
    acceptanceCriteriaJson: jsonb('acceptance_criteria_json').notNull(),
  },
  (t) => [uniqueIndex('agent_phases_run_sequence_idx').on(t.runId, t.sequence)],
);

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: text('id').primaryKey(), // task_*
    organizationId: organizationId(),
    phaseId: text('phase_id')
      .notNull()
      .references(() => agentPhases.id),
    /** Set when a task was split during execution (PRD §13.4); Drizzle's self-reference form. */
    parentTaskId: text('parent_task_id').references((): AnyPgColumn => agentTasks.id),
    title: text('title').notNull(),
    status: text('status', { enum: TASK_STATES }).notNull(),
    /** `low` | `medium` | `high` — drives the approval policy for the task's tools (PRD §16.2). */
    riskLevel: text('risk_level').notNull(),
    /** Every task starts from a recorded base commit (PRD §13.3); null until it is scheduled. */
    baseCommitSha: text('base_commit_sha'),
    /** Null until the task produces a commit — a failed or cancelled task never does. */
    outputCommitSha: text('output_commit_sha'),
    acceptanceCriteriaJson: jsonb('acceptance_criteria_json').notNull(),
    /** Ids of the tasks this one waits on; the planner's edge list (PRD §13.1). */
    dependenciesJson: jsonb('dependencies_json').notNull(),
    /** Agent role name (PRD §15.2), not an id: roles are code, not rows. Null until dispatch. */
    assignedAgentRole: text('assigned_agent_role'),
  },
  (t) => [
    check('agent_tasks_status_check', oneOf('status', TASK_STATES)),
    index('agent_tasks_phase_idx').on(t.phaseId),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(), // appr_*
    organizationId: organizationId(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id),
    /** Null for run-level gates (specification approval, production deploy). */
    taskId: text('task_id').references(() => agentTasks.id),
    type: text('type').notNull(),
    status: text('status').notNull(),
    /** What is being asked, rendered by the client: the tool call, the diff, the deploy target. */
    requestJson: jsonb('request_json').notNull(),
    /** Null while pending. */
    responseJson: jsonb('response_json'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** A person, always: the builder cannot approve itself (PRD §7.3). */
    resolvedBy: text('resolved_by').references(() => users.id),
  },
  (t) => [index('approvals_run_status_idx').on(t.runId, t.status)],
);

export type Specification = typeof specifications.$inferSelect;
export type NewSpecification = typeof specifications.$inferInsert;
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
export type AgentPhase = typeof agentPhases.$inferSelect;
export type NewAgentPhase = typeof agentPhases.$inferInsert;
export type AgentTask = typeof agentTasks.$inferSelect;
export type NewAgentTask = typeof agentTasks.$inferInsert;
export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
