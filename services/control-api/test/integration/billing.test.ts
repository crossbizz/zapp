import { createHash, createHmac } from 'node:crypto';

import { newId } from '@zapp/contracts';
import { createActivityIdempotencyRepository, organizations } from '@zapp/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createBillingWebhookProcessor,
  createDbBillingStore,
  createFlexpriceBillingClient,
  StripeWebhookError,
  type FlexpriceBillingPort,
} from '../../src/billing/webhooks.js';
import {
  bootstrapStripeCatalog,
  createFlexpriceStripeCatalogClient,
  createStripeBillingClient,
  StripePriceCatalogSchema,
  type BillingPlanCatalog,
} from '../../src/billing/stripe.js';
import { StripeCreditPackPriceCatalogSchema } from '../../src/billing/topup.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';
import { buildHarness, signIn, type Harness } from '../support/harness.js';
import { credentialGate } from '../support/credentials.js';
import { UsageEntrySchema } from '../../src/usage/ledger.js';
import { loadPricingFile } from '../../src/usage/pricing.js';

const WEBHOOK_SECRET = ['whsec', 'platform', 'billing', 'fixture'].join('_');
const PLATFORM_STRIPE_SECRET = ['sk', 'test', 'platformbilling'].join('_');
const GENERATED_APP_STRIPE_SECRET = ['rk', 'test', 'generatedapp'].join('_');
const NOW = new Date('2026-08-11T12:00:00.000Z');
const plans: BillingPlanCatalog = {
  trial: { monthlyCredits: '10.0000', seats: 1 },
  builder: { monthlyCredits: '100.0000', seats: 3 },
  studio: { monthlyCredits: '1000.0000', seats: 10 },
};

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

function requestBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error('Expected a string or URLSearchParams request body');
}

