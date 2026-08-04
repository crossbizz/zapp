import { newId } from '@zapp/contracts';
import { memberships, organizations, type Database, type Executor } from '@zapp/db';
import { and, asc, desc, eq, exists, lt, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { PageRequest, StorePage } from '../pagination.js';
import type { AuditHook } from '../plugins/audit.js';
import type { Role } from '../policy/permissions.js';

/**
 * Organizations and memberships, as the org routes use them.
 *
 * A port rather than a raw `Database`, for CP-2's reason: route tests need no
 * PostgreSQL, and the handful of statements a membership change actually
 * performs stay in one file instead of being spread across handlers.
 *
 * Two rules live here rather than in a route, because only here can they be
 * atomic:
 *
 *   - **An organization always has at least one active Owner.** Checking the
 *     count in a handler and then writing leaves a window in which two
 *     concurrent demotions each see a second owner and both succeed. The guard
 *     is therefore part of the `UPDATE`'s own `WHERE`, and the store reports
 *     `last_owner` when it matched nothing.
 *   - **Creating an organization is all-or-nothing**, including the provider
 *     side of it: {@link CreateOrganizationInput.link} runs inside the same
 *     transaction as the rows, so a Stytch organization that cannot be created
 *     leaves no zapp organization behind (plan 02 CP-3).
 *   - **The audit row is part of the mutation.** Every write here takes an
 *     {@link AuditHook} and calls it inside its own transaction, so the row that
 *     says what happened and the change it describes commit together or not at
 *     all (plan 02 CP-5, master plan §Global Constraints). It is not optional:
 *     a mutation that could be performed without recording it is one that will
 *     be.
 */

export type MembershipStatus = 'invited' | 'active' | 'removed';

export interface OrganizationRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** PRD §23.1. Seeded `trial`; CP-8 moves it. */
  readonly plan: string;
}

export interface MembershipRecord {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: Role;
  readonly status: MembershipStatus;
}

export interface OrganizationMembership {
  readonly organization: OrganizationRecord;
  readonly role: Role;
  readonly status: MembershipStatus;
}

/**
 * The slug is taken. A distinct error rather than a boolean because the caller's
 * answer depends on where the slug came from — a slug it derived gets another
 * try with a suffix, a slug the client chose gets a 409.
 */
export class SlugTakenError extends Error {
  constructor() {
    super('organization slug already in use');
    this.name = 'SlugTakenError';
  }
}

export interface CreateOrganizationInput {
  readonly name: string;
  readonly slug: string;
  /** Becomes the first Owner (PRD §22.2 — someone has to be able to manage it). */
  readonly creatorUserId: string;
  readonly now: Date;
  /**
   * Mirrors the organization into the identity provider, inside the
   * transaction. A rejection rolls the whole creation back: an organization
   * whose Stytch counterpart does not exist cannot be signed in to, so it is
   * worse than no organization at all.
   */
  readonly link: (organization: OrganizationRecord) => Promise<{ externalOrgId: string }>;
  /** Runs last, still inside the transaction — see the file header. */
  readonly audit: AuditHook<CreatedOrganization>;
}

export interface CreatedOrganization {
  readonly organization: OrganizationRecord;
  readonly membership: MembershipRecord;
  /**
   * The provider's id for the paired organization.
   *
   * Returned rather than stored: PRD §23.1 gives `organizations` no column for
   * it (unlike `users.external_id`, which `packages/db` added for CP-2), so
   * until that column lands the link lives in the audit record this creates and
   * in Stytch itself. Nothing drops it silently.
   */
  readonly externalOrgId: string;
}

/** Outcome of a membership write. `last_owner` is the invariant, not an error. */
export type MemberUpdate = 'updated' | 'member_not_found' | 'last_owner';

/**
 * `setRole`'s answer: the membership as it now stands, or why it was refused.
 *
 * The *record*, not `'updated'` — because the caller's next act is to report and
 * audit it, and re-reading the row outside the store call is how the two drift:
 * a concurrent removal between the write and the read turns a successful change
 * into a spurious 404 with no audit row, and a concurrent second change makes
 * the trail record a role nobody requested (plan 02 CP-3 review).
 */
export type RoleUpdate = MembershipRecord | 'member_not_found' | 'last_owner';

/**
 * Pagination is one shape for the whole service (`src/pagination.ts`), re-exported
 * here so a caller of this store does not have to know which module owns it.
 */
export type { PageRequest, StorePage };

