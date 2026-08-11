import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

const migrationSql = readFileSync(
  new URL('../../drizzle/0023_premium_arclight.sql', import.meta.url),
  'utf8',
);

describe.skipIf(!hasDatabase)('OPS-2-FIX-1 migration', () => {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await setUpTestDatabase();
  });

  afterAll(async () => {
    await database?.close();
  });

  it('backfills a previously delivered correction before installing the confirmed-state check', async () => {
    if (database === undefined) throw new Error('test database was not initialized');
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(
        (statement) =>
          statement.includes('usage_reconciliation_corrections_status_check') ||
          statement.startsWith('UPDATE "usage_reconciliation_corrections"'),
      );
    expect(statements).toHaveLength(3);

    await database.sql.begin(async (tx) => {
      await tx.unsafe('set local search_path = pg_temp');
      await tx.unsafe(`
        create temporary table usage_reconciliation_corrections (
          status text not null,
          constraint usage_reconciliation_corrections_status_check
            check (status in ('pending', 'delivered'))
        )
      `);
      await tx.unsafe(
        `insert into usage_reconciliation_corrections (status) values ('delivered')`,
      );
      for (const statement of statements) await tx.unsafe(statement);
      const rows = await tx<{ status: string }[]>`
        select status from usage_reconciliation_corrections
      `;
      expect(rows).toEqual([{ status: 'pending' }]);
      const [constraint] = await tx<{ definition: string }[]>`
        select pg_get_constraintdef(oid) as definition
          from pg_constraint
         where conname = 'usage_reconciliation_corrections_status_check'
           and conrelid = 'usage_reconciliation_corrections'::regclass
      `;
      expect(constraint?.definition).toContain("'confirmed'");
      expect(constraint?.definition).not.toContain("'delivered'");
    });
  });
});
