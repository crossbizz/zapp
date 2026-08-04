import { newId } from '@zapp/contracts';
import { users, type Database } from '@zapp/db';

import type { AuthIdentity } from './port.js';

/**
 * The identity half of `packages/db`, as the auth routes use it.
 *
 * A port rather than a raw `Database` so route tests need no PostgreSQL, and so
 * the two statements a login actually performs stay visible in one file instead
 * of being spread through handlers.
 */

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface ProfileMembership {
  readonly organization: { readonly id: string; readonly name: string; readonly slug: string };
  readonly role: 'owner' | 'builder' | 'viewer';
  readonly status: 'invited' | 'active' | 'removed';
}

export interface UserProfile {
  readonly user: SessionUser;
  readonly memberships: readonly ProfileMembership[];
}

export interface UserStore {
  /**
   * First login creates the row; every later one updates it. Returns the row
   * either way — the caller cannot tell, and must not care.
   */
  upsertFromIdentity(identity: AuthIdentity, now: Date): Promise<SessionUser>;
  /** `undefined` when the user no longer exists, which makes a live session stale. */
  profile(userId: string): Promise<UserProfile | undefined>;
}

/**
 * PRD §23.1 gives `users` no provider column, so **email is the link**: the
 * provider's `externalId` identifies the person to Stytch, and the address it
 * asserts identifies them to us. That is sound precisely because the address
 * comes from the provider's verified assertion and never from a request — but
 * it is the reason a provider that stops verifying email addresses would be a
 * schema change here, not a configuration one.
 */
export function createDbUserStore(db: Database): UserStore {
  return {
    async upsertFromIdentity(identity, now) {
      const [row] = await db
        .insert(users)
        .values({
          id: newId('user'),
          email: identity.email,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl ?? null,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: users.email,
          set: {
            displayName: identity.displayName,
            avatarUrl: identity.avatarUrl ?? null,
            lastSeenAt: now,
          },
        })
        .returning({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
        });

      if (row === undefined) {
        throw new Error('user upsert returned no row');
      }
      return row;
    },

    async profile(userId) {
      const user = await db.query.users.findFirst({
        where: (row, { eq }) => eq(row.id, userId),
        columns: { id: true, email: true, displayName: true, avatarUrl: true },
      });
      if (user === undefined) {
        return undefined;
      }

      // A removed membership is not a membership: it stays in the table as the
      // audit trail of an access change, and must never widen what /v1/me says
      // this user can reach.
      const rows = await db.query.memberships.findMany({
        where: (row, { and, eq, ne }) => and(eq(row.userId, userId), ne(row.status, 'removed')),
      });
      const organizationIds = rows.map((row) => row.organizationId);
      const organizations =
        organizationIds.length === 0
          ? []
          : await db.query.organizations.findMany({
              where: (row, { inArray }) => inArray(row.id, organizationIds),
              columns: { id: true, name: true, slug: true },
            });
      const byId = new Map(organizations.map((organization) => [organization.id, organization]));

      return {
        user,
        memberships: rows.flatMap((row) => {
          const organization = byId.get(row.organizationId);
          return organization === undefined
            ? []
            : [{ organization, role: row.role, status: row.status }];
        }),
      };
    },
  };
}
