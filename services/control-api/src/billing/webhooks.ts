import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { newId } from '@zapp/contracts';
import {
  organizations,
  subscriptions,
  usageLedger,
  type ActivityIdempotencyRepository,
  type Database,
} from '@zapp/db';
import { and, eq, gte, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { paymentFailedNotification, type NotificationTrigger } from '../notifications/service.js';
import { BillingPlanCatalogSchema, type BillingPlanCatalog } from './stripe.js';
import type { CreditGrantService } from './topup.js';

const StripeEventIdSchema = z.string().regex(/^evt_[A-Za-z0-9_]+$/u);
const StripeObjectIdSchema = z.string().trim().min(1).max(255);
const UnixTimestampSchema = z.number().int().nonnegative();
const PlanIdSchema = z.enum(['trial', 'builder', 'studio']);

const StripeSubscriptionObjectSchema = z
  .object({
    id: StripeObjectIdSchema,
    customer: StripeObjectIdSchema,
    status: z.string().trim().min(1).max(100),
    current_period_start: UnixTimestampSchema,
    current_period_end: UnixTimestampSchema,
    metadata: z
      .object({
        organization_id: z.string().trim().min(1),
        plan_id: PlanIdSchema,
      })
      .passthrough(),
    items: z
      .object({
        data: z
          .array(
            z
              .object({
                id: StripeObjectIdSchema,
                quantity: z.number().int().positive().nullable().optional(),
                price: z.object({ product: StripeObjectIdSchema }).passthrough(),
              })
              .passthrough(),
          )
          .min(1),
      })
      .passthrough(),
  })
  .passthrough();

const StripeInvoiceObjectSchema = z
  .object({
    id: StripeObjectIdSchema,
    customer: StripeObjectIdSchema,
    subscription: StripeObjectIdSchema.nullable().optional(),
    billing_reason: z.string().optional(),
    period_start: UnixTimestampSchema.optional(),
    period_end: UnixTimestampSchema.optional(),
  })
  .passthrough();

const StripeEventSchema = z
  .object({
    id: StripeEventIdSchema,
    object: z.literal('event'),
    created: UnixTimestampSchema,
    type: z.enum([
      'checkout.session.async_payment_succeeded',
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed',
    ]),
    data: z.object({ object: z.record(z.unknown()) }).strict(),
  })
  .passthrough();

const DunningStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('current') }).strict(),
  z
    .object({
      state: z.literal('grace'),
      failedInvoiceId: StripeObjectIdSchema,
      graceEndsAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      state: z.literal('downgraded'),
      failedInvoiceId: StripeObjectIdSchema,
      graceEndsAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);
export type BillingDunningState = z.infer<typeof DunningStateSchema>;

const BillingSettingsSchema = z
  .object({
    billing: z.object({ dunning: DunningStateSchema }).strict().optional(),
  })
  .passthrough();

export interface BillingStatus {
  readonly planId: string;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly subscriptionStatus: string | null;
  readonly dunning: BillingDunningState;
}

export interface BillingStore {
  status(organizationId: string): Promise<BillingStatus | undefined>;
  syncSubscription(input: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly stripeSubscriptionId: string;
    readonly planId: string;
    readonly status: string;
    readonly currentPeriodStart: Date;
    readonly currentPeriodEnd: Date;
    readonly terminal: boolean;
  }): Promise<void>;
  findOrganizationByCustomer(customerId: string): Promise<string | undefined>;
  markPaymentFailed(input: {
    readonly organizationId: string;
    readonly invoiceId: string;
    readonly failedAt: Date;
  }): Promise<void>;
  clearDunning(organizationId: string): Promise<void>;
  mirrorCreditGrant(input: {
    readonly organizationId: string;
    readonly invoiceId: string;
    readonly credits: string;
    readonly occurredAt: Date;
  }): Promise<void>;
  ledgerCostUsd(input: {
    readonly organizationId: string;
    readonly from: Date;
    readonly to: Date;
  }): Promise<string>;
  downgradeExpiredDunning(now: Date): Promise<number>;
}

function ledgerId(organizationId: string, operationKey: string): string {
  return `usage_${createHash('sha256').update(`${organizationId}\0${operationKey}`).digest('hex').slice(0, 32)}`;
}

