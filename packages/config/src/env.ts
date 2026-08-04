import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Validates `source` against `schema` and returns the parsed, typed environment.
 *
 * Unknown keys are stripped by the schema, so callers only ever see what they
 * declared. On failure the thrown error names the offending keys and nothing
 * else — environment values are secrets and must never reach an error message,
 * a log line, or a stack trace.
 *
 * @throws Error `Invalid environment: <KEY>, <KEY>` when validation fails, or
 * `Invalid environment: <schema>` when no failure can be attributed to a key.
 */
export function defineEnv<TEnv>(
  schema: ZodType<TEnv, ZodTypeDef, unknown>,
  source: unknown = process.env,
): TEnv {
  const result = schema.safeParse(source);
  if (!result.success) {
    // Issues that carry no key path — a top-level `.refine()`, or a source that
    // is not an object at all — would otherwise contribute an empty name.
    const names = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.')).filter(Boolean)),
    ];
    throw new Error('Invalid environment: ' + (names.length ? names.join(', ') : '<schema>'));
  }
  return result.data;
}
