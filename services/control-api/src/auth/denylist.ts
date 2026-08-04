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

/**
 * Process-local, and therefore correct only for a single instance.
 *
 * This is deliberate and temporary: the Upstash Redis client is a locked stack
 * decision (master plan §2) and arrives with the rate-limit and fanout work in
 * CP-5, at which point this becomes `SET NX PX` behind the same interface and
 * every caller stays as written. Until then a multi-instance deployment would
 * honour a logout only on the instance that served it — which is why this ships
 * behind a port instead of a `Map` in a route handler, and why `buildApp`
 * refuses to fall back to it in production.
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
