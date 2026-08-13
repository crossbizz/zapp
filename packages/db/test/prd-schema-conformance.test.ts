import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../src/schema/index.js';
import { columnNames, tableName } from './table-config.js';

/**
 * The PRD is the schema's specification, so this test reads it rather than
 * restating it: it parses §23 out of `docs/zapp-build-prd.md` and diffs every
 * table and column against the Drizzle definitions.
 *
 * The per-module suites pin what the schema *is*, in literals a reviewer can
 * read. This one pins that it still matches what the PRD *says* — and it fails
 * in both directions, so a PRD edit that nobody implemented is as loud as a
 * column somebody renamed. Written after a one-off script found 0 mismatches
 * during FND-6; a claim that only holds the day it was checked is not a claim.
 */

const PRD_PATH = fileURLToPath(new URL('../../../docs/zapp-build-prd.md', import.meta.url));

/**
 * The one documented deviation. The PRD's §23 model is conceptual ("physical
 * schema may split large event and artifact tables"), and PRD §22.3 requires
 * every control-plane query to be organization-scoped, so each tenant-owned
 * table carries a denormalized `organization_id` directly after `id` — the
 * position the PRD itself uses on the tables that declare one.
 */
const TENANT_COLUMN = 'organization_id';

/** Tables that exist for mechanism rather than for the model; each needs a reason. */
const NON_PRD_TABLES = new Map([
  [
    'run_event_counters',
    'the gapless allocator behind agent_events.sequence (plan 01 FND-6); no PRD row of its own',
  ],
  [
    'secret_ciphertexts',
    'the vault behind secret_metadata.encrypted_value_ref (PRD §18.12, plan 02 CP-7): §23.6 says the ciphertext is held elsewhere, and this is elsewhere — kept off secret_metadata so the metadata read has no value column to leak',
  ],
  [
    'preview_shares',
    'tenant-owned hashed preview bearer metadata and revocation state required by ADR-0023 and plan 03 WS-12; the PRD predates zapp-owned preview ingress',
  ],
  [
    'run_credit_accounts',
    'the authoritative per-run reservation and running-total account required by ADR-0025 and plan 10 OPS-1A; the PRD predates durable model-completion accounting',
  ],
  [
    'model_completion_journal',
    'the durable idempotent claim and completion replay journal required by ADR-0025 and plan 10 OPS-1A; the PRD models runs rather than provider-call attempts',
  ],
  [
    'run_credit_ceiling_adjustments',
    'the append-only approval-backed ceiling adjustment history required by ADR-0025 and plan 10 OPS-1A; the PRD has no physical reservation model',
  ],
  [
    'usage_outbox',
    'the transactional delivery record that couples usage ledger rows to SQS without a database-to-queue loss window, required by plan 10 OPS-1A',
  ],
  [
    'accounting_leader_leases',
    'the database lease that makes active-run credit reconciliation single-leader and bounded as required by plan 10 OPS-1A',
  ],
  [
    'credit_exhaustion_episodes',
    'durable per-organization exhaustion operation identity and bounded delivery cursor required by plan 10 OPS-3-FIX-1',
  ],
  [
    'desktop_local_agent_sessions',
    'the tenant/user-scoped bridge from a desktop-local transcript to server-owned project, run, task, and accounting identities required by plan 09 MAC-6',
  ],
  [
    'activity_idempotency',
    'the durable Temporal activity claim, lease, result hash, and replay record required by plan 04 AR-9; it is worker-delivery mechanism rather than a PRD domain row',
  ],
  [
    'github_webhook_deliveries',
    'the durable signature-free delivery receipt and SQS outbox required by plan 06 INT-1 and ADR-0028',
  ],
  [
    'github_imports',
    'the one-row-per-project durable GitHub import state machine required by plan 06 INT-2 and ADR-0028',
  ],
  [
    'github_import_outbox',
    'the transactional one-stage-per-delivery SQS outbox required by plan 06 INT-2 and ADR-0028',
  ],
  [
    'sandbox_snapshot_measurements',
    'the durable logical-byte inventory captured at snapshot creation because Modal 0.9.0 exposes no authoritative snapshot size API, required by ADR-0030 and plan 10 OPS-2',
  ],
  [
    'usage_reconciliation_corrections',
    'the idempotent durable Flexprice correction journal required by plan 10 OPS-2 so reconciliation retries cannot double-adjust vendor aggregates',
  ],
  [
    'trial_credit_grants',
    'the durable organization trial delivery journal and structural per-user abuse guard required by plan 10 OPS-5',
  ],
  [
    'incidents',
    'the durable production-error to AR-19 Fix-run and resolving-release linkage required by PRD §29.4 and plan 10 OPS-11',
  ],
  [
    'project_deletions',
    'the durable cross-store deletion state and post-project polling proof required by PRD §31.4 and plan 02 CP-17',
  ],
  [
    'artifact_retention',
    'the closed expirable-artifact classification required by ADR-0031 and plan 02 CP-17 so release evidence cannot be selected by a name heuristic',
  ],
  [
    'deployment_events',
    'the append-only eight-stage replay and terminal-success projection required by plan 07 DEP-14',
  ],
  [
    'deployment_action_requests',
    'the durable idempotency claim for safe readiness and deployment actions required by plan 07 DEP-14',
  ],
  [
    'environment_domains',
    'the provider-neutral DNS and managed-SSL verification state required by plan 07 DEP-10 and exposed by DEP-14',
  ],
  [
    'production_health_results',
    'append-only production health evidence history required by plan 07 DEP-15',
  ],
  [
    'synthetic_check_results',
    'immutable per-run synthetic result history and retention evidence required by plan 07 DEP-11 and exposed by DEP-15',
  ],
  [
    'release_annotations',
    'durable Grafana/PostHog monitoring annotation links required by plan 07 DEP-8 and exposed by DEP-15',
  ],
]);

