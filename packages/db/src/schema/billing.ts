import { check, index, numeric, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { oneOf } from './columns.js';
import { organizations } from './identity.js';

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

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type UsageLedgerEntry = typeof usageLedger.$inferSelect;
export type NewUsageLedgerEntry = typeof usageLedger.$inferInsert;
