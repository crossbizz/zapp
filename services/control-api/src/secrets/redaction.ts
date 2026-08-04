/**
 * Secret redaction, in one implementation (PRD §18.12: "Secret values are
 * redacted from command output, logs, events, screenshots, and model context").
 *
 * Exported rather than kept private because that list is not one plan's: plan 03
 * pipes sandbox command output to the event stream, plan 04 puts tool results in
 * model context, and plan 05 attaches build logs to evidence. Each of them needs
 * this, and three implementations of "replace a secret with a marker" is three
 * places for a subtly different one to be wrong — the one that forgets to sort
 * by length, or the one that builds a regex from an unescaped value.
 *
 * Plan 02 CP-7 (step 1) suggests `packages/config/src/redaction.ts` as the
 * eventual home so services that never depend on the control plane can import
 * it. It lives here for now because CP-7's commit scope is this service and
 * `packages/db`; the move is a re-export away, and this module is exported from
 * `src/index.ts` so a second consumer does not have to wait for it.
 *
 * Three properties, each of which is a way a redactor is usually wrong:
 *
 *   1. **Literal, never a pattern.** Values are matched by `split`/`join`, so a
 *      secret containing `.`, `$`, `\` or `(` is matched as itself. A redactor
 *      that compiles its inputs into a regex either throws on those or silently
 *      matches the wrong thing.
 *   2. **Longest first.** When one secret's value contains another's, replacing
 *      the shorter one first leaves the longer one's remainder in the output —
 *      partial credentials are still credentials.
 *   3. **Over-eager on purpose.** A short value redacts every coincidental
 *      occurrence of itself, which makes output noisy. Noisy output is the right
 *      side of that trade: the alternative is a threshold below which secrets
 *      are printed, and nothing about a value's length makes it less of one.
 */

/** What replaces a value. Names the secret so a reader can act on the redaction. */
export function secretMarker(name: string): string {
  return `[secret:${name}]`;
}

/**
 * `name → value` for the secrets in scope. A `Map` is the natural argument; any
 * iterable of pairs is accepted so a caller with rows rather than a map does not
 * have to build one.
 */
export type SecretRegistry = Iterable<readonly [name: string, value: string]>;

/**
 * Credentials that are not in any registry, in the shapes they travel in.
 *
 * {@link redactSecrets} needs to know the value; this needs only to recognise
 * the wrapper. It is for the case where something we did not choose the wording
 * of has to be written down — a provider's error message quoting the request
 * that failed, which for the internal git service is a request carrying our own
 * credentials (plan 02 CP-6 review). Logging that verbatim puts a service
 * credential in the log; logging nothing at all leaves an operator with
 * `errorKind: 'git_service'` and no way to tell a wrong token from a full disk.
 *
 * Each pattern keeps the surrounding structure and replaces only the secret
 * part, so the redacted line still reads as what it was.
 */
const CREDENTIAL_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // `https://user:token@host/…` — the form a git remote carries a password in.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@'],
  // `Authorization: Bearer …`, `token …`, and the `?access_token=` family.
  [/\b(bearer|token|basic)\s+[\w+/=._-]+/gi, '$1 [redacted]'],
  [/\b((?:access_|api_|private_)?token|password|secret|key)=[^\s&"']+/gi, '$1=[redacted]'],
];

/**
 * Replaces credential-shaped substrings in `text` with `[redacted]`.
 *
 * Not a substitute for {@link redactSecrets} — it recognises wrappers, not
 * values, so it cannot see a bare credential with nothing around it. It is the
 * pass applied to text we did not author before it reaches a log.
 */
export function redactCredentials(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/**
 * Replaces every occurrence of each secret's value in `text` with
 * `[secret:NAME]`.
 *
 * Empty values are skipped — they occur nowhere and everywhere, and `split('')`
 * would explode the string into characters.
 */
export function redactSecrets(text: string, secrets: SecretRegistry): string {
  const entries = [...secrets]
    .filter(([, value]) => value !== '')
    // Longest first — see property 2 in the module comment.
    .sort(([, left], [, right]) => right.length - left.length);

  let redacted = text;
  for (const [name, value] of entries) {
    redacted = redacted.split(value).join(secretMarker(name));
  }
  return redacted;
}
