import { createHash } from 'node:crypto';

import { IdempotencyHeader } from '@zapp/contracts';
import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import fp from 'fastify-plugin';

import { ApiError } from '../errors.js';
import type { RedisCommands } from '../redis/client.js';

/**
 * `Idempotency-Key`, as PRD §36.1 and plan 02 §Global Constraints require of
 * every mutating route.
 *
 * A client that retries a request it never saw the answer to — a dropped
 * connection, a proxy timeout, a phone changing networks mid-POST — must not
 * create a second organization, a second project, or a second invitation. So
 * the first request with a key reserves it, the response is stored under it for
 * 24 hours, and a repeat gets that stored response back with
 * `x-idempotent-replay: true` instead of running the handler again.
 *
 * Four rules, and each of them is a decision somebody will ask about:
 *
 * 1. **The key is scoped, not global.** It is combined with the organization
 *    (or the caller) so one tenant's keys can neither collide with nor probe
 *    another's.
 * 2. **Same key, different request → 422.** The body, the method and the path
 *    are hashed into a fingerprint. A key that comes back with a different
 *    fingerprint is a client bug — reusing a key for a second, different
 *    mutation — and answering with the *first* response would be worse than
 *    refusing: it would report success for something that never happened.
 * 3. **A duplicate that is still in flight → 409, not a wait.** Holding the
 *    second request open until the first finishes turns a retry storm into
 *    exhausted connections, and the client already has a retry loop — telling
 *    it `409 idempotency_in_progress` with `retry-after: 1` hands the decision
 *    back to the caller that owns it. (Both are defensible; this is the one
 *    this service implements, and `test/plugins.test.ts` pins it.)
 * 4. **Only a success is stored.** A reservation whose handler answered 4xx or
 *    5xx is released, so the client may fix the request and try again with the
 *    same key. Storing a failure would make a transient 500 permanent for 24
 *    hours.
 *
 * A reservation is short-lived (a minute) and only the *completed* record lives
 * for 24 hours — otherwise a process that died mid-handler would leave a key
 * that answers 409 for a day.
 *
 * **The stored body may contain a credential** — `POST /v1/organizations/:id/invites`
 * returns the one legible copy of an invite token. That is deliberate: the
 * alternative is a retry minting a second invitation, and the record expires in
 * 24 hours in the same store that already holds this service's session denylist
 * and invite hashes. Anything with a longer life than that does not belong in a
 * response body in the first place.
 */

/** Set on a replayed response, and only on one. Absence means the handler ran. */
export const IDEMPOTENT_REPLAY_HEADER = 'x-idempotent-replay';

/** How long a reservation is held while the handler runs. */
export const RESERVATION_TTL_MS = 60_000;

/** How long a completed response is replayable — PRD §36.1's 24 hours. */
export const RECORD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Responses larger than this are not stored, and their reservation is released.
 * An unbounded copy of every response would make the idempotency store the
 * API's memory, and the routes that mint something worth replaying all answer
 * in well under a kilobyte.
 */
const MAX_STORED_BODY_BYTES = 64 * 1024;

/** What a replay sends back. Headers beyond the content type are not preserved. */
export interface StoredResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly contentType: string | undefined;
}

export type IdempotencyEntry =
  | { readonly state: 'pending'; readonly fingerprint: string }
  | {
      readonly state: 'completed';
      readonly fingerprint: string;
      readonly response: StoredResponse;
    };

export interface IdempotencyStore {
  /**
   * Reserves `key` for this request. `undefined` means the reservation is ours
   * and the handler should run; anything else is the entry that was already
   * there. The reservation and the read are one step — two concurrent retries
   * must not both be told to proceed.
   */
  reserve(key: string, fingerprint: string, ttlMs: number): Promise<IdempotencyEntry | undefined>;
  complete(
    key: string,
    fingerprint: string,
    response: StoredResponse,
    ttlMs: number,
  ): Promise<void>;
  /** Drops a reservation that produced nothing worth replaying. Never touches a completed record. */
  release(key: string): Promise<void>;
}

const RESERVE = `
  if redis.call('EXISTS', KEYS[1]) == 1 then
    return redis.call('HMGET', KEYS[1], 'state', 'fingerprint', 'status', 'body', 'contentType')
  end
  redis.call('HSET', KEYS[1], 'state', 'pending', 'fingerprint', ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return false
`;

