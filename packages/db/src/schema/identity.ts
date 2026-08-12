import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, index, jsonb } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(), // user_*
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /**
     * The identity provider's own id for this person — a Stytch member id
     * (plan 02 CP-2/CP-3, ADR-0001). Not a PRD §23.1 column: that section was
     * written before the provider was chosen, and the PRD is not edited to
     * match the implementation. `test/prd-schema-conformance.test.ts` carries
     * the exemption and the reason for it.
     *
     * Nullable, because a row can exist before it is linked (an invite, a
     * seeded fixture), and last in the list because that is where
     * `ALTER TABLE ... ADD COLUMN` physically puts it.
     *
     * Matching on this rather than on `email` is what makes a login survive an
     * address change, and what stops a re-registered address from inheriting
     * the previous holder's account.
     */
    externalId: text('external_id'),
  },
  (t) => [
    uniqueIndex('users_email_idx').on(t.email),
    // Partial: two users may both be unlinked, and Postgres would allow that
    // under a plain unique index anyway (NULLs are distinct) — the predicate
    // says so out loud and keeps the index to the rows that carry a value.
    uniqueIndex('users_external_id_idx')
      .on(t.externalId)
      .where(sql`external_id is not null`),
  ],
);

export const organizations = pgTable(
  'organizations',
  {
    id: text('id').primaryKey(), // org_*
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    plan: text('plan').notNull().default('trial'),
    billingCustomerId: text('billing_customer_id'),
    /** CP-17's durable fence: once set, no project creation may enter this organization. */
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Durable organization-owned settings (ADR-0004). This is an intentional
     * physical-schema extension to PRD §23.1, documented in the conformance
     * allowlist. It remains raw JSON here; the control-plane boundary owns the
     * strict schema and fail-closed defaults.
     */
    settingsJson: jsonb('settings_json').notNull().default({}),
  },
  (t) => [uniqueIndex('organizations_slug_idx').on(t.slug)],
);

export const memberships = pgTable(
  'memberships',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['owner', 'builder', 'viewer'] }).notNull(),
    status: text('status', { enum: ['invited', 'active', 'removed'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memberships_org_user_idx').on(t.organizationId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