/**
 * Columns the schema carries that PRD §23 does not list, keyed `table.column`.
 *
 * Same contract as {@link NON_PRD_TABLES}: a deviation is allowed to exist, but
 * only in writing. The PRD is not edited to match the implementation — it
 * records what the product must do, and an implementation detail it predates is
 * this file's problem to declare, not the PRD's to absorb. Anything not listed
 * here fails the diff, which is what keeps the list from becoming a rubber
 * stamp.
 */
const NON_PRD_COLUMNS = new Map([
  [
    'agent_runs.plan_max_credits',
    'immutable resolved plan ceiling required by plan 10 OPS-3-FIX-1 so retries, continuation, and approvals cannot drift after a plan change',
  ],
  [
    'users.external_id',
    'platform identity link (Stytch member id); PRD §23.1 predates the identity-provider decision (ADR-0001)',
  ],
  [
    'organizations.settings_json',
    'durable organization settings for CP-12 and its configurable deploy policy; accepted physical-schema extension in ADR-0004',
  ],
  [
    'organizations.deletion_requested_at',
    'durable organization deletion fence required by plan 02 CP-17 so a concurrent project create cannot enter after cascade enumeration',
  ],
  [
    'usage_ledger.operation_key',
    'caller-supplied stable operation identity required by plan 10 OPS-1B so an append retry returns its original immutable ledger row and outbox event',
  ],
  [
    'usage_ledger.metadata',
    'correction_of metadata required by plan 10 OPS-1B to make negative compensating ledger entries traceable without ever mutating the original row',
  ],
  [
    'secret_metadata.key_version',
    'which master-key generation wrapped this secret’s data key (PRD §18.12, plan 02 CP-7); metadata rather than key material, and what a re-encrypt sweep is planned from',
  ],
  [
    'secret_metadata.created_at',
    'when the secret was first set; PRD §23.6 lists rotated_at but no creation time, and the metadata read (PRD §32.5) answers both halves of the question',
  ],
  [
    'repositories.provisioned_at',
    'null while only the repository *record* exists, set when the internal Git instance confirms; lets plan 06 GIT-2 tell a row it must still provision from one it must not create twice (plan 02 CP-6 review)',
  ],
  ...[
    'run_id',
    'task_id',
    'purpose',
    'environment',
    'image_tag',
    'preview_monitor_enabled',
    'preview_monitor_owner_id',
    'preview_monitor_lease_expires_at',
  ].map(
    (column) =>
      [
        `workspaces.${column}`,
        'durable Modal attachment attribution and single-owner preview failure observation required by plan 03 WS-13',
      ] as const,
  ),
  ...[
    'usage_operation_key',
    'usage_last_sample_at',
    'usage_last_cpu_micros',
    'usage_cpu_seconds',
    'usage_memory_gib_seconds',
    'usage_cpu_second_usd',
    'usage_memory_gib_second_usd',
    'usage_credits_per_usd',
    'usage_finalized_at',
    'usage_cpu_delivered_at',
    'usage_memory_delivered_at',
  ].map(
    (column) =>
      [
        `workspaces.${column}`,
        'durable provider sampling, finalization, and per-category delivery state required by plan 10 OPS-2 so CPU/memory metering survives sandbox-service restarts',
      ] as const,
  ),
  [
    'agent_events.project_id',
    'PRD §14.4 replay contract carries projectId; CP-13 persists it for tenant/project validation and complete event replay although conceptual §23.4 omits it',
  ],
  [
    'agent_events.phase_id',
    'PRD §14.4 replay contract carries optional phaseId; CP-13 persists the top-level event context rather than hiding it in payload_json',
  ],
  [
    'agent_events.task_id',
    'PRD §14.4 replay contract carries optional taskId; CP-13 persists the top-level event context rather than hiding it in payload_json',
  ],
  [
    'agent_events.agent_id',
    'PRD §14.4 replay contract carries optional agentId role; CP-13 persists the top-level event context rather than hiding it in payload_json',
  ],
]);

