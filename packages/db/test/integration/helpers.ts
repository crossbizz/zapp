import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { createDb, type Database } from '../../src/client.js';

/**
 * The rail every database-backed suite in this package runs on.
 *
 * Two rules, both learned the hard way (FND-5 review, minor 2):
 *
 * 1. Integration tests never touch the database `DATABASE_URL` points at. They
 *    derive `${name}_test` from it, create that database if it is missing, and
 *    work there. A developer's dev stack and a CI service container are the
 *    same shape, so this needs no separate environment variable.
 * 2. Nothing truncates a database whose name does not end in `_test`. The guard
 *    lives in {@link TestDatabase.truncateAll} — next to the `TRUNCATE`, not in
 *    the caller — because that is the only place it cannot be forgotten.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? '';

/** Env-gated on the FND-7 dev stack: with no `DATABASE_URL`, suites skip — never pass. */
export const hasDatabase = DATABASE_URL !== '';

if (!hasDatabase) {
  console.warn(
    '[@zapp/db] integration tests skipped: DATABASE_URL is unset — start the dev stack with ./scripts/dev-up.sh',
  );
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

const TEST_SUFFIX = '_test';

/**
 * What we are willing to splice into DDL. `CREATE DATABASE` takes no bind
 * parameters, so the name is interpolated; the name comes from `DATABASE_URL`,
 * which is configuration rather than user input, but configuration is exactly
 * what an attacker edits when they have already got that far.
 */
const SAFE_DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Postgres error codes we treat as "someone else already did it". */
const DUPLICATE_DATABASE = '42P04';

/** The `${name}_test` sibling of `url`, or `url` itself when it already is one. */
export function testDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name === '') {
    throw new Error('DATABASE_URL names no database — expected something like .../zapp');
  }

  const testName = name.endsWith(TEST_SUFFIX) ? name : `${name}${TEST_SUFFIX}`;
  if (!SAFE_DATABASE_NAME.test(testName)) {
    throw new Error(
      `refusing to use "${testName}" as a database name: expected letters, digits and underscores only`,
    );
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

/** Creates the test database if it does not exist yet, connecting through the server's `postgres` database. */
async function ensureDatabaseExists(testUrl: string): Promise<void> {
  const name = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  const maintenanceUrl = new URL(testUrl);
  maintenanceUrl.pathname = '/postgres';

  const admin = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => undefined });
  try {
    const existing = await admin<{ oid: number }[]>`
      select oid from pg_database where datname = ${name}
    `;
    if (existing.length > 0) {
      return;
    }
    await admin.unsafe(`create database "${name}"`);
  } catch (error) {
    // Two vitest workers can reach the create at once on a cold machine.
    if (!isDuplicateDatabase(error)) {
      throw error;
    }
  } finally {
    await admin.end();
  }
}

export interface TestDatabase {
  /** Connection string actually in use — the `_test` sibling, never `DATABASE_URL` itself. */
  readonly url: string;
  /** Typed query builder. */
  readonly db: Database;
  /** The driver underneath, for statements Drizzle cannot express. */
  readonly sql: postgres.Sql;
  /** Empties every table. Refuses on any database not named `*_test`. */
  truncateAll: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Opens the test database, creating and migrating it as needed.
 *
 * Applying `drizzle/` here is deliberate: the generated SQL is the schema's
 * source of truth, so a suite that runs is also proof that the migrations still
 * produce the tables the TypeScript definitions describe.
 */
export async function setUpTestDatabase(): Promise<TestDatabase> {
  if (!hasDatabase) {
    throw new Error('setUpTestDatabase requires DATABASE_URL — guard the suite with `hasDatabase`');
  }

  const url = testDatabaseUrl(DATABASE_URL);
  await ensureDatabaseExists(url);

  // Migrations run on their own single-use connection: the migrator's
  // `if not exists` bookkeeping DDL raises a NOTICE on every re-run, and that is
  // noise rather than information for everything that follows.
  const migrationSql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await migrationSql.end();
  }

