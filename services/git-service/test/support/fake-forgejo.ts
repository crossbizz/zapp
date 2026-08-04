import {
  ForgejoError,
  type ForgejoClient,
  type ForgejoRequest,
  type ForgejoResponse,
} from '../../src/forgejo/client.js';

/**
 * A Forgejo that answers from a script, and records what it was asked.
 *
 * The unit suites use this so that they test *our* logic — the order of the
 * calls, which of them are writes, what a 404 is turned into — rather than
 * Forgejo's behaviour, which the integration suites test against the real thing.
 * The two halves are deliberately different tests: this one can prove "a second
 * run issues no writes", which is a property of this codebase, and only a real
 * instance can prove "a scoped token cannot clone another repository", which is
 * a property of Forgejo.
 */

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly auth: string;
}

/** A canned answer, matched on `METHOD /path`. */
export interface Route {
  readonly status?: number;
  readonly body?: unknown;
  /** Thrown instead of answering. For proving a failure path. */
  readonly error?: Error;
  /**
   * What this path answers from the *next* call onwards.
   *
   * The only way to express the race the provider's idempotency exists for: a
   * repository that is absent when we check and present when we create. A single
   * canned answer per path cannot say that, and a test that could not say it
   * would be testing the easy half.
   */
  readonly then?: Route;
}

export interface FakeForgejo extends ForgejoClient {
  readonly calls: readonly RecordedCall[];
  /** Just the calls that could change something. What an idempotency test counts. */
  readonly writes: readonly RecordedCall[];
  /** Replaces the answer for `METHOD /path` — e.g. after a "create" made it exist. */
  route(key: string, route: Route): void;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createFakeForgejo(
  routes: Record<string, Route> = {},
  baseUrl = 'https://git.test',
): FakeForgejo {
  const table = new Map(Object.entries(routes));
  const calls: RecordedCall[] = [];

  return {
    baseUrl,
    calls,
    get writes() {
      return calls.filter((call) => WRITE_METHODS.has(call.method));
    },
    route(key, route) {
      table.set(key, route);
    },
    send<T>(request: ForgejoRequest): Promise<ForgejoResponse<T>> {
      const auth = request.auth ?? { kind: 'admin' as const };
      calls.push({
        method: request.method,
        path: request.path,
        body: request.body,
        auth: auth.kind,
      });

      const key = `${request.method} ${request.path}`;
      const route = table.get(key);
      if (route?.then !== undefined) {
        table.set(key, route.then);
      }
      if (route?.error !== undefined) {
        return Promise.reject(route.error);
      }
      const status = route?.status ?? (route === undefined ? 404 : 200);
      if (status >= 300 && !(request.allow ?? []).includes(status)) {
        // The real client throws for an unallowed non-2xx, and a fake that
        // returned one instead would let a test pass against code that never
        // checks. The real error class, not a lookalike: callers branch on
        // `instanceof ForgejoError` and on `.status`, and a double that failed
        // that check would exercise the wrong branch.
        return Promise.reject(new ForgejoError(request.method, request.path, status, 'fake'));
      }
      return Promise.resolve({ status, body: route?.body as T | undefined });
    },
  };
}
