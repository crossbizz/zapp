import { createHash } from 'node:crypto';

import {
  trialCreditGrants,
  usageLedger,
  type Database,
} from '@zapp/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { operationOf } from '../routes/runs.js';
import {
  CreditPackCatalogSchema,
  UsageEstimateInputSchema,
  estimateUsage,
  type CreditPackCatalog,
  type PricingConfig,
} from '../usage/pricing.js';
import type { StripeCreditCheckoutPort } from './stripe.js';
import type { BillingStore } from './webhooks.js';

const CreditAmountSchema = z.string().regex(/^\d+(?:\.\d{1,4})?$/u);
const MoneyAmountSchema = z.string().regex(/^\d+(?:\.\d{1,6})?$/u);
const IdentifierSchema = z.string().trim().min(1).max(255);
const OrganizationIdSchema = z.string().regex(/^org_[A-Za-z0-9]+$/u);
const UserIdSchema = z.string().regex(/^user_[A-Za-z0-9]+$/u);
const CreditPackIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/u);

export type CreditTopupReason = 'FREE_CREDIT_GRANT' | 'PURCHASED_CREDIT_DIRECT';

export interface CreditWalletPort {
  topUp(input: {
    readonly organizationId: string;
    readonly credits: string;
    readonly operationKey: string;
    readonly reason: CreditTopupReason;
  }): Promise<void>;
}

export type TrialClaimState = 'pending' | 'delivered' | 'denied';

export interface CreditGrantStore {
  claimTrial(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly occurredAt: Date;
  }): Promise<TrialClaimState>;
  completeTrial(input: {
    readonly organizationId: string;
    readonly credits: string;
    readonly occurredAt: Date;
  }): Promise<void>;
  pendingTrials(
    limit: number,
  ): Promise<readonly { readonly organizationId: string; readonly userId: string }[]>;
  mirrorPaidGrant(input: {
    readonly organizationId: string;
    readonly checkoutSessionId: string;
    readonly packId: string;
    readonly credits: string;
    readonly occurredAt: Date;
  }): Promise<void>;
}

export interface TrialGrantPort {
  ensureTrial(input: {
    readonly organizationId: string;
    readonly userId: string;
  }): Promise<
    | { readonly granted: true; readonly reason: 'delivered' }
    | { readonly granted: false; readonly reason: 'already_used' }
  >;
}

function ledgerId(organizationId: string, operationKey: string): string {
  return `usage_${createHash('sha256').update(`${organizationId}\0${operationKey}`).digest('hex').slice(0, 32)}`;
}

function grantLedgerValues(input: {
  readonly organizationId: string;
  readonly operationKey: string;
  readonly credits: string;
  readonly occurredAt: Date;
  readonly metadata: Record<string, unknown>;
}) {
  return {
    id: ledgerId(input.organizationId, input.operationKey),
    operationKey: input.operationKey,
    organizationId: input.organizationId,
    projectId: null,
    runId: null,
    taskId: null,
    category: 'credit_grant' as const,
    provider: 'flexprice',
    quantity: input.credits,
    unit: 'credits',
    costUsd: '0.000000',
    creditsCharged: input.credits.startsWith('-') ? input.credits : `-${input.credits}`,
    metadata: input.metadata,
    occurredAt: input.occurredAt,
  };
}

