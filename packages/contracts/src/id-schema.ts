import { z } from 'zod';

/**
 * Every entity id is a TypeID: an entity prefix, an underscore, and a ULID.
 * The set is closed — master plan §Global Constraints owns this list.
 */
export type IdPrefix =
  | 'org'
  | 'user'
  | 'sub'
  | 'proj'
  | 'repo'
  | 'br'
  | 'env'
  | 'pc'
  | 'spec'
  | 'dec'
  | 'run'
  | 'phase'
  | 'task'
  | 'appr'
  | 'ws'
  | 'evt'
  | 'art'
  | 'trun'
  | 'tcase'
  | 'vr'
  | 'rel'
  | 'dep'
  | 'syn'
  | 'sec'
  | 'intc'
  | 'aud';

/** Crockford base32: digits plus A-Z without I, L, O and U. */
const ULID_PATTERN = '[0-9A-HJKMNP-TV-Z]{26}';

export function idSchema(prefix: IdPrefix): z.ZodString {
  return z.string().regex(new RegExp(`^${prefix}_${ULID_PATTERN}$`), `Invalid ${prefix} id`);
}
