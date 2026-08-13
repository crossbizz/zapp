import { afterEach, describe, expect, it } from 'vitest';

import type { BillingDeps } from '../src/app.js';
import { createStripeBillingClient, type StripeCreditCheckoutPort } from '../src/billing/stripe.js';
import { loadPricingConfig } from '../src/usage/pricing.js';
import { buildHarness, signIn, type Harness } from './support/harness.js';

const PLATFORM_STRIPE_SECRET = ['sk', 'test', 'platformtopup'].join('_');

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

function requestBody(init: RequestInit | undefined): string {
  if (!(init?.body instanceof URLSearchParams)) throw new Error('Expected Stripe form body');
  return init.body.toString();
}

const pricing = loadPricingConfig({
  version: 'ops5-test',
  defaultRunCreditCeiling: '1000.0000',
  creditsPerUsd: '100.0000',
  creditPacks: {
    starter: { credits: '500.0000', amountUsd: '5.00' },
  },
  models: {
    'anthropic/claude-sonnet-5': {
      inputUsdPerMillion: '3.000000',
      outputUsdPerMillion: '15.000000',
      cacheReadUsdPerMillion: '0.300000',
      cacheWriteUsdPerMillion: '3.750000',
    },
  },
  usageRates: {
    sandbox_cpu_seconds: { unit: 'cpu_seconds', usdPerUnit: '0.000010' },
  },
});

type CreditCheckoutInput = Parameters<StripeCreditCheckoutPort['createCreditCheckout']>[0];

function billing(stripeCalls: CreditCheckoutInput[], trialCalls: unknown[] = []): BillingDeps {
  return {
    stripe: {
      createCheckout: () => Promise.reject(new Error('subscription checkout not expected')),
      createPortal: () => Promise.reject(new Error('portal not expected')),
      updateSeats: () => Promise.reject(new Error('seat update not expected')),
      createProduct: () => Promise.reject(new Error('product creation not expected')),
      createMonthlyPrice: () => Promise.reject(new Error('price creation not expected')),
      verifyWebhookEndpoint: () => Promise.reject(new Error('webhook inspection not expected')),
    },
    store: {
      status: () =>
        Promise.resolve({
          planId: 'trial',
          customerId: null,
          subscriptionId: null,
          subscriptionStatus: null,
          seats: null,
          dunning: { state: 'current' },
        }),
      syncSubscription: () => Promise.reject(new Error('subscription sync not expected')),
      findOrganizationByCustomer: () => Promise.reject(new Error('customer lookup not expected')),
      markPaymentFailed: () => Promise.reject(new Error('dunning not expected')),
      clearDunning: () => Promise.reject(new Error('dunning not expected')),
      mirrorCreditGrant: () => Promise.reject(new Error('monthly grant not expected')),
      ledgerCostUsd: () => Promise.reject(new Error('ledger cost not expected')),
      downgradeExpiredDunning: () => Promise.resolve(0),
    },
    prices: { builder: 'price_builder123', studio: 'price_studio123' },
    appBaseUrl: 'https://app.zapp.test',
    webhook: { handle: () => Promise.reject(new Error('webhook not expected')) },
    trial: {
      ensureTrial(input) {
        trialCalls.push(input);
        return Promise.resolve({ granted: true, reason: 'delivered' });
      },
      reconcileTrials: () => Promise.resolve(0),
      grantPaidCheckout: () => Promise.resolve(),
    },
    topups: {
      stripe: {
        createCreditCheckout(input) {
          stripeCalls.push(input);
          return Promise.resolve({
            id: 'cs_test_topup',
            url: 'https://checkout.stripe.test/topup',
          });
        },
      },
      packs: pricing.creditPacks ?? {},
      prices: { starter: 'price_starter123' },
      pricing,
    },
  };
}

const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(({ app }) => app.close()));
});

