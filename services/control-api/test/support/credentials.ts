/**
 * Whether a credential is actually present in the environment — the gate every
 * env-gated suite in this service is guarded by.
 *
 * Its whole reason for existing is that `!== ''` is not that question.
 * `.env.example` ships `STYTCH_SECRET=replace-me` so the variable *exists* on a
 * fresh checkout, `scripts/dev-up.sh` copies that file to `.env`, and a `!== ''`
 * gate reads the placeholder as "configured" — so
 * `test/integration/auth.test.ts` ran its live-Stytch suite against a project id
 * of all zeros and a secret of `replace-me`, and passed in 239 ms. It could not
 * have done otherwise: the adapter turned every provider failure into `null` or
 * a fixed error code, so the assertions held whether or not anything answered.
 * Two green tests, zero evidence.
 *
 * Three states therefore collapse into two, on purpose: unset, empty and "still
 * the template's placeholder" are all **absent**. A suite that cannot tell them
 * apart from a real credential is a suite that cannot fail.
 *
 * `services/git-service/test/support/credentials.ts` is a deliberate copy of
 * this file, for the reason the two `test/integration/helpers.ts` files are
 * copies of each other: a `test/` tree is not exported and is not on another
 * package's TypeScript path. Change one, change the other.
 */

/**
 * Value shapes that mean "nobody has filled this in yet".
 *
 * Keyed on what this repository actually ships rather than on a general theory
 * of placeholders: `replace-me` is `.env.example`'s own spelling (and
 * `scripts/dev-up.sh` substitutes exactly those), and the nil UUID is the shape
 * the Stytch project id placeholder had — `project-test-00000000-0000-...`,
 * which is the one placeholder here that could be mistaken for a real
 * identifier at a glance. The rest are the spellings a hurried `.env` picks up.
 *
 * Deliberately not matched: anything that merely *looks* like a test value.
 * `postgres://zapp:zapp@localhost:5432/zapp` and `minioadmin` are placeholders
 * in spirit and working credentials in fact, and a gate that refused them would
 * turn the local dev stack into a permanent skip.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /replace[-_]?me/i,
  /change[-_]?me/i,
  /0{8}-0{4}-0{4}-0{4}-0{12}/,
  /^(todo|tbd|xxx+|placeholder|dummy|fake|unset|none)$/i,
];

/** Whether `value` is one of the template's fill-me-in shapes rather than a credential. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

export interface CredentialGate {
  /** True only when every named variable holds something that is not a placeholder. */
  readonly present: boolean;
  /**
   * Why not, naming the variables and which state they are in — so the skip
   * line says what to fix rather than only that something is missing. Empty
   * when {@link present}.
   */
  readonly reason: string;
}

/**
 * The gate for a set of variables that must *all* be present.
 *
 * Reads `process.env` at call time rather than at import time: a suite that is
 * gated on a variable is usually also the suite that documents how to set it,
 * and a module-level snapshot makes the two disagree.
 */
export function credentialGate(names: readonly string[]): CredentialGate {
  const unset: string[] = [];
  const placeholders: string[] = [];

  for (const name of names) {
    const value = (process.env[name] ?? '').trim();
    if (value === '') {
      unset.push(name);
    } else if (isPlaceholder(value)) {
      placeholders.push(name);
    }
  }

  const reasons: string[] = [];
  if (unset.length > 0) {
    reasons.push(`${unset.join(', ')} ${unset.length === 1 ? 'is' : 'are'} unset`);
  }
  if (placeholders.length > 0) {
    reasons.push(
      `${placeholders.join(', ')} still ${placeholders.length === 1 ? 'holds' : 'hold'} an .env.example placeholder`,
    );
  }

  return { present: reasons.length === 0, reason: reasons.join('; ') };
}