const COMPLETE = `
  redis.call('HSET', KEYS[1],
    'state', 'completed', 'fingerprint', ARGV[1],
    'status', ARGV[2], 'body', ARGV[3], 'contentType', ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return 1
`;

const RELEASE = `
  if redis.call('HGET', KEYS[1], 'state') == 'pending' then
    redis.call('DEL', KEYS[1])
    return 1
  end
  return 0
`;

/** The `[state, fingerprint, status, body, contentType]` array {@link RESERVE} returns. */
function parseEntry(reply: unknown): IdempotencyEntry | undefined {
  if (!Array.isArray(reply)) {
    return undefined;
  }
  const [state, fingerprint, status, body, contentType] = reply as unknown[];
  if (typeof fingerprint !== 'string') {
    return undefined;
  }
  if (state === 'completed' && typeof status === 'string' && typeof body === 'string') {
    return {
      state: 'completed',
      fingerprint,
      response: {
        statusCode: Number(status),
        body,
        contentType: typeof contentType === 'string' ? contentType : undefined,
      },
    };
  }
  return { state: 'pending', fingerprint };
}

export function createRedisIdempotencyStore(redis: RedisCommands): IdempotencyStore {
  return {
    async reserve(key, fingerprint, ttlMs) {
      return parseEntry(await redis.eval(RESERVE, [key], [fingerprint, Math.ceil(ttlMs)]));
    },
    async complete(key, fingerprint, response, ttlMs) {
      await redis.eval(
        COMPLETE,
        [key],
        [
          fingerprint,
          String(response.statusCode),
          response.body,
          response.contentType ?? '',
          Math.ceil(ttlMs),
        ],
      );
    },
    async release(key) {
      await redis.eval(RELEASE, [key], []);
    },
  };
}

interface StoredEntry {
  entry: IdempotencyEntry;
  expiresAt: number;
}

/**
 * Process-local — for tests and a single-process development run. `buildApp`
 * refuses to fall back to it outside development: a key reserved on one
 * instance is unknown to the next, which is exactly the retry the header exists
 * to survive.
 */
export function createInMemoryIdempotencyStore(
  now: () => Date = () => new Date(),
): IdempotencyStore {
  const entries = new Map<string, StoredEntry>();

  function live(key: string): StoredEntry | undefined {
    const found = entries.get(key);
    if (found === undefined) {
      return undefined;
    }
    if (found.expiresAt <= now().getTime()) {
      entries.delete(key);
      return undefined;
    }
    return found;
  }

  return {
    reserve(key, fingerprint, ttlMs) {
      const found = live(key);
      if (found !== undefined) {
        return Promise.resolve(found.entry);
      }
      // Nothing is awaited between the read and the write, so on one event loop
      // turn this is as exclusive as the Lua script above.
      entries.set(key, {
        entry: { state: 'pending', fingerprint },
        expiresAt: now().getTime() + ttlMs,
      });
      return Promise.resolve(undefined);
    },
    complete(key, fingerprint, response, ttlMs) {
      entries.set(key, {
        entry: { state: 'completed', fingerprint, response },
        expiresAt: now().getTime() + ttlMs,
      });
      return Promise.resolve();
    },
    release(key) {
      if (live(key)?.entry.state === 'pending') {
        entries.delete(key);
      }
      return Promise.resolve();
    },
  };
}

/**
 * What the key has to look like before it is used to address anything.
 *
 * Bounded and free of separators, for the reason CP-1 bounds the request id: it
 * is concatenated into a store key and copied into a log line.
 */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,255}$/;

/**
 * A stable rendering of the request body — object key order is not part of what
 * a client asked for, so `{a,b}` and `{b,a}` must not read as two different
 * requests under one key.
 */
