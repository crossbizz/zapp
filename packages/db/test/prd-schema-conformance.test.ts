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
    'users.external_id',
    'platform identity link (Stytch member id); PRD §23.1 predates the identity-provider decision (ADR-0001)',
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
