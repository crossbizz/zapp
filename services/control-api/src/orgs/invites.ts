import { createHash, randomBytes } from 'node:crypto';

import { ROLES, type Role } from '../policy/permissions.js';
import type { RedisCommands } from '../redis/client.js';

/**
 * Invitations to an organization.
 *
 * An invite is a bearer credential that travels by email and lives for a week,
 * so it is handled like one:
 *
 *   - **Only the hash is stored.** {@link hashInviteToken} is what reaches the
 *     store; the token itself exists in one HTTP response and in the invitee's
 *     inbox. A dump of this store — or of the table that replaces it — grants
 *     nobody anything.
 *   - **Single use.** {@link InviteStore.claim} spends the invite in the same
 *     step that reads it, so two concurrent accepts cannot both succeed.
 *   - **Bound to an address.** The invite names who it is for; presenting it
 *     while signed in as somebody else neither works nor spends it.
 *   - **Spent only if the membership was written.** `claim` takes the work that
 *     has to happen for the invite to have been worth spending, and undoes the
 *     claim if that work fails — see {@link InviteStore.claim}.
 *
 * Storage is Redis (CP-5). PRD §23 defines no invite table, so this is not a
 * `packages/db` repository; the record is a hash with a TTL, which is the right
 * shape for a credential that expires on its own.
 */

/** PRD-adjacent product decision (plan 02 CP-3): an invite is good for a week. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 32 bytes: an invite token sits in an inbox for seven days and is the whole of
 * the credential, so it is sized against offline guessing rather than against
 * the 16-byte tokens this service uses for values that live for minutes.
 */
export function newInviteToken(): string {
  return randomBytes(32).toString('hex');
}

/** What the token looks like on the wire — used to reject junk before it is hashed. */
export const INVITE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * SHA-256, unsalted and unstretched — deliberately.
 *
 * A password needs a slow KDF because it is low-entropy and chosen by a human.
 * This token is 256 bits from the system CSPRNG, so there is nothing to brute
 * force, and the lookup has to be by exact hash for the claim to stay a single
 * atomic operation.
 */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Normalized before it is stored or compared, so `Alice@Acme.test` accepts an invite to `alice@acme.test`. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface InviteRecord {
  readonly organizationId: string;
  /** Already normalized by {@link normalizeEmail}. */
  readonly email: string;
  readonly role: Role;
  readonly invitedBy: string;
  readonly expiresAt: Date;
}

/** What `issue` is given: an {@link InviteRecord} plus the hash it is found by. */
export interface NewInvite extends InviteRecord {
  readonly tokenHash: string;
}

/**
 * Why an accept did or did not happen. Every outcome is distinct because the
 * routes answer them differently (410 for spent, 403 for the wrong person), and
 * because "expired" and "already used" are both more useful to a person than
 * "not found".
 */
export type InviteClaim<T = void> =
  | { readonly status: 'claimed'; readonly invite: InviteRecord; readonly result: T }
  | { readonly status: 'unknown' }
  | { readonly status: 'expired' }
  | { readonly status: 'used' }
  | { readonly status: 'email_mismatch'; readonly invite: InviteRecord };

export interface ClaimInput<T> {
  readonly tokenHash: string;
  /** Already normalized by {@link normalizeEmail}. */
  readonly email: string;
  /**
   * What spending the invite is *for* — writing the membership it promises.
   *
   * Runs with the invite already marked used, so a concurrent accept cannot
   * slip past it, and a rejection puts the invite back. Without this the two
   * halves are separate steps in the route, and a membership write that fails
   * strands the invitee on `410 invite_used` holding a link that can never work
   * again — an account nobody can recover without a second invitation nobody
   * knows to send (plan 02 CP-3 review).
   *
   * The invite store is Redis and the membership is a PostgreSQL row, so this
   * is a compensating action rather than one transaction. What it guarantees is
   * the property the route needs: **the invite is spent only if the membership
   * was written.**
   */
  readonly complete: (invite: InviteRecord) => Promise<T>;
}

export interface InviteStore {
  issue(invite: NewInvite): Promise<void>;
  /**
   * Spends the invite named by `tokenHash`, if `email` is the address it was
   * issued to, and runs {@link ClaimInput.complete} while it is spent. A
   * mismatch does **not** spend it: the wrong person following a link must not
   * burn an invite for the right one.
   *
   * @throws whatever `complete` throws — after restoring the invite.
   */
  claim<T>(input: ClaimInput<T>): Promise<InviteClaim<T>>;
}

interface StoredInvite extends InviteRecord {
  usedAt: Date | undefined;
}

/**
 * How long a spent or expired invite is remembered.
 *
 * Forgetting it immediately would be cheaper and worse: the answer to a reused
 * link would decay from "this invite has already been used" into "no such
 * invite", which is the one thing the person following it cannot act on.
 */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const KEY_PREFIX = 'invite:';

/**
 * Read the invite and spend it in one server-side step.
 *
 * The order of the refusals is the same as the in-memory store's, and it is not
 * arbitrary: `used` outranks `expired`, so a link someone already accepted says
 * so even after a week — "expired" would send them to ask for a new invitation
 * they do not need.
 *
 * Fields come back as an array rather than as JSON so nothing here depends on
 * `cjson`, and the reply is all strings so the client parses one shape.
 */
const CLAIM = `
  local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAt'))
  if expiresAt == nil then return {'unknown'} end
  local row = redis.call('HMGET', KEYS[1], 'organizationId', 'email', 'role', 'invitedBy', 'usedAt')
  if row[5] then return {'used'} end
  if expiresAt <= tonumber(ARGV[1]) then return {'expired'} end
  local status = 'claimed'
  if row[2] ~= ARGV[2] then
    status = 'email_mismatch'
  else
    redis.call('HSET', KEYS[1], 'usedAt', ARGV[1])
  end
  return {status, row[1], row[2], row[3], row[4], tostring(expiresAt)}
`;

