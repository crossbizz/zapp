import { fileURLToPath } from 'node:url';

import { createDb, type Db } from '@zapp/db';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { credentialGate } from '../support/credentials.js';

/**
 * The database rail for this service's integration suites.
 *
 * Same two rules as `@zapp/db`'s own harness, and deliberately a separate copy
 * of them: that file lives in another package's `test/` tree, which is not
 * exported and not on this package's TypeScript path. The rules matter more
 * than the duplication —
 *
 * 1. Never touch the database `DATABASE_URL` points at. Derive `${name}_test`,
 *    create it if missing, work there.
 * 2. Never truncate anything whose name does not end in `_test`.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? '';

/**
 * Env-gated on the FND-7 dev stack: with no `DATABASE_URL`, suites skip — never
 * pass.
 *
 * Through `credentialGate` rather than `!== ''` so that one rule decides what
 * "present" means for every gated suite in this service — see
 * `../support/credentials.ts`. `.env.example` ships a working local URL here, so
 * this gate does not change behaviour; it is the *rule* that is shared, not the
 * outcome.
 */
const databaseGate = credentialGate(['DATABASE_URL']);
export const hasDatabase = databaseGate.present;

if (!hasDatabase) {
  console.warn(
    `[@zapp/control-api] integration tests skipped: ${databaseGate.reason} — start the dev stack with ./scripts/dev-up.sh`,
  );
}

const REDIS_URL = process.env.REDIS_URL ?? '';

/** Env-gated the same way: with no `REDIS_URL`, the Redis suites skip — never pass. */
const redisGate = credentialGate(['REDIS_URL']);
export const hasRedis = redisGate.present;

if (!hasRedis) {
  console.warn(
    `[@zapp/control-api] Redis integration tests skipped: ${redisGate.reason} — start the dev stack with ./scripts/dev-up.sh`,
  );
}

/**
 * The Redis to test against.
 *
 * No `_test` sibling and no `FLUSHDB`, deliberately: Redis' numbered databases
 * are not namespaces a shared instance can be carved up with safely, and a
 * suite that flushed one could erase a developer's running stack. Every suite
 * below works on randomly named keys instead, which collide with nothing and
 * expire on their own.
 *
 * @throws Error when `REDIS_URL` is unset — guard the suite with `hasRedis`.
 */
export function redisUrl(): string {
  if (!hasRedis) {
    throw new Error('redisUrl requires REDIS_URL — guard the suite with `hasRedis`');
  }
  return REDIS_URL;
}

/** The guard suffix: nothing truncates a database whose name does not end in this. */
const TEST_SUFFIX = '_test';

/**
 * This service's *own* test database, not the `${name}_test` that `@zapp/db`'s
 * harness uses.
 *
 * `turbo run test:integration` schedules the two packages' suites in parallel,
 * and that harness truncates every table in its database between tests — so
 * sharing one would have the two suites deleting each other's fixtures, which
 * is a flake that only appears when both packages have integration tests. Ours
 * still ends in `_test`, so the truncate guard applies to it unchanged.
 */
const SERVICE_SUFFIX = '_control_api_test';

const SAFE_DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DUPLICATE_DATABASE = '42P04';

// The migrations are @zapp/db's, and the path to them is relative because they
// are data rather than code: nothing imports this directory, so there is no
// module resolution to hang it off.
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../../../packages/db/drizzle', import.meta.url),
);

/** The `${name}_control_api_test` sibling of `url`, whatever `url` already ends in. */
export function testDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name === '') {
    throw new Error('DATABASE_URL names no database — expected something like .../zapp');
  }

  // Strip any suffix a previous derivation added, so pointing DATABASE_URL at a
  // test database is idempotent rather than cumulative.
  const testName = `${name.replace(/(_control_api)?_test$/, '')}${SERVICE_SUFFIX}`;
  if (!SAFE_DATABASE_NAME.test(testName)) {
    throw new Error(`refusing to use "${testName}" as a database name`);
  }

  parsed.pathname = `/${testName}`;
  return parsed.toString();
}

function isDuplicateDatabase(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === DUPLICATE_DATABASE
  );
}

async function ensureDatabaseExists(testUrl: string): Promise<void> {
  const name = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  const maintenanceUrl = new URL(testUrl);
  maintenanceUrl.pathname = '/postgres';

  const admin = createDb(maintenanceUrl.toString());
  try {
    const existing = await admin.sql<{ oid: number }[]>`
      select oid from pg_database where datname = ${name}
    `;
    if (existing.length === 0) {
      await admin.sql.unsafe(`create database "${name}"`);
    }
  } catch (error) {
    if (!isDuplicateDatabase(error)) {
      throw error;
    }
  } finally {
    await admin.close();
  }
}

export interface TestDatabase extends Db {
  readonly url: string;
  /** Empties the identity tables. Refuses on any database not named `*_test`. */
  truncateIdentity: () => Promise<void>;
}

/**
 * The postgres.js client, named from `@zapp/db`'s own export rather than
 * imported: `postgres` is that package's dependency, not this one's, and a
 * `import type` of it here would be a dependency this service does not declare.
 */
type Sql = Db['sql'];

/** The two names `packages/db/drizzle/0003`–`0006` give an append-only guard. */
const GUARD_SUFFIXES = ['_append_only', '_append_only_truncate'] as const;

interface Guard {
  readonly table: string;
  readonly trigger: string;
}

