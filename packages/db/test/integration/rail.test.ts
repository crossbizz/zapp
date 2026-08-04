import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { hasDatabase, testDatabaseUrl, truncateAll } from './helpers.js';

/**
 * The rail itself. Everything else in this directory trusts these two rules, so
 * they get their own tests rather than being assumed: derive `${name}_test`,
 * and never truncate anything else.
 */
describe('test database rail', () => {
  const connections: postgres.Sql[] = [];

  afterAll(async () => {
    await Promise.all(connections.map((connection) => connection.end()));
  });

  it('derives the _test sibling of a connection string', () => {
    expect(testDatabaseUrl('postgres://zapp:zapp@localhost:5432/zapp')).toBe(
      'postgres://zapp:zapp@localhost:5432/zapp_test',
    );
    // Idempotent: passing an already-derived url back in must not stutter.
    expect(testDatabaseUrl('postgres://zapp:zapp@localhost:5432/zapp_test')).toBe(
      'postgres://zapp:zapp@localhost:5432/zapp_test',
    );
    // Everything else about the url survives — credentials, port, parameters.
    expect(testDatabaseUrl('postgres://u:p@db.internal:6543/app?sslmode=require')).toBe(
      'postgres://u:p@db.internal:6543/app_test?sslmode=require',
    );
  });

  it('refuses a connection string that names no database, or an unusable name', () => {
    expect(() => testDatabaseUrl('postgres://zapp:zapp@localhost:5432')).toThrow(
      /names no database/,
    );
    expect(() => testDatabaseUrl('postgres://zapp@localhost:5432/we"ird')).toThrow(
      /letters, digits and underscores/,
    );
  });

  it.skipIf(!hasDatabase)('refuses to truncate a database not named *_test', async () => {
    // The database DATABASE_URL points at is the developer's dev stack (or the
    // CI service container) — the one thing these suites must never empty.
    const development = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
    connections.push(development);

    await expect(truncateAll(development)).rejects.toThrow(/refusing to truncate/);
  });
});