  const handle = createDb(url);

  return {
    url,
    db: handle.db,
    sql: handle.sql,
    truncateAll: async () => {
      await truncateAll(handle.sql);
    },
    close: handle.close,
  };
}

/**
 * Empty every table in `public`, or refuse loudly.
 *
 * Tables are read from the catalog rather than listed: this package grows, and
 * a list that goes stale silently leaves rows behind for the next test to trip
 * over. Partitions are skipped — emptying their parent empties them, and naming
 * both is a needless lock.
 *
 * `usage_ledger` and `audit_events` are append-only (plan 02 CP-2): triggers
 * reject UPDATE, DELETE and TRUNCATE on them for *every* role, owner and
 * superuser included, which is the point. So a reset cannot go around them —
 * `DELETE` is refused by one trigger and `TRUNCATE` by the other, and even
 * leaving both tables out of the statement does not help, because `CASCADE`
 * from `organizations` reaches them and fires the trigger anyway (measured).
 *
 * It therefore goes *through* them, using the escape hatch those migrations
 * document for deliberate maintenance: stand the guards down inside a
 * transaction, empty, put them back. Ownership is required to do it, the window
 * is one transaction, and a failure rolls the guards back up with everything
 * else. A test database being reset is exactly the deliberate case that hatch
 * exists for; nothing else in this package may use it.
 */
export async function truncateAll(sql: postgres.Sql): Promise<void> {
  const [current] = await sql<{ name: string }[]>`select current_database() as name`;
  const name = current?.name ?? '';
  if (!name.endsWith(TEST_SUFFIX)) {
    throw new Error(
      `refusing to truncate "${name}": integration tests only ever truncate a database whose name ends in "${TEST_SUFFIX}" — see testDatabaseUrl()`,
    );
  }

  const tables = await sql<{ name: string }[]>`
    select class.relname as name
      from pg_class class
      join pg_namespace namespace on namespace.oid = class.relnamespace
     where namespace.nspname = 'public'
       and class.relkind in ('r', 'p')
       and not exists (select 1 from pg_inherits where inhrelid = class.oid)
  `;
  if (tables.length === 0) {
    return;
  }

  // Read from the catalog, not hardcoded: the guards arrive with a migration,
  // so a database that has not applied it yet simply has none to stand down,
  // and a table protected later is picked up without touching this file.
  // Matched by the `<table>_append_only[_truncate]` naming those migrations use.
  const guards = await sql<{ table: string; trigger: string }[]>`
    select relation.relname as table, trigger.tgname as trigger
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and not trigger.tgisinternal
       and trigger.tgname in (
         relation.relname || '_append_only',
         relation.relname || '_append_only_truncate'
       )
  `;

  const targets = tables.map((table) => `"${table.name}"`).join(', ');
  await sql.begin(async (tx) => {
    for (const guard of guards) {
      await tx.unsafe(`alter table "${guard.table}" disable trigger "${guard.trigger}"`);
    }
    await tx.unsafe(`truncate table ${targets} restart identity cascade`);
    for (const guard of guards) {
      await tx.unsafe(`alter table "${guard.table}" enable trigger "${guard.trigger}"`);
    }
  });
}

/** `noUncheckedIndexedAccess` types `rows[0]` as optional; fail loudly rather than assert non-null. */
export function only<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected a row, got none');
  }
  return row;
}

/**
 * Runs a query that must fail and returns the driver's error. Drizzle wraps
 * failures in its own error type, so the SQLSTATE fields (`code`,
 * `constraint_name`) live on the postgres.js `cause` underneath; raw `sql`
 * queries throw that error directly.
 */
export async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error instanceof Error && error.cause !== undefined ? error.cause : error;
  }
  throw new Error('expected the query to be rejected, but it succeeded');
}
