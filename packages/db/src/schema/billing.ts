import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { oneOf } from './columns.js';
import { organizations } from './identity.js';
import { agentRuns, agentTasks, approvals } from './planning.js';
import { projectTenantForeignKey, projects } from './projects.js';

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    stripeSubscriptionId: text('stripe_subscription_id'),
    planId: text('plan_id').notNull(),
    status: text('status').notNull(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  },
  (t) => [
    // Stripe's id is the idempotency key for `customer.subscription.*` webhook
    // sync (plan 10 OPS-4). Nullable because a row can exist before Stripe does
    // — Postgres allows many NULLs under a unique index, one id under it.
    uniqueIndex('subscriptions_stripe_subscription_id_idx').on(t.stripeSubscriptionId),
    index('subscriptions_organization_idx').on(t.organizationId),
  ],
);

/**
 * PRD §23.1, in order. Persisted as `text` + CHECK rather than a pg enum (see
 * `oneOf` in `./columns.ts`): plan 10 (OPS-4) already has to add `credit_grant`,
 * and extending a CHECK is one `ALTER TABLE`, while enum values cannot be
 * dropped at all and only append. The TypeScript union below is the
 * compile-time half of the same rule.
 */
export const USAGE_CATEGORIES = [
  'model_input_tokens',
  'model_output_tokens',
  'model_cached_tokens',
  'sandbox_cpu_seconds',
  'sandbox_mem_gib_seconds',
  'storage_gib_hours',
  'deploy_provider',
  'artifact_storage',
] as const;

export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

/**
 * Append-only (plan 01 §Global Constraints, plan 10 OPS-1): rows are never
 * updated or deleted — corrections are compensating entries with a negative
 * quantity — so this package exports no update or delete helper for it, and
 * CP-1 revokes the UPDATE/DELETE grants from the application role.
 */
export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: text('id').primaryKey(), // also the Flexprice ingestion `event_id` (plan 10 OPS-1)
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    // Attribution below the organization is optional: storage and credit rows
    // belong to no single project, run, or task. No FKs — plan FND-6 owns those
    // tables, and a ledger row must never be blocked by a purged project.
    projectId: text('project_id'),
    runId: text('run_id'),
    taskId: text('task_id'),
    category: text('category', { enum: USAGE_CATEGORIES }).notNull(),
    // Nullable: an internal entry (a credit grant, plan 10 OPS-4) has no vendor.
    provider: text('provider'),
    // `numeric`, never a float: these are money and metered quantities, and
    // Drizzle surfaces them as strings so JS never rounds them silently.
    // Unconstrained precision on quantity — token counts and GiB-hours differ
    // by many orders of magnitude.
    quantity: numeric('quantity').notNull(),
    unit: text('unit').notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull(),
    creditsCharged: numeric('credits_charged', { precision: 12, scale: 4 }).notNull(),
    // No default: usage happens when it happens, and late-arriving batches must
    // not be silently stamped with their insert time.
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Every read is org-scoped and time-bounded (invoicing periods, budget
    // windows, the three-way reconciliation job in plan 10).
    index('usage_ledger_org_occurred_at_idx').on(t.organizationId, t.occurredAt),
    check('usage_ledger_category_check', oneOf('category', USAGE_CATEGORIES)),
  ],
);

const COMPLETION_STATES = ['claimed', 'completed'] as const;
const OUTBOX_STATES = ['pending', 'published'] as const;

/**
 * ADR-0025's one authoritative accounting row per run. Reservations and usage
 * settle under the row lock; Redis is only a hot mirror of these values.
 */
export const runCreditAccounts = pgTable(
  'run_credit_accounts',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => agentRuns.id),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    baseCeiling: numeric('base_ceiling', { precision: 12, scale: 4 }).notNull(),
    pricingVersion: text('pricing_version').notNull(),
    pricingSnapshotJson: jsonb('pricing_snapshot_json').notNull(),
    usedCredits: numeric('used_credits', { precision: 12, scale: 4 }).notNull().default('0'),
    reservedCredits: numeric('reserved_credits', { precision: 12, scale: 4 })
      .notNull()
      .default('0'),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('run_credit_accounts_org_idx').on(t.organizationId)],
);

/**
 * Replay journal for one stable model completion identity. The neutral response
 * and terminal outcome are immutable after `state = completed`.
 */
export const modelCompletionJournal = pgTable(
  'model_completion_journal',
  {
    completionId: text('completion_id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id),
    taskId: text('task_id').references(() => agentTasks.id),
    requestFingerprint: text('request_fingerprint').notNull(),
    claimOwner: text('claim_owner'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    reservedCredits: numeric('reserved_credits', { precision: 12, scale: 4 }).notNull(),
    state: text('state', { enum: COMPLETION_STATES }).notNull(),
    responseJson: jsonb('response_json'),
    terminalJson: jsonb('terminal_json'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('model_completion_journal_state_check', oneOf('state', COMPLETION_STATES)),
    index('model_completion_journal_run_idx').on(t.runId),
    projectTenantForeignKey('model_completion_journal', t.projectId, t.organizationId),
  ],
);

/** Append-only approval-backed absolute ceiling history. */
export const runCreditCeilingAdjustments = pgTable(
  'run_credit_ceiling_adjustments',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id),
    approvalId: text('approval_id')
      .notNull()
      .references(() => approvals.id),
    operationKey: text('operation_key').notNull(),
    absoluteCeiling: numeric('absolute_ceiling', { precision: 12, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('run_credit_ceiling_adjustments_operation_idx').on(t.runId, t.operationKey),
    index('run_credit_ceiling_adjustments_run_created_idx').on(t.runId, t.createdAt),
  ],
);

/** One transactional delivery record per immutable ledger row. */
export const usageOutbox = pgTable(
  'usage_outbox',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    ledgerRowId: text('ledger_row_id')
      .notNull()
      .references(() => usageLedger.id),
    eventJson: jsonb('event_json').notNull(),
    status: text('status', { enum: OUTBOX_STATES }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('usage_outbox_ledger_row_idx').on(t.ledgerRowId),
    index('usage_outbox_pending_idx').on(t.status, t.nextAttemptAt),
    check('usage_outbox_status_check', oneOf('status', OUTBOX_STATES)),
  ],
);

/** Database lease that makes reconciliation single-leader across replicas. */
export const accountingLeaderLeases = pgTable('accounting_leader_leases', {
  name: text('name').primaryKey(),
  owner: text('owner').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  cursorRunId: text('cursor_run_id'),
});

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type UsageLedgerEntry = typeof usageLedger.$inferSelect;
export type NewUsageLedgerEntry = typeof usageLedger.$inferInsert;
export type RunCreditAccount = typeof runCreditAccounts.$inferSelect;
export type ModelCompletionJournal = typeof modelCompletionJournal.$inferSelect;
export type RunCreditCeilingAdjustment = typeof runCreditCeilingAdjustments.$inferSelect;
export type UsageOutboxEntry = typeof usageOutbox.$inferSelect;
export type AccountingLeaderLease = typeof accountingLeaderLeases.$inferSelect;