function signature(body: Buffer, at: Date): string {
  const timestamp = Math.floor(at.getTime() / 1_000);
  const digest = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${String(timestamp)}.${body.toString('utf8')}`)
    .digest('hex');
  return `t=${String(timestamp)},v1=${digest}`;
}

function event(id: string, type: string, object: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      id,
      object: 'event',
      created: Math.floor(NOW.getTime() / 1_000),
      type,
      data: { object },
    }),
  );
}

class RecordingFlexprice implements FlexpriceBillingPort {
  readonly assignments: Array<{
    organizationId: string;
    stripeSubscriptionId: string;
    stripeProductId: string;
    terminal: boolean;
    operationKey: string;
  }> = [];
  readonly grants: Array<{
    organizationId: string;
    credits: string;
    operationKey: string;
  }> = [];
  readonly reconciliations: Array<{
    organizationId: string;
    invoiceId: string;
    ledgerCostUsd: string;
    from: Date;
    to: Date;
    operationKey: string;
  }> = [];

  verifyStripeAssignment(input: (typeof this.assignments)[number]): Promise<void> {
    this.assignments.push(input);
    return Promise.resolve();
  }

  grantCredits(input: (typeof this.grants)[number]): Promise<void> {
    this.grants.push(input);
    return Promise.resolve();
  }

  reconcileInvoice(input: (typeof this.reconciliations)[number]): Promise<void> {
    this.reconciliations.push(input);
    return Promise.resolve();
  }
}

describe('Flexprice billing adapter', () => {
  it('keeps credit grants out of the metered usage outbox boundary', () => {
    expect(
      UsageEntrySchema.safeParse({
        operationKey: 'credit-grant-must-not-meter',
        organizationId: 'org_01J00000000000000000000000',
        projectId: null,
        runId: null,
        taskId: null,
        category: 'credit_grant',
        provider: 'flexprice',
        quantity: '100.0000',
        unit: 'credits',
        costUsd: '0.000000',
        creditsCharged: '-100.0000',
        occurredAt: NOW.toISOString(),
        metadata: {},
      }).success,
    ).toBe(false);
  });

  it('forwards Stripe events, grants wallet credits idempotently, and reconciles monthly cost', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      Response.json({
        items: [
          {
            lookup_key: 'sub_adapter',
            subscription_status: 'active',
            plan: { lookup_key: 'prod_builder' },
          },
        ],
        pagination: { total: 1, limit: 100, offset: 100 },
      }),
      Response.json([
        { id: 'wallet_active', wallet_type: 'PRE_PAID', wallet_status: 'active' },
      ]),
      Response.json({ id: 'transaction_grant' }),
      Response.json({ total_cost: '12.340000', items: [] }),
    ];
    const client = createFlexpriceBillingClient({
      baseUrl: 'https://flexprice.test/v1',
      apiKey: 'flexprice-test-key',
      fetcher: (input, init) => {
        calls.push({ url: requestUrl(input), init });
        return Promise.resolve(responses.shift() ?? new Response(null, { status: 500 }));
      },
    });
    await client.verifyStripeAssignment({
      organizationId: 'org_01J00000000000000000000000',
      stripeSubscriptionId: 'sub_adapter',
      stripeProductId: 'prod_builder',
      terminal: false,
      operationKey: 'stripe-event:evt_adapter',
    });
    await client.grantCredits({
      organizationId: 'org_01J00000000000000000000000',
      credits: '100.0000',
      operationKey: 'stripe-invoice:in_adapter:credit-grant',
    });
    await client.reconcileInvoice({
      organizationId: 'org_01J00000000000000000000000',
      invoiceId: 'in_adapter',
      ledgerCostUsd: '12.340000',
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-08-01T00:00:00.000Z'),
      operationKey: 'stripe-invoice:in_adapter:reconcile',
    });

    expect(calls.map(({ url }) => url)).toEqual([
      'https://flexprice.test/v1/subscriptions/search',
      'https://flexprice.test/v1/customers/wallets?lookup_key=org_01J00000000000000000000000&include_real_time_balance=true',
      'https://flexprice.test/v1/wallets/wallet_active/top-up',
      'https://flexprice.test/v1/events/analytics',
    ]);
    expect(JSON.parse(requestBody(calls[0]?.init))).toMatchObject({
      external_customer_id: 'org_01J00000000000000000000000',
      expand: 'plan',
    });
    expect(JSON.parse(requestBody(calls[2]?.init))).toMatchObject({
      credits_to_add: '100.0000',
      transaction_reason: 'SUBSCRIPTION_CREDIT_GRANT',
      idempotency_key: 'stripe-invoice:in_adapter:credit-grant',
    });
  });
});

describe('Stripe platform billing adapter', () => {
  it('uses subscription checkout metadata and Stripe proration while rejecting generated-app keys', async () => {
    expect(() =>
      createStripeBillingClient({ platformSecretKey: GENERATED_APP_STRIPE_SECRET }),
    ).toThrow();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      Response.json({ data: [] }),
      Response.json({ id: 'cus_test' }),
      Response.json({ id: 'cs_test', url: 'https://checkout.stripe.test/session' }),
      Response.json({ id: 'sub_test', items: { data: [{ id: 'si_test' }] } }),
      Response.json({ id: 'sub_test' }),
      Response.json({
        data: [
          {
            url: 'https://api.cloud.flexprice.io/v1/webhooks/stripe/tenant/environment',
            status: 'enabled',
            enabled_events: [
              'customer.subscription.created',
              'customer.subscription.updated',
              'customer.subscription.deleted',
              'invoice.paid',
              'invoice.payment_failed',
              'checkout.session.completed',
              'checkout.session.async_payment_succeeded',
            ],
          },
        ],
      }),
    ];
    const stripe = createStripeBillingClient({
      platformSecretKey: PLATFORM_STRIPE_SECRET,
      baseUrl: 'https://stripe.test',
      fetcher: (input, init) => {
        calls.push({ url: requestUrl(input), init });
        return Promise.resolve(responses.shift() ?? new Response(null, { status: 500 }));
      },
    });

    await stripe.createCheckout({
      organizationId: 'org_01J00000000000000000000000',
      planId: 'builder',
      seats: 3,
      priceId: 'price_builder123',
      customerId: null,
      successUrl: 'https://app.zapp.test/settings/billing?checkout=success',
      cancelUrl: 'https://app.zapp.test/settings/billing?checkout=cancelled',
      operationKey: 'billing-checkout:test',
    });
    await stripe.updateSeats({
      subscriptionId: 'sub_test',
      seats: 5,
      operationKey: 'billing-seats:test',
    });
    await stripe.verifyWebhookEndpoint({
      url: 'https://api.cloud.flexprice.io/v1/webhooks/stripe/tenant/environment',
    });

    expect(requestBody(calls[1]?.init)).toContain('metadata%5Bflexprice_customer_id%5D=org_01J00000000000000000000000');
    expect(requestBody(calls[2]?.init)).toContain('subscription_data%5Bmetadata%5D%5Borganization_id%5D=org_01J00000000000000000000000');
    expect(requestBody(calls[4]?.init)).toContain('proration_behavior=create_prorations');
    expect(calls[4]?.init?.headers).toMatchObject({ 'idempotency-key': 'billing-seats:test' });
  });

  it('bootstraps one Stripe product and monthly seat price for every configured plan', async () => {
    const products: string[] = [];
    const prices: string[] = [];
    const planMappings: string[] = [];
    const webhookUrls: string[] = [];
    const result = await bootstrapStripeCatalog({
      plans,
      monthlyUnitAmountsCents: { trial: 0, builder: 2_000, studio: 5_000 },
      flexpriceStripeWebhookUrl:
        'https://api.cloud.flexprice.io/v1/webhooks/stripe/tenant/environment',
      flexprice: {
        linkPlan(input) {
          planMappings.push(`${input.planId}:${input.stripeProductId}`);
          return Promise.resolve();
        },
      },
      stripe: {
        verifyWebhookEndpoint(input) {
          webhookUrls.push(input.url);
          return Promise.resolve();
        },
        createProduct(input) {
          products.push(input.planId);
          return Promise.resolve({ id: `prod_${input.planId}` });
        },
        createMonthlyPrice(input) {
          prices.push(`${input.planId}:${String(input.unitAmountCents)}`);
          return Promise.resolve({ id: `price_${input.planId}` });
        },
      },
    });

    expect(products).toEqual(['trial', 'builder', 'studio']);
    expect(webhookUrls).toEqual([
      'https://api.cloud.flexprice.io/v1/webhooks/stripe/tenant/environment',
    ]);
    expect(prices).toEqual(['trial:0', 'builder:2000', 'studio:5000']);
    expect(planMappings).toEqual([
      'trial:prod_trial',
      'builder:prod_builder',
      'studio:prod_studio',
    ]);
    expect(result).toEqual({
      trial: 'price_trial',
      builder: 'price_builder',
      studio: 'price_studio',
    });
  });

  it('links Stripe products to the existing code-owned Flexprice plans idempotently', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      Response.json({ items: [{ id: 'plan_builder', lookup_key: 'builder' }] }),
      Response.json({ items: [] }),
      Response.json({
        mapping: {
          id: 'eim_builder',
          entity_id: 'plan_builder',
          entity_type: 'plan',
          provider_type: 'stripe',
          provider_entity_id: 'prod_builder',
        },
      }),
      Response.json({ items: [{ id: 'plan_builder', lookup_key: 'builder' }] }),
      Response.json({
        items: [
          {
            entity_id: 'plan_builder',
            entity_type: 'plan',
            provider_type: 'stripe',
            provider_entity_id: 'prod_builder',
          },
        ],
      }),
    ];
    const flexprice = createFlexpriceStripeCatalogClient({
      baseUrl: 'https://flexprice.test/v1',
      apiKey: 'flexprice-test-key',
      fetcher: (input, init) => {
        calls.push({ url: requestUrl(input), init });
        return Promise.resolve(responses.shift() ?? new Response(null, { status: 500 }));
      },
    });

    await flexprice.linkPlan({ planId: 'builder', stripeProductId: 'prod_builder' });
    await flexprice.linkPlan({ planId: 'builder', stripeProductId: 'prod_builder' });

    expect(calls.map(({ url }) => url)).toEqual([
      'https://flexprice.test/v1/plans/search',
      'https://flexprice.test/v1/integrations/mappings?entity_type=plan&entity_id=plan_builder',
      'https://flexprice.test/v1/integrations/link',
      'https://flexprice.test/v1/plans/search',
      'https://flexprice.test/v1/integrations/mappings?entity_type=plan&entity_id=plan_builder',
    ]);
    expect(JSON.parse(requestBody(calls[2]?.init))).toMatchObject({
      entity_type: 'plan',
      entity_id: 'plan_builder',
      provider_type: 'stripe',
      provider_entity_id: 'prod_builder',
    });
  });
});

const stripeProviderGate = credentialGate([
  'PLATFORM_BILLING_STRIPE_SECRET_KEY',
  'STRIPE_PLAN_PRICE_IDS_JSON',
]);

describe.skipIf(!stripeProviderGate.present)('Stripe test-mode provider acceptance', () => {
  it('creates a test-mode subscription checkout session with the deployed builder price', async () => {
    const platformSecretKey = process.env['PLATFORM_BILLING_STRIPE_SECRET_KEY'] ?? '';
    expect(platformSecretKey).toMatch(/^sk_test_/u);
    const prices = StripePriceCatalogSchema.parse(
      JSON.parse(process.env['STRIPE_PLAN_PRICE_IDS_JSON'] ?? ''),
    );
    const checkout = await createStripeBillingClient({ platformSecretKey }).createCheckout({
      organizationId: 'org_01J00000000000000000000000',
      planId: 'builder',
      seats: 1,
      priceId: prices.builder,
      customerId: null,
      successUrl: 'https://app.zapp.build/settings/billing?checkout=success',
      cancelUrl: 'https://app.zapp.build/settings/billing?checkout=cancelled',
      operationKey: 'ops4-provider-checkout-v1',
    });
    expect(checkout.id).toMatch(/^cs_test_/u);
    expect(checkout.url).toMatch(/^https:\/\/checkout\.stripe\.com\//u);
  });
});

const stripeTopupProviderGate = credentialGate([
  'PLATFORM_BILLING_STRIPE_SECRET_KEY',
  'STRIPE_CREDIT_PACK_PRICE_IDS_JSON',
]);
if (!stripeTopupProviderGate.present) {
  console.warn(
    `[@zapp/control-api] OPS-5 Stripe top-up provider test SKIPPED — not run, not passed: ${stripeTopupProviderGate.reason}`,
  );
}

describe.skipIf(!stripeTopupProviderGate.present)('Stripe credit top-up provider acceptance', () => {
  it('creates a test-mode one-time checkout with the deployed starter pack price', async () => {
    const platformSecretKey = process.env['PLATFORM_BILLING_STRIPE_SECRET_KEY'] ?? '';
    expect(platformSecretKey).toMatch(/^sk_test_/u);
    const prices = StripeCreditPackPriceCatalogSchema.parse(
      JSON.parse(process.env['STRIPE_CREDIT_PACK_PRICE_IDS_JSON'] ?? ''),
    );
    const deployedPricing = await loadPricingFile(
      new URL('../../../../config/pricing.json', import.meta.url),
    );
    const starter = deployedPricing.creditPacks?.starter;
    if (starter === undefined) throw new Error('starter credit pack is not configured');
    const checkout = await createStripeBillingClient({
      platformSecretKey,
    }).createCreditCheckout({
      organizationId: 'org_01J00000000000000000000000',
      packId: 'starter',
      priceId: prices.starter ?? '',
      credits: starter.credits,
      amountUsd: starter.amountUsd,
      pricingVersion: deployedPricing.version,
      customerId: null,
      successUrl: 'https://app.zapp.build/settings/billing?topup=success',
      cancelUrl: 'https://app.zapp.build/settings/billing?topup=cancelled',
      operationKey: 'ops5-provider-topup-v1',
    });
    expect(checkout.id).toMatch(/^cs_test_/u);
    expect(checkout.url).toMatch(/^https:\/\/checkout\.stripe\.com\//u);
  });
});

const routeHarnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(routeHarnesses.splice(0).map(({ app }) => app.close()));
});

describe('billing API', () => {
  it('exposes checkout, portal, and prorated seat changes to an organization owner', async () => {
    const stripeCalls: Array<{ operation: string; input: unknown }> = [];
    let organizationId = '';
    const built = buildHarness({
      tenantDb: () => ({}) as never,
      billing: {
        stripe: {
          createCheckout(input) {
            stripeCalls.push({ operation: 'checkout', input });
            return Promise.resolve({ id: 'cs_test', url: 'https://checkout.stripe.test/session' });
          },
          createPortal(input) {
            stripeCalls.push({ operation: 'portal', input });
            return Promise.resolve({ id: 'bps_test', url: 'https://billing.stripe.test/portal' });
          },
          updateSeats(input) {
            stripeCalls.push({ operation: 'seats', input });
            return Promise.resolve();
          },
          createProduct: () => Promise.reject(new Error('route must not create products')),
          createMonthlyPrice: () => Promise.reject(new Error('route must not create prices')),
          verifyWebhookEndpoint: () => Promise.reject(new Error('route must not inspect webhooks')),
        },
        store: {
          status: () => Promise.resolve({
            planId: 'builder',
            customerId: 'cus_route',
            subscriptionId: 'sub_route',
            subscriptionStatus: 'active',
            dunning: { state: 'current' },
          }),
          syncSubscription: () => Promise.reject(new Error('route must not sync subscriptions')),
          findOrganizationByCustomer: () => Promise.reject(new Error('route must not find customers')),
          markPaymentFailed: () => Promise.reject(new Error('route must not mark dunning')),
          clearDunning: () => Promise.reject(new Error('route must not clear dunning')),
          mirrorCreditGrant: () => Promise.reject(new Error('route must not grant credits')),
          ledgerCostUsd: () => Promise.reject(new Error('route must not read cost')),
          downgradeExpiredDunning: () => Promise.resolve(0),
        },
        prices: { builder: 'price_builder123', studio: 'price_studio123' },
        appBaseUrl: 'https://app.zapp.test',
        webhook: { handle: () => Promise.reject(new Error('route must not process webhooks')) },
      },
    });
    routeHarnesses.push(built);
    const owner = await signIn(built, {
      externalId: 'billing-route-owner',
      email: 'billing-owner@zapp.test',
      displayName: 'Billing Owner',
    });
    const created = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Billing API Org' },
    });
    organizationId = created.json<{ organization: { id: string } }>().organization.id;
    const headers = {
      ...owner.headers,
      'x-organization-id': organizationId,
      'idempotency-key': 'billing-route-operation',
    };

    const checkout = await built.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers,
      payload: { planId: 'builder', seats: 4 },
    });
    const portal = await built.app.inject({
      method: 'POST',
      url: '/v1/billing/portal',
      headers: { ...headers, 'idempotency-key': 'billing-route-portal' },
    });
    const seats = await built.app.inject({
      method: 'PATCH',
      url: '/v1/billing/subscription',
      headers: { ...headers, 'idempotency-key': 'billing-route-seats' },
      payload: { seats: 5 },
    });

    expect(checkout.statusCode).toBe(201);
    expect(checkout.json()).toEqual({ url: 'https://checkout.stripe.test/session' });
    expect(portal.statusCode).toBe(201);
    expect(seats.statusCode).toBe(202);
    expect(stripeCalls.map(({ operation }) => operation)).toEqual(['checkout', 'portal', 'seats']);
    expect(stripeCalls[0]?.input).toMatchObject({
      organizationId,
      planId: 'builder',
      seats: 4,
      priceId: 'price_builder123',
    });
  });
});

describe.skipIf(!hasDatabase)('Stripe platform billing, on PostgreSQL', () => {
  let database: TestDatabase;
  let organizationId: string;
  let flexprice: RecordingFlexprice;

  beforeAll(async () => {
    database = await setUpTestDatabase();
  }, 180_000);

  beforeEach(async () => {
    await database.truncateIdentity();
    organizationId = newId('org');
    await database.db.insert(organizations).values({
      id: organizationId,
      name: 'Billing Test Org',
      slug: `billing-${organizationId.slice(4, 12).toLowerCase()}`,
    });
    flexprice = new RecordingFlexprice();
  });

  afterAll(async () => {
    await database.close();
  });

  function processor() {
    return createBillingWebhookProcessor({
      webhookSecret: WEBHOOK_SECRET,
      store: createDbBillingStore({ database: database.db }),
      idempotency: createActivityIdempotencyRepository(database.db),
      flexprice,
      plans,
      now: () => NOW,
    });
  }

  it('deduplicates a signed webhook replay by Stripe event id', async () => {
    const stripeEventId = `evt_subscription_replay_${organizationId.slice(4)}`;
    const body = event(stripeEventId, 'customer.subscription.created', {
      id: 'sub_replay',
      customer: 'cus_replay',
      status: 'active',
      current_period_start: 1_754_308_800,
      current_period_end: 1_756_987_200,
      metadata: { organization_id: organizationId, plan_id: 'builder' },
      items: { data: [{ id: 'si_replay', quantity: 3, price: { product: 'prod_builder' } }] },
    });

    await expect(processor().handle(body, signature(body, NOW))).resolves.toEqual({
      accepted: true,
      replayed: false,
    });
    await expect(processor().handle(body, signature(body, NOW))).resolves.toEqual({
      accepted: true,
      replayed: true,
    });

    expect(flexprice.assignments).toHaveLength(1);
    expect(flexprice.assignments[0]).toMatchObject({
      stripeSubscriptionId: 'sub_replay',
      stripeProductId: 'prod_builder',
      operationKey: `stripe-event:${stripeEventId}`,
    });
    const [subscription] = await database.sql<Array<{ count: string }>>`
      select count(*)::text as count from subscriptions where organization_id = ${organizationId}
    `;
    expect(subscription?.count).toBe('1');
  });

  it('delivers a paid credit checkout once under Stripe event replay', async () => {
    const sessions: Array<{ session: unknown; occurredAt: Date }> = [];
    const billing = createBillingWebhookProcessor({
      webhookSecret: WEBHOOK_SECRET,
      store: createDbBillingStore({ database: database.db }),
      idempotency: createActivityIdempotencyRepository(database.db),
      flexprice,
      plans,
      topups: {
        grantPaidCheckout(session, occurredAt) {
          sessions.push({ session, occurredAt });
          return Promise.resolve();
        },
      },
      now: () => NOW,
    });
    const body = event(
      `evt_checkout_topup_${organizationId.slice(4)}`,
      'checkout.session.async_payment_succeeded',
      {
        id: 'cs_test_credit_pack',
        mode: 'payment',
        payment_status: 'paid',
        metadata: {
          checkout_kind: 'credit_topup',
          organization_id: organizationId,
          credit_pack_id: 'starter',
        },
      },
    );

    await expect(billing.handle(body, signature(body, NOW))).resolves.toEqual({
      accepted: true,
      replayed: false,
    });
    await expect(billing.handle(body, signature(body, NOW))).resolves.toEqual({
      accepted: true,
      replayed: true,
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.session).toMatchObject({ id: 'cs_test_credit_pack' });
    expect(sessions[0]?.occurredAt).toEqual(NOW);
  });

  it('syncs active and deleted subscription lifecycle transitions to the organization plan', async () => {
    const created = event(
      `evt_subscription_created_${organizationId.slice(4)}`,
      'customer.subscription.created',
      {
      id: 'sub_lifecycle',
      customer: 'cus_lifecycle',
      status: 'active',
      current_period_start: 1_754_308_800,
      current_period_end: 1_756_987_200,
      metadata: { organization_id: organizationId, plan_id: 'studio' },
      items: { data: [{ id: 'si_lifecycle', quantity: 7, price: { product: 'prod_studio' } }] },
      },
    );
    await processor().handle(created, signature(created, NOW));

    const [active] = await database.sql<
      Array<{ plan: string; customer: string; status: string; plan_id: string }>
    >`
      select o.plan, o.billing_customer_id as customer, s.status, s.plan_id
        from organizations o
        join subscriptions s on s.organization_id = o.id
       where o.id = ${organizationId}
    `;
    expect(active).toEqual({
      plan: 'studio',
      customer: 'cus_lifecycle',
      status: 'active',
      plan_id: 'studio',
    });

    const deleted = event(
      `evt_subscription_deleted_${organizationId.slice(4)}`,
      'customer.subscription.deleted',
      {
      id: 'sub_lifecycle',
      customer: 'cus_lifecycle',
      status: 'canceled',
      current_period_start: 1_754_308_800,
      current_period_end: 1_756_987_200,
      metadata: { organization_id: organizationId, plan_id: 'studio' },
      items: { data: [{ id: 'si_lifecycle', quantity: 7, price: { product: 'prod_studio' } }] },
      },
    );
    await processor().handle(deleted, signature(deleted, NOW));

    const status = await createDbBillingStore({ database: database.db }).status(organizationId);
    expect(status).toMatchObject({ planId: 'trial', subscriptionStatus: 'canceled' });
    expect(flexprice.assignments.map(({ terminal }) => terminal)).toEqual([false, true]);
  });

  it('grants monthly credits once and mirrors the invoice in the append-only ledger', async () => {
    const subscription = event(
      `evt_grant_subscription_${organizationId.slice(4)}`,
      'customer.subscription.created',
      {
      id: 'sub_grant',
      customer: 'cus_grant',
      status: 'active',
      current_period_start: 1_754_308_800,
      current_period_end: 1_756_987_200,
      metadata: { organization_id: organizationId, plan_id: 'builder' },
      items: { data: [{ id: 'si_grant', quantity: 3, price: { product: 'prod_builder' } }] },
      },
    );
    await processor().handle(subscription, signature(subscription, NOW));

    const invoice = event(`evt_invoice_paid_${organizationId.slice(4)}`, 'invoice.paid', {
      id: 'in_monthly_grant',
      customer: 'cus_grant',
      subscription: 'sub_grant',
      billing_reason: 'subscription_cycle',
      period_start: 1_754_308_800,
      period_end: 1_756_987_200,
    });
    await processor().handle(invoice, signature(invoice, NOW));
    await processor().handle(invoice, signature(invoice, NOW));

    expect(flexprice.grants).toEqual([
      {
        organizationId,
        credits: '100.0000',
        operationKey: 'stripe-invoice:in_monthly_grant:credit-grant',
      },
    ]);
    const rows = await database.sql<
      Array<{ category: string; quantity: string; credits_charged: string; operation_key: string }>
    >`
      select category, quantity::text, credits_charged::text, operation_key
        from usage_ledger
       where organization_id = ${organizationId}
    `;
    expect(rows).toEqual([
      {
        category: 'credit_grant',
        quantity: '100.0000',
        credits_charged: '-100.0000',
        operation_key: 'stripe-invoice:in_monthly_grant:credit-grant',
      },
    ]);
    expect(flexprice.reconciliations).toHaveLength(1);
  });

  it('rejects a concurrently leased event so Stripe retries it', async () => {
    const stripeEventId = `evt_subscription_in_progress_${organizationId.slice(4)}`;
    const body = event(stripeEventId, 'customer.subscription.created', {
      id: 'sub_in_progress',
      customer: 'cus_in_progress',
      status: 'active',
      current_period_start: 1_754_308_800,
      current_period_end: 1_756_987_200,
      metadata: { organization_id: organizationId, plan_id: 'builder' },
      items: { data: [{ id: 'si_in_progress', quantity: 3, price: { product: 'prod_builder' } }] },
    });
    const repository = createActivityIdempotencyRepository(database.db);
    await repository.claim({
      idempotencyKey: `stripe-webhook:${stripeEventId}`,
      activityType: 'stripe_webhook',
      inputHash: createHash('sha256').update(body).digest('hex'),
      ownerId: 'billing-in-progress-owner',
      leaseMs: 60_000,
    });
    const billing = createBillingWebhookProcessor({
      webhookSecret: WEBHOOK_SECRET,
      store: createDbBillingStore({ database: database.db }),
      idempotency: repository,
      flexprice,
      plans,
      now: () => NOW,
    });

    await expect(billing.handle(body, signature(body, NOW))).rejects.toMatchObject({
      reason: 'in_progress',
    } satisfies Partial<StripeWebhookError>);
  });

  it('keeps data during seven-day dunning grace, then downgrades only limits to trial', async () => {
    const subscription = event(
      `evt_dunning_subscription_${organizationId.slice(4)}`,
      'customer.subscription.created',
      {
      id: 'sub_dunning',
      customer: 'cus_dunning',
      status: 'active',
      current_period_start: 1_754_308_800,
      current_period_end: 1_756_987_200,
      metadata: { organization_id: organizationId, plan_id: 'builder' },
      items: { data: [{ id: 'si_dunning', quantity: 3, price: { product: 'prod_builder' } }] },
      },
    );
    await processor().handle(subscription, signature(subscription, NOW));

    const failed = event(`evt_invoice_failed_${organizationId.slice(4)}`, 'invoice.payment_failed', {
      id: 'in_failed',
      customer: 'cus_dunning',
      subscription: 'sub_dunning',
    });
    await processor().handle(failed, signature(failed, NOW));
    const store = createDbBillingStore({ database: database.db });

    expect(await store.status(organizationId)).toMatchObject({
      planId: 'builder',
      dunning: {
        state: 'grace',
        failedInvoiceId: 'in_failed',
        graceEndsAt: '2026-08-18T12:00:00.000Z',
      },
    });
    await expect(store.downgradeExpiredDunning(new Date('2026-08-18T11:59:59.999Z'))).resolves.toBe(
      0,
    );
    await expect(store.downgradeExpiredDunning(new Date('2026-08-18T12:00:00.000Z'))).resolves.toBe(
      1,
    );
    expect(await store.status(organizationId)).toMatchObject({
      planId: 'trial',
      dunning: { state: 'downgraded', failedInvoiceId: 'in_failed' },
    });
    const [organization] = await database.sql<Array<{ count: string }>>`
      select count(*)::text as count from organizations where id = ${organizationId}
    `;
    expect(organization?.count).toBe('1');

    const recovered = event(
      `evt_invoice_recovered_${organizationId.slice(4)}`,
      'invoice.paid',
      {
        id: 'in_recovered',
        customer: 'cus_dunning',
        subscription: 'sub_dunning',
        billing_reason: 'subscription_cycle',
        period_start: 1_754_308_800,
        period_end: 1_756_987_200,
      },
    );
    await processor().handle(recovered, signature(recovered, NOW));
    expect(await store.status(organizationId)).toMatchObject({
      planId: 'builder',
      dunning: { state: 'current' },
    });
    expect(flexprice.grants.at(-1)).toMatchObject({ credits: '100.0000' });
  }, 15_000);
});
