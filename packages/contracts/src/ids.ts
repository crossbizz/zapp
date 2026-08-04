import { monotonicFactory } from 'ulid';
import { z } from 'zod';

/**
 * Every entity id is a TypeID: an entity prefix, an underscore, and a ULID.
 * The set is closed — master plan §Global Constraints owns this list.
 */
export type IdPrefix =
  'org' | 'user' | 'proj' | 'run' | 'task' | 'ws' | 'rel' | 'dep' | 'evt' | 'art' | 'spec' | 'sec';

/** Crockford base32: digits plus A–Z without I, L, O and U. */
const ULID_PATTERN = '[0-9A-HJKMNP-TV-Z]{26}';

/**
 * Monotonic within the process: ids minted in the same millisecond still sort
 * ascending, so a stream of events stays orderable by id alone.
 */
const ulid = monotonicFactory();

/** Mints a new sortable id for `prefix`, e.g. `run_01J8ME7YQZJ2V9Q0X3T5B6K7N9`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

/**
 * A schema accepting exactly the ids of one entity type. The failure message
 * names the expected prefix and never echoes the rejected value, which is
 * routinely user-supplied and ends up in logs.
 */
export function idSchema(prefix: IdPrefix): z.ZodString {
  return z.string().regex(new RegExp(`^${prefix}_${ULID_PATTERN}$`), `Invalid ${prefix} id`);
}
