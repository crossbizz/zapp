/**
 * The Forgejo HTTP transport, and nothing above it (plan 06 GIT-1).
 *
 * One layer, one job: turn "call this API path with this credential" into a
 * parsed body or a typed failure, with a deadline and without ever putting a
 * credential where somebody can read it. Everything that knows what a repository
 * or a token *means* lives above this — `src/provider/forgejo.ts` (GIT-2) and
 * `src/tokens.ts` (GIT-3) — and `scripts/bootstrap.ts` uses this directly,
 * which is why it is a separate module rather than the private half of the
 * provider.
 *
 * Three properties hold here rather than at each call site:
 *
 * 1. **Every request has a deadline.** An `AbortSignal.timeout` per call, from
 *    `FORGEJO_TIMEOUT_MS`. Without it a hung Git host holds a control-plane
 *    transaction — and therefore a pooled PostgreSQL connection — open until TCP
 *    gives up, which is minutes (`services/control-api/src/git/port.ts`).
 * 2. **A credential never reaches an error, a log line or a stack trace.**
 *    {@link ForgejoError} carries the method, the path and the status, and its
 *    message is built from those. The token is in a header this module writes
 *    and nothing reads back, and {@link redactToken} exists for the one case
 *    where a URL might carry one — a clone URL with basic-auth credentials in it.
 * 3. **A non-2xx is a value, not a surprise.** `send` throws {@link ForgejoError}
 *    with the status attached, so a caller can treat 404 as "not there" and 409
 *    as "already there" — which is what makes the provider's operations
 *    idempotent instead of racy.
 */

/** Where the API lives under the instance's base URL. */
const API_PREFIX = '/api/v1';

/**
 * How a request authenticates.
 *
 * Three modes, and the third one is not an accident of the API's design but of
 * Forgejo's: token *creation* (`POST /users/{name}/tokens`) refuses token auth
 * and requires HTTP basic, which is why GIT-3 creates an ephemeral user with a
 * password it generates and then authenticates as that user to mint its token.
 */
export type ForgejoAuth =
  /** The platform admin token — organizations, repositories, users. */
  | { readonly kind: 'admin' }
  /** A specific access token, e.g. a repository-scoped one being verified. */
  | { readonly kind: 'token'; readonly token: string }
  /** A username and password, for the endpoints that accept nothing else. */
  | { readonly kind: 'basic'; readonly username: string; readonly password: string }
  /** No credential at all. For `/api/healthz` and for asserting what anonymity can see. */
  | { readonly kind: 'anonymous' };

/**
 * A Forgejo call that did not succeed.
 *
 * `status` is 0 for a failure that never got a response — a timeout, a refused
 * connection, DNS — which callers distinguish from a refusal: a 404 means the
 * thing is not there, and a 0 means we do not know.
 */
export class ForgejoError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(
    method: string,
    path: string,
    status: number,
    detail: string,
    options?: { cause?: unknown },
  ) {
    // Built from the request line and the status, never from the response body
    // and never from the URL: a body can echo a token that was sent to it, and a
    // clone URL carries one in its userinfo. The underlying failure goes on
    // `cause`, where a logger can reach it and a message cannot.
    super(
      `forgejo ${method} ${path} failed (${status === 0 ? 'no response' : String(status)})${
        detail === '' ? '' : `: ${detail}`
      }`,
      options,
    );
    this.name = 'ForgejoError';
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

/**
 * Removes anything credential-shaped from a string that is about to be logged.
 *
 * Narrow on purpose: it covers URL userinfo (`https://user:token@host/…`),
 * because a clone URL is the one place in this service where a credential is
 * legitimately part of a value that gets passed around, and Forgejo's own error
 * bodies quote the URL they were given. It is not a general secret scrubber and
 * must not be treated as one — the actual rule is that tokens are never put into
 * strings in the first place.
 */
export function redactToken(value: string): string {
  return value.replace(/\/\/[^/@\s]+@/g, '//***@');
}

/** What a caller passes; the client fills in the rest. */
export interface ForgejoRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** API path *without* the `/api/v1` prefix, e.g. `/orgs/zapp-projects`. */
  readonly path: string;
  readonly auth?: ForgejoAuth;
  /** Serialized as JSON. Absent for a request with no body. */
  readonly body?: unknown;
  /**
   * Statuses to treat as an answer rather than an error, e.g. `[404]` for "is
   * this there?". Anything outside 2xx and this list throws.
   */
  readonly allow?: readonly number[];
}

