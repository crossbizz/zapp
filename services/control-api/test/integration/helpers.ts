import { fileURLToPath } from 'node:url';

import { createDb, type Db } from '@zapp/db';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

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

/** Env-gated on the FND-7 dev stack: with no `DATABASE_URL`, suites skip — never pass. */
export const hasDatabase = DATABASE_URL !== '';

if (!hasDatabase) {
  console.warn(
    '[@zapp/control-api] integration tests skipped: DATABASE_URL is unset — start the dev stack with ./scripts/dev-up.sh',
  );
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
      await handle.sql.begin(async (tx) => {
        for (const guard of guards) {
          await tx.unsafe(`alter table "${guard.table}" disable trigger "${guard.trigger}"`);
        }
        await tx.unsafe(
          'truncate table "memberships", "organizations", "users" restart identity cascade',
        );
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
    },
  };
}
