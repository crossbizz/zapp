import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../src/schema/index.js';
import { tableName } from './table-config.js';

/**
 * The migrations are the schema's source of truth — the TypeScript tables only
 * describe what the SQL builds. These pins are database-free, so a table added
 * without a migration, or a hand-written migration lost to a regeneration,
 * fails in the `test` job rather than at the first deploy.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

const journal = JSON.parse(
  readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: { idx: number; tag: string; when: number }[] };

const files = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();

const allSql = files.map((file) => readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8')).join('\n');

const partitioningSql = readFileSync(
  new URL('../drizzle/0001_prd23_schema_and_event_partitioning.sql', import.meta.url),
  'utf8',
);
const planEnforcementSql = readFileSync(
  new URL('../drizzle/0026_cooing_hemingway.sql', import.meta.url),
  'utf8',
);

describe('migration journal', () => {
  it('lists every migration file, in order, exactly once', () => {
    expect(journal.entries.map((entry) => `${String(entry.idx).padStart(4, '0')}_`)).toEqual(
      files.map((file) => file.slice(0, 5)),
    );
    expect(journal.entries.map((entry) => `${entry.tag}.sql`)).toEqual(files);
    // The migrator applies in `when` order and skips what it has already run; a
    // migration dated before its predecessor would silently never apply.
    const timestamps = journal.entries.map((entry) => entry.when);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
  });

  it('creates every table the schema declares', () => {
    // Catches the common miss: a table added to src/schema without running
    // `pnpm db:generate`, which typechecks and unit-tests green and then fails
    // against a real database.
    const tables = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map(tableName);

    expect(tables.length).toBeGreaterThan(23);
    for (const table of tables) {
      expect(allSql).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it('adds durable organization settings without a backfill migration', () => {
    expect(allSql).toContain(
      `ALTER TABLE "organizations" ADD COLUMN "settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL`,
    );
  });

  it('creates the audit read indexes under the same names as the Drizzle schema', () => {
    // Break caught: a schema-only index passes unit types but never reaches a
    // deployed database, or a migration rename drifts from Drizzle tooling.
    for (const statement of [
      'CREATE INDEX "audit_events_org_id_idx" ON "audit_events" USING btree ("organization_id","id")',
      'CREATE INDEX "audit_events_org_actor_id_id_idx" ON "audit_events" USING btree ("organization_id","actor_id","id")',
      'CREATE INDEX "audit_events_org_action_id_idx" ON "audit_events" USING btree ("organization_id","action","id")',
      'CREATE INDEX "audit_events_org_target_id_idx" ON "audit_events" USING btree ("organization_id","target_type","target_id","id")',
    ]) {
      expect(allSql).toContain(statement);
    }
  });

  it('backfills immutable run caps from the organization plan before future plan changes', () => {
    expect(planEnforcementSql).toMatch(/update "agent_runs" as run/iu);
    expect(planEnforcementSql).toMatch(/when 'trial' then 10\.0000/iu);
    expect(planEnforcementSql).toMatch(/when 'builder' then 100\.0000/iu);
    expect(planEnforcementSql).toMatch(/when 'studio' then 1000\.0000/iu);
    expect(planEnforcementSql).toContain(
      'cannot backfill agent_runs.plan_max_credits for an unknown organization plan',
    );
    expect(planEnforcementSql).not.toMatch(/plan_max_credits[^;]*default/iu);
    expect(planEnforcementSql).not.toMatch(/else\s+\d/iu);
    expect(planEnforcementSql).toMatch(
      /alter table "agent_runs" alter column "plan_max_credits" set not null/iu,
    );
  });
});

describe('agent_events partitioning', () => {
  it('declares the parent as range-partitioned on occurred_at', () => {
    expect(partitioningSql).toContain('PARTITION BY RANGE ("occurred_at")');
    expect(partitioningSql).toContain(
      'CONSTRAINT "agent_events_pk" PRIMARY KEY("id","occurred_at")',
    );
    expect(partitioningSql).toContain('CHECK (pg_column_size(payload_json) <= 65536)');
  });

  it('seeds twelve months from the P0 launch month, and no more', () => {
    const seeded = [...partitioningSql.matchAll(/create_event_partition\('(\d{4}-\d{2})-01'\)/g)]
      .map((match) => match[1])
      .sort();

    expect(seeded).toEqual([
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
      '2027-03',
      '2027-04',
      '2027-05',
      '2027-06',
      '2027-07',
    ]);
  });

  it('ships the function the retention job extends the runway with', () => {
    // Plan 10 (OPS-14) owns the schedule; the SQL lives here so a database
    // restored from these migrations alone is already able to roll forward.
    expect(partitioningSql).toContain('CREATE FUNCTION create_next_partition()');
    expect(partitioningSql).toContain('CREATE FUNCTION create_event_partition(starts date)');
    // Every partition gets the per-partition unique index; the parent cannot
    // carry it, because a unique index there must include the partition key.
    expect(partitioningSql).toContain(
      "'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (run_id, sequence)'",
    );
  });

  it('pins month edges to UTC instead of the session time zone', () => {
    // A bare date in the bound would be cast to timestamptz with whatever
    // TimeZone the migration ran under (FND-6 review, minor 4).
    expect(partitioningSql).toContain("starts::timestamp AT TIME ZONE 'UTC'");
    expect(partitioningSql).toContain(
      "(starts + interval '1 month')::timestamp AT TIME ZONE 'UTC'",
    );
    // …and the same text is what 0002 replays onto databases that already
    // applied the earlier version, so the two cannot drift.
    const converge = readFileSync(
      new URL('../drizzle/0002_tenant_composite_fks_and_utc_bounds.sql', import.meta.url),
      'utf8',
    );
    expect(converge).toContain('CREATE OR REPLACE FUNCTION create_event_partition(starts date)');
    expect(converge).toContain("starts::timestamp AT TIME ZONE 'UTC'");
  });

  it('creates no DEFAULT partition', () => {
    // Deliberate: a row parked in a default partition would outlive its
    // retention window and stay invisible to the month-at-a-time archiver, so
    // an unpartitioned month has to fail loudly at insert time instead.
    expect(partitioningSql).not.toMatch(/DEFAULT\s*;/i);
    expect(partitioningSql.toLowerCase()).not.toContain('partition of agent_events default');
  });
});
