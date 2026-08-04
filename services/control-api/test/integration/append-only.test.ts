import { newId } from '@zapp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

/**
 * `packages/db/drizzle/0003_append_only_usage_and_audit.sql` — the grants the
 * CP-1 review deferred, verified against a real PostgreSQL rather than by
 * reading the SQL.
 *
 * It lives in this service's suite rather than `@zapp/db`'s because CP-2 owns
 * the migration and `packages/db/test/` belongs to FND-6; the subject is the
 * migration, not this service.
 *
 * What is asserted is the *property* (an UPDATE or a DELETE fails with
 * `insufficient_privilege`), not the mechanism. Locally and in CI the
 * connection role is a superuser and only the trigger can stop it; in staging
 * and production the REVOKE stops it before the trigger is reached. Both
 * produce SQLSTATE 42501, which is why the property is stated that way.
 */

const LEDGERS = ['usage_ledger', 'audit_events'] as const;

async function sqlstate(query: Promise<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    // Drizzle wraps failures; raw `sql` throws the driver error directly, and
    // the SQLSTATE lives on whichever of the two is underneath.
    const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' ? code : '';
  }
  throw new Error('expected the statement to be rejected, but it succeeded');
}

describe.skipIf(!hasDatabase)('append-only ledgers', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await setUpTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  it('carries the statement-level trigger on both ledgers', async () => {
    const triggers = await database.sql<{ tgrelid: string }[]>`
      select relation.relname as tgrelid
        from pg_trigger trigger
        join pg_class relation on relation.oid = trigger.tgrelid
       where trigger.tgname like '%_append_only'
         and not trigger.tgisinternal
    `;

    expect(triggers.map((row) => row.tgrelid).sort()).toEqual([...LEDGERS].sort());
  });

  for (const table of LEDGERS) {
    it(`refuses an UPDATE on ${table}`, async () => {
      expect(await sqlstate(database.sql.unsafe(`update ${table} set organization_id = 'x'`))).toBe(
        '42501',
      );
    });

    it(`refuses a DELETE on ${table}`, async () => {
      expect(await sqlstate(database.sql.unsafe(`delete from ${table}`))).toBe('42501');
    });
  }

  it('still accepts the INSERT the ledger exists for', async () => {
    const organizationId = newId('org');
    await database.sql`
      insert into organizations (id, name, slug) values (${organizationId}, 'Ledger', ${organizationId})
    `;
    // `usage_ledger.id` doubles as the Flexprice ingestion event id and carries
    // no TypeID prefix of its own (packages/db/src/schema/billing.ts).
    await database.sql`
      insert into usage_ledger (id, organization_id, category, quantity, unit, cost_usd, credits_charged, occurred_at)
      values (${`usage-${organizationId}`}, ${organizationId}, 'model_input_tokens', 1000, 'tokens', 0.01, 1, now())
    `;

    const [row] = await database.sql<{ count: string }[]>`
      select count(*)::text as count from usage_ledger where organization_id = ${organizationId}
    `;
    expect(row?.count).toBe('1');

    // Cleanup has to go around the trigger, which is the point of it: a
    // deliberate maintenance operation, spelled out, inside a transaction.
    await database.sql.begin(async (tx) => {
      await tx.unsafe('alter table usage_ledger disable trigger usage_ledger_append_only');
      await tx.unsafe(`delete from usage_ledger where organization_id = '${organizationId}'`);
      await tx.unsafe('alter table usage_ledger enable trigger usage_ledger_append_only');
      await tx.unsafe(`delete from organizations where id = '${organizationId}'`);
    });
  });
});
