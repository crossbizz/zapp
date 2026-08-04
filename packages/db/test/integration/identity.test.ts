import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { newId } from '@zapp/contracts';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type Db } from '../../src/client.js';
import {
  memberships,
  organizations,
  subscriptions,
  usageLedger,
  users,
} from '../../src/schema/index.js';

/**
 * Env-gated on the FND-7 dev stack (`./scripts/dev-up.sh`). With no
 * `DATABASE_URL` every test below reports as *skipped* — never as passed.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const hasDatabase = DATABASE_URL !== '';

if (!hasDatabase) {
  console.warn(
    '[@zapp/db] integration tests skipped: DATABASE_URL is unset — start the dev stack with ./scripts/dev-up.sh',
  );
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * `subscriptions` has no entry in the closed TypeID prefix list (master plan
 * §Global Constraints) — plan 10 owns that call — so the tests use an opaque id
 * rather than borrowing an unrelated entity's prefix. The column is plain text.
 */
const newSubscriptionId = (): string => `sub_${randomUUID()}`;

/** `noUncheckedIndexedAccess` types `rows[0]` as optional; fail loudly rather than assert non-null. */
function only<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected a row, got none');
  }
  return row;
}

/**
 * Runs a query that must fail and returns the driver's error. Drizzle wraps
 * failures in its own error type, so the SQLSTATE fields (`code`,
 * `constraint_name`) live on the postgres.js `cause` underneath; raw
 * `handle.sql` queries throw that error directly.
 */
async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error instanceof Error && error.cause !== undefined ? error.cause : error;
  }
  throw new Error('expected the query to be rejected, but it succeeded');
}

