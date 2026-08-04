import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Validates `source` against `schema` and returns the parsed, typed environment.
 *
 * Unknown keys are stripped by the schema, so callers only ever see what they
 * declared. On failure the thrown error names the offending keys and nothing
 * else — environment values are secrets and must never reach an error message,
 * a log line, or a stack trace.
 *
 * @throws Error `Invalid environment: <KEY>, <KEY>` when validation fails.
 */
export function defineEnv<TEnv>(
  schema: ZodType<TEnv, ZodTypeDef, unknown>,
  source: unknown = process.env,
): TEnv {
  const result = schema.safeParse(source);
  if (!result.success) {
    const names = result.error.issues.map((issue) => issue.path.join('.'));
    throw new Error('Invalid environment: ' + names.join(', '));
  }
  return result.data;
}
