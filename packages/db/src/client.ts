import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema/index.js';

/** The Drizzle query interface, typed with every table in the schema barrel. */
export type Database = PostgresJsDatabase<typeof schema>;

/** What {@link createDb} hands back: the ORM, the driver underneath it, and one way to release both. */
export interface Db {
  /** Typed query builder — the interface repositories and services should take. */
  readonly db: Database;
  /**
   * The postgres.js client, for the statements Drizzle cannot express: DDL in
   * tests, `LISTEN`/`NOTIFY`, advisory locks.
   */
  readonly sql: postgres.Sql;
  /** Closes the connection pool. Awaits in-flight queries first. */
  close: () => Promise<void>;
}

/**
 * Opens a connection pool against `url` and wraps it in Drizzle.
 *
 * The url is always passed in — never read from the environment here — so tests
 * and services stay explicit about which database they are talking to, and a
 * connection string never leaks into a log line from this layer.
 */
export function createDb(url: string): Db {
  const sql = postgres(url);
  const db = drizzle(sql, { schema });

  return {
    db,
    sql,
    close: async () => {
      await sql.end();
    },
  };
}