/** `#### \`table\`` followed by a `- \`column\`` list, which is how PRD §23 is written. */
function parsePrdSection(markdown: string): Map<string, string[]> {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## 23. Data model');
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## 24.'));
  if (start === -1 || end === -1) {
    throw new Error('could not find PRD §23 — has the data model section been renumbered?');
  }

  const tables = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(start, end)) {
    const table = /^#### `([a-z_]+)`\s*$/.exec(line);
    if (table?.[1] !== undefined) {
      current = [];
      tables.set(table[1], current);
      continue;
    }
    const column = /^- `([a-z_]+)`\s*$/.exec(line);
    if (column?.[1] !== undefined && current !== undefined) {
      current.push(column[1]);
    }
  }
  return tables;
}

const prdTables = parsePrdSection(readFileSync(PRD_PATH, 'utf8'));

const implemented = new Map(
  Object.values(schema)
    .filter((value) => is(value, PgTable))
    .map((table) => [tableName(table), columnNames(table)] as const),
);

describe('PRD §23 conformance', () => {
  it('parses a data model out of the PRD at all', () => {
    // Guards the test itself: a PRD reformat that stops matching the parser
    // would otherwise turn every assertion below into a silent pass.
    expect(prdTables.size).toBe(28);
    expect(prdTables.get('projects')).toContain('support_level');
    expect(prdTables.get('agent_runs')).toContain('request_fingerprint');
    expect([...prdTables.values()].every((columns) => columns.length > 0)).toBe(true);
  });

  it('implements every table the PRD models, and no undocumented extras', () => {
    const missing = [...prdTables.keys()].filter((table) => !implemented.has(table));
    expect(missing).toEqual([]);

    const extra = [...implemented.keys()].filter(
      (table) => !prdTables.has(table) && !NON_PRD_TABLES.has(table),
    );
    expect(extra).toEqual([]);
    // Every non-PRD table carries a written reason, so the next reader does not
    // have to guess whether it was deliberate.
    for (const [table, reason] of NON_PRD_TABLES) {
      expect(implemented.has(table)).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('declares each non-PRD column against a table and column that exist', () => {
    // An allowlist entry that no longer matches anything is how a stale
    // exemption survives a rename and quietly widens the hole it was cut for.
    for (const [key, reason] of NON_PRD_COLUMNS) {
      const [table, column] = key.split('.');
      expect(implemented.get(table ?? '')).toContain(column);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it.each([...prdTables.keys()].map((table) => [table]))(
    '%s has exactly the PRD columns, in PRD order',
    (table) => {
      const prdColumns = prdTables.get(table) ?? [];
      const actual = implemented.get(table) ?? [];

      // Drop the denormalized tenant column only where the PRD does not list it;
      // where the PRD *does* list it, position and all, it must still line up.
      const declaresTenantColumn = prdColumns.includes(TENANT_COLUMN);
      const compared = actual.filter(
        (column) =>
          !(column === TENANT_COLUMN && !declaresTenantColumn) &&
          !NON_PRD_COLUMNS.has(`${table}.${column}`),
      );

      expect(compared).toEqual(prdColumns);

      if (!declaresTenantColumn && actual.includes(TENANT_COLUMN)) {
        // …and when it was added, it went directly after `id`.
        expect(actual.slice(0, 2)).toEqual(['id', TENANT_COLUMN]);
      }
    },
  );
});