export interface OrganizationStore {
  /** @throws {SlugTakenError} when `slug` is taken; rolls back if `link` or `audit` rejects. */
  create(input: CreateOrganizationInput): Promise<CreatedOrganization>;
  findById(organizationId: string): Promise<OrganizationRecord | undefined>;
  /**
   * The caller's own **active** memberships, newest first, one keyset page at a
   * time.
   *
   * `active`, not merely "not removed": an invitation that was issued and never
   * accepted is a row, not an access grant — the same rule `membership()` and
   * the tenant plugin apply, because it is the same question. A list that
   * disagreed with them would show a person an organization every other route
   * then denies them.
   */
  listForUser(userId: string, page?: PageRequest): Promise<StorePage<OrganizationMembership>>;
  /** `undefined` when there is no active membership — removed and invited are the same answer. */
  membership(organizationId: string, userId: string): Promise<MembershipRecord | undefined>;
  /** @throws {SlugTakenError} */
  update(
    organizationId: string,
    patch: { name?: string; slug?: string },
    audit: AuditHook<OrganizationRecord>,
  ): Promise<OrganizationRecord | undefined>;
  /**
   * Adds a membership, or reactivates a removed one. An **active** membership is
   * left exactly as it is: accepting an invite must never be a way to change —
   * least of all lower — a role someone already holds.
   */
  addMember(input: {
    organizationId: string;
    userId: string;
    role: Role;
    now: Date;
    audit: AuditHook<MembershipRecord>;
  }): Promise<MembershipRecord>;
  setRole(
    organizationId: string,
    userId: string,
    role: Role,
    audit: AuditHook<MembershipRecord>,
  ): Promise<RoleUpdate>;
  removeMember(
    organizationId: string,
    userId: string,
    audit: AuditHook<MembershipRecord>,
  ): Promise<MemberUpdate>;
}

/** How many memberships a page carries when the client does not say. */
export const DEFAULT_PAGE_SIZE = 50;

const UNIQUE_VIOLATION = '23505';

/** Drizzle wraps driver failures; the SQLSTATE is on whichever layer is underneath. */
function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

const ORGANIZATION_COLUMNS = {
  id: organizations.id,
  name: organizations.name,
  slug: organizations.slug,
  plan: organizations.plan,
} as const;

