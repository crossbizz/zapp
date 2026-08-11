import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

const CreditAmountSchema = z.string().regex(/^\d+(?:\.\d{1,4})?$/u);
const PlanIdSchema = z.enum(['trial', 'builder', 'studio']);

const BillingPlanSchema = z
  .object({
    monthlyCredits: CreditAmountSchema,
    seats: z.number().int().positive(),
  })
  .passthrough();

export const BillingPlanCatalogSchema = z
  .object({
    trial: BillingPlanSchema,
    builder: BillingPlanSchema,
    studio: BillingPlanSchema,
  })
  .strict();
export type BillingPlanCatalog = z.infer<typeof BillingPlanCatalogSchema>;
export type BillingPlanId = z.infer<typeof PlanIdSchema>;

export const StripePriceCatalogSchema = z
  .object({
    builder: z.string().regex(/^price_[A-Za-z0-9]+$/u),
    studio: z.string().regex(/^price_[A-Za-z0-9]+$/u),
  })
  .strict();
export type StripePriceCatalog = z.infer<typeof StripePriceCatalogSchema>;

export const StripePlatformSecretSchema = z
  .string()
  .regex(/^sk_(?:test|live)_[A-Za-z0-9]+$/u);
export const StripeWebhookSecretSchema = z.string().regex(/^whsec_[A-Za-z0-9]+$/u);
const StripeIdempotencyKeySchema = z.string().trim().min(8).max(255);
const StripeIdentifierSchema = z.string().trim().min(1).max(255);
const StripeUrlSchema = z.string().url().refine((value) => /^https?:\/\//u.test(value));

const StripeObjectSchema = z.object({ id: StripeIdentifierSchema }).passthrough();
const StripeObjectListSchema = z.object({ data: z.array(StripeObjectSchema) }).passthrough();
const StripeUrlObjectSchema = StripeObjectSchema.extend({ url: StripeUrlSchema }).passthrough();
const StripeSubscriptionSchema = StripeObjectSchema.extend({
  items: z.object({ data: z.array(StripeObjectSchema).min(1) }).passthrough(),
}).passthrough();
const StripeWebhookEndpointListSchema = z
  .object({
    data: z.array(
      z
        .object({
          url: StripeUrlSchema,
          status: z.string(),
          enabled_events: z.array(z.string()),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const FlexpricePlanSearchSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: StripeIdentifierSchema,
          lookup_key: PlanIdSchema,
        })
        .passthrough(),
    ),
  })
  .passthrough();
const FlexpriceMappingSchema = z
  .object({
    entity_id: StripeIdentifierSchema,
    entity_type: z.literal('plan'),
    provider_type: z.literal('stripe'),
    provider_entity_id: StripeIdentifierSchema,
  })
  .passthrough();
const FlexpriceMappingListSchema = z
  .object({ items: z.array(FlexpriceMappingSchema) })
  .passthrough();
const FlexpriceLinkResponseSchema = z
  .object({ mapping: FlexpriceMappingSchema })
  .passthrough();
const BILLING_WEBHOOK_EVENTS = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const;

export interface StripeBillingPort {
  createCheckout(input: {
    readonly organizationId: string;
    readonly planId: Exclude<BillingPlanId, 'trial'>;
    readonly seats: number;
    readonly priceId: string;
    readonly customerId: string | null;
    readonly successUrl: string;
    readonly cancelUrl: string;
    readonly operationKey: string;
  }): Promise<{ readonly id: string; readonly url: string }>;
  createPortal(input: {
    readonly customerId: string;
    readonly returnUrl: string;
    readonly operationKey: string;
  }): Promise<{ readonly id: string; readonly url: string }>;
  updateSeats(input: {
    readonly subscriptionId: string;
    readonly seats: number;
    readonly operationKey: string;
  }): Promise<void>;
  createProduct(input: {
    readonly planId: BillingPlanId;
    readonly operationKey: string;
  }): Promise<{ readonly id: string }>;
  createMonthlyPrice(input: {
    readonly productId: string;
    readonly planId: BillingPlanId;
    readonly unitAmountCents: number;
    readonly operationKey: string;
  }): Promise<{ readonly id: string }>;
  verifyWebhookEndpoint(input: { readonly url: string }): Promise<void>;
}

export interface FlexpriceStripeCatalogPort {
  linkPlan(input: {
    readonly planId: BillingPlanId;
    readonly stripeProductId: string;
  }): Promise<void>;
}

export function createFlexpriceStripeCatalogClient(options: {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetcher?: typeof fetch;
}): FlexpriceStripeCatalogPort {
  const apiKey = z.string().trim().min(1).parse(options.apiKey);
  const baseUrl = StripeUrlSchema.parse(options.baseUrl).replace(/\/+$/u, '');
  const fetcher = options.fetcher ?? fetch;

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await fetcher(`${baseUrl}${path}`, {
      method,
      headers: {
        'x-api-key': apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`Flexprice Stripe catalog request failed with status ${String(response.status)}`);
    }
    return await response.json();
  }

  return {
    async linkPlan(rawInput) {
      const input = z
        .object({
          planId: PlanIdSchema,
          stripeProductId: StripeIdentifierSchema,
        })
        .strict()
        .parse(rawInput);
      const plans = FlexpricePlanSearchSchema.parse(
        await request('POST', '/plans/search', {
          limit: 2,
          lookup_key: input.planId,
          offset: 0,
          status: 'published',
        }),
      ).items.filter((plan) => plan.lookup_key === input.planId);
      if (plans.length !== 1 || plans[0] === undefined) {
        throw new Error(`Flexprice plan ${input.planId} must exist exactly once before Stripe bootstrap`);
      }
      const planId = plans[0].id;
      const mappings = FlexpriceMappingListSchema.parse(
        await request(
          'GET',
          `/integrations/mappings?entity_type=plan&entity_id=${encodeURIComponent(planId)}`,
        ),
      ).items;
      if (mappings.length > 1) {
        throw new Error(`Flexprice plan ${input.planId} has multiple Stripe mappings`);
      }
      if (mappings[0]?.provider_entity_id === input.stripeProductId) return;
      if (mappings[0] !== undefined) {
        throw new Error(`Flexprice plan ${input.planId} is linked to a different Stripe product`);
      }
      FlexpriceLinkResponseSchema.parse(
        await request('POST', '/integrations/link', {
          entity_type: 'plan',
          entity_id: planId,
          provider_type: 'stripe',
          provider_entity_id: input.stripeProductId,
          metadata: { plan_id: input.planId, source: 'zapp_billing_bootstrap' },
        }),
      );
    },
  };
}

function append(
  params: URLSearchParams,
  entries: ReadonlyArray<readonly [string, string | number]>,
): URLSearchParams {
  for (const [key, value] of entries) params.append(key, String(value));
  return params;
}

export function createStripeBillingClient(options: {
  readonly platformSecretKey: string;
  readonly fetcher?: typeof fetch;
  readonly baseUrl?: string;
}): StripeBillingPort {
  const apiKey = StripePlatformSecretSchema.parse(options.platformSecretKey);
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = (options.baseUrl ?? 'https://api.stripe.com').replace(/\/+$/u, '');

  async function request(
    method: 'GET' | 'POST',
    path: string,
    operationKey: string,
    body?: URLSearchParams,
  ): Promise<unknown> {
    const response = await fetcher(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(method === 'POST'
          ? {
              'content-type': 'application/x-www-form-urlencoded',
              'idempotency-key': StripeIdempotencyKeySchema.parse(operationKey),
            }
          : {}),
      },
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) {
      throw new Error(`Stripe billing request failed with status ${String(response.status)}`);
    }
    return await response.json();
  }

  return {
    async createCheckout(input) {
      const query = encodeURIComponent(
        `metadata['flexprice_customer_id']:'${input.organizationId}'`,
      );
      const matchingCustomers =
        input.customerId === null
          ? StripeObjectListSchema.parse(
              await request(
                'GET',
                `/v1/customers/search?query=${query}&limit=2`,
                'stripe-customer-search',
              ),
            ).data
          : [];
      if (matchingCustomers.length > 1) {
        throw new Error('Stripe returned multiple customers for one organization');
      }
      const customerId =
        input.customerId ??
        matchingCustomers[0]?.id ??
        StripeObjectSchema.parse(
          await request(
            'POST',
            '/v1/customers',
            `${input.operationKey}:customer`,
            append(new URLSearchParams(), [
              ['metadata[organization_id]', input.organizationId],
              ['metadata[flexprice_customer_id]', input.organizationId],
            ]),
          ),
        ).id;
      const params = append(new URLSearchParams(), [
        ['mode', 'subscription'],
        ['client_reference_id', input.organizationId],
        ['line_items[0][price]', input.priceId],
        ['line_items[0][quantity]', input.seats],
        ['success_url', input.successUrl],
        ['cancel_url', input.cancelUrl],
        ['metadata[organization_id]', input.organizationId],
        ['metadata[plan_id]', input.planId],
        ['subscription_data[metadata][organization_id]', input.organizationId],
        ['subscription_data[metadata][plan_id]', input.planId],
        ['customer', customerId],
      ]);
      return StripeUrlObjectSchema.parse(
        await request('POST', '/v1/checkout/sessions', input.operationKey, params),
      );
    },

    async createPortal(input) {
      const params = append(new URLSearchParams(), [
        ['customer', input.customerId],
        ['return_url', input.returnUrl],
      ]);
      return StripeUrlObjectSchema.parse(
        await request('POST', '/v1/billing_portal/sessions', input.operationKey, params),
      );
    },

    async updateSeats(input) {
      const subscription = StripeSubscriptionSchema.parse(
        await request('GET', `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, input.operationKey),
      );
      const params = append(new URLSearchParams(), [
        ['items[0][id]', subscription.items.data[0]?.id ?? ''],
        ['items[0][quantity]', input.seats],
        ['proration_behavior', 'create_prorations'],
      ]);
      StripeObjectSchema.parse(
        await request(
          'POST',
          `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
          input.operationKey,
          params,
        ),
      );
    },

    async createProduct(input) {
      return StripeObjectSchema.parse(
        await request(
          'POST',
          '/v1/products',
          input.operationKey,
          append(new URLSearchParams(), [
            ['name', `zapp.build ${input.planId}`],
            ['metadata[plan_id]', input.planId],
          ]),
        ),
      );
    },

    async createMonthlyPrice(input) {
      return StripeObjectSchema.parse(
        await request(
          'POST',
          '/v1/prices',
          input.operationKey,
          append(new URLSearchParams(), [
            ['product', input.productId],
            ['currency', 'usd'],
            ['unit_amount', input.unitAmountCents],
            ['recurring[interval]', 'month'],
            ['lookup_key', `zapp:${input.planId}:monthly:seat`],
            ['metadata[plan_id]', input.planId],
          ]),
        ),
      );
    },

    async verifyWebhookEndpoint(input) {
      const endpoints = StripeWebhookEndpointListSchema.parse(
        await request('GET', '/v1/webhook_endpoints?limit=100', 'stripe-webhook-endpoints'),
      );
      const expectedUrl = StripeUrlSchema.parse(input.url);
      const endpoint = endpoints.data.find(
        (candidate) => candidate.url === expectedUrl && candidate.status === 'enabled',
      );
      if (
        endpoint === undefined ||
        BILLING_WEBHOOK_EVENTS.some((eventName) => !endpoint.enabled_events.includes(eventName))
      ) {
        throw new Error('Flexprice Stripe webhook endpoint is not fully configured');
      }
    },
  };
}