/**
 * The append-only guards currently installed, read from the catalog rather than
 * listed: a database that has not applied the migration yet simply has none, and
 * a table protected later is picked up without touching this file.
 */
async function appendOnlyGuards(sql: Sql): Promise<Guard[]> {
  return await sql<Guard[]>`
    select relation.relname as table, trigger.tgname as trigger
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and not trigger.tgisinternal
       and trigger.tgname in (
         relation.relname || ${GUARD_SUFFIXES[0]},
         relation.relname || ${GUARD_SUFFIXES[1]}
       )
  `;
}

/**
 * Every guard's `tgenabled`, by trigger name. `'O'` is Postgres' "enabled, fires
 * in origin sessions" — the armed position, and the only one a reset may leave
 * behind. `'D'` is disabled.
 */
export async function guardStates(sql: Sql): Promise<Map<string, string>> {
  const rows = await sql<{ trigger: string; enabled: string }[]>`
    select trigger.tgname as trigger, trigger.tgenabled as enabled
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and not trigger.tgisinternal
       and trigger.tgname in (
         relation.relname || ${GUARD_SUFFIXES[0]},
         relation.relname || ${GUARD_SUFFIXES[1]}
       )
  `;
  return new Map(rows.map((row) => [row.trigger, row.enabled]));
}

/**
 * Opens the test database, creating and migrating it as needed. Applying the
 * migrations here is what makes this a test of the shipped schema rather than
 * of a hand-built one — including this task's own `0003` append-only migration.
 */
export async function setUpTestDatabase(): Promise<TestDatabase> {
  if (!hasDatabase) {
    throw new Error('setUpTestDatabase requires DATABASE_URL — guard the suite with `hasDatabase`');
  }

  const url = testDatabaseUrl(DATABASE_URL);
  await ensureDatabaseExists(url);

  const handle = createDb(url);
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    ...handle,
    url,
    truncateIdentity: async () => {
      const [current] = await handle.sql<{ name: string }[]>`select current_database() as name`;
      if (!(current?.name ?? '').endsWith(TEST_SUFFIX)) {
        throw new Error(`refusing to truncate "${current?.name ?? ''}"`);
      }

      // `usage_ledger` and `audit_events` are append-only, and since
      // `packages/db/drizzle/0006` a `BEFORE TRUNCATE` trigger enforces that for
      // every role — owner and superuser included, which is the point. Leaving
      // both tables out of the statement does not avoid it: `CASCADE` from
      // `organizations` reaches them through their `organization_id` foreign key
      // and fires the trigger anyway.
      //
      // So the reset goes *through* the guards, using the escape hatch those
      // migrations document for deliberate maintenance, exactly as
      // `packages/db/test/integration/helpers.ts` does: stand them down inside a
      // transaction, empty, put them back. The window is one transaction, a
      // failure rolls the guards back up with everything else, and the
      // post-condition below refuses to hand back a database whose protections
      // are still down — a harness that disarmed an append-only ledger and said
      // nothing would be worse than the reset it was trying to perform.
      const guards = await appendOnlyGuards(handle.sql);
      const guardedTables = [...new Set(guards.map((guard) => guard.table))];
      const truncatePrivileges = new Map<string, boolean>();
      for (const table of guardedTables) {
        const [row] = await handle.sql<{ allowed: boolean }[]>`
          select has_table_privilege(current_user, ${`public.${table}`}, 'TRUNCATE') as allowed
        `;
        truncatePrivileges.set(table, row?.allowed ?? false);
      }

      await handle.sql.begin(async (tx) => {
        for (const guard of guards) {
          await tx.unsafe(`alter table "${guard.table}" disable trigger "${guard.trigger}"`);
        }
        // Migration 0004 revokes TRUNCATE from the configured app role, which
        // is also the table owner in the local dev stack. Disabling the trigger
        // is therefore necessary but not sufficient: PostgreSQL still checks
        // the revoked table privilege first. Restore it only for the guarded
        // tables that lacked it, inside this reset transaction, then put the
        // exact privilege state back before commit. The owner can re-grant to
        // itself; a non-owner capable of disabling these triggers is a
        // superuser and already has the privilege.
        for (const table of guardedTables) {
          if (truncatePrivileges.get(table) === false) {
            await tx.unsafe(`grant truncate on public."${table}" to current_user`);
          }
        }
        await tx.unsafe(
          'truncate table "accounting_leader_leases", "memberships", "organizations", "users" restart identity cascade',
        );
        for (const table of guardedTables) {
          if (truncatePrivileges.get(table) === false) {
            await tx.unsafe(`revoke truncate on public."${table}" from current_user`);
          }
        }
        for (const guard of guards) {
          await tx.unsafe(`alter table "${guard.table}" enable trigger "${guard.trigger}"`);
        }
      });

      const states = await guardStates(handle.sql);
      const disarmed = guards.filter((guard) => states.get(guard.trigger) !== 'O');
      if (disarmed.length > 0) {
        throw new Error(
          `append-only guards left disabled after a reset: ${disarmed
            .map((guard) => guard.trigger)
            .join(', ')}`,
        );
      }

      for (const table of guardedTables) {
        const [row] = await handle.sql<{ allowed: boolean }[]>`
          select has_table_privilege(current_user, ${`public.${table}`}, 'TRUNCATE') as allowed
        `;
        if ((row?.allowed ?? false) !== truncatePrivileges.get(table)) {
          throw new Error(`TRUNCATE privilege changed after reset for ${table}`);
        }
      }
    },
  };
}