export function createDbOrganizationStore(db: Database): OrganizationStore {
  /**
   * "Some *other* active Owner exists" — the whole of the last-owner rule,
   * expressed as a correlated subquery so it is evaluated by the same statement
   * that performs the write rather than by a read that precedes it.
   */
  function anotherActiveOwner(organizationId: string, userId: string) {
    const other = alias(memberships, 'other_membership');
    return exists(
      db
        .select({ one: sql`1` })
        .from(other)
        .where(
          and(
            eq(other.organizationId, organizationId),
            ne(other.userId, userId),
            eq(other.role, 'owner'),
            eq(other.status, 'active'),
          ),
        ),
    );
  }

  /**
   * Serializes every owner-mutating write on one organization.
   *
   * The `EXISTS` guard alone is not enough under `READ COMMITTED`: two
   * concurrent demotions each take their snapshot before the other commits, so
   * each sees the other as the replacement Owner and both succeed — leaving an
   * organization nobody can administer. Locking the Owner rows first makes the
   * second transaction wait, re-read, and find that its replacement is gone.
   *
   * Ordered, so two transactions take the same locks in the same order and
   * cannot deadlock against each other.
   */
  async function lockOwners(tx: Executor, organizationId: string): Promise<void> {
    await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.role, 'owner'),
          eq(memberships.status, 'active'),
        ),
      )
      .orderBy(asc(memberships.userId))
      .for('update');
  }

  /** Tells `last_owner` from `member_not_found` once a guarded write matched nothing. */
  async function classify(
    tx: Executor,
    organizationId: string,
    userId: string,
  ): Promise<'member_not_found' | 'last_owner'> {
    const [row] = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          ne(memberships.status, 'removed'),
        ),
      )
      .limit(1);
    return row === undefined ? 'member_not_found' : 'last_owner';
  }

  /** The membership columns, as a record — one shape for every write that returns one. */
  const MEMBERSHIP_COLUMNS = {
    organizationId: memberships.organizationId,
    userId: memberships.userId,
    role: memberships.role,
    status: memberships.status,
  } as const;

  return {
    async create(input) {
      return await db.transaction(async (tx) => {
        const organization: OrganizationRecord = {
          id: newId('org'),
          name: input.name,
          slug: input.slug,
          plan: 'trial',
        };

        try {
          await tx.insert(organizations).values({ ...organization, createdAt: input.now });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new SlugTakenError();
          }
          throw error;
        }

        const membership: MembershipRecord = {
          organizationId: organization.id,
          userId: input.creatorUserId,
          role: 'owner',
          status: 'active',
        };
        await tx.insert(memberships).values({ ...membership, createdAt: input.now });

        // Last, and inside the transaction: everything above it is undone if
        // the provider refuses.
        const { externalOrgId } = await input.link(organization);
        const created = { organization, membership, externalOrgId };
        await input.audit(tx, created);
        return created;
      });
    },

    async findById(organizationId) {
      const [row] = await db
        .select(ORGANIZATION_COLUMNS)
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      return row;
    },

    async listForUser(userId, page) {
      const limit = page?.limit ?? DEFAULT_PAGE_SIZE;
      const cursor = page?.cursor;
      const rows = await db
        .select({
          organization: ORGANIZATION_COLUMNS,
          role: memberships.role,
          status: memberships.status,
        })
        .from(memberships)
        .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.status, 'active'),
            ...(cursor === undefined ? [] : [lt(organizations.id, cursor)]),
          ),
        )
        // Ids are monotonic ULIDs, so descending id is newest-first — and a
        // total order, which is what makes the cursor below unambiguous.
        .orderBy(desc(organizations.id))
        // One extra row, never returned: its presence is the whole of "there is
        // another page", and asking that way costs one row instead of a count.
        .limit(limit + 1);

      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > limit ? (items.at(-1)?.organization.id ?? null) : null,
      };
    },

    async membership(organizationId, userId) {
      const [row] = await db
        .select(MEMBERSHIP_COLUMNS)
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.userId, userId),
            ne(memberships.status, 'removed'),
          ),
        )
        .limit(1);
      return row;
    },

    async update(organizationId, patch, audit) {
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx
            .update(organizations)
            .set({
              ...(patch.name === undefined ? {} : { name: patch.name }),
              ...(patch.slug === undefined ? {} : { slug: patch.slug }),
            })
            .where(eq(organizations.id, organizationId))
            .returning(ORGANIZATION_COLUMNS);
          if (row !== undefined) {
            await audit(tx, row);
          }
          return row;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new SlugTakenError();
        }
        throw error;
      }
    },

    async addMember(input) {
      return await db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({
            organizationId: input.organizationId,
            userId: input.userId,
            role: input.role,
            status: 'active',
            createdAt: input.now,
          })
          .onConflictDoUpdate({
            target: [memberships.organizationId, memberships.userId],
            set: { role: input.role, status: 'active' },
            // The existing row, not the proposed one: an active membership is
            // never rewritten.
            setWhere: ne(memberships.status, 'active'),
          });

        const [row] = await tx
          .select(MEMBERSHIP_COLUMNS)
          .from(memberships)
          .where(
            and(
              eq(memberships.organizationId, input.organizationId),
              eq(memberships.userId, input.userId),
            ),
          )
          .limit(1);
        if (row === undefined) {
          throw new Error('membership upsert returned no row');
        }
        await input.audit(tx, row);
        return row;
      });
    },

    async setRole(organizationId, userId, role, audit) {
      // Promotion to Owner can never remove the last one, so it carries no guard.
      const guard =
        role === 'owner'
          ? []
          : [or(ne(memberships.role, 'owner'), anotherActiveOwner(organizationId, userId))];

      return await db.transaction(async (tx) => {
        await lockOwners(tx, organizationId);
        const [updated] = await tx
          .update(memberships)
          .set({ role })
          .where(
            and(
              eq(memberships.organizationId, organizationId),
              eq(memberships.userId, userId),
              ne(memberships.status, 'removed'),
              ...guard,
            ),
          )
          .returning(MEMBERSHIP_COLUMNS);

        if (updated === undefined) {
          return await classify(tx, organizationId, userId);
        }
        await audit(tx, updated);
        return updated;
      });
    },

    async removeMember(organizationId, userId, audit) {
      return await db.transaction(async (tx) => {
        await lockOwners(tx, organizationId);
        // Soft: the row stays as the audit trail of an access change (PRD §23.1
        // gives memberships a `removed` status for exactly this), and every read
        // path treats it as absent.
        const [updated] = await tx
          .update(memberships)
          .set({ status: 'removed' })
          .where(
            and(
              eq(memberships.organizationId, organizationId),
              eq(memberships.userId, userId),
              ne(memberships.status, 'removed'),
              or(ne(memberships.role, 'owner'), anotherActiveOwner(organizationId, userId)),
            ),
          )
          .returning(MEMBERSHIP_COLUMNS);

        if (updated === undefined) {
          return await classify(tx, organizationId, userId);
        }
        await audit(tx, updated);
        return 'updated';
      });
    },
  };
}
