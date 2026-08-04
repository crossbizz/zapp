/**
 * Revocation for tokens that are otherwise still valid.
 *
 * A signed JWT is only as revocable as the list you check it against: logging
 * out, or spending a refresh token, has to make a token that still verifies
 * stop working. Entries are keyed by `jti` and expire with the token they
 * revoke, so the list stays bounded by the number of *unexpired* sessions
 * rather than growing forever.
 */
export interface TokenDenylist {
  /** Revokes `jti` until `expiresAt`, after which the token is worthless anyway. */
  deny(jti: string, expiresAt: Date): Promise<void>;
  isDenied(jti: string): Promise<boolean>;
}

/**
 * Process-local, and therefore correct only for a single instance.
 *
 * This is deliberate and temporary: the Upstash Redis client is a locked stack
 * decision (master plan §2) and arrives with the rate-limit and fanout work in
 * CP-5, at which point this becomes `SETEX jti "" <ttl>` behind the same
 * interface and every caller stays as written. Until then a multi-instance
 * deployment would honour a logout only on the instance that served it — which
 * is why this ships behind a port instead of a `Map` in a route handler.
 */
export function createInMemoryTokenDenylist(now: () => Date = () => new Date()): TokenDenylist {
  const entries = new Map<string, number>();

  /** Amortised cleanup: a token that has expired can no longer be presented. */
  function sweep(at: number): void {
    for (const [jti, expiresAt] of entries) {
      if (expiresAt <= at) {
        entries.delete(jti);
      }
    }
  }

  return {
    deny(jti, expiresAt) {
      const at = now().getTime();
      sweep(at);
      if (expiresAt.getTime() > at) {
        entries.set(jti, expiresAt.getTime());
      }
      return Promise.resolve();
    },

    isDenied(jti) {
      const expiresAt = entries.get(jti);
      return Promise.resolve(expiresAt !== undefined && expiresAt > now().getTime());
    },
  };
}
