/**
 * The one thing this service asks a database failure: was it a uniqueness
 * conflict? Every other detail belongs in the log, never in a response.
 */

const UNIQUE_VIOLATION = '23505';

/** Drizzle wraps driver failures; the SQLSTATE is on whichever layer is underneath. */
export function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
