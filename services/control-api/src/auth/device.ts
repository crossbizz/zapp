import { randomBytes } from 'node:crypto';

/**
 * The desktop sign-in handshake (RFC 8628 in shape, zapp in spelling).
 *
 * The macOS app cannot host a redirect URI, so it asks for a grant, sends the
 * human to a browser, and polls until that browser leg finishes. Two secrets,
 * two audiences: the `deviceCode` is long and machine-only, the `userCode` is
 * short enough to survive being carried between windows — which is exactly why
 * it is single-use, short-lived, and drawn from an alphabet with no characters
 * a person can confuse.
 */

/** Long enough that polling with guesses is pointless. */
const DEVICE_CODE_BYTES = 32;
/** Ten minutes to walk to a browser and back. */
export const DEVICE_GRANT_TTL_MS = 10 * 60 * 1000;
/** Seconds the client is told to wait between polls. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/** No I, O, S, U, 0 or 1: a human reads this off one screen and types it into another. */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTVWXYZ2346789';
const USER_CODE_GROUP = 4;

export interface DeviceGrant {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresAt: Date;
}

export type DeviceClaim =
  /** Issued, unexpired, nobody has approved it yet. */
  | { readonly status: 'pending' }
  /** Never issued, already spent, or swept. Both cases answer the same thing. */
  | { readonly status: 'unknown' }
  | { readonly status: 'expired' }
  /** A signed-in human looked at this code and said no. */
  | { readonly status: 'denied' }
  | { readonly status: 'approved'; readonly userId: string };

export interface DeviceStore {
  start(): Promise<DeviceGrant>;
  /**
   * Binds a grant to the human who approved it — and it is *that* human whose
   * session the device receives, which is why approval has to be an explicit,
   * authenticated act rather than a side effect of signing in. `false` when
   * there is no such pending grant.
   */
  approve(userCode: string, userId: string): Promise<boolean>;
  /** Refuses a grant outright, so the polling device is told rather than left waiting. */
  deny(userCode: string): Promise<boolean>;
  /** Reads *and spends* an approved grant: a device code buys exactly one token. */
  claim(deviceCode: string): Promise<DeviceClaim>;
}

/**
 * The largest multiple of the alphabet that fits in a byte. Bytes at or above
 * it are discarded rather than folded with `%`, which would make the first
 * `256 % 29` characters likelier than the rest — a small bias, but this is a
 * short code that someone can be socially engineered into typing, so its
 * entropy should be exactly what it looks like.
 */
const UNBIASED_LIMIT = Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length;

function userCode(): string {
  const characters: string[] = [];
  const wanted = USER_CODE_GROUP * 2;
  while (characters.length < wanted) {
    for (const byte of randomBytes(wanted)) {
      const character = USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
      if (byte < UNBIASED_LIMIT && character !== undefined && characters.length < wanted) {
        characters.push(character);
      }
    }
  }
  return `${characters.slice(0, USER_CODE_GROUP).join('')}-${characters.slice(USER_CODE_GROUP).join('')}`;
}

interface StoredGrant {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresAt: number;
  userId?: string;
  denied?: boolean;
}

/**
 * Process-local, like {@link import('./denylist.js').createInMemoryTokenDenylist}
 * and for the same reason: CP-5 moves this to Redis so any instance can serve
 * the poll that follows a browser leg another instance handled. Until then a
 * device login only completes when both requests reach the same process.
 */
export function createInMemoryDeviceStore(now: () => Date = () => new Date()): DeviceStore {
  const byDeviceCode = new Map<string, StoredGrant>();
  const byUserCode = new Map<string, StoredGrant>();

  function sweep(at: number): void {
    for (const [code, grant] of byDeviceCode) {
      if (grant.expiresAt <= at) {
        byDeviceCode.delete(code);
        byUserCode.delete(grant.userCode);
      }
    }
  }

  return {
    start() {
      const at = now().getTime();
      sweep(at);
      const grant: StoredGrant = {
        deviceCode: randomBytes(DEVICE_CODE_BYTES).toString('hex'),
        userCode: userCode(),
        expiresAt: at + DEVICE_GRANT_TTL_MS,
      };
      byDeviceCode.set(grant.deviceCode, grant);
      byUserCode.set(grant.userCode, grant);
      return Promise.resolve({
        deviceCode: grant.deviceCode,
        userCode: grant.userCode,
        expiresAt: new Date(grant.expiresAt),
      });
    },

    approve(code, userId) {
      const grant = byUserCode.get(code.toUpperCase());
      // An already-decided grant is not re-decidable: a second approval would
      // let one code be pointed at a second identity.
      if (
        grant === undefined ||
        grant.expiresAt <= now().getTime() ||
        grant.denied === true ||
        grant.userId !== undefined
      ) {
        return Promise.resolve(false);
      }
      grant.userId = userId;
      return Promise.resolve(true);
    },

    deny(code) {
      const grant = byUserCode.get(code.toUpperCase());
      if (grant === undefined || grant.expiresAt <= now().getTime()) {
        return Promise.resolve(false);
      }
      grant.denied = true;
      // The userId is cleared as well: denying after approving is a person
      // changing their mind, and the later answer is the one that counts.
      delete grant.userId;
      return Promise.resolve(true);
    },

    claim(deviceCode) {
      const grant = byDeviceCode.get(deviceCode);
      if (grant === undefined) {
        return Promise.resolve({ status: 'unknown' } as const);
      }
      if (grant.expiresAt <= now().getTime()) {
        byDeviceCode.delete(grant.deviceCode);
        byUserCode.delete(grant.userCode);
        return Promise.resolve({ status: 'expired' } as const);
      }
      if (grant.denied === true) {
        byDeviceCode.delete(grant.deviceCode);
        byUserCode.delete(grant.userCode);
        return Promise.resolve({ status: 'denied' } as const);
      }
      if (grant.userId === undefined) {
        return Promise.resolve({ status: 'pending' } as const);
      }
      // Spent: the token has been handed over, and the code that bought it is
      // now just a string in somebody's poll loop.
      byDeviceCode.delete(grant.deviceCode);
      byUserCode.delete(grant.userCode);
      return Promise.resolve({ status: 'approved', userId: grant.userId } as const);
    },
  };
}
