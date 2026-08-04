import { PgDialect, getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

/**
 * Reflection over the Drizzle table objects, shared by the schema pin suites.
 *
 * These run without a database on purpose: the column names are the contract
 * PRD §23 fixes, and a rename must fail in the plain `test` run that CI executes
 * everywhere — rather than only where Postgres happens to exist.
 */

const dialect = new PgDialect();

export function tableName(table: PgTable): string {
  return getTableConfig(table).name;
}

export function columnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

/** Columns that may not be null, in declaration order. */
export function requiredColumns(table: PgTable): string[] {
  return getTableConfig(table)
    .columns.filter((column) => column.notNull)
    .map((column) => column.name);
}

export function indexNames(table: PgTable): (string | undefined)[] {
  return getTableConfig(table).indexes.map((index) => index.config.name);
}

/** Each foreign key rendered as `column -> table.column`. */
export function foreignKeys(table: PgTable): string[] {
  return getTableConfig(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    const from = reference.columns.map((column) => column.name).join(', ');
    const to = reference.foreignColumns.map((column) => column.name).join(', ');
    return `${from} -> ${tableName(reference.foreignTable)}.${to}`;
  });
}

export function checkNames(table: PgTable): string[] {
  return getTableConfig(table).checks.map((check) => check.name);
}

/** The SQL a named CHECK renders to — the value set itself, not just its name. */
export function checkExpression(table: PgTable, name: string): string {
  const check = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  if (check === undefined) {
    throw new Error(`${tableName(table)} has no check named ${name}`);
  }
  return dialect.sqlToQuery(check.value).sql;
}

/** Columns of a composite primary key; empty when the key is a single column. */
export function primaryKeyColumns(table: PgTable): string[] {
  return getTableConfig(table).primaryKeys.flatMap((key) =>
    key.columns.map((column) => column.name),
  );
}

export function sqlType(table: PgTable, columnName: string): string | undefined {
  return getTableConfig(table)
    .columns.find((column) => column.name === columnName)
    ?.getSQLType();
}

/** The TypeScript-side value set of a `text(..., { enum })` column. */
export function enumValues(table: PgTable, columnName: string): string[] {
  const column = getTableConfig(table).columns.find((candidate) => candidate.name === columnName);
  if (column === undefined) {
    throw new Error(`${tableName(table)} has no column named ${columnName}`);
  }
  return [...(column.enumValues ?? [])];
}
