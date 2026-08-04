import { sql, type SQL } from 'drizzle-orm';
import { text } from 'drizzle-orm/pg-core';

import { organizations } from './identity.js';

/**
 * The tenant column. Every table below PRD §23.1 carries it, directly after
 * `id`, even where the PRD's conceptual model only implies it through a parent:
 * PRD §22.3 requires *every* control-plane query to be organization-scoped, and
 * a denormalized column is what lets `forOrg` filter without joining a chain of
 * parents it would then have to trust (plan 01 FND-6).
 *
 * A factory rather than a shared instance: each table needs its own builder, and
 * Drizzle derives the foreign-key constraint name from the table it lands in.
 */
export const organizationId = () =>
  text('organization_id')
    .notNull()
    .references(() => organizations.id);

/**
 * `column in ('a', 'b')` for a table CHECK, built from the same literal list the
 * TypeScript column type uses so the database and the type can never disagree.
 *
 * Value sets are persisted as `text` + CHECK rather than as a pg enum: extending
 * a CHECK is one `ALTER TABLE`, while enum values can never be dropped and only
 * ever append. The column reference is deliberately unqualified — a table CHECK
 * cannot use a table-qualified name — and every value is a compile-time literal
 * from `@zapp/contracts`, never anything a request carries.
 */
export function oneOf(column: string, values: readonly string[]): SQL {
  return sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(', ')})`);
}
