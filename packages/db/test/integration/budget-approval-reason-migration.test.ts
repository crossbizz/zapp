import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

const migrationsDirectory = fileURLToPath(new URL('../../drizzle', import.meta.url));

function loadBackfillSql(): string {
  const migration = readdirSync(migrationsDirectory).find((file) =>
    file.endsWith('_budget_approval_reason_backfill.sql'),
  );
  if (migration === undefined) throw new Error('budget approval reason backfill migration is missing');
  return readFileSync(`${migrationsDirectory}/${migration}`, 'utf8');
}

describe.skipIf(!hasDatabase)('OPS-3-FIX-2 budget approval reason migration', () => {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await setUpTestDatabase();
  });

  afterAll(async () => {
    await database?.close();
  });

  it('backfills a missing legacy reason without replacing a persisted reason', async () => {
    if (database === undefined) throw new Error('test database was not initialized');
    const statement = loadBackfillSql()
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .find((part) => /^update "approvals"/iu.test(part));
    expect(statement).toBeDefined();
    if (statement === undefined) return;

    await database.sql.begin(async (tx) => {
      await tx.unsafe('set local search_path = pg_temp');
      await tx.unsafe(`
        create temporary table approvals (
          type text not null,
          request_json jsonb not null
        )
      `);
      await tx.unsafe(`
        insert into approvals (type, request_json) values
          ('budget_increase', '{"currentCeiling":"10.0000","absoluteCeiling":"20.0000","workspaceId":null}'),
          ('budget_increase', '{"currentCeiling":"10.0000","absoluteCeiling":"10.0000","workspaceId":null,"reason":"organization_credit_exhausted"}'),
          ('production_deploy', '{"releaseId":"rel_legacy"}')
      `);
      await tx.unsafe(statement);
      const rows = await tx<{ type: string; requestJson: Record<string, unknown> }[]>`
        select type, request_json as "requestJson"
          from approvals
         order by type, request_json->>'absoluteCeiling'
      `;
      expect(rows).toEqual([
        {
          type: 'budget_increase',
          requestJson: {
            currentCeiling: '10.0000',
            absoluteCeiling: '10.0000',
            workspaceId: null,
            reason: 'organization_credit_exhausted',
          },
        },
        {
          type: 'budget_increase',
          requestJson: {
            currentCeiling: '10.0000',
            absoluteCeiling: '20.0000',
            workspaceId: null,
            reason: 'run_budget_exhausted',
          },
        },
        { type: 'production_deploy', requestJson: { releaseId: 'rel_legacy' } },
      ]);
    });
  });
});
