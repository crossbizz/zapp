/**
 * Whether a credential is actually present in the environment.
 *
 * A deliberate copy of `services/control-api/test/support/credentials.ts`, for
 * the reason the two `test/integration/helpers.ts` files are copies of each
 * other: a `test/` tree is not exported and is not on another package's
 * TypeScript path. Change one, change the other.
 *
 * Its whole reason for existing is that `!== ''` is not the question it looks
 * like. `.env.example` ships placeholders so that variables *exist* on a fresh
 * checkout, `scripts/dev-up.sh` copies that file to `.env`, and a `!== ''` gate
 * reads a placeholder as "configured". That is how the control plane's Stytch
 * suite came to run — and pass, in 239 ms — against a project that does not
 * exist.
 *
 * The shape of the trap here is different and worse. `FORGEJO_ADMIN_TOKEN` gates
 * the cross-repo denial suites, and node's `--env-file` never overrides a
 * variable that is already in the process environment: a shell that has
 * `source`d `.env` shadows the real token in `.env.local.forgejo` for
 * `pnpm --filter @zapp/git-service test:integration`, which loads that file
 * exactly this way. So the documented command reports a clean skip while the
 * dev stack it needs is running three feet away.
 */

/**
 * Value shapes that mean "nobody has filled this in yet".
 *
 * Keyed on what this repository actually ships rather than on a general theory
 * of placeholders — `replace-me` is `.env.example`'s own spelling. Deliberately
 * not matched: anything that merely *looks* like a test value.
 * `http://localhost:3300` and `postgres://zapp:zapp@localhost:5432/zapp` are
 * placeholders in spirit and working credentials in fact, and a gate that
 * refused them would turn the local dev stack into a permanent skip.
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
   * Why not, naming the variables and which state they are in. Empty when
   * {@link present}.
   */
  readonly reason: string;
  /** The names that hold a placeholder — the state worth a louder line than "unset". */
  readonly placeholders: readonly string[];
}

/** The gate for a set of variables that must *all* be present. */
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

  return { present: reasons.length === 0, reason: reasons.join('; '), placeholders };
}
