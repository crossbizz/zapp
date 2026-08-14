import { newId } from '@zapp/contracts';
import { auditEvents, memberships, organizations, users, type Database } from '@zapp/db';
import { and, eq, or } from 'drizzle-orm';

import { allowedModelsFromPolicy } from '../orgs/model-policy.js';
import { defaultOrganizationForIdentity } from './default-organization.js';
import type { AuthIdentity } from './port.js';

/**
 * The identity half of `packages/db`, as the auth routes use it.
 *
 * A port rather than a raw `Database` so route tests need no PostgreSQL, and so
 * the complete first-login transaction stays visible in one file instead of
 * being spread through handlers.
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
 * The provider id is the durable link. Email is only the one-time fallback for
 * an invited or legacy user whose row has not been linked yet; a row already
 * linked to another provider member is never claimed by matching its address.
 */
export function createDbUserStore(db: Database): UserStore {
  return {
    async upsertFromIdentity(identity, now) {
      return await db.transaction(async (tx) => {
        const userColumns = {
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          externalId: users.externalId,
        } as const;
        const [inserted] = await tx
          .insert(users)
          .values({
            id: newId('user'),
            externalId: identity.externalId,
            email: identity.email,
            displayName: identity.displayName,
            avatarUrl: identity.avatarUrl ?? null,
            lastSeenAt: now,
          })
          .onConflictDoNothing()
          .returning(userColumns);

        let user: SessionUser;
        const created = inserted !== undefined;
        if (inserted !== undefined) {
          user = inserted;
        } else {
          const candidates = await tx
            .select(userColumns)
            .from(users)
            .where(or(eq(users.externalId, identity.externalId), eq(users.email, identity.email)))
            .for('update');
          const byExternalId = candidates.find((candidate) => candidate.externalId === identity.externalId);
          const byEmail = candidates.find((candidate) => candidate.email === identity.email);
          if (
            (byExternalId !== undefined && byEmail !== undefined && byExternalId.id !== byEmail.id) ||
            (byExternalId === undefined && byEmail?.externalId !== null)
          ) {
            throw new Error('provider identity conflicts with an existing user');
          }
          const existing = byExternalId ?? byEmail;
          if (existing === undefined) {
            throw new Error('user upsert returned no row');
          }

          const [updated] = await tx
            .update(users)
            .set({
              externalId: identity.externalId,
              email: identity.email,
              displayName: identity.displayName,
              avatarUrl: identity.avatarUrl ?? null,
              lastSeenAt: now,
            })
            .where(eq(users.id, existing.id))
            .returning(userColumns);
          if (updated === undefined) {
            throw new Error('user upsert returned no row');
          }
          user = updated;
        }

        const [activeMembership] = await tx
          .select({ organizationId: memberships.organizationId })
          .from(memberships)
          .where(and(eq(memberships.userId, user.id), eq(memberships.status, 'active')))
          .limit(1);
        if (activeMembership === undefined) {
          const organization = defaultOrganizationForIdentity(identity);
          const organizationId = newId('org');
          await tx.insert(organizations).values({
            id: organizationId,
            name: organization.name,
            slug: organization.slug,
            plan: 'trial',
            createdAt: now,
          });
          await tx.insert(memberships).values({
            organizationId,
            userId: user.id,
            role: 'owner',
            status: 'active',
            createdAt: now,
          });
          await tx.insert(auditEvents).values({
            id: newId('aud'),
            organizationId,
            actorType: 'user',
            actorId: user.id,
            action: 'organization.created',
            targetType: 'organization',
            targetId: organizationId,
            metadataJson: { slug: organization.slug, source: 'self_service_login' },
            occurredAt: now,
          });
        }

        return { user, created };
      });
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
