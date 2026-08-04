import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as db from '../src/index.js';
import { USAGE_CATEGORIES } from '../src/schema/billing.js';
import {
  memberships,
  organizations,
  subscriptions,
  usageLedger,
  users,
} from '../src/schema/index.js';

/**
 * These run without a database on purpose: the column names are the contract
 * PRD §23.1 fixes, and a rename must fail here — in the plain `test` run that
 * CI executes everywhere — rather than only where Postgres happens to exist.
 */

function columnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function indexNames(table: PgTable): (string | undefined)[] {
  return getTableConfig(table).indexes.map((index) => index.config.name);
}

/** Each foreign key rendered as `column -> table.column`. */
function foreignKeys(table: PgTable): string[] {
  return getTableConfig(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    const from = reference.columns.map((column) => column.name).join(', ');
    const to = reference.foreignColumns.map((column) => column.name).join(', ');
    return `${from} -> ${getTableConfig(reference.foreignTable).name}.${to}`;
  });
}

function sqlType(table: PgTable, columnName: string): string | undefined {
  return getTableConfig(table)
    .columns.find((column) => column.name === columnName)
    ?.getSQLType();
}

describe('identity tables', () => {
  it('names its tables as PRD §23.1 does', () => {
    expect([users, organizations, memberships].map((table) => getTableConfig(table).name)).toEqual([
      'users',
      'organizations',
      'memberships',
    ]);
  });

  it('gives users exactly the PRD §23.1 columns, in order', () => {
    expect(columnNames(users)).toEqual([
      'id',
      'email',
      'display_name',
      'avatar_url',
      'created_at',
      'last_seen_at',
    ]);
  });

  it('gives organizations exactly the PRD §23.1 columns, in order', () => {
    expect(columnNames(organizations)).toEqual([
      'id',
      'name',
      'slug',
      'plan',
      'billing_customer_id',
      'created_at',
    ]);
  });

  it('gives memberships exactly the PRD §23.1 columns, in order', () => {
    expect(columnNames(memberships)).toEqual([
      'organization_id',
      'user_id',
      'role',
      'status',
      'created_at',
    ]);
  });

  it('indexes the lookups the control plane makes', () => {
    expect(indexNames(users)).toEqual(['users_email_idx']);
    expect(indexNames(organizations)).toEqual(['organizations_slug_idx']);
    // The unique index is also what makes (organization, user) the membership's
    // identity — the table has no surrogate key.
    expect(indexNames(memberships)).toEqual(['memberships_org_user_idx', 'memberships_user_idx']);
  });

  it('points memberships at both parents', () => {
    expect(foreignKeys(memberships)).toEqual([
      'organization_id -> organizations.id',
      'user_id -> users.id',
    ]);
  });
});

describe('billing tables', () => {
  it('gives subscriptions exactly the PRD §23.1 columns, in order', () => {
    expect(columnNames(subscriptions)).toEqual([
      'id',
      'organization_id',
      'stripe_subscription_id',
      'plan_id',
      'status',
      'current_period_start',
      'current_period_end',
    ]);
  });

  it('gives usage_ledger exactly the PRD §23.1 columns, in order', () => {
    expect(columnNames(usageLedger)).toEqual([
      'id',
      'organization_id',
      'project_id',
      'run_id',
      'task_id',
      'category',
      'provider',
      'quantity',
      'unit',
      'cost_usd',
      'credits_charged',
      'occurred_at',
    ]);
  });

  it('keeps money and metered quantities in numeric, at the declared scale', () => {
    expect(sqlType(usageLedger, 'quantity')).toBe('numeric');
    expect(sqlType(usageLedger, 'cost_usd')).toBe('numeric(12, 6)');
    expect(sqlType(usageLedger, 'credits_charged')).toBe('numeric(12, 4)');
  });

  it('scopes every ledger read by organization and time', () => {
    expect(indexNames(usageLedger)).toEqual(['usage_ledger_org_occurred_at_idx']);
    expect(foreignKeys(usageLedger)).toEqual(['organization_id -> organizations.id']);
    // project/run/task attribution is deliberately unconstrained: those tables
    // arrive with FND-6, and a purge there must never orphan a billing row.
    expect(foreignKeys(subscriptions)).toEqual(['organization_id -> organizations.id']);
  });

  it('constrains the usage category in the database, not just in TypeScript', () => {
    expect(getTableConfig(usageLedger).checks.map((check) => check.name)).toEqual([
      'usage_ledger_category_check',
    ]);
  });

  it('enumerates exactly the plan 01 FND-5 usage categories, in order', () => {
    // Deliberately an untyped literal: a category dropped from both the const
    // and this list would otherwise slip through.
    expect(USAGE_CATEGORIES).toEqual([
      'model_input_tokens',
      'model_output_tokens',
      'model_cached_tokens',
      'sandbox_cpu_seconds',
      'sandbox_mem_gib_seconds',
      'storage_gib_hours',
      'deploy_provider',
      'artifact_storage',
    ]);
  });
});

describe('public surface', () => {
  it('exports no mutation helper that could rewrite the append-only ledger', () => {
    // usage_ledger corrections are compensating entries (plan 10 OPS-1), and
    // CP-1 revokes UPDATE/DELETE from the app role. Nothing here may offer one.
    expect(Object.keys(db).filter((name) => /update|delete|remove|truncate/i.test(name))).toEqual(
      [],
    );
  });

  it('exports every table through the barrel', () => {
    expect(Object.keys(db)).toEqual(
      expect.arrayContaining([
        'createDb',
        'users',
        'organizations',
        'memberships',
        'subscriptions',
        'usageLedger',
        'USAGE_CATEGORIES',
      ]),
    );
  });
});