/**
 * Undoes one claim, and only that claim: the timestamp we wrote has to still be
 * the one on the record, so a release can never reopen an invite somebody else
 * has since spent.
 */
const RELEASE = `
  if redis.call('HGET', KEYS[1], 'usedAt') == ARGV[1] then
    redis.call('HDEL', KEYS[1], 'usedAt')
    return 1
  end
  return 0
`;

/** `role` as this service understands it, or a refusal — never an unchecked string from a store. */
function toRole(value: string): Role {
  const role = ROLES.find((candidate) => candidate === value);
  if (role === undefined) {
    throw new Error('stored invite carries a role this service does not define');
  }
  return role;
}

/** The `{status, organizationId, email, role, invitedBy, expiresAt}` array {@link CLAIM} returns. */
function parseClaimReply(reply: unknown): { status: string; invite?: InviteRecord } {
  if (!Array.isArray(reply) || typeof reply[0] !== 'string') {
    throw new Error('invite store returned an unreadable reply');
  }
  const [status, organizationId, email, role, invitedBy, expiresAt] = reply as unknown[];
  if (
    typeof organizationId !== 'string' ||
    typeof email !== 'string' ||
    typeof role !== 'string' ||
    typeof invitedBy !== 'string' ||
    typeof expiresAt !== 'string'
  ) {
    return { status: status as string };
  }
  return {
    status: status as string,
    invite: {
      organizationId,
      email,
      role: toRole(role),
      invitedBy,
      expiresAt: new Date(Number(expiresAt)),
    },
  };
}

/**
 * The shipping implementation (CP-5): one hash per invite, addressed by the
 * token's SHA-256, expiring on its own.
 *
 * The key outlives the invite by {@link RETENTION_MS} so a spent or lapsed link
 * still answers "used" or "expired" rather than decaying into "no such invite",
 * which is the one answer the person following it cannot act on.
 */
export function createRedisInviteStore(
  redis: RedisCommands,
  now: () => Date = () => new Date(),
): InviteStore {
  return {
    async issue(invite) {
      const key = `${KEY_PREFIX}${invite.tokenHash}`;
      const ttl = invite.expiresAt.getTime() - now().getTime() + RETENTION_MS;
      await redis.eval(
        `redis.call('HSET', KEYS[1],
           'organizationId', ARGV[1], 'email', ARGV[2], 'role', ARGV[3],
           'invitedBy', ARGV[4], 'expiresAt', ARGV[5])
         redis.call('PEXPIRE', KEYS[1], ARGV[6])
         return 1`,
        [key],
        [
          invite.organizationId,
          invite.email,
          invite.role,
          invite.invitedBy,
          String(invite.expiresAt.getTime()),
          String(Math.max(1, Math.ceil(ttl))),
        ],
      );
    },

    async claim({ tokenHash, email, complete }) {
      const key = `${KEY_PREFIX}${tokenHash}`;
      const claimedAt = String(now().getTime());
      const { status, invite } = parseClaimReply(
        await redis.eval(CLAIM, [key], [claimedAt, email]),
      );

      if (invite === undefined) {
        switch (status) {
          case 'used':
            return { status: 'used' };
          case 'expired':
            return { status: 'expired' };
          default:
            return { status: 'unknown' };
        }
      }
      if (status === 'email_mismatch') {
        return { status: 'email_mismatch', invite };
      }

      try {
        return { status: 'claimed', invite, result: await complete(invite) };
      } catch (error) {
        // The invite goes back exactly as it was. Whatever failed is the
        // caller's to report; what must not happen is the invitee losing the
        // link as well as the membership.
        await redis.eval(RELEASE, [key], [claimedAt]);
        throw error;
      }
    },
  };
}

/**
 * Process-local, and therefore single-instance — kept for tests and for a
 * single-process development run. `buildApp` refuses to default to it outside
 * development, because an invite that can only be accepted against the process
 * that issued it is not an invitation.
 */
export function createInMemoryInviteStore(now: () => Date = () => new Date()): InviteStore {
  const invites = new Map<string, StoredInvite>();

  /** Amortised: an invite past its retention window can no longer be reported on. */
  function sweep(at: number): void {
    for (const [hash, invite] of invites) {
      if (invite.expiresAt.getTime() + RETENTION_MS <= at) {
        invites.delete(hash);
      }
    }
  }

  return {
    issue(invite) {
      const { tokenHash, ...record } = invite;
      sweep(now().getTime());
      invites.set(tokenHash, { ...record, usedAt: undefined });
      return Promise.resolve();
    },

    async claim({ tokenHash, email, complete }) {
      const at = now().getTime();
      const invite = invites.get(tokenHash);
      if (invite === undefined) {
        return { status: 'unknown' };
      }

      const { usedAt, ...record } = invite;
      if (usedAt !== undefined) {
        return { status: 'used' };
      }
      if (invite.expiresAt.getTime() <= at) {
        return { status: 'expired' };
      }
      if (invite.email !== email) {
        return { status: 'email_mismatch', invite: record };
      }

      // Nothing is awaited between the read and the write, so on one event loop
      // turn this is as single-use as the Lua script above.
      invites.set(tokenHash, { ...invite, usedAt: new Date(at) });
      try {
        return { status: 'claimed', invite: record, result: await complete(record) };
      } catch (error) {
        invites.set(tokenHash, { ...invite, usedAt: undefined });
        throw error;
      }
    },
  };
}
