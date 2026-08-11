import { describe, expect, it } from 'vitest';

import * as db from '../src/index.js';
import { USAGE_CATEGORIES } from '../src/schema/billing.js';
import {
  agentEvents,
  agentPhases,
  agentRuns,
  agentTasks,
  approvals,
  artifacts,
  auditEvents,
  branches,
  decisions,
  deployments,
  environments,
  integrationConnections,
  memberships,
  organizations,
  projectContracts,
  projects,
  releases,
  repositories,
  modelCompletionJournal,
  runCreditAccounts,
  runCreditCeilingAdjustments,
  usageOutbox,
  accountingLeaderLeases,
  runEventCounters,
  secretMetadata,
  specifications,
  subscriptions,
  syntheticChecks,
  testCases,
  testRuns,
  usageLedger,
  users,
  verificationResults,
  workspaces,
} from '../src/schema/index.js';
import {
  checkNames,
  columnNames,
  foreignKeys,
  indexColumns,
  indexNames,
  requiredColumns,
  sqlType,
  tableName,
} from './table-config.js';

describe('identity tables', () => {
  it('names its tables as PRD §23.1 does', () => {
    expect([users, organizations, memberships].map(tableName)).toEqual([
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
      // Not a PRD column: the identity-provider link (ADR-0001), declared with
      // its reason in prd-schema-conformance.test.ts and last in the list
      // because that is where ALTER TABLE ... ADD COLUMN puts it.
      'external_id',
    ]);
  });

  it('gives organizations the PRD §23.1 columns plus ADR-0004 settings storage', () => {
    expect(columnNames(organizations)).toEqual([
      'id',
      'name',
      'slug',
      'plan',
      'billing_customer_id',
      'created_at',
      'settings_json',
    ]);
    expect(requiredColumns(organizations)).toContain('settings_json');
    expect(sqlType(organizations, 'settings_json')).toBe('jsonb');
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
    // The external id is unique only where it is set: two users may both be
    // unlinked, and that is not a duplicate.
    expect(indexNames(users)).toEqual(['users_email_idx', 'users_external_id_idx']);
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
      'operation_key',
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
      'metadata',
      'occurred_at',
    ]);
  });

  it('keeps money and metered quantities in numeric, at the declared scale', () => {
    expect(sqlType(usageLedger, 'quantity')).toBe('numeric');
    expect(sqlType(usageLedger, 'cost_usd')).toBe('numeric(12, 6)');
    expect(sqlType(usageLedger, 'credits_charged')).toBe('numeric(12, 4)');
  });

  it('scopes every ledger read by organization and time', () => {
    expect(indexNames(usageLedger)).toEqual([
      'usage_ledger_org_occurred_at_idx',
      'usage_ledger_operation_idx',
    ]);
    expect(foreignKeys(usageLedger)).toEqual(['organization_id -> organizations.id']);
    // project/run/task attribution is deliberately unconstrained: those tables
    // arrive with FND-6, and a purge there must never orphan a billing row.
    expect(foreignKeys(subscriptions)).toEqual(['organization_id -> organizations.id']);
  });

  it('constrains the usage category in the database, not just in TypeScript', () => {
    expect(checkNames(usageLedger)).toEqual(['usage_ledger_category_check']);
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

  it('defines the ADR-0025 authoritative completion-accounting tables', () => {
    expect(
      [
        runCreditAccounts,
        modelCompletionJournal,
        runCreditCeilingAdjustments,
        usageOutbox,
        accountingLeaderLeases,
      ].map(tableName),
    ).toEqual([
      'run_credit_accounts',
      'model_completion_journal',
      'run_credit_ceiling_adjustments',
      'usage_outbox',
      'accounting_leader_leases',
    ]);

    expect(columnNames(runCreditAccounts)).toEqual([
      'run_id',
      'organization_id',
      'base_ceiling',
      'pricing_version',
      'pricing_snapshot_json',
      'used_credits',
      'reserved_credits',
      'version',
      'updated_at',
    ]);
    expect(columnNames(modelCompletionJournal)).toEqual([
      'completion_id',
      'organization_id',
      'project_id',
      'run_id',
      'task_id',
      'request_fingerprint',
      'claim_owner',
      'claim_expires_at',
      'reserved_credits',
      'state',
      'response_json',
      'terminal_json',
      'created_at',
      'updated_at',
    ]);
    expect(columnNames(runCreditCeilingAdjustments)).toEqual([
      'id',
      'organization_id',
      'run_id',
      'approval_id',
      'operation_key',
      'absolute_ceiling',
      'created_at',
    ]);
    expect(columnNames(usageOutbox)).toEqual([
      'id',
      'organization_id',
      'ledger_row_id',
      'event_json',
      'status',
      'attempts',
      'next_attempt_at',
      'created_at',
      'published_at',
    ]);
    expect(columnNames(accountingLeaderLeases)).toEqual([
      'name',
      'owner',
      'expires_at',
      'cursor_run_id',
    ]);
  });
});

describe('audit read indexes', () => {
  it('covers tenant keysets and each supported equality filter before the id cursor', () => {
    // Break caught: the API query remains correct but every page or filtered
    // read degrades into a tenant-wide audit_events scan.
    expect(indexColumns(auditEvents)).toEqual({
      audit_events_org_occurred_at_idx: ['organization_id', 'occurred_at'],
      audit_events_org_id_idx: ['organization_id', 'id'],
      audit_events_org_actor_id_id_idx: ['organization_id', 'actor_id', 'id'],
      audit_events_org_action_id_idx: ['organization_id', 'action', 'id'],
      audit_events_org_target_id_idx: ['organization_id', 'target_type', 'target_id', 'id'],
    });
  });
});

