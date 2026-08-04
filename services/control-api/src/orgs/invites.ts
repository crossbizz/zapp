import { createHash, randomBytes } from 'node:crypto';

import type { Role } from '../policy/permissions.js';

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
 *
 * Storage is process-local for now, like CP-2's denylist and device store: PRD
 * §23 defines no invite table, and adding one belongs to whoever owns
 * `packages/db`. CP-5 replaces the implementation behind this interface — the
 * routes, the hashing and every rule above stay as written.
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
export type InviteClaim =
  | { readonly status: 'claimed'; readonly invite: InviteRecord }
  | { readonly status: 'unknown' }
  | { readonly status: 'expired' }
  | { readonly status: 'used' }
  | { readonly status: 'email_mismatch'; readonly invite: InviteRecord };

export interface InviteStore {
  issue(invite: NewInvite): Promise<void>;
  /**
   * Spends the invite named by `tokenHash`, if `email` is the address it was
   * issued to. A mismatch does **not** spend it: the wrong person following a
   * link must not burn an invite for the right one.
   */
  claim(input: { tokenHash: string; email: string }): Promise<InviteClaim>;
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

/**
 * Process-local, and therefore single-instance — the same trade, and the same
 * temporary status, as {@link import('../auth/denylist.js').createInMemoryTokenDenylist}.
 * `buildApp` refuses to default to it in production.
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

    claim({ tokenHash, email }) {
      const at = now().getTime();
      const invite = invites.get(tokenHash);
      if (invite === undefined) {
        return Promise.resolve({ status: 'unknown' } as const);
      }

      const { usedAt, ...record } = invite;
      if (usedAt !== undefined) {
        return Promise.resolve({ status: 'used' } as const);
      }
      if (invite.expiresAt.getTime() <= at) {
        return Promise.resolve({ status: 'expired' } as const);
      }
      if (invite.email !== email) {
        return Promise.resolve({ status: 'email_mismatch', invite: record } as const);
      }

      // Nothing is awaited between the read and the write, so on one event loop
      // turn this is as single-use as the `UPDATE … WHERE used_at IS NULL` that
      // replaces it.
      invites.set(tokenHash, { ...invite, usedAt: new Date(at) });
      return Promise.resolve({ status: 'claimed', invite: record } as const);
    },
  };
}