/** A response that was allowed through, whether or not it was a success. */
export interface ForgejoResponse<T> {
  readonly status: number;
  /** Parsed JSON, or `undefined` for 204 and for an allowed error status. */
  readonly body: T | undefined;
}

export interface ForgejoClient {
  /** @throws {ForgejoError} for a transport failure or a status outside 2xx and `allow`. */
  send<T = unknown>(request: ForgejoRequest): Promise<ForgejoResponse<T>>;
  /** The instance's base URL, normalized. Clone URLs are built from it. */
  readonly baseUrl: string;
}

/** Injected in tests. Node 22's global `fetch` is the shipping one. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ForgejoClientOptions {
  readonly baseUrl: string;
  readonly adminToken: string;
  readonly timeoutMs: number;
  readonly fetch?: FetchLike;
}

function authHeaders(auth: ForgejoAuth, adminToken: string): Record<string, string> {
  switch (auth.kind) {
    case 'admin':
      return { authorization: `token ${adminToken}` };
    case 'token':
      return { authorization: `token ${auth.token}` };
    case 'basic':
      return {
        authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString(
          'base64',
        )}`,
      };
    case 'anonymous':
      return {};
  }
}

/**
 * The first line of a Forgejo error body, bounded.
 *
 * Forgejo answers a failure with `{"message": "...", "url": "..."}`, and the
 * message is genuinely useful ("user already exists", "branch protection
 * exists"). Bounded to a sentence and passed through {@link redactToken},
 * because it is the one part of a response that ends up in a log line.
 */
function detailOf(text: string): string {
  if (text === '') {
    return '';
  }
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'message' in parsed) {
      const value = (parsed as { message?: unknown }).message;
      if (typeof value === 'string') {
        message = value;
      }
    }
  } catch {
    // Not JSON — an HTML error page from a proxy, most likely. Truncated below.
  }
  return redactToken(message.replace(/\s+/g, ' ').trim()).slice(0, 200);
}

export function createForgejoClient(options: ForgejoClientOptions): ForgejoClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  return {
    baseUrl,

    async send<T>(request: ForgejoRequest): Promise<ForgejoResponse<T>> {
      const { method, path, auth = { kind: 'admin' } as const, body, allow = [] } = request;
      // `/api/healthz` is outside the versioned API, so a path that already
      // starts with `/api/` is taken as given. Everything else is versioned.
      const url = `${baseUrl}${path.startsWith('/api/') ? '' : API_PREFIX}${path}`;

      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          headers: {
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...authHeaders(auth, options.adminToken),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          // Per call rather than per client: a shared signal would abort every
          // in-flight request the first time one of them timed out.
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        // Status 0: no response at all. The cause is attached for the log, and
        // the message names only the request line — `error.message` from fetch
        // can quote the URL, which for a clone URL carries a credential.
        throw new ForgejoError(method, path, 0, 'transport', { cause: error });
      }

      const ok = response.status >= 200 && response.status < 300;
      if (!ok && !allow.includes(response.status)) {
        throw new ForgejoError(method, path, response.status, detailOf(await response.text()));
      }

      if (response.status === 204 || !ok) {
        // 204 has no body by definition; an allowed error status has one that
        // says why, which the caller asked to be told about by status alone.
        return { status: response.status, body: undefined };
      }

      const text = await response.text();
      if (text === '') {
        return { status: response.status, body: undefined };
      }
      try {
        return { status: response.status, body: JSON.parse(text) as T };
      } catch (error) {
        // A 2xx that is not JSON is a proxy answering instead of Forgejo, and
        // treating it as success would hand the caller `undefined` where it
        // expects a repository.
        throw new ForgejoError(method, path, response.status, 'response was not JSON', {
          cause: error,
        });
      }
    },
  };
}
