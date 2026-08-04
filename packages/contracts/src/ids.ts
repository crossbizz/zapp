import { monotonicFactory } from 'ulid';
import { z } from 'zod';

/**
 * Every entity id is a TypeID: an entity prefix, an underscore, and a ULID.
 * The set is closed — master plan §Global Constraints owns this list.
 *
 * One prefix per PRD §23 table, so no row anywhere carries an untyped
 * identifier. Prefixes are never reused or renamed: an id outlives the code
 * that minted it, and `idSchema` is what an API boundary rejects a stale or
 * cross-entity id with.
 */
export type IdPrefix =
  // Identity, billing and projects (PRD §23.1–23.2).
  | 'org'
  | 'user'
  | 'sub' // subscriptions
  | 'proj'
  | 'repo' // repositories
  | 'br' // branches
  | 'env' // environments
  | 'pc' // project_contracts
  // Specification, planning and execution (PRD §23.3–23.4).
  | 'spec' // specifications
  | 'dec' // decisions
  | 'run' // agent_runs
  | 'phase' // agent_phases
  | 'task' // agent_tasks
  | 'appr' // approvals
  | 'ws' // workspaces
  | 'evt' // agent_events
  | 'art' // artifacts
  | 'trun' // test_runs
  | 'tcase' // test_cases
  | 'vr' // verification_results
  // Releases, security and integrations (PRD §23.5–23.6).
  | 'rel' // releases
  | 'dep' // deployments
  | 'syn' // synthetic_checks
  | 'sec' // secret_metadata
  | 'intc' // integration_connections
  | 'aud'; // audit_events

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
