/**
 * Cookie handling, by hand and on purpose.
 *
 * Every value this service sets is one it minted itself — a JWT, a hex nonce —
 * so serialization has no untrusted input to escape, and {@link SAFE_VALUE}
 * turns that assumption into an assertion rather than a comment. Doing it here
 * instead of through a plugin keeps the attributes that matter (`HttpOnly`,
 * `Secure`, `SameSite`, `Path`) in one readable place where a review can see
 * all of them at once, and adds no dependency to a service whose whole job is
 * handling credentials.
 */

/** 12-hour session JWT. Sent on every request, so it lives at the root path. */
export const SESSION_COOKIE = 'zapp_session';
/** 30-day refresh JWT. Only ever presented to `/v1/auth`, so it is scoped there. */
export const REFRESH_COOKIE = 'zapp_refresh';
/** Double-submit token. Readable by the page — that is the entire mechanism. */
export const CSRF_COOKIE = 'zapp_csrf';
/** Login nonce, matched against the signed `state` the provider returns. */
export const OAUTH_STATE_COOKIE = 'zapp_oauth_state';

/** Header the browser echoes {@link CSRF_COOKIE} in. Lowercase: HTTP/2 field names are. */
export const CSRF_HEADER = 'x-zapp-csrf';

export const ROOT_PATH = '/';
/** Everything a refresh or a login handshake ever touches. */
export const AUTH_PATH = '/v1/auth';

/**
 * base64url (JWTs) plus hex (nonces), and nothing else — no `;`, no `,`, no
 * whitespace, no control characters. A value that fails this cannot split a
 * `Set-Cookie` header or smuggle a second cookie, and reaching this check means
 * a caller is about to serialize something it did not mint.
 */
const SAFE_VALUE = /^[A-Za-z0-9._~-]*$/;

export interface CookieOptions {
  readonly path: string;
  /** Lifetime in seconds. `0` expires the cookie immediately. */
  readonly maxAgeSeconds: number;
  /** `false` only for the CSRF cookie, which the page has to be able to read. */
  readonly httpOnly?: boolean;
}

/**
 * `Secure` and `SameSite=Lax` are not options: `Secure` is what keeps a session
 * off plaintext HTTP (browsers treat `localhost` as secure, so development is
 * unaffected), and `Lax` is the strictest setting that still survives the
 * top-level redirect the identity provider sends the browser back on.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  if (!SAFE_VALUE.test(value)) {
    throw new Error(`refusing to set cookie ${name}: value is not base64url`);
  }

  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${String(Math.floor(options.maxAgeSeconds))}`,
    'Secure',
    'SameSite=Lax',
  ];
  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }
  return parts.join('; ');
}

/** The same cookie, emptied and expired. The path must match the one it was set on. */
export function expireCookie(name: string, options: Omit<CookieOptions, 'maxAgeSeconds'>): string {
  return serializeCookie(name, '', { ...options, maxAgeSeconds: 0 });
}

/**
 * Splits a `Cookie` request header. Unparseable pairs are skipped rather than
 * guessed at, and a repeated name keeps the first value — a second one is
 * either a path-scoped duplicate or an attempt at cookie shadowing, and the
 * first is the one the browser considers most specific.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined) {
    return cookies;
  }

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    if (name !== '' && !cookies.has(name)) {
      cookies.set(name, pair.slice(separator + 1).trim());
    }
  }
  return cookies;
}
