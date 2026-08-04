import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { newId } from '@zapp/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

/**
 * `packages/db/drizzle/0003_append_only_usage_and_audit.sql` and its successor
 * `0004_append_only_truncate_and_app_role.sql` — the grants the CP-1 review
 * deferred, verified against a real PostgreSQL rather than by reading the SQL.
 *
 * They live in this service's suite rather than `@zapp/db`'s because CP-2 owns
 * the migrations and `packages/db/test/` belongs to FND-6; the subject is the
 * migration, not this service.
 *
 * Two mechanisms, so two halves to prove, both landing on SQLSTATE 42501:
 *
 *   - the trigger, which stops UPDATE and DELETE for *every* role including the
 *     superuser this suite connects as; and
 *   - the REVOKE, which additionally stops TRUNCATE, but only for a role that
 *     does not own the table — so proving it needs a role built for the purpose,
 *     because a superuser bypasses privilege checks entirely.
 */

const LEDGERS = ['usage_ledger', 'audit_events'] as const;

/** An unprivileged stand-in for the role the API connects as in staging and production. */
const PROBE_ROLE = 'zapp_append_only_probe';

const REVOKE_MIGRATION = fileURLToPath(
  new URL(
    '../../../../packages/db/drizzle/0004_append_only_truncate_and_app_role.sql',
    import.meta.url,
  ),
);

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
  let organizationId = '';

  beforeAll(async () => {
    database = await setUpTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  /** Seeds one row in each ledger. {@link afterEach} takes them back out. */
  async function seed(): Promise<void> {
    organizationId = newId('org');
    await database.sql`
      insert into organizations (id, name, slug) values (${organizationId}, 'Ledger', ${organizationId})
    `;
    // `usage_ledger.id` doubles as the Flexprice ingestion event id and carries
    // no TypeID prefix of its own (packages/db/src/schema/billing.ts).
    await database.sql`
      insert into usage_ledger (id, organization_id, category, quantity, unit, cost_usd, credits_charged, occurred_at)
      values (${`usage-${organizationId}`}, ${organizationId}, 'model_input_tokens', 1000, 'tokens', 0.01, 1, now())
    `;
    await database.sql`
      insert into audit_events (id, organization_id, actor_type, actor_id, action, target_type, metadata_json, occurred_at)
      values (${newId('aud')}, ${organizationId}, 'user', 'user_test', 'ledger.test', 'organization', '{}'::jsonb, now())
    `;
  }

  afterEach(async () => {
    if (organizationId === '') {
      return;
    }
    // Cleanup has to go around the trigger, which is the point of it: a
    // deliberate maintenance operation, spelled out, inside a transaction. It
    // needs table ownership — exactly the privilege boundary the migration
    // relies on.
    await database.sql.begin(async (tx) => {
      for (const table of LEDGERS) {
        await tx.unsafe(`alter table ${table} disable trigger ${table}_append_only`);
        await tx.unsafe(`delete from ${table} where organization_id = '${organizationId}'`);
        await tx.unsafe(`alter table ${table} enable trigger ${table}_append_only`);
      }
      await tx.unsafe(`delete from organizations where id = '${organizationId}'`);
    });
    organizationId = '';
  });

  it('carries a statement-level trigger over update and delete', async () => {
    const triggers = await database.sql<{ table: string; definition: string }[]>`
      select relation.relname as table, pg_get_triggerdef(trigger.oid) as definition
        from pg_trigger trigger
        join pg_class relation on relation.oid = trigger.tgrelid
       where trigger.tgname like '%\\_append\\_only'
         and not trigger.tgisinternal
    `;

    expect(triggers.map((row) => row.table).sort()).toEqual([...LEDGERS].sort());
    for (const trigger of triggers) {
      expect(trigger.definition, trigger.table).toContain('BEFORE DELETE OR UPDATE');
      expect(trigger.definition, trigger.table).toContain('FOR EACH STATEMENT');
    }
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

  it('denies the application role UPDATE, DELETE and TRUNCATE alike', async (ctx) => {
    // The REVOKE half, which is the only thing standing between a compromised
    // API and a wiped ledger — and which is a no-op for the superuser this
    // suite connects as. So the production topology gets built here: an
    // unprivileged role, granted everything an application role could want, and
    // then the *shipped migration* pointed at it. Nothing is simulated; the SQL
    // under test is the file that ships.
    const created = await database.sql
      .unsafe(`create role ${PROBE_ROLE}`)
      .then(() => true)
      .catch(() => false);
    if (!created) {
      // Only reachable on a database whose login role cannot create roles.
      console.warn(`[@zapp/control-api] REVOKE test skipped: cannot create ${PROBE_ROLE}`);
      ctx.skip();
      return;
    }

    try {
      const tables = LEDGERS.join(', ');
      await database.sql.unsafe(
        `grant select, insert, update, delete, truncate on ${tables} to ${PROBE_ROLE}`,
      );

      const statements = readFileSync(REVOKE_MIGRATION, 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement !== '');
      await database.sql.begin(async (tx) => {
        // `set local`, inside the transaction the DO block reads it from.
        await tx.unsafe(`set local zapp.app_role = '${PROBE_ROLE}'`);
        for (const statement of statements) {
          await tx.unsafe(statement);
        }
      });

      for (const table of LEDGERS) {
        // The privilege the ledger exists for survives…
        const [granted] = await database.sql<{ allowed: boolean }[]>`
          select has_table_privilege(${PROBE_ROLE}, ${table}, 'INSERT') as allowed
        `;
        expect(granted?.allowed, `${table} INSERT`).toBe(true);

        // …and the three that destroy evidence do not, in the catalog and in
        // practice.
        for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) {
          const [revoked] = await database.sql<{ allowed: boolean }[]>`
            select has_table_privilege(${PROBE_ROLE}, ${table}, ${privilege}) as allowed
          `;
          expect(revoked?.allowed, `${table} ${privilege}`).toBe(false);
        }

        for (const statement of [
          `update ${table} set organization_id = 'x'`,
          `delete from ${table}`,
          `truncate table ${table}`,
        ]) {
          const code = await sqlstate(
            database.sql.begin(async (tx) => {
              await tx.unsafe(`set local role ${PROBE_ROLE}`);
              await tx.unsafe(statement);
            }),
          );
          expect(code, statement).toBe('42501');
        }
      }
    } finally {
      await database.sql.unsafe(`drop owned by ${PROBE_ROLE}`);
      await database.sql.unsafe(`drop role ${PROBE_ROLE}`);
    }
  });

  it('still accepts the INSERT the ledger exists for', async () => {
    await seed();

    const [row] = await database.sql<{ count: string }[]>`
      select count(*)::text as count from usage_ledger where organization_id = ${organizationId}
    `;
    expect(row?.count).toBe('1');
  });
});