function canonical(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([field, nested]) => `${JSON.stringify(field)}:${canonical(nested)}`)
    .join(',')}}`;
}

/** Method, path and body — everything that decides what a request *does*. */
function fingerprintOf(request: FastifyRequest): string {
  return createHash('sha256')
    .update(`${request.method}\n${request.url}\n${canonical(request.body)}`)
    .digest('hex');
}

/**
 * The scope a key lives in: one tenant's keys can neither collide with nor be
 * probed by another's.
 */
function scopeOf(request: FastifyRequest): string {
  const organizationId = request.tenant?.organizationId;
  if (organizationId !== undefined) {
    return `org:${organizationId}`;
  }
  const userId = request.auth?.userId;
  return userId === undefined ? `ip:${request.ip}` : `user:${userId}`;
}

/** The plugin's own bookkeeping for the request in flight. */
interface IdempotencyState {
  readonly key: string;
  readonly fingerprint: string;
  /** True once a stored response has been sent, so `onSend` does not store it again. */
  replayed: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Internal to the idempotency plugin; `undefined` when the header was absent. */
    idempotency?: IdempotencyState;
  }
}

export interface IdempotencyOptions {
  readonly store: IdempotencyStore;
}

function conflict(): ApiError {
  return new ApiError(
    'idempotency_conflict',
    422,
    'That Idempotency-Key was already used for a different request.',
  );
}

function inProgress(): ApiError {
  return new ApiError(
    'idempotency_in_progress',
    409,
    'A request with that Idempotency-Key is still being processed.',
  );
}

/** Read-only methods carry nothing to replay, so they are never enrolled. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const idempotency = fp<IdempotencyOptions>(
  (app, options, done) => {
    const { store } = options;

    app.decorateRequest('idempotency', undefined);

    async function reserve(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const header = request.headers[IdempotencyHeader];
      const submitted = (Array.isArray(header) ? header[0] : header)?.trim() ?? '';
      if (submitted === '') {
        return;
      }
      if (!KEY_PATTERN.test(submitted)) {
        throw new ApiError(
          'idempotency_key_invalid',
          400,
          `The ${IdempotencyHeader} header must be 8–255 characters of [A-Za-z0-9._:-].`,
        );
      }

      const key = `idem:${scopeOf(request)}:${submitted}`;
      const fingerprint = fingerprintOf(request);

      let existing: IdempotencyEntry | undefined;
      try {
        existing = await store.reserve(key, fingerprint, RESERVATION_TTL_MS);
      } catch (error) {
        // Fails closed, and only for the caller who asked for exactly-once: a
        // client that sent a key is entitled to be told we cannot honour it,
        // rather than to be given at-least-once semantics it did not ask for.
        // Requests without the header are untouched by this.
        request.log.error({ err: error }, 'idempotency store unavailable');
        reply.header('retry-after', '1');
        throw new ApiError(
          'idempotency_unavailable',
          503,
          'Idempotent replay is temporarily unavailable. Please retry in a moment.',
        );
      }

      if (existing === undefined) {
        request.idempotency = { key, fingerprint, replayed: false };
        return;
      }
      if (existing.fingerprint !== fingerprint) {
        throw conflict();
      }
      if (existing.state === 'pending') {
        reply.header('retry-after', '1');
        throw inProgress();
      }

      request.idempotency = { key, fingerprint, replayed: true };
      reply.header(IDEMPOTENT_REPLAY_HEADER, 'true');
      if (existing.response.contentType !== undefined && existing.response.contentType !== '') {
        reply.header('content-type', existing.response.contentType);
      }
      // A string payload is sent as it stands, which is what makes this a
      // replay of the stored bytes rather than a re-serialization of them
      // through this route's own response schema.
      await reply.status(existing.response.statusCode).send(existing.response.body || undefined);
    }

    app.addHook('onRoute', (route: RouteOptions) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      if (methods.every((method) => READ_METHODS.has(method.toUpperCase()))) {
        return;
      }
      const existing = route.preHandler;
      route.preHandler =
        existing === undefined
          ? [reserve]
          : [...(Array.isArray(existing) ? existing : [existing]), reserve];
    });

    app.addHook('onSend', async (request, reply, payload: unknown) => {
      const state = request.idempotency;
      if (state === undefined || state.replayed) {
        return payload;
      }

      const body = typeof payload === 'string' ? payload : '';
      const storable =
        reply.statusCode >= 200 &&
        reply.statusCode < 300 &&
        (payload === undefined || payload === null || typeof payload === 'string') &&
        Buffer.byteLength(body) <= MAX_STORED_BODY_BYTES;

      if (storable) {
        const contentType = reply.getHeader('content-type');
        await store.complete(
          state.key,
          state.fingerprint,
          {
            statusCode: reply.statusCode,
            body,
            contentType: typeof contentType === 'string' ? contentType : undefined,
          },
          RECORD_TTL_MS,
        );
      } else {
        // A failure, a stream, or something too large to keep: the key goes
        // back so the client can retry with it.
        await store.release(state.key);
      }
      return payload;
    });

    done();
  },
  { name: 'idempotency', fastify: '5.x' },
);
