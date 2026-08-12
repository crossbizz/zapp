import { newId } from '@zapp/contracts';
import { users, type Database } from '@zapp/db';
import { eq } from 'drizzle-orm';

import { allowedModelsFromPolicy } from '../orgs/model-policy.js';
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
  readonly allowedModels: readonly string[];
  readonly organization: { readonly id: string; readonly name: string; readonly slug: string };
  readonly role: 'owner' | 'builder' | 'viewer';
  readonly status: 'invited' | 'active' | 'removed';
}

export interface UserProfile {
  readonly user: SessionUser;
  readonly memberships: readonly ProfileMembership[];
}

export interface UserUpsertResult {
  readonly user: SessionUser;
  readonly created: boolean;
}

export interface UserStore {
  /**
   * First login creates the row; every later one updates it. Returns the row
   * either way, plus whether this transaction inserted it so signup analytics
   * can be emitted exactly once without inspecting identity content.
   */
  upsertFromIdentity(identity: AuthIdentity, now: Date): Promise<UserUpsertResult>;
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
      const [inserted] = await db
        .insert(users)
        .values({
          id: newId('user'),
          email: identity.email,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl ?? null,
          lastSeenAt: now,
        })
        .onConflictDoNothing({ target: users.email })
        .returning({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
        });

      if (inserted !== undefined) return { user: inserted, created: true };

      const [updated] = await db
        .update(users)
        .set({
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl ?? null,
          lastSeenAt: now,
        })
        .where(eq(users.email, identity.email))
        .returning({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
        });
      if (updated === undefined) {
        throw new Error('user upsert returned no row');
      }
      return { user: updated, created: false };
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
              columns: { id: true, name: true, slug: true, settingsJson: true },
            });
      const byId = new Map(organizations.map((organization) => [organization.id, organization]));

      return {
        user,
        memberships: rows.flatMap((row) => {
          const organization = byId.get(row.organizationId);
          const settings = organization?.settingsJson;
          const defaultModelPolicy =
            typeof settings === 'object'
            && settings !== null
            && !Array.isArray(settings)
            && 'defaultModelPolicy' in settings
              ? settings.defaultModelPolicy
              : undefined;
          return organization === undefined
            ? []
            : [{
                allowedModels: [...allowedModelsFromPolicy(defaultModelPolicy)],
                organization: {
                  id: organization.id,
                  name: organization.name,
                  slug: organization.slug,
                },
                role: row.role,
                status: row.status,
              }];
        }),
      };
    },
  };
}
