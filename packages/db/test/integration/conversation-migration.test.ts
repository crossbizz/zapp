import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

const migrationSql = readFileSync(
  new URL('../../drizzle/0036_rich_naoko.sql', import.meta.url),
  'utf8',
);

describe.skipIf(!hasDatabase)('CP-28 legacy conversation migration', () => {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await setUpTestDatabase();
  });

  afterAll(async () => {
    await database?.close();
  });

  it('backfills one deterministic conversation per run without changing dependent counts', async () => {
    if (database === undefined) throw new Error('test database was not initialized');
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(
        (statement) =>
          statement.startsWith('CREATE TABLE "conversations"') ||
          statement.startsWith('ALTER TABLE "agent_runs" ADD COLUMN') ||
          statement.startsWith('INSERT INTO "conversations"') ||
          statement.startsWith('UPDATE "agent_runs"') ||
          statement.startsWith('ALTER TABLE "agent_runs" ALTER COLUMN'),
      );
    expect(statements).toHaveLength(7);

    await database.sql.begin(async (tx) => {
      await tx.unsafe('set local search_path = pg_temp');
      await tx.unsafe(`
        create temporary table agent_runs (
          id text primary key,
          organization_id text not null,
          project_id text not null,
          started_by text not null,
          status text not null,
          started_at timestamptz not null,
          completed_at timestamptz
        )
      `);
      await tx.unsafe(`
        create temporary table agent_events (
          id text primary key,
          run_id text not null,
          sequence integer not null,
          type text not null,
          payload_json jsonb not null
        )
      `);
      await tx.unsafe(`
        create temporary table run_credit_accounts (
          run_id text primary key,
          used_credits numeric not null
        )
      `);
      await tx.unsafe(`
        insert into agent_runs
          (id, organization_id, project_id, started_by, status, started_at, completed_at)
        values
          ('run_01J8ME7YQZJ2V9Q0X3T5B6K7N9', 'org_legacy', 'proj_legacy', 'user_legacy', 'completed', '2026-08-15T10:00:00Z', '2026-08-15T10:01:00Z'),
          ('run_01J8ME7YQZJ2V9Q0X3T5B6K7NA', 'org_legacy', 'proj_legacy', 'user_legacy', 'failed', '2026-08-15T11:00:00Z', null)
      `);
      await tx.unsafe(`
        insert into agent_events (id, run_id, sequence, type, payload_json) values
          ('evt_1', 'run_01J8ME7YQZJ2V9Q0X3T5B6K7N9', 1, 'message.user', '{"content":"Repair the checkout history"}'),
          ('evt_2', 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NA', 1, 'run.created', '{}')
      `);
      await tx.unsafe(`
        insert into run_credit_accounts (run_id, used_credits) values
          ('run_01J8ME7YQZJ2V9Q0X3T5B6K7N9', 2),
          ('run_01J8ME7YQZJ2V9Q0X3T5B6K7NA', 3)
      `);
      const [before] = await tx<{ runs: number; events: number; accounts: number }[]>`
        select
          (select count(*)::int from agent_runs) as runs,
          (select count(*)::int from agent_events) as events,
          (select count(*)::int from run_credit_accounts) as accounts
      `;
      for (const statement of statements) await tx.unsafe(statement);

      const runs = await tx<{
        id: string;
        conversationId: string;
        conversationRunNumber: number;
      }[]>`
        select id,
               conversation_id as "conversationId",
               conversation_run_number as "conversationRunNumber"
          from agent_runs
         order by id
      `;
      expect(runs).toEqual([
        {
          id: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
          conversationId: 'conv_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
          conversationRunNumber: 1,
        },
        {
          id: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
          conversationId: 'conv_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
          conversationRunNumber: 1,
        },
      ]);
      const conversations = await tx<{ id: string; title: string }[]>`
        select id, title from conversations order by id
      `;
      expect(conversations).toEqual([
        {
          id: 'conv_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
          title: 'Repair the checkout history',
        },
        {
          id: 'conv_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
          title: 'Conversation T5B6K7NA',
        },
      ]);
      const [after] = await tx<{ runs: number; events: number; accounts: number }[]>`
        select
          (select count(*)::int from agent_runs) as runs,
          (select count(*)::int from agent_events) as events,
          (select count(*)::int from run_credit_accounts) as accounts
      `;
      expect(after).toEqual(before);
    });
  });
});