const UnitAmountsSchema = z
  .object({
    trial: z.number().int().nonnegative(),
    builder: z.number().int().nonnegative(),
    studio: z.number().int().nonnegative(),
  })
  .strict();

export async function bootstrapStripeCatalog(input: {
  readonly plans: BillingPlanCatalog;
  readonly monthlyUnitAmountsCents: z.infer<typeof UnitAmountsSchema>;
  readonly flexpriceStripeWebhookUrl: string;
  readonly flexprice: FlexpriceStripeCatalogPort;
  readonly stripe: Pick<
    StripeBillingPort,
    'createProduct' | 'createMonthlyPrice' | 'verifyWebhookEndpoint'
  >;
}): Promise<Record<BillingPlanId, string>> {
  const plans = BillingPlanCatalogSchema.parse(input.plans);
  const amounts = UnitAmountsSchema.parse(input.monthlyUnitAmountsCents);
  await input.stripe.verifyWebhookEndpoint({ url: input.flexpriceStripeWebhookUrl });
  const priceIds = {} as Record<BillingPlanId, string>;
  for (const planId of PlanIdSchema.options) {
    // Reading the plan is deliberate: a price can never be bootstrapped for a
    // name absent from the authoritative entitlement catalog.
    BillingPlanSchema.parse(plans[planId]);
    const product = await input.stripe.createProduct({
      planId,
      operationKey: `stripe-product:${planId}`,
    });
    await input.flexprice.linkPlan({ planId, stripeProductId: product.id });
    const price = await input.stripe.createMonthlyPrice({
      productId: product.id,
      planId,
      unitAmountCents: amounts[planId],
      operationKey: `stripe-price:${planId}:monthly-seat:${String(amounts[planId])}`,
    });
    priceIds[planId] = price.id;
  }
  return priceIds;
}

async function runBootstrap(): Promise<void> {
  const plansUrl = new URL('../../../../config/plans.json', import.meta.url);
  const plans = BillingPlanCatalogSchema.parse(JSON.parse(await readFile(plansUrl, 'utf8')));
  const amounts = UnitAmountsSchema.parse(
    JSON.parse(process.env['STRIPE_PLAN_MONTHLY_UNIT_AMOUNTS_CENTS_JSON'] ?? ''),
  );
  const priceIds = await bootstrapStripeCatalog({
    plans,
    monthlyUnitAmountsCents: amounts,
    flexpriceStripeWebhookUrl: process.env['FLEXPRICE_STRIPE_WEBHOOK_URL'] ?? '',
    flexprice: createFlexpriceStripeCatalogClient({
      apiKey: process.env['FLEXPRICE_API_KEY'] ?? '',
      baseUrl: process.env['FLEXPRICE_BASE_URL'] ?? '',
    }),
    stripe: createStripeBillingClient({
      platformSecretKey: process.env['PLATFORM_BILLING_STRIPE_SECRET_KEY'] ?? '',
    }),
  });
  process.stdout.write(`${JSON.stringify(priceIds, null, 2)}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runBootstrap();
}
