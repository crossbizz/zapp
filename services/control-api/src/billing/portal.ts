import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { operationOf } from '../routes/runs.js';
import {
  StripePriceCatalogSchema,
  type StripeBillingPort,
  type StripePriceCatalog,
} from './stripe.js';
import type { BillingStore } from './webhooks.js';

const CheckoutBodySchema = z
  .object({
    planId: z.enum(['builder', 'studio']),
    seats: z.number().int().min(1).max(1_000),
  })
  .strict();
const SeatBodySchema = z.object({ seats: z.number().int().min(1).max(1_000) }).strict();
const UrlResponseSchema = z.object({ url: z.string().url() }).strict();
const AcceptedResponseSchema = z.object({ accepted: z.literal(true) }).strict();
const DunningResponseSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('current') }).strict(),
  z
    .object({
      state: z.literal('grace'),
      failedInvoiceId: z.string(),
      graceEndsAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      state: z.literal('downgraded'),
      failedInvoiceId: z.string(),
      graceEndsAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);
const BillingStatusResponseSchema = z
  .object({
    billing: z
      .object({
        planId: z.string(),
        customerId: z.string().nullable(),
        subscriptionId: z.string().nullable(),
        subscriptionStatus: z.string().nullable(),
        dunning: DunningResponseSchema,
      })
      .strict(),
  })
  .strict();

export interface BillingRoutesDeps {
  readonly stripe: StripeBillingPort;
  readonly store: BillingStore;
  readonly prices: StripePriceCatalog;
  readonly appBaseUrl: string;
}

function billingNotFound(): ApiError {
  return new ApiError('billing_not_found', 404, 'Billing is not configured for this organization.');
}

function billingCustomerMissing(): ApiError {
  return new ApiError(
    'billing_customer_missing',
    409,
    'Start a subscription before opening the billing portal.',
  );
}

function billingSubscriptionMissing(): ApiError {
  return new ApiError(
    'billing_subscription_missing',
    409,
    'Start a subscription before changing seats.',
  );
}

export function registerBillingRoutes(app: AppInstance, dependencies: BillingRoutesDeps): void {
  const prices = StripePriceCatalogSchema.parse(dependencies.prices);
  const appBaseUrl = new URL(dependencies.appBaseUrl);

  app.get(
    '/v1/billing/status',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { response: { 200: BillingStatusResponseSchema } },
    },
    async (request) => {
      const context = tenantOf(request);
      const billing = await dependencies.store.status(context.organizationId);
      if (billing === undefined) throw billingNotFound();
      return BillingStatusResponseSchema.parse({ billing });
    },
  );

  app.post(
    '/v1/billing/checkout',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { body: CheckoutBodySchema, response: { 201: UrlResponseSchema } },
    },
    async (request, reply) => {
      const context = tenantOf(request);
      authorize(context, 'manage_organization');
      const body = CheckoutBodySchema.parse(request.body);
      const current = await dependencies.store.status(context.organizationId);
      if (current === undefined) throw billingNotFound();
      const checkout = await dependencies.stripe.createCheckout({
        organizationId: context.organizationId,
        planId: body.planId,
        seats: body.seats,
        priceId: prices[body.planId],
        customerId: current.customerId,
        successUrl: new URL('/settings/billing?checkout=success', appBaseUrl).toString(),
        cancelUrl: new URL('/settings/billing?checkout=cancelled', appBaseUrl).toString(),
        operationKey: operationOf(request),
      });
      return await reply.status(201).send({ url: checkout.url });
    },
  );

  app.post(
    '/v1/billing/portal',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { response: { 201: UrlResponseSchema } },
    },
    async (request, reply) => {
      const context = tenantOf(request);
      authorize(context, 'manage_organization');
      const current = await dependencies.store.status(context.organizationId);
      if (current === undefined) throw billingNotFound();
      if (current.customerId === null) throw billingCustomerMissing();
      const portal = await dependencies.stripe.createPortal({
        customerId: current.customerId,
        returnUrl: new URL('/settings/billing', appBaseUrl).toString(),
        operationKey: operationOf(request),
      });
      return await reply.status(201).send({ url: portal.url });
    },
  );

  app.patch(
    '/v1/billing/subscription',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { body: SeatBodySchema, response: { 202: AcceptedResponseSchema } },
    },
    async (request, reply) => {
      const context = tenantOf(request);
      authorize(context, 'manage_organization');
      const body = SeatBodySchema.parse(request.body);
      const current = await dependencies.store.status(context.organizationId);
      if (current === undefined) throw billingNotFound();
      if (current.subscriptionId === null) throw billingSubscriptionMissing();
      await dependencies.stripe.updateSeats({
        subscriptionId: current.subscriptionId,
        seats: body.seats,
        operationKey: operationOf(request),
      });
      return await reply.status(202).send({ accepted: true });
    },
  );
}
