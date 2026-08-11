import { monotonicFactory } from 'ulid';
import type { IdPrefix } from './id-schema.js';

export { idSchema, type IdPrefix } from './id-schema.js';

/**
 * Monotonic within the process: ids minted in the same millisecond still sort
 * ascending, so a stream of events stays orderable by id alone.
 */
const ulid = monotonicFactory();

/** Mints a new sortable id for `prefix`, e.g. `run_01J8ME7YQZJ2V9Q0X3T5B6K7N9`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
