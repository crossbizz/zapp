import { randomBytes } from 'node:crypto';

import { z } from 'zod';

/**
 * What a slug is, in one place.
 *
 * Organizations and projects both carry one, and both end up in URLs and — later
 * — in preview hostnames, so they answer to the same rule rather than to two
 * regexes that drift apart.
 */

/**
 * A DNS-label-shaped handle. Lowercase only, so two rows cannot differ by case
 * alone, and no leading, trailing or doubled hyphens.
 */
export const SlugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * `Acme Rockets, Inc.` → `acme-rockets-inc`.
 *
 * Decomposing first folds the accents a Latin name carries, so `Café Zünd`
 * becomes `cafe-zund` rather than `caf-z-nd`. Letters that do not decompose
 * (`Æ`, `ø`) and scripts with no Latin form at all still drop out, and a name
 * that survives none of it yields the empty string — callers fall back to a
 * random slug rather than to a shared constant. That is acceptable because the
 * slug is a handle, not a rendering of the name: the name itself is stored
 * exactly as it was given, and a slug can always be chosen explicitly.
 */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      // Combining marks, spelled in escapes: the literal characters are invisible
      // in a diff and easy to mangle.
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)
      .replace(/^-+|-+$/g, '')
  );
}

/** Six hex characters, for disambiguating a derived slug. */
export function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

/**
 * A slug derived from `name`, guaranteed to be one.
 *
 * `slugify` answers with whatever survives, and what survives is not always a
 * slug: a name of one character ("X", "李") reduces to a single character, which
 * {@link SlugSchema} rejects at two, and a name with nothing Latin in it reduces
 * to nothing at all. Both used to become rows that this service's own schema
 * would refuse on the way back out — a `PATCH` that changed only the name would
 * fail validation on a slug the caller never chose (plan 02 CP-3 review).
 *
 * So the derived slug is checked against the same schema a client's slug is
 * held to, and anything that fails it falls back to `<prefix>-<random>`. That
 * keeps the rule in one place: a future tightening of `SlugSchema` cannot leave
 * derived slugs behind.
 */
export function derivedSlug(name: string, prefix: string): string {
  const candidate = slugify(name);
  return SlugSchema.safeParse(candidate).success ? candidate : `${prefix}-${randomSuffix()}`;
}
