import type { RedisCommands } from '../redis/client.js';

/**
 * Revocation for tokens that are otherwise still valid.
 *
 * A signed JWT is only as revocable as the list you check it against: logging
 * out, or spending a refresh token, has to make a token that still verifies
 * stop working. Entries are keyed by `jti` — or by {@link sessionFamilyKey} for
 * a whole login — and expire with what they revoke, so the list stays bounded
 * by the number of *unexpired* sessions rather than growing forever.
 */
export interface TokenDenylist {
  /**
   * Revokes `key` until `expiresAt`.
   *
   * Returns whether *this call* is the one that revoked it: `false` means the
   * key was already denied. That makes the write the test as well, which is
   * what lets refresh rotation be atomic — two concurrent presentations of one
   * refresh token both verify, and exactly one of them gets `true`. A
   * read-then-write leaves a gap that both can pass through.
   *
   * Maps to Redis `SET key "" NX PX <ttl>` at CP-5, whose reply is exactly this
   * boolean.
   */
  deny(key: string, expiresAt: Date): Promise<boolean>;
  /**
   * Whether *any* of `keys` is denied. Variadic so a caller can check a token
   * and its session family in one round trip (Redis `EXISTS k1 k2`) rather than
   * paying twice on the hot path.
   */
  isDenied(...keys: string[]): Promise<boolean>;
}

/**
 * The key that revokes an entire login rather than one token.
 *
 * Prefixed so it can never collide with a `jti`: both are hex, and a namespace
 * is cheaper than a proof that they cannot coincide.
 */
export function sessionFamilyKey(sessionId: string): string {
  return `sid:${sessionId}`;
}

/** Namespace, so a denied `jti` cannot collide with any other key in the database. */
const KEY_PREFIX = 'deny:';

/**
 * The shipping implementation (CP-5), and the reason {@link TokenDenylist.deny}
 * returns a boolean: `SET key "" NX PX <ttl>` answers `OK` for the caller that
 * created the key and `nil` for everyone after, so the *write* decides who spent
 * a refresh token. A `GET` followed by a `SET` would let two concurrent
 * presentations of one token both pass, which is precisely the reuse this exists
 * to detect.
 *
 * Expiry is Redis', not ours: an entry outlives the token it revokes by nothing,
 * so the list stays bounded by the number of unexpired sessions rather than
 * growing forever, and there is no sweep to get wrong.
 */
export function createRedisTokenDenylist(
  redis: RedisCommands,
  now: () => Date = () => new Date(),
): TokenDenylist {
  return {
    async deny(key, expiresAt) {
      const ttl = expiresAt.getTime() - now().getTime();
      // Already expired: there is nothing left to revoke, and writing a key
      // with a non-positive TTL is an error rather than a no-op.
      if (ttl <= 0) {
        return false;
      }
      return await redis.setIfAbsent(`${KEY_PREFIX}${key}`, '', ttl);
    },

    async isDenied(...keys) {
      return await redis.exists(keys.map((key) => `${KEY_PREFIX}${key}`));
    },
  };
}

/**
 * Process-local, and therefore correct only for a single instance — kept for
 * tests and for a single-process development run. {@link createRedisTokenDenylist}
 * is what a deployment uses; `buildApp` refuses to fall back to this one outside
 * development, because a multi-instance deployment would otherwise honour a
 * logout only on the instance that served it.
 */
export function createInMemoryTokenDenylist(now: () => Date = () => new Date()): TokenDenylist {
  const entries = new Map<string, number>();

  /** Amortised cleanup: a token that has expired can no longer be presented. */
  function sweep(at: number): void {
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= at) {
        entries.delete(key);
      }
    }
  }

  return {
    deny(key, expiresAt) {
      const at = now().getTime();
      sweep(at);
      // Nothing is awaited between the read and the write, so on one event loop
      // turn this is as atomic as the Redis primitive it stands in for.
      if (entries.has(key) || expiresAt.getTime() <= at) {
        return Promise.resolve(false);
      }
      entries.set(key, expiresAt.getTime());
      return Promise.resolve(true);
    },

    isDenied(...keys) {
      const at = now().getTime();
      return Promise.resolve(
        keys.some((key) => {
          const expiresAt = entries.get(key);
          return expiresAt !== undefined && expiresAt > at;
        }),
      );
    },
  };
}