/**
 * Every table the PRD models below identity and billing, in PRD order. The list
 * is the pin: a §23 table nobody implemented, or one implemented under a
 * different name, fails here.
 */
const TENANT_OWNED_TABLES = [
  // PRD §23.2
  projects,
  repositories,
  branches,
  environments,
  projectContracts,
  // PRD §23.3
  specifications,
  decisions,
  agentRuns,
  agentPhases,
  agentTasks,
  approvals,
  // PRD §23.4
  workspaces,
  agentEvents,
  artifacts,
  testRuns,
  testCases,
  verificationResults,
  // PRD §23.5
  releases,
  deployments,
  syntheticChecks,
  // PRD §23.6
  secretMetadata,
  integrationConnections,
  auditEvents,
];

describe('tenant scoping', () => {
  it('implements every PRD §23.2–23.6 table, named as the PRD names it', () => {
    expect(TENANT_OWNED_TABLES.map(tableName)).toEqual([
      'projects',
      'repositories',
      'branches',
      'environments',
      'project_contracts',
      'specifications',
      'decisions',
      'agent_runs',
      'agent_phases',
      'agent_tasks',
      'approvals',
      'workspaces',
      'agent_events',
      'artifacts',
      'test_runs',
      'test_cases',
      'verification_results',
      'releases',
      'deployments',
      'synthetic_checks',
      'secret_metadata',
      'integration_connections',
      'audit_events',
    ]);
  });

  it.each(TENANT_OWNED_TABLES.map((table) => [tableName(table), table] as const))(
    '%s carries organization_id right after id, with a real foreign key',
    (_name, table) => {
      // PRD §22.3: every control-plane query is organization-scoped, and
      // `forOrg` filters on this column directly rather than joining a chain of
      // parents it would then have to trust. The position is part of the
      // convention — the PRD itself puts it here on the tables that declare it.
      expect(columnNames(table).slice(0, 2)).toEqual(['id', 'organization_id']);
      expect(foreignKeys(table)).toContain('organization_id -> organizations.id');
      expect(requiredColumns(table)).toContain('organization_id');
    },
  );

  it.each(
    TENANT_OWNED_TABLES.filter((table) => columnNames(table).includes('project_id')).map(
      (table) => [tableName(table), table] as const,
    ),
  )('%s checks its tenant column against the project it names', (_name, table) => {
    // Without this composite key, `organization_id` is a copy nothing verifies:
    // one buggy writer pairs org A with org B's project, and every forOrg query
    // then returns it. With it, the mismatch is a foreign-key violation
    // (integration test: "refuses a child row whose tenant does not match…").
    expect(foreignKeys(table)).toContain(
      'project_id, organization_id -> projects.id, organization_id',
    );
  });

  it('has a unique index for those composite keys to target', () => {
    expect(indexNames(projects)).toContain('projects_id_org_idx');
  });

  it('names the tables whose tenant column is still unchecked', () => {
    // Honest inventory rather than a silent gap: these hang off a run, phase,
    // test run or release instead of a project, so the same pattern needs a
    // unique (id, organization_id) on each of those parents first. Additive
    // when someone does it — see the 0002 migration comment.
    const unchecked = TENANT_OWNED_TABLES.filter(
      // `projects` is the parent the composite keys point at, not a child.
      (table) => table !== projects && !columnNames(table).includes('project_id'),
    ).map(tableName);

    expect(unchecked).toEqual([
      'agent_phases',
      'agent_tasks',
      'approvals',
      'test_runs',
      'test_cases',
      'verification_results',
      'deployments',
      'audit_events',
    ]);
  });

  it('leaves the event sequence allocator out of it', () => {
    // run_event_counters is reached only through nextEventSequence(runId) and is
    // never listed, read or joined by tenant, so a tenant column would be dead
    // weight on the hottest write in the system.
    expect(columnNames(runEventCounters)).toEqual(['run_id', 'last_sequence']);
    expect(foreignKeys(runEventCounters)).toEqual(['run_id -> agent_runs.id']);
  });
});

describe('public surface', () => {
  it('exports no mutation-named helper (grants enforce append-only — CP-1)', () => {
    // usage_ledger, agent_events and audit_events are append-only: corrections
    // are compensating entries (plan 10 OPS-1) and retention drops partitions
    // rather than rows. This pin is a smoke alarm, not the enforcement — CP-1
    // revokes UPDATE/DELETE from the application role, and that is what binds.
    expect(Object.keys(db).filter((name) => /update|delete|remove|truncate/i.test(name))).toEqual(
      [],
    );
  });

  it('exports every table through the barrel', () => {
    const exported = Object.keys(db);
    expect(exported).toEqual(
      expect.arrayContaining([
        'createDb',
        'forOrg',
        'nextEventSequence',
        'users',
        'organizations',
        'memberships',
        'subscriptions',
        'usageLedger',
        'USAGE_CATEGORIES',
        'runEventCounters',
        'MAX_EVENT_PAYLOAD_BYTES',
      ]),
    );
    // Every PRD §23 table reaches consumers by its camelCase export, so a table
    // added to the schema but not to the barrel fails here rather than at the
    // first import in plan 02.
    for (const table of TENANT_OWNED_TABLES) {
      const exportName = tableName(table).replace(/_(.)/g, (_match, letter: string) =>
        letter.toUpperCase(),
      );
      expect(exported).toContain(exportName);
    }
  });
});
