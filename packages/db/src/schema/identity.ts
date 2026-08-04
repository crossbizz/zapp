import { pgTable, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(), // user_*
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

export const organizations = pgTable(
  'organizations',
  {
    id: text('id').primaryKey(), // org_*
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    plan: text('plan').notNull().default('trial'),
    billingCustomerId: text('billing_customer_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
