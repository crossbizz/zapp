import { describe, expect, it } from 'vitest';

import {
  createCreditGrantService,
  createFlexpriceCreditWalletClient,
  type CreditGrantStore,
  type CreditWalletPort,
} from '../src/billing/topup.js';

const NOW = new Date('2026-08-11T15:00:00.000Z');
const ORGANIZATION_ID = 'org_01J00000000000000000000000';
const USER_ID = 'user_01J0000000000000000000000';

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

class MemoryGrantStore implements CreditGrantStore {
  readonly claims = new Map<string, { userId: string; state: 'pending' | 'delivered' }>();
  readonly ledger: string[] = [];
  readonly paidSessions = new Set<string>();

  claimTrial(input: { organizationId: string; userId: string; occurredAt: Date }) {
    const existing = this.claims.get(input.organizationId);
    if (existing !== undefined) return Promise.resolve(existing.state);
    if ([...this.claims.values()].some((claim) => claim.userId === input.userId)) {
      return Promise.resolve('denied' as const);
    }
    this.claims.set(input.organizationId, { userId: input.userId, state: 'pending' });
    return Promise.resolve('pending' as const);
  }

  completeTrial(input: { organizationId: string; credits: string; occurredAt: Date }) {
    const existing = this.claims.get(input.organizationId);
    if (existing === undefined) throw new Error('trial claim missing');
    existing.state = 'delivered';
    this.ledger.push(`trial:${input.organizationId}:${input.credits}`);
    return Promise.resolve();
  }

  pendingTrials() {
    return Promise.resolve(
      [...this.claims.entries()]
        .filter(([, claim]) => claim.state === 'pending')
        .map(([organizationId, claim]) => ({ organizationId, userId: claim.userId })),
    );
  }

  mirrorPaidGrant(input: {
    organizationId: string;
    checkoutSessionId: string;
    packId: string;
    credits: string;
    occurredAt: Date;
  }) {
    if (this.paidSessions.has(input.checkoutSessionId)) return Promise.resolve();
    this.paidSessions.add(input.checkoutSessionId);
    this.ledger.push(`paid:${input.checkoutSessionId}:${input.packId}:${input.credits}`);
    return Promise.resolve();
  }
}

describe('Flexprice credit wallet adapter', () => {
  it('creates a customer and prepaid USD wallet before an idempotent credit top-up', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      new Response(null, { status: 404 }),
      Response.json({ id: 'cust_flexprice' }),
      Response.json([]),
      Response.json({ id: 'wallet_credit', wallet_type: 'PRE_PAID', wallet_status: 'active' }),
      Response.json({
        wallet_transaction: { id: 'txn_trial' },
        wallet: { id: 'wallet_credit' },
      }),
    ];
    const client = createFlexpriceCreditWalletClient({
      baseUrl: 'https://flexprice.test/v1',
      apiKey: 'flexprice-test-key',
      creditsPerUsd: '100.0000',
      fetcher: (input, init) => {
        calls.push({ url: requestUrl(input), init });
        return Promise.resolve(responses.shift() ?? new Response(null, { status: 500 }));
      },
    });

    await client.topUp({
      organizationId: ORGANIZATION_ID,
      credits: '10.0000',
      operationKey: `trial:${ORGANIZATION_ID}`,
      reason: 'FREE_CREDIT_GRANT',
    });

    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      `/v1/customers/external/${ORGANIZATION_ID}`,
      '/v1/customers',
      '/v1/customers/wallets',
      '/v1/wallets',
      '/v1/wallets/wallet_credit/top-up',
    ]);
    expect(requestBody(calls[1]?.init)).toMatchObject({
      external_id: ORGANIZATION_ID,
      name: ORGANIZATION_ID,
    });
    expect(requestBody(calls[3]?.init)).toMatchObject({
      external_customer_id: ORGANIZATION_ID,
      currency: 'usd',
      conversion_rate: '0.010000',
      topup_conversion_rate: '0.010000',
      wallet_type: 'PRE_PAID',
    });
    expect(requestBody(calls[4]?.init)).toMatchObject({
      credits_to_add: '10.0000',
      transaction_reason: 'FREE_CREDIT_GRANT',
      idempotency_key: `trial:${ORGANIZATION_ID}`,
    });
  });
});

