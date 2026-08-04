/**
 * The one thing this service asks a database failure: was it a uniqueness
 * conflict, and on *which* constraint? Every other detail belongs in the log,
 * never in a response.
 *
 * The second half of that question is not decoration. `projects.create` writes a
 * project, a repository, a branch and two environments in one transaction, and
 * every one of those tables has a unique index; a bare "was it 23505?" turns a
 * duplicate branch name, a duplicate environment name or a repository ref
 * collision into `slug_taken`, so the route answers 409 "that project slug is
 * already in use" for a bug that has nothing to do with slugs — and the retry
 * loop above it then burns its five attempts on a condition no suffix can fix
 * (plan 02 CP-6 review). Naming the constraint makes the mapping say what it
 * means.
 */

const UNIQUE_VIOLATION = '23505';

/**
 * The constraint a driver reports. `postgres` (this service's driver, through
 * `@zapp/db`) spells it `constraint_name`; `pg` spells it `constraint`. Both are
 * read, because which one is underneath is not something a caller of this
 * function should have to know.
 */
function constraintOf(cause: object): string | undefined {
  const named = cause as { constraint_name?: unknown; constraint?: unknown };
  const value = named.constraint_name ?? named.constraint;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Whether `error` is a unique-constraint violation — and, when `constraints` is
 * given, whether it is a violation of one of *those*.
 *
 * A violation whose constraint the driver did not report fails the narrowed
 * check: an unnamed conflict is one we cannot vouch for, and mapping it to a
 * specific client-facing 409 would be a guess. It surfaces as the error it is.
 */
export function isUniqueViolation(error: unknown, constraints?: readonly string[]): boolean {
  // Drizzle wraps driver failures; the SQLSTATE is on whichever layer is underneath.
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  if (typeof cause !== 'object' || cause === null) {
    return false;
  }
  if ((cause as { code?: unknown }).code !== UNIQUE_VIOLATION) {
    return false;
  }
  if (constraints === undefined) {
    return true;
  }
  const name = constraintOf(cause);
  return name !== undefined && constraints.includes(name);
}