describe('credit top-up and estimate API', () => {
  it('lists configured packs, starts one-time checkout, and returns exact local estimates', async () => {
    const stripeCalls: CreditCheckoutInput[] = [];
    const trialCalls: unknown[] = [];
    const built = buildHarness({
      tenantDb: () => ({}) as never,
      billing: billing(stripeCalls, trialCalls),
    });
    harnesses.push(built);
    const owner = await signIn(built, {
      externalId: 'ops5-api-owner',
      email: 'ops5-owner@zapp.test',
      displayName: 'OPS-5 Owner',
    });
    const created = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'OPS-5 API Org' },
    });
    const organizationId = created.json<{ organization: { id: string } }>().organization.id;
    expect(trialCalls).toEqual([{ organizationId, userId: owner.userId }]);
    const headers = { ...owner.headers, 'x-organization-id': organizationId };

    const listed = await built.app.inject({ method: 'GET', url: '/v1/billing/topups', headers });
    const checkout = await built.app.inject({
      method: 'POST',
      url: '/v1/billing/topups/checkout',
      headers: { ...headers, 'idempotency-key': 'ops5-topup-checkout-0001' },
      payload: { packId: 'starter' },
    });
    const estimate = await built.app.inject({
      method: 'POST',
      url: '/v1/billing/estimate',
      headers,
      payload: {
        items: [
          {
            category: 'model_input_tokens',
            quantity: '1000000',
            provider: 'anthropic',
            model: 'claude-sonnet-5',
          },
          { category: 'sandbox_cpu_seconds', quantity: '100' },
        ],
      },
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      packs: [{ id: 'starter', credits: '500.0000', amountUsd: '5.00' }],
    });
    expect(checkout.statusCode).toBe(201);
    expect(checkout.json()).toEqual({ url: 'https://checkout.stripe.test/topup' });
    expect(stripeCalls).toHaveLength(1);
    expect(stripeCalls[0]).toMatchObject({
      organizationId,
      packId: 'starter',
      priceId: 'price_starter123',
      credits: '500.0000',
      amountUsd: '5.00',
      pricingVersion: 'ops5-test',
    });
    expect(stripeCalls[0]?.operationKey).toMatch(/^op_[0-9a-f]{64}$/u);
    expect(estimate.statusCode).toBe(200);
    expect(estimate.json()).toEqual({
      pricingVersion: 'ops5-test',
      items: [
        { costUsd: '3.000000', credits: '300.0000' },
        { costUsd: '0.001000', credits: '0.1000' },
      ],
      total: { costUsd: '3.001000', credits: '300.1000' },
    });
  });
});

describe('Stripe credit checkout adapter', () => {
  it('uses payment mode, one configured price, and organization-bound metadata', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      Response.json({ data: [] }),
      Response.json({ id: 'cus_topup' }),
      Response.json({ id: 'cs_test_topup', url: 'https://checkout.stripe.test/topup' }),
    ];
    const stripe = createStripeBillingClient({
      platformSecretKey: PLATFORM_STRIPE_SECRET,
      baseUrl: 'https://stripe.test',
      fetcher: (input, init) => {
        calls.push({ url: requestUrl(input), init });
        return Promise.resolve(responses.shift() ?? new Response(null, { status: 500 }));
      },
    });

    await stripe.createCreditCheckout({
      organizationId: 'org_01J00000000000000000000000',
      packId: 'starter',
      priceId: 'price_starter123',
      credits: '500.0000',
      amountUsd: '5.00',
      pricingVersion: 'ops5-test',
      customerId: null,
      successUrl: 'https://app.zapp.test/settings/billing?topup=success',
      cancelUrl: 'https://app.zapp.test/settings/billing?topup=cancelled',
      operationKey: 'ops5-stripe-checkout-0001',
    });

    const body = requestBody(calls[2]?.init);
    expect(body).toContain('mode=payment');
    expect(body).toContain('line_items%5B0%5D%5Bprice%5D=price_starter123');
    expect(body).toContain('metadata%5Bcheckout_kind%5D=credit_topup');
    expect(body).toContain('metadata%5Borganization_id%5D=org_01J00000000000000000000000');
    expect(body).toContain('metadata%5Bcredit_pack_id%5D=starter');
    expect(body).toContain('metadata%5Bcredit_amount%5D=500.0000');
    expect(body).toContain('metadata%5Bamount_usd%5D=5.00');
    expect(body).toContain('metadata%5Bpricing_version%5D=ops5-test');
    expect(calls[2]?.init?.headers).toMatchObject({
      'idempotency-key': 'ops5-stripe-checkout-0001',
    });
  });
});