export function createDbCreditGrantStore(options: {
  readonly database: Database;
}): CreditGrantStore {
  const { database } = options;
  return {
    async claimTrial(input) {
      return await database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`trial-user:${input.userId}`}, 0))`,
        );
        const [organizationClaim] = await tx
          .select({ state: trialCreditGrants.state, userId: trialCreditGrants.userId })
          .from(trialCreditGrants)
          .where(eq(trialCreditGrants.organizationId, input.organizationId))
          .limit(1);
        if (organizationClaim !== undefined) {
          if (organizationClaim.userId !== input.userId) {
            throw new Error('Trial organization is already claimed by another user');
          }
          return organizationClaim.state;
        }
        const [userClaim] = await tx
          .select({ organizationId: trialCreditGrants.organizationId })
          .from(trialCreditGrants)
          .where(eq(trialCreditGrants.userId, input.userId))
          .limit(1);
        if (userClaim !== undefined) return 'denied';
        await tx.insert(trialCreditGrants).values({
          organizationId: input.organizationId,
          userId: input.userId,
          state: 'pending',
          createdAt: input.occurredAt,
        });
        return 'pending';
      });
    },

    async completeTrial(input) {
      const operationKey = `trial:${input.organizationId}`;
      await database.transaction(async (tx) => {
        const completed = await tx
          .update(trialCreditGrants)
          .set({ state: 'delivered', deliveredAt: input.occurredAt })
          .where(
            and(
              eq(trialCreditGrants.organizationId, input.organizationId),
              eq(trialCreditGrants.state, 'pending'),
            ),
          )
          .returning({ organizationId: trialCreditGrants.organizationId });
        if (completed.length === 0) {
          const [existing] = await tx
            .select({ state: trialCreditGrants.state })
            .from(trialCreditGrants)
            .where(eq(trialCreditGrants.organizationId, input.organizationId))
            .limit(1);
          if (existing?.state !== 'delivered') throw new Error('Trial claim is missing');
        }
        await tx
          .insert(usageLedger)
          .values(
            grantLedgerValues({
              organizationId: input.organizationId,
              operationKey,
              credits: input.credits,
              occurredAt: input.occurredAt,
              metadata: { source: 'trial' },
            }),
          )
          .onConflictDoNothing();
      });
    },

    async pendingTrials(rawLimit) {
      const limit = z.number().int().min(1).max(1_000).parse(rawLimit);
      return await database
        .select({
          organizationId: trialCreditGrants.organizationId,
          userId: trialCreditGrants.userId,
        })
        .from(trialCreditGrants)
        .where(eq(trialCreditGrants.state, 'pending'))
        .orderBy(asc(trialCreditGrants.createdAt))
        .limit(limit);
    },

    async mirrorPaidGrant(input) {
      const operationKey = `stripe-checkout:${input.checkoutSessionId}`;
      await database
        .insert(usageLedger)
        .values(
          grantLedgerValues({
            organizationId: input.organizationId,
            operationKey,
            credits: input.credits,
            occurredAt: input.occurredAt,
            metadata: {
              source: 'credit_pack',
              checkout_session_id: input.checkoutSessionId,
              credit_pack_id: input.packId,
            },
          }),
        )
        .onConflictDoNothing();
    },
  };
}

const PaidCheckoutSchema = z
  .object({
    id: z.string().regex(/^cs_[A-Za-z0-9_]+$/u),
    mode: z.literal('payment'),
    payment_status: z.literal('paid'),
    amount_total: z.number().int().nonnegative(),
    currency: z.literal('usd'),
    metadata: z
      .object({
        checkout_kind: z.literal('credit_topup'),
        organization_id: OrganizationIdSchema,
        credit_pack_id: CreditPackIdSchema,
        credit_amount: CreditAmountSchema,
        amount_usd: MoneyAmountSchema,
        pricing_version: z.string().trim().min(1),
      })
      .passthrough(),
  })
  .passthrough();

export interface CreditGrantService extends TrialGrantPort {
  reconcileTrials(limit: number): Promise<number>;
  grantPaidCheckout(rawSession: unknown, occurredAt: Date): Promise<void>;
}

export const StripeCreditPackPriceCatalogSchema = z.record(
  CreditPackIdSchema,
  z.string().regex(/^price_[A-Za-z0-9]+$/u),
);
export type StripeCreditPackPriceCatalog = z.infer<
  typeof StripeCreditPackPriceCatalogSchema
>;

export interface CreditTopupRouteConfig {
  readonly stripe: StripeCreditCheckoutPort;
  readonly packs: CreditPackCatalog;
  readonly prices: StripeCreditPackPriceCatalog;
  readonly pricing: PricingConfig;
}

export interface CreditTopupRoutesDeps extends CreditTopupRouteConfig {
  readonly store: BillingStore;
  readonly appBaseUrl: string;
}

const EstimateBodySchema = z
  .object({ items: z.array(UsageEstimateInputSchema).min(1).max(32) })
  .strict();
const PackListResponseSchema = z
  .object({
    packs: z.array(
      z
        .object({ id: CreditPackIdSchema, credits: CreditAmountSchema, amountUsd: MoneyAmountSchema })
        .strict(),
    ),
  })
  .strict();
const UrlResponseSchema = z.object({ url: z.string().url() }).strict();
const EstimateResponseSchema = z
  .object({
    pricingVersion: z.string(),
    items: z.array(z.object({ costUsd: z.string(), credits: z.string() }).strict()),
    total: z.object({ costUsd: z.string(), credits: z.string() }).strict(),
  })
  .strict();

function addFixed(values: readonly string[], scale: number): string {
  const units = values.reduce((sum, value) => sum + decimalUnits(value, scale), 0n);
  const factor = 10n ** BigInt(scale);
  return `${String(units / factor)}.${String(units % factor).padStart(scale, '0')}`;
}

export function registerCreditTopupRoutes(
  app: AppInstance,
  dependencies: CreditTopupRoutesDeps,
): void {
  const packs = CreditPackCatalogSchema.parse(dependencies.packs);
  const prices = StripeCreditPackPriceCatalogSchema.parse(dependencies.prices);
  const packIds = Object.keys(packs).sort();
  if (JSON.stringify(Object.keys(prices).sort()) !== JSON.stringify(packIds)) {
    throw new Error('Stripe credit pack prices must match configured credit packs exactly');
  }
  const appBaseUrl = new URL(dependencies.appBaseUrl);

  app.get(
    '/v1/billing/topups',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { response: { 200: PackListResponseSchema } },
    },
    () => ({
      packs: packIds.map((id) => {
        const pack = packs[id];
        if (pack === undefined) {
          throw new Error(`Configured credit pack ${id} is unavailable`);
        }
        return { id, credits: pack.credits, amountUsd: pack.amountUsd };
      }),
    }),
  );

  app.post(
    '/v1/billing/topups/checkout',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        body: z.object({ packId: CreditPackIdSchema }).strict(),
        response: { 201: UrlResponseSchema },
      },
    },
    async (request, reply) => {
      const context = tenantOf(request);
      authorize(context, 'manage_organization');
      const packId = CreditPackIdSchema.parse(request.body.packId);
      const pack = packs[packId];
      const priceId = prices[packId];
      if (pack === undefined || priceId === undefined) {
        throw new ApiError('credit_pack_not_found', 404, 'That credit pack does not exist.');
      }
      const current = await dependencies.store.status(context.organizationId);
      if (current === undefined) {
        throw new ApiError('billing_not_found', 404, 'Billing is not configured for this organization.');
      }
      const checkout = await dependencies.stripe.createCreditCheckout({
        organizationId: context.organizationId,
        packId,
        priceId,
        credits: pack.credits,
        amountUsd: pack.amountUsd,
        pricingVersion: dependencies.pricing.version,
        customerId: current.customerId,
        successUrl: new URL('/settings/billing?topup=success', appBaseUrl).toString(),
        cancelUrl: new URL('/settings/billing?topup=cancelled', appBaseUrl).toString(),
        operationKey: operationOf(request),
      });
      return await reply.status(201).send({ url: checkout.url });
    },
  );

  app.post(
    '/v1/billing/estimate',
    {
      config: { idempotency: 'exempt' },
      preHandler: [app.requireSession, app.requireTenant],
      schema: { body: EstimateBodySchema, response: { 200: EstimateResponseSchema } },
    },
    (request) => {
      tenantOf(request);
      const body = EstimateBodySchema.parse(request.body);
      const items = body.items.map((item) => estimateUsage(dependencies.pricing, item));
      return {
        pricingVersion: dependencies.pricing.version,
        items,
        total: {
          costUsd: addFixed(items.map((item) => item.costUsd), 6),
          credits: addFixed(items.map((item) => item.credits), 4),
        },
      };
    },
  );
}

export function createCreditGrantService(options: {
  readonly store: CreditGrantStore;
  readonly wallet: CreditWalletPort;
  readonly trialCredits: string;
  readonly now?: () => Date;
}): CreditGrantService {
  const trialCredits = CreditAmountSchema.parse(options.trialCredits);
  const now = options.now ?? (() => new Date());

  async function deliverTrial(organizationId: string, occurredAt: Date): Promise<void> {
    const operationKey = `trial:${organizationId}`;
    await options.wallet.topUp({
      organizationId,
      credits: trialCredits,
      operationKey,
      reason: 'FREE_CREDIT_GRANT',
    });
    await options.store.completeTrial({ organizationId, credits: trialCredits, occurredAt });
  }

  return {
    async ensureTrial(rawInput) {
      const input = z
        .object({ organizationId: OrganizationIdSchema, userId: UserIdSchema })
        .strict()
        .parse(rawInput);
      const occurredAt = now();
      const claim = await options.store.claimTrial({ ...input, occurredAt });
      if (claim === 'denied') return { granted: false, reason: 'already_used' };
      if (claim === 'pending') await deliverTrial(input.organizationId, occurredAt);
      return { granted: true, reason: 'delivered' };
    },

    async reconcileTrials(rawLimit) {
      const limit = z.number().int().min(1).max(1_000).parse(rawLimit);
      const pending = await options.store.pendingTrials(limit);
      let delivered = 0;
      let firstFailure: Error | undefined;
      for (const claim of pending) {
        try {
          await deliverTrial(claim.organizationId, now());
          delivered += 1;
        } catch (error) {
          firstFailure ??=
            error instanceof Error
              ? error
              : new Error('Trial credit delivery failed', { cause: error });
        }
      }
      if (firstFailure !== undefined) throw firstFailure;
      return delivered;
    },

    async grantPaidCheckout(rawSession, occurredAt) {
      const candidate = z.record(z.unknown()).parse(rawSession);
      const metadata = z.record(z.unknown()).safeParse(candidate['metadata']);
      if (!metadata.success || metadata.data['checkout_kind'] !== 'credit_topup') return;
      if (candidate['payment_status'] !== 'paid') return;
      const session = PaidCheckoutSchema.parse(candidate);
      const expectedUsdUnits = decimalUnits(session.metadata.amount_usd, 6);
      if (
        expectedUsdUnits % 10_000n !== 0n ||
        expectedUsdUnits / 10_000n !== BigInt(session.amount_total)
      ) {
        throw new Error('Stripe checkout paid amount does not match the credit pack snapshot');
      }
      const operationKey = `stripe-checkout:${session.id}`;
      await options.wallet.topUp({
        organizationId: session.metadata.organization_id,
        credits: session.metadata.credit_amount,
        operationKey,
        reason: 'PURCHASED_CREDIT_DIRECT',
      });
      await options.store.mirrorPaidGrant({
        organizationId: session.metadata.organization_id,
        checkoutSessionId: session.id,
        packId: session.metadata.credit_pack_id,
        credits: session.metadata.credit_amount,
        occurredAt,
      });
    },
  };
}

export function createTrialGrantLifecycle(options: {
  readonly service: Pick<CreditGrantService, 'reconcileTrials'>;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly onError?: (error: unknown) => void;
}): { readonly start: () => void; readonly stop: () => Promise<void> } {
  const intervalMs = options.intervalMs ?? 60_000;
  const batchSize = options.batchSize ?? 100;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  const sweep = (): void => {
    if (inFlight !== undefined) return;
    inFlight = options.service
      .reconcileTrials(batchSize)
      .then(() => undefined)
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .catch(() => undefined)
      .finally(() => {
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

const FlexpriceCustomerSchema = z.object({ id: IdentifierSchema }).passthrough();
const FlexpriceWalletSchema = z
  .object({
    id: IdentifierSchema,
    wallet_type: z.string(),
    wallet_status: z.string(),
  })
  .passthrough();
const FlexpriceTopupResponseSchema = z
  .object({
    wallet_transaction: z.object({ id: IdentifierSchema }).passthrough(),
  })
  .passthrough();

function decimalUnits(value: string, scale: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
}

function usdPerCredit(creditsPerUsd: string): string {
  const parsed = MoneyAmountSchema.parse(creditsPerUsd);
  const credits = decimalUnits(parsed, 6);
  const numerator = 10n ** 12n;
  if (credits === 0n || numerator % credits !== 0n) {
    throw new Error('creditsPerUsd must have an exact six-decimal reciprocal');
  }
  const units = numerator / credits;
  const whole = units / 1_000_000n;
  const fraction = String(units % 1_000_000n).padStart(6, '0');
  return `${String(whole)}.${fraction}`;
}

export function createFlexpriceCreditWalletClient(options: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly creditsPerUsd: string;
  readonly fetcher?: typeof fetch;
}): CreditWalletPort {
  const baseUrl = `${z.string().url().parse(options.baseUrl).replace(/\/+$/u, '')}/`;
  const apiKey = z.string().trim().min(1).parse(options.apiKey);
  const conversionRate = usdPerCredit(options.creditsPerUsd);
  const fetcher = options.fetcher ?? fetch;

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    return await fetcher(new URL(path, baseUrl), {
      method,
      headers: {
        'x-api-key': apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
  }

  async function ensureCustomer(organizationId: string): Promise<void> {
    const path = `customers/external/${encodeURIComponent(organizationId)}`;
    const existing = await request('GET', path);
    if (existing.ok) {
      FlexpriceCustomerSchema.parse(await existing.json());
      return;
    }
    if (existing.status !== 404) {
      throw new Error(`Flexprice customer lookup failed with status ${String(existing.status)}`);
    }
    const created = await request('POST', 'customers', {
      external_id: organizationId,
      name: organizationId,
      metadata: { source: 'zapp_trial_or_topup' },
    });
    if (created.ok) {
      FlexpriceCustomerSchema.parse(await created.json());
      return;
    }
    if (created.status === 409) {
      const raced = await request('GET', path);
      if (raced.ok) {
        FlexpriceCustomerSchema.parse(await raced.json());
        return;
      }
    }
    throw new Error(`Flexprice customer creation failed with status ${String(created.status)}`);
  }

  async function activeWallet(organizationId: string): Promise<string> {
    const walletsUrl = new URL('customers/wallets', baseUrl);
    walletsUrl.searchParams.set('lookup_key', organizationId);
    walletsUrl.searchParams.set('include_real_time_balance', 'true');
    const response = await fetcher(walletsUrl, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Flexprice wallet lookup failed with status ${String(response.status)}`);
    }
    const active = z
      .array(FlexpriceWalletSchema)
      .parse(await response.json())
      .filter(
        (wallet) => wallet.wallet_type === 'PRE_PAID' && wallet.wallet_status === 'active',
      );
    if (active.length > 1) throw new Error('Flexprice returned multiple active prepaid wallets');
    if (active[0] !== undefined) return active[0].id;

    const created = await request('POST', 'wallets', {
      external_customer_id: organizationId,
      currency: 'usd',
      conversion_rate: conversionRate,
      topup_conversion_rate: conversionRate,
      wallet_type: 'PRE_PAID',
      name: 'zapp.build credits',
      metadata: { source: 'zapp_trial_or_topup' },
    });
    if (!created.ok) {
      throw new Error(`Flexprice wallet creation failed with status ${String(created.status)}`);
    }
    return FlexpriceWalletSchema.parse(await created.json()).id;
  }

  return {
    async topUp(rawInput) {
      const input = z
        .object({
          organizationId: OrganizationIdSchema,
          credits: CreditAmountSchema,
          operationKey: z.string().trim().min(8).max(255),
          reason: z.enum(['FREE_CREDIT_GRANT', 'PURCHASED_CREDIT_DIRECT']),
        })
        .strict()
        .parse(rawInput);
      await ensureCustomer(input.organizationId);
      const walletId = await activeWallet(input.organizationId);
      const response = await request('POST', `wallets/${encodeURIComponent(walletId)}/top-up`, {
        credits_to_add: input.credits,
        transaction_reason: input.reason,
        idempotency_key: input.operationKey,
        description:
          input.reason === 'FREE_CREDIT_GRANT'
            ? 'zapp.build trial credit grant'
            : 'zapp.build purchased credit pack',
        metadata: { organization_id: input.organizationId },
      });
      if (!response.ok) {
        throw new Error(`Flexprice wallet top-up failed with status ${String(response.status)}`);
      }
      FlexpriceTopupResponseSchema.parse(await response.json());
    },
  };
}