describe.skipIf(!hasDatabase)('identity and billing schema', () => {
  let handle: Db;
  let organizationId: string;

  beforeAll(async () => {
    // Migrations run on their own single-use connection: the migrator's
    // `if not exists` bookkeeping DDL raises a NOTICE on every re-run, and that
    // is noise rather than information for everything that follows.
    const migrationSql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    try {
      // The generated SQL is the schema's source of truth, so applying it here
      // is also what proves drizzle/ still matches the TypeScript tables.
      await migrate(drizzle(migrationSql), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await migrationSql.end();
    }

    handle = createDb(DATABASE_URL);
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    // CASCADE rather than an exhaustive table list: FND-6 adds more tables
    // referencing organizations into this same database. Nothing here drops a
    // schema, so the dev database stays reusable across runs.
    await handle.sql`truncate table usage_ledger, subscriptions, memberships, organizations, users cascade`;

    organizationId = newId('org');
    await handle.db
      .insert(organizations)
      .values({ id: organizationId, name: 'Acme Rockets', slug: `acme-${organizationId}` });
  });

  describe('identity', () => {
    it('stores an organization, a user, and the membership joining them', async () => {
      const userId = newId('user');
      await handle.db.insert(users).values({
        id: userId,
        email: `ada+${userId}@example.com`,
        displayName: 'Ada Lovelace',
      });
      await handle.db.insert(memberships).values({ organizationId, userId, role: 'owner' });

      const membership = only(
        await handle.db
          .select()
          .from(memberships)
          .where(
            and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)),
          ),
      );
      expect(membership.role).toBe('owner');
      // Defaulted, not supplied above.
      expect(membership.status).toBe('active');
      expect(membership.createdAt).toBeInstanceOf(Date);

      const organization = only(
        await handle.db.select().from(organizations).where(eq(organizations.id, organizationId)),
      );
      expect(organization.plan).toBe('trial');
      expect(organization.billingCustomerId).toBeNull();

      const user = only(await handle.db.select().from(users).where(eq(users.id, userId)));
      expect(user.displayName).toBe('Ada Lovelace');
      expect(user.avatarUrl).toBeNull();
      expect(user.lastSeenAt).toBeNull();
    });

    it('rejects a second membership for the same (organization, user)', async () => {
      const userId = newId('user');
      await handle.db.insert(users).values({
        id: userId,
        email: `grace+${userId}@example.com`,
        displayName: 'Grace Hopper',
      });
      await handle.db.insert(memberships).values({ organizationId, userId, role: 'builder' });

      expect(
        await rejection(
          handle.db.insert(memberships).values({ organizationId, userId, role: 'viewer' }),
        ),
      ).toMatchObject({
        code: '23505', // unique_violation
        constraint_name: 'memberships_org_user_idx',
      });
    });

    it('rejects a membership pointing at a user that does not exist', async () => {
      expect(
        await rejection(
          handle.db
            .insert(memberships)
            .values({ organizationId, userId: newId('user'), role: 'viewer' }),
        ),
      ).toMatchObject({
        code: '23503', // foreign_key_violation
        constraint_name: 'memberships_user_id_users_id_fk',
      });
    });

    it('rejects two users sharing an email address', async () => {
      const email = `dup+${newId('user')}@example.com`;
      await handle.db.insert(users).values({ id: newId('user'), email, displayName: 'First' });

      expect(
        await rejection(
          handle.db.insert(users).values({ id: newId('user'), email, displayName: 'Second' }),
        ),
      ).toMatchObject({ code: '23505', constraint_name: 'users_email_idx' });
    });
  });

  describe('billing', () => {
    it('round-trips usage_ledger decimals without losing precision', async () => {
      const id = newId('evt');
      const occurredAt = new Date('2026-08-03T12:00:00.000Z');
      await handle.db.insert(usageLedger).values({
        id,
        organizationId,
        projectId: newId('proj'),
        runId: newId('run'),
        taskId: newId('task'),
        category: 'model_input_tokens',
        provider: 'anthropic',
        quantity: '1234567.5',
        unit: 'tokens',
        costUsd: '0.001234',
        creditsCharged: '2.5',
        occurredAt,
      });

      const row = only(await handle.db.select().from(usageLedger).where(eq(usageLedger.id, id)));
      // numeric columns cross the wire as strings: doing this in JS numbers
      // would silently round money, so the column type must never become a float.
      expect(typeof row.quantity).toBe('string');
      expect(row.quantity).toBe('1234567.5');
      expect(row.costUsd).toBe('0.001234');
      // numeric(12,4) pads to its declared scale — 2.5 credits, not 2.5000001.
      expect(row.creditsCharged).toBe('2.5000');
      expect(row.occurredAt).toEqual(occurredAt);
      expect(row.category).toBe('model_input_tokens');
    });

    it('accepts a negative compensating entry (plan 10 corrections)', async () => {
      const id = newId('evt');
      await handle.db.insert(usageLedger).values({
        id,
        organizationId,
        category: 'sandbox_cpu_seconds',
        provider: 'modal',
        quantity: '-42.25',
        unit: 'cpu_second',
        costUsd: '-0.123456',
        creditsCharged: '-1.2345',
        occurredAt: new Date(),
      });

      const row = only(await handle.db.select().from(usageLedger).where(eq(usageLedger.id, id)));
      expect(row.quantity).toBe('-42.25');
      expect(row.costUsd).toBe('-0.123456');
      expect(row.creditsCharged).toBe('-1.2345');
      // Attribution is optional below the organization: a storage or credit row
      // belongs to no single project/run/task.
      expect(row.projectId).toBeNull();
      expect(row.runId).toBeNull();
      expect(row.taskId).toBeNull();
    });

    it('rejects a usage category outside the enumerated set', async () => {
      // Raw SQL on purpose: the TypeScript enum makes this unrepresentable
      // through Drizzle, so only the database CHECK can be exercised here.
      expect(
        await rejection(handle.sql`
          insert into usage_ledger
            (id, organization_id, category, quantity, unit, cost_usd, credits_charged, occurred_at)
          values
            (${newId('evt')}, ${organizationId}, 'crypto_mining', 1, 'unit', 0, 0, now())
        `),
      ).toMatchObject({
        code: '23514', // check_violation
        constraint_name: 'usage_ledger_category_check',
      });
    });

    it('stores a subscription with its Stripe billing period', async () => {
      const id = newSubscriptionId();
      const currentPeriodStart = new Date('2026-08-01T00:00:00.000Z');
      const currentPeriodEnd = new Date('2026-09-01T00:00:00.000Z');
      await handle.db.insert(subscriptions).values({
        id,
        organizationId,
        stripeSubscriptionId: newSubscriptionId(),
        planId: 'team_monthly',
        status: 'active',
        currentPeriodStart,
        currentPeriodEnd,
      });

      const row = only(
        await handle.db.select().from(subscriptions).where(eq(subscriptions.id, id)),
      );
      expect(row.organizationId).toBe(organizationId);
      expect(row.planId).toBe('team_monthly');
      expect(row.currentPeriodStart).toEqual(currentPeriodStart);
      expect(row.currentPeriodEnd).toEqual(currentPeriodEnd);
    });

    it('rejects two subscriptions carrying the same Stripe id', async () => {
      const stripeSubscriptionId = newSubscriptionId();
      await handle.db.insert(subscriptions).values({
        id: newSubscriptionId(),
        organizationId,
        stripeSubscriptionId,
        planId: 'team_monthly',
        status: 'active',
      });

      expect(
        await rejection(
          handle.db.insert(subscriptions).values({
            id: newSubscriptionId(),
            organizationId,
            stripeSubscriptionId,
            planId: 'team_monthly',
            status: 'active',
          }),
        ),
      ).toMatchObject({
        code: '23505',
        constraint_name: 'subscriptions_stripe_subscription_id_idx',
      });
    });
  });
});