describe('credit grant service', () => {
  it('grants one trial per user, heals pending delivery, and mirrors paid sessions once', async () => {
    const store = new MemoryGrantStore();
    const topups: Array<Parameters<CreditWalletPort['topUp']>[0]> = [];
    let failFirstTrial = true;
    const wallet: CreditWalletPort = {
      topUp(input) {
        topups.push(input);
        if (input.reason === 'FREE_CREDIT_GRANT' && failFirstTrial) {
          failFirstTrial = false;
          return Promise.reject(new Error('provider unavailable'));
        }
        return Promise.resolve();
      },
    };
    const service = createCreditGrantService({
      store,
      wallet,
      trialCredits: '10.0000',
      now: () => NOW,
    });

    await expect(service.ensureTrial({ organizationId: ORGANIZATION_ID, userId: USER_ID }))
      .rejects.toThrow('provider unavailable');
    await expect(
      service.ensureTrial({
        organizationId: 'org_01J00000000000000000000001',
        userId: USER_ID,
      }),
    ).resolves.toEqual({ granted: false, reason: 'already_used' });

    await expect(service.reconcileTrials(10)).resolves.toBe(1);
    await expect(service.ensureTrial({ organizationId: ORGANIZATION_ID, userId: USER_ID }))
      .resolves.toEqual({ granted: true, reason: 'delivered' });

    const session = {
      id: 'cs_test_credit_pack',
      mode: 'payment',
      payment_status: 'paid',
      amount_total: 500,
      currency: 'usd',
      metadata: {
        checkout_kind: 'credit_topup',
        organization_id: ORGANIZATION_ID,
        credit_pack_id: 'starter',
        credit_amount: '475.0000',
        amount_usd: '5.00',
        pricing_version: 'ops5-checkout-v1',
      },
    };
    await service.grantPaidCheckout({ ...session, payment_status: 'unpaid' }, NOW);
    expect(topups).toHaveLength(2);
    await expect(
      service.grantPaidCheckout({ ...session, amount_total: 499 }, NOW),
    ).rejects.toThrow('paid amount');
    expect(topups).toHaveLength(2);
    await service.grantPaidCheckout(session, NOW);
    await service.grantPaidCheckout(session, NOW);

    expect(topups).toEqual([
      {
        organizationId: ORGANIZATION_ID,
        credits: '10.0000',
        operationKey: `trial:${ORGANIZATION_ID}`,
        reason: 'FREE_CREDIT_GRANT',
      },
      {
        organizationId: ORGANIZATION_ID,
        credits: '10.0000',
        operationKey: `trial:${ORGANIZATION_ID}`,
        reason: 'FREE_CREDIT_GRANT',
      },
      {
        organizationId: ORGANIZATION_ID,
        credits: '475.0000',
        operationKey: 'stripe-checkout:cs_test_credit_pack',
        reason: 'PURCHASED_CREDIT_DIRECT',
      },
      {
        organizationId: ORGANIZATION_ID,
        credits: '475.0000',
        operationKey: 'stripe-checkout:cs_test_credit_pack',
        reason: 'PURCHASED_CREDIT_DIRECT',
      },
    ]);
    expect(store.ledger).toEqual([
      `trial:${ORGANIZATION_ID}:10.0000`,
      'paid:cs_test_credit_pack:starter:475.0000',
    ]);
  });

  it('attempts every pending trial even when an earlier provider delivery fails', async () => {
    const store = new MemoryGrantStore();
    const failingOrganizationId = ORGANIZATION_ID;
    const healthyOrganizationId = 'org_01J00000000000000000000001';
    await store.claimTrial({
      organizationId: failingOrganizationId,
      userId: USER_ID,
      occurredAt: NOW,
    });
    await store.claimTrial({
      organizationId: healthyOrganizationId,
      userId: 'user_01J0000000000000000000001',
      occurredAt: NOW,
    });
    const service = createCreditGrantService({
      store,
      wallet: {
        topUp(input) {
          return input.organizationId === failingOrganizationId
            ? Promise.reject(new Error('first provider delivery failed'))
            : Promise.resolve();
        },
      },
      trialCredits: '10.0000',
      now: () => NOW,
    });

    await expect(service.reconcileTrials(10)).rejects.toThrow('first provider delivery failed');
    expect(store.claims.get(failingOrganizationId)?.state).toBe('pending');
    expect(store.claims.get(healthyOrganizationId)?.state).toBe('delivered');
  });
});
