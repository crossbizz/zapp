import { Redis } from 'ioredis';

import type { EventWakeupSource, EventWakeupSubscription } from '../events/sse.js';

/**
 * The shared state this service keeps outside its own process.
 *
 * Everything CP-2 and CP-3 deferred to CP-5 — the token denylist, the device
 * grants, the invitations — plus this task's own idempotency records and rate
 * limit buckets, live here. All five were built behind ports for exactly this
 * moment: the implementations change, the callers do not.
 *
 * **Vendor:** Upstash (master plan §2, locked). **Client:** `ioredis`, because
 * the locked decision names the managed service, not the npm package, and the
 * only wire protocol that works in all three environments we have to run in is
 * RESP over `REDIS_URL`: the dev stack (`infra/docker/docker-compose.dev.yml`)
 * and both CI jobs run a plain `redis:7` container, which has no REST endpoint
 * for `@upstash/redis` to talk to. Upstash speaks RESP over TLS (`rediss://`),
 * so one client and one URL cover local, CI and production.
 *
 * **The interface is narrow on purpose.** Seven commands, and `eval` is one of
 * them: every operation that has to be atomic — spending a refresh token,
 * claiming an invite, taking a token from a bucket — is a Lua script rather than
 * a read followed by a write, because a read followed by a write is how two
 * concurrent callers both succeed.
 */

/** The commands the stores below this line use. Nothing else is reachable. */
export interface RedisCommands {
  get(key: string): Promise<string | null>;
  /** `SET key value PX ttl`. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /**
   * `SET key value PX ttl NX` — true when *this call* created the key.
   *
   * The write is the test, which is what makes refresh-token rotation atomic
   * (`src/auth/denylist.ts`) and an idempotency reservation exclusive.
   */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** `EXISTS k1 k2 …` — true when any of them is present. One round trip. */
  exists(keys: readonly string[]): Promise<boolean>;
  delete(keys: readonly string[]): Promise<void>;
  /** `EVAL` — several reads and writes as one step. */
  eval(
    script: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown>;
}

/** The pub/sub write kept separate from the request-store command surface. */
export interface RedisPublisher {
  publish(channel: string, body: string): Promise<number>;
}

export interface RedisConnection extends RedisCommands, RedisPublisher, EventWakeupSource {
  close(): Promise<void>;
}

/**
 * How long a single command may take before it is treated as a failure.
 *
 * Deliberately short. A rate limiter or an idempotency lookup that waits on an
 * unreachable Redis turns one broken dependency into a service-wide stall, and
 * the plugins above are written to *decide* on a failure (fail open for reads,
 * closed for auth) — they can only do that if the failure arrives promptly.
 */
const COMMAND_TIMEOUT_MS = 1_000;
const CONNECT_TIMEOUT_MS = 2_000;

export interface RedisConnectionOptions {
  /** Milliseconds a command may take before it fails. Lowered in tests. */
  readonly commandTimeoutMs?: number;
  /** Called on every connection-level error, so a service can log it once. */
  readonly onError?: (error: Error) => void;
}

/**
 * Opens the pool. Every command is bounded, and no failure is silent.
 *
 * `commandTimeout` is the load-bearing setting, and ioredis applies it when the
 * command is *created* rather than when it is written — so it bounds a command
 * issued while the connection is still coming up or reconnecting, not merely
 * one in flight. That is what lets the offline queue stay on: a cold start or a
 * blink of a reconnect is absorbed instead of failing the requests that land in
 * it, while a genuine outage still surfaces as an error within a second rather
 * than as a request that hangs. `maxRetriesPerRequest: 1` bounds it from the
 * other side.
 */
export function createRedisConnection(
  url: string,
  options: RedisConnectionOptions = {},
): RedisConnection {
  const client = new Redis(url, {
    commandTimeout: options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });

  // Without a handler ioredis emits `error` on the client, which is an
  // unhandled 'error' event and therefore a process crash. A cache outage must
  // not be able to take the API down.

  client.on('error', (error: Error) => {
    options.onError?.(error);
  });
  // Kicks the lazy connection off without awaiting it: the process must come up
  // and serve `/healthz` whether or not Redis is reachable yet.
  void client.connect().catch(() => {
    // Reported through `onError` above; a rejection here would be a second copy
    // of the same event, and an unhandled one.
  });

  return {
    async get(key) {
      return await client.get(key);
    },
    async set(key, value, ttlMs) {
      await client.set(key, value, 'PX', Math.max(1, Math.ceil(ttlMs)));
    },
    async setIfAbsent(key, value, ttlMs) {
      const reply = await client.set(key, value, 'PX', Math.max(1, Math.ceil(ttlMs)), 'NX');
      // `OK` when it was set, `null` when the key already existed.
      return reply !== null;
    },
    async exists(keys) {
      if (keys.length === 0) {
        return false;
      }
      return (await client.exists(...keys)) > 0;
    },
    async delete(keys) {
      if (keys.length > 0) {
        await client.del(...keys);
      }
    },
    async eval(script, keys, args) {
      return await client.eval(script, keys.length, ...keys, ...args);
    },
    async publish(channel, body) {
      return await client.publish(channel, body);
    },
    async subscribe(channel): Promise<EventWakeupSubscription> {
      const subscriber = new Redis(url, {
        commandTimeout: options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
        connectTimeout: CONNECT_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
      let queued: string | undefined;
      let waiter:
        | { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
        | undefined;
      let closed = false;
      const fail = (error: Error): void => {
        try {
          options.onError?.(error);
        } catch {
          // Diagnostics cannot become a pub/sub failure of their own.
        }
        const pending = waiter;
        waiter = undefined;
        pending?.reject(error);
      };
      const receive = (receivedChannel: string, message: string): void => {
        if (closed || receivedChannel !== channel) return;
        const pending = waiter;
        waiter = undefined;
        if (pending === undefined) queued = message;
        else pending.resolve(message);
      };
      subscriber.on('error', fail);
      subscriber.on('message', receive);
      try {
        await subscriber.connect();
        await subscriber.subscribe(channel);
      } catch (error) {
        closed = true;
        subscriber.removeListener('error', fail);
        subscriber.removeListener('message', receive);
        subscriber.disconnect();
        throw error;
      }
      return {
        next() {
          if (closed) return Promise.reject(new Error('Redis subscription is closed'));
          const message = queued;
          queued = undefined;
          if (message !== undefined) return Promise.resolve(message);
          if (waiter !== undefined) {
            return Promise.reject(new Error('Redis subscription already has a pending waiter'));
          }
          return new Promise<unknown>((resolve, reject) => {
            waiter = { resolve, reject };
          });
        },
        async close() {
          if (closed) return;
          closed = true;
          const pending = waiter;
          waiter = undefined;
          pending?.reject(new Error('Redis subscription closed'));
          try {
            await subscriber.unsubscribe(channel);
            await subscriber.quit();
          } catch {
            subscriber.disconnect();
          } finally {
            subscriber.removeListener('error', fail);
            subscriber.removeListener('message', receive);
          }
        },
      };
    },
    async close() {
      // `quit` drains; `disconnect` is the fallback for a client that never
      // reached a connected state, where `quit` would reject.
      await client.quit().catch(() => {
        client.disconnect();
      });
    },
  };
}
