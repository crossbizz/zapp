import { newId } from '@zapp/contracts';
import { organizations, trialCreditGrants, usageLedger, users } from '@zapp/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbCreditGrantStore } from '../../src/billing/topup.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-08-11T16:00:00.000Z');

describe.skipIf(!hasDatabase)('credit grant durability, on PostgreSQL', () => {
  let database: TestDatabase;
  let userId: string;
  let firstOrganizationId: string;
  let secondOrganizationId: string;

  beforeAll(async () => {
    database = await setUpTestDatabase();
  }, 180_000);

  beforeEach(async () => {
    await database.truncateIdentity();
    userId = newId('user');
    firstOrganizationId = newId('org');
    secondOrganizationId = newId('org');
    await database.db.insert(users).values({
      id: userId,
      email: `${userId}@zapp.test`,
      displayName: 'Trial User',
    });
    await database.db.insert(organizations).values([
      { id: firstOrganizationId, name: 'First Trial', slug: `first-${userId.slice(-8)}` },
      { id: secondOrganizationId, name: 'Second Trial', slug: `second-${userId.slice(-8)}` },
    ]);
  });

  afterAll(async () => {
    await database.close();
  });

  it('structurally allows one pending or delivered trial per user under a concurrent claim', async () => {
    const store = createDbCreditGrantStore({ database: database.db });
    const claims = await Promise.all([
      store.claimTrial({ organizationId: firstOrganizationId, userId, occurredAt: NOW }),
      store.claimTrial({ organizationId: secondOrganizationId, userId, occurredAt: NOW }),
    ]);

    expect(claims.sort()).toEqual(['denied', 'pending']);
    const rows = await database.db.select().from(trialCreditGrants);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, state: 'pending' });
  });

  it('atomically completes trial and paid mirrors once under replay', async () => {
    const store = createDbCreditGrantStore({ database: database.db });
    await store.claimTrial({ organizationId: firstOrganizationId, userId, occurredAt: NOW });
    await store.completeTrial({
      organizationId: firstOrganizationId,
      credits: '10.0000',
      occurredAt: NOW,
    });
    await store.completeTrial({
      organizationId: firstOrganizationId,
      credits: '10.0000',
      occurredAt: NOW,
    });
    await store.mirrorPaidGrant({
      organizationId: firstOrganizationId,
      checkoutSessionId: 'cs_test_pack_replay',
      packId: 'starter',
      credits: '500.0000',
      occurredAt: NOW,
    });
    await store.mirrorPaidGrant({
      organizationId: firstOrganizationId,
      checkoutSessionId: 'cs_test_pack_replay',
      packId: 'starter',
      credits: '500.0000',
      occurredAt: NOW,
    });

    const [claim] = await database.db
      .select()
      .from(trialCreditGrants)
      .where(eq(trialCreditGrants.organizationId, firstOrganizationId));
    expect(claim).toMatchObject({ state: 'delivered', deliveredAt: NOW });
    const rows = await database.db
      .select()
      .from(usageLedger)
      .where(
        and(
          eq(usageLedger.organizationId, firstOrganizationId),
          eq(usageLedger.category, 'credit_grant'),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.operationKey).sort()).toEqual([
      `stripe-checkout:cs_test_pack_replay`,
      `trial:${firstOrganizationId}`,
    ]);
  });
});