function dunningFromSettings(settings: unknown): BillingDunningState {
  const parsed = BillingSettingsSchema.safeParse(settings);
  return parsed.success && parsed.data.billing !== undefined
    ? parsed.data.billing.dunning
    : { state: 'current' };
}

export function createDbBillingStore(options: { readonly database: Database }): BillingStore {
  const { database } = options;
  return {
    async status(organizationId) {
      const [organization] = await database
        .select({
          planId: organizations.plan,
          customerId: organizations.billingCustomerId,
          settings: organizations.settingsJson,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      if (organization === undefined) return undefined;
      const [subscription] = await database
        .select({
          subscriptionId: subscriptions.stripeSubscriptionId,
          status: subscriptions.status,
        })
        .from(subscriptions)
        .where(eq(subscriptions.organizationId, organizationId))
        .orderBy(
          sql`case when ${subscriptions.status} in ('active', 'trialing', 'past_due') then 0 else 1 end`,
        )
        .limit(1);
      return {
        planId: organization.planId,
        customerId: organization.customerId,
        subscriptionId: subscription?.subscriptionId ?? null,
        subscriptionStatus: subscription?.status ?? null,
        dunning: dunningFromSettings(organization.settings),
      };
    },

    async syncSubscription(input) {
      await database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`stripe-subscription:${input.stripeSubscriptionId}`}, 0))`,
        );
        const [otherCustomer] = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(
            and(
              eq(organizations.billingCustomerId, input.customerId),
              ne(organizations.id, input.organizationId),
            ),
          )
          .limit(1);
        if (otherCustomer !== undefined) {
          throw new Error('Stripe customer is already bound to another organization');
        }
        const [organization] = await tx
          .select({ customerId: organizations.billingCustomerId })
          .from(organizations)
          .where(eq(organizations.id, input.organizationId))
          .limit(1)
          .for('update');
        if (organization === undefined) throw new Error('Billing organization does not exist');
        if (organization.customerId !== null && organization.customerId !== input.customerId) {
          throw new Error('Billing organization is already bound to another Stripe customer');
        }

        const [existing] = await tx
          .select({ id: subscriptions.id, organizationId: subscriptions.organizationId })
          .from(subscriptions)
          .where(eq(subscriptions.stripeSubscriptionId, input.stripeSubscriptionId))
          .limit(1);
        if (existing === undefined) {
          await tx.insert(subscriptions).values({
            id: newId('sub'),
            organizationId: input.organizationId,
            stripeSubscriptionId: input.stripeSubscriptionId,
            planId: input.planId,
            status: input.status,
            currentPeriodStart: input.currentPeriodStart,
            currentPeriodEnd: input.currentPeriodEnd,
          });
        } else {
          if (existing.organizationId !== input.organizationId) {
            throw new Error('Stripe subscription is already bound to another organization');
          }
          await tx
            .update(subscriptions)
            .set({
              planId: input.planId,
              status: input.status,
              currentPeriodStart: input.currentPeriodStart,
              currentPeriodEnd: input.currentPeriodEnd,
            })
            .where(
              and(
                eq(subscriptions.id, existing.id),
                eq(subscriptions.organizationId, input.organizationId),
              ),
            );
        }
        await tx
          .update(organizations)
          .set({
            billingCustomerId: input.customerId,
            plan: input.terminal ? 'trial' : input.planId,
          })
          .where(eq(organizations.id, input.organizationId));
      });
    },

    async findOrganizationByCustomer(customerId) {
      const [organization] = await database
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.billingCustomerId, customerId))
        .limit(1);
      return organization?.id;
    },

    async markPaymentFailed(input) {
      const graceEndsAt = new Date(input.failedAt.getTime() + 7 * 24 * 60 * 60 * 1_000);
      const dunning = DunningStateSchema.parse({
        state: 'grace',
        failedInvoiceId: input.invoiceId,
        graceEndsAt: graceEndsAt.toISOString(),
      });
      await database
        .update(organizations)
        .set({
          settingsJson: sql`jsonb_set(${organizations.settingsJson}, '{billing}', ${JSON.stringify({ dunning })}::jsonb, true)`,
        })
        .where(eq(organizations.id, input.organizationId));
    },

    async clearDunning(organizationId) {
      const dunning = DunningStateSchema.parse({ state: 'current' });
      await database
        .update(organizations)
        .set({
          plan: sql`coalesce(
            (
              select ${subscriptions.planId}
                from ${subscriptions}
               where ${subscriptions.organizationId} = ${organizationId}
                 and ${subscriptions.status} in ('active', 'trialing', 'past_due')
               order by ${subscriptions.currentPeriodEnd} desc nulls last
               limit 1
            ),
            ${organizations.plan}
          )`,
          settingsJson: sql`jsonb_set(${organizations.settingsJson}, '{billing}', ${JSON.stringify({ dunning })}::jsonb, true)`,
        })
        .where(eq(organizations.id, organizationId));
    },

    async mirrorCreditGrant(input) {
      const operationKey = `stripe-invoice:${input.invoiceId}:credit-grant`;
      await database
        .insert(usageLedger)
        .values({
          id: ledgerId(input.organizationId, operationKey),
          operationKey,
          organizationId: input.organizationId,
          projectId: null,
          runId: null,
          taskId: null,
          category: 'credit_grant',
          provider: 'flexprice',
          quantity: input.credits,
          unit: 'credits',
          costUsd: '0.000000',
          creditsCharged: input.credits.startsWith('-') ? input.credits : `-${input.credits}`,
          metadata: { invoice_id: input.invoiceId },
          occurredAt: input.occurredAt,
        })
        .onConflictDoNothing();
    },

    async ledgerCostUsd(input) {
      const [aggregate] = await database
        .select({ cost: sql<string>`coalesce(sum(${usageLedger.costUsd}), 0)::text` })
        .from(usageLedger)
        .where(
          and(
            eq(usageLedger.organizationId, input.organizationId),
            ne(usageLedger.category, 'credit_grant'),
            gte(usageLedger.occurredAt, input.from),
            lt(usageLedger.occurredAt, input.to),
          ),
        );
      return aggregate?.cost ?? '0';
    },

    async downgradeExpiredDunning(now) {
      const rows = await database.execute(sql`
        update organizations
           set plan = 'trial',
               settings_json = jsonb_set(
                 settings_json,
                 '{billing,dunning,state}',
                 '"downgraded"'::jsonb,
                 true
               )
         where settings_json #>> '{billing,dunning,state}' = 'grace'
           and (settings_json #>> '{billing,dunning,graceEndsAt}')::timestamptz <= ${now.toISOString()}::timestamptz
        returning id
      `);
      return rows.length;
    },
  };
}

export interface FlexpriceBillingPort {
  verifyStripeAssignment(input: {
    readonly organizationId: string;
    readonly stripeSubscriptionId: string;
    readonly stripeProductId: string;
    readonly terminal: boolean;
    readonly operationKey: string;
  }): Promise<void>;
  grantCredits(input: {
    readonly organizationId: string;
    readonly credits: string;
    readonly operationKey: string;
  }): Promise<void>;
  reconcileInvoice(input: {
    readonly organizationId: string;
    readonly invoiceId: string;
    readonly ledgerCostUsd: string;
    readonly from: Date;
    readonly to: Date;
    readonly operationKey: string;
  }): Promise<void>;
}

const FlexpriceWalletSchema = z
  .object({
    id: z.string().trim().min(1),
    wallet_type: z.string(),
    wallet_status: z.string(),
  })
  .passthrough();
const FlexpriceAnalyticsSchema = z
  .object({ total_cost: z.string().regex(/^-?\d+(?:\.\d+)?$/u), items: z.array(z.unknown()) })
  .passthrough();
const MoneySchema = z.string().regex(/^-?\d+(?:\.\d{1,6})?$/u);
const FlexpriceSubscriptionListSchema = z
  .object({
    items: z.array(
      z
        .object({
          lookup_key: z.string(),
          subscription_status: z.string(),
          plan: z.object({ lookup_key: z.string() }).passthrough().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function moneyUnits(value: string): bigint {
  const parsed = MoneySchema.parse(value);
  const negative = parsed.startsWith('-');
  const absolute = negative ? parsed.slice(1) : parsed;
  const [whole = '0', fraction = ''] = absolute.split('.');
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return negative ? -units : units;
}

export function createFlexpriceBillingClient(options: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetcher?: typeof fetch;
}): FlexpriceBillingPort {
  const baseUrl = `${z.string().url().parse(options.baseUrl).replace(/\/+$/u, '')}/`;
  const apiKey = z.string().trim().min(1).parse(options.apiKey);
  const fetcher = options.fetcher ?? fetch;

  async function request(url: string | URL, init: RequestInit): Promise<Response> {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      throw new Error(`Flexprice billing request failed with status ${String(response.status)}`);
    }
    return response;
  }

  return {
    async verifyStripeAssignment(input) {
      const response = await request(new URL('subscriptions/search', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          external_customer_id: input.organizationId,
          expand: 'plan',
          limit: 100,
        }),
      });
      const subscriptions = FlexpriceSubscriptionListSchema.parse(await response.json());
      const matching = subscriptions.items.find(
        (subscription) => subscription.lookup_key === input.stripeSubscriptionId,
      );
      if (matching === undefined || matching.plan?.lookup_key !== input.stripeProductId) {
        throw new Error('Flexprice has not synchronized the Stripe subscription assignment');
      }
      const terminal = ['cancelled', 'canceled', 'unpaid'].includes(
        matching.subscription_status.toLowerCase(),
      );
      if (terminal !== input.terminal) {
        throw new Error('Flexprice Stripe subscription status is not synchronized');
      }
    },

    async grantCredits(input) {
      const walletsUrl = new URL('customers/wallets', baseUrl);
      walletsUrl.searchParams.set('lookup_key', input.organizationId);
      walletsUrl.searchParams.set('include_real_time_balance', 'true');
      const wallets = z
        .array(FlexpriceWalletSchema)
        .parse(await (await request(walletsUrl, { headers: { 'x-api-key': apiKey } })).json());
      const active = wallets.filter(
        (wallet) => wallet.wallet_type === 'PRE_PAID' && wallet.wallet_status === 'active',
      );
      if (active.length !== 1) {
        throw new Error('Flexprice did not return exactly one active prepaid wallet');
      }
      await request(new URL(`wallets/${encodeURIComponent(active[0]?.id ?? '')}/top-up`, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          credits_to_add: input.credits,
          transaction_reason: 'SUBSCRIPTION_CREDIT_GRANT',
          idempotency_key: input.operationKey,
          description: 'Monthly zapp.build subscription credit grant',
        }),
      });
    },

    async reconcileInvoice(input) {
      const response = await request(new URL('events/analytics', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          external_customer_id: input.organizationId,
          start_time: input.from.toISOString(),
          end_time: input.to.toISOString(),
        }),
      });
      const analytics = FlexpriceAnalyticsSchema.parse(await response.json());
      if (moneyUnits(analytics.total_cost) !== moneyUnits(input.ledgerCostUsd)) {
        throw new Error(`Flexprice invoice ${input.invoiceId} does not match the usage ledger`);
      }
    },
  };
}

export class StripeWebhookError extends Error {
  public constructor(
    message: string,
    public readonly reason: 'signature' | 'payload' | 'conflict' | 'in_progress' = 'payload',
  ) {
    super(message);
    this.name = 'StripeWebhookError';
  }
}

function verifyStripeSignature(input: {
  readonly body: Buffer;
  readonly header: string;
  readonly secret: string;
  readonly now: Date;
  readonly toleranceSeconds: number;
}): void {
  const parts = input.header.split(',').map((part) => part.split('=', 2) as [string, string]);
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (timestamp === undefined || !/^\d+$/u.test(timestamp) || signatures.length === 0) {
    throw new StripeWebhookError('Stripe signature is malformed', 'signature');
  }
  const seconds = Number(timestamp);
  if (Math.abs(Math.floor(input.now.getTime() / 1_000) - seconds) > input.toleranceSeconds) {
    throw new StripeWebhookError('Stripe signature timestamp is outside tolerance', 'signature');
  }
  const expected = Buffer.from(
    createHmac('sha256', input.secret)
      .update(`${timestamp}.${input.body.toString('utf8')}`)
      .digest('hex'),
    'hex',
  );
  const valid = signatures.some((candidate) => {
    if (!/^[0-9a-f]{64}$/u.test(candidate)) return false;
    const actual = Buffer.from(candidate, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  if (!valid) throw new StripeWebhookError('Stripe signature is invalid', 'signature');
}

const TERMINAL_SUBSCRIPTION_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

export function createBillingWebhookProcessor(options: {
  readonly webhookSecret: string;
  readonly store: BillingStore;
  readonly idempotency: ActivityIdempotencyRepository;
  readonly flexprice: FlexpriceBillingPort;
  readonly plans: BillingPlanCatalog;
  readonly topups?: Pick<CreditGrantService, 'grantPaidCheckout'>;
  readonly enqueueNotification?: (trigger: NotificationTrigger) => Promise<void>;
  readonly now?: () => Date;
  readonly signatureToleranceSeconds?: number;
}): {
  handle(body: Buffer, signature: string): Promise<{ accepted: true; replayed: boolean }>;
} {
  const plans = BillingPlanCatalogSchema.parse(options.plans);
  const now = options.now ?? (() => new Date());
  const toleranceSeconds = options.signatureToleranceSeconds ?? 300;

  async function apply(event: z.infer<typeof StripeEventSchema>): Promise<void> {
    const operationKey = `stripe-event:${event.id}`;
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      if (options.topups === undefined) {
        throw new Error('Credit top-up checkout processing is not configured');
      }
      await options.topups.grantPaidCheckout(event.data.object, new Date(event.created * 1_000));
      return;
    }
    if (event.type.startsWith('customer.subscription.')) {
      const subscription = StripeSubscriptionObjectSchema.parse(event.data.object);
      const planId = subscription.metadata.plan_id;
      BillingPlanCatalogSchema.parse(plans);
      await options.store.syncSubscription({
        organizationId: subscription.metadata.organization_id,
        customerId: subscription.customer,
        stripeSubscriptionId: subscription.id,
        planId,
        status: subscription.status,
        currentPeriodStart: new Date(subscription.current_period_start * 1_000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1_000),
        terminal:
          event.type === 'customer.subscription.deleted' ||
          TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status),
      });
      await options.flexprice.verifyStripeAssignment({
        organizationId: subscription.metadata.organization_id,
        stripeSubscriptionId: subscription.id,
        stripeProductId: subscription.items.data[0]?.price.product ?? '',
        terminal:
          event.type === 'customer.subscription.deleted' ||
          TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status),
        operationKey,
      });
      return;
    }

    const invoice = StripeInvoiceObjectSchema.parse(event.data.object);
    const organizationId = await options.store.findOrganizationByCustomer(invoice.customer);
    if (organizationId === undefined) throw new Error('Stripe invoice customer is not linked');
    const status = await options.store.status(organizationId);
    if (status === undefined) throw new Error('Billing organization disappeared');
    if (event.type === 'invoice.payment_failed') {
      if (invoice.subscription === undefined || invoice.subscription !== status.subscriptionId)
        return;
      await options.store.markPaymentFailed({
        organizationId,
        invoiceId: invoice.id,
        failedAt: new Date(event.created * 1_000),
      });
      await options.enqueueNotification?.(
        paymentFailedNotification({
          organizationId,
          invoiceId: invoice.id,
          occurredAt: new Date(event.created * 1_000).toISOString(),
        }),
      );
      return;
    }

    if (
      invoice.subscription === undefined ||
      invoice.subscription === null ||
      invoice.subscription !== status.subscriptionId ||
      !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason ?? '')
    ) {
      return;
    }
    await options.store.clearDunning(organizationId);
    const recoveredStatus = await options.store.status(organizationId);
    if (recoveredStatus === undefined) throw new Error('Billing organization disappeared');
    const planId = PlanIdSchema.parse(recoveredStatus.planId);
    const credits = plans[planId].monthlyCredits;
    const creditOperationKey = `stripe-invoice:${invoice.id}:credit-grant`;
    await options.flexprice.grantCredits({
      organizationId,
      credits,
      operationKey: creditOperationKey,
    });
    const occurredAt = new Date(event.created * 1_000);
    const from = new Date((invoice.period_start ?? event.created) * 1_000);
    const to = new Date((invoice.period_end ?? event.created + 1) * 1_000);
    const ledgerCostUsd = await options.store.ledgerCostUsd({ organizationId, from, to });
    await options.flexprice.reconcileInvoice({
      organizationId,
      invoiceId: invoice.id,
      ledgerCostUsd,
      from,
      to,
      operationKey: `stripe-invoice:${invoice.id}:reconcile`,
    });
    await options.store.mirrorCreditGrant({
      organizationId,
      invoiceId: invoice.id,
      credits,
      occurredAt,
    });
  }

  return {
    async handle(body, signature) {
      const instant = now();
      verifyStripeSignature({
        body,
        header: signature,
        secret: options.webhookSecret,
        now: instant,
        toleranceSeconds,
      });
      let event: z.infer<typeof StripeEventSchema>;
      try {
        event = StripeEventSchema.parse(JSON.parse(body.toString('utf8')));
      } catch {
        throw new StripeWebhookError('Stripe webhook payload is invalid');
      }
      const ownerId = randomUUID();
      const claim = await options.idempotency.claim({
        idempotencyKey: `stripe-webhook:${event.id}`,
        activityType: 'stripe_webhook',
        inputHash: createHash('sha256').update(body).digest('hex'),
        ownerId,
        leaseMs: 60_000,
      });
      if (claim.status === 'replay') {
        return { accepted: true, replayed: true };
      }
      if (claim.status === 'in_progress') {
        throw new StripeWebhookError('Stripe event is already being processed', 'in_progress');
      }
      if (claim.status === 'conflict') {
        throw new StripeWebhookError(
          'Stripe event id was reused with a different payload',
          'conflict',
        );
      }
      try {
        await apply(event);
        const completed = await options.idempotency.complete({
          idempotencyKey: `stripe-webhook:${event.id}`,
          ownerId,
          resultHash: createHash('sha256').update('accepted').digest('hex'),
          result: { accepted: true },
        });
        if (!completed) throw new Error('Stripe webhook idempotency lease was lost');
        return { accepted: true, replayed: false };
      } catch (error) {
        await options.idempotency.release({
          idempotencyKey: `stripe-webhook:${event.id}`,
          ownerId,
        });
        throw error;
      }
    },
  };
}

export type BillingWebhookProcessor = ReturnType<typeof createBillingWebhookProcessor>;

const StripeWebhookHeadersSchema = z
  .object({ 'stripe-signature': z.string().trim().min(1).max(2_000).optional() })
  .passthrough();
const StripeWebhookAcceptedSchema = z.object({ accepted: z.literal(true) }).strict();

export function registerStripeBillingWebhookRoute(
  app: AppInstance,
  processor: BillingWebhookProcessor,
): void {
  app.post(
    '/v1/webhooks/stripe',
    {
      schema: {
        headers: StripeWebhookHeadersSchema,
        body: z.unknown(),
        response: { 202: StripeWebhookAcceptedSchema },
      },
    },
    async (request, reply) => {
      const raw = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(JSON.stringify(request.body));
      const rawSignature = request.headers['stripe-signature'];
      const signature = Array.isArray(rawSignature) ? undefined : rawSignature;
      if (signature === undefined) {
        throw new ApiError('stripe_signature_invalid', 401, 'The Stripe signature is invalid.');
      }
      try {
        await processor.handle(raw, signature);
      } catch (error) {
        if (error instanceof StripeWebhookError) {
          if (error.reason === 'signature') {
            throw new ApiError('stripe_signature_invalid', 401, 'The Stripe signature is invalid.');
          }
          if (error.reason === 'conflict') {
            throw new ApiError(
              'stripe_event_conflict',
              409,
              'The Stripe event conflicts with a replay.',
            );
          }
          if (error.reason === 'in_progress') {
            throw new ApiError(
              'stripe_event_in_progress',
              409,
              'The Stripe event is still processing.',
            );
          }
          throw new ApiError('stripe_payload_invalid', 400, 'The Stripe payload is invalid.');
        }
        throw error;
      }
      return await reply.status(202).send({ accepted: true });
    },
  );
}

export function createDunningLifecycle(options: {
  readonly store: BillingStore;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}): { readonly start: () => void; readonly stop: () => Promise<void> } {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  const sweep = (): void => {
    if (inFlight !== undefined) return;
    const pending = options.store
      .downgradeExpiredDunning(now())
      .then(() => undefined)
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .catch(() => undefined);
    inFlight = pending.finally(() => {
      inFlight = undefined;
    });
  };
  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(sweep, intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      await inFlight;
    },
  };
}
