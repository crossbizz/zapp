import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryWorkspaceRuntime } from '@zapp/workspace-runtime';
import postgres from 'postgres';
import Stripe from 'stripe';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  installStripeAdapterTemplates,
  renderStripeAdapterTemplates,
  STRIPE_SUBSCRIPTION_MIGRATION_SQL,
} from '../../src/integrations/stripe.js';

const TEMPLATE_NAMES = ['checkout', 'portal', 'webhook', 'sync', 'access'] as const;

async function templates(): Promise<Record<(typeof TEMPLATE_NAMES)[number], string>> {
  return Object.fromEntries(
    await Promise.all(
      TEMPLATE_NAMES.map(async (name) => [
        name,
        await readFile(
          new URL(`../../../../templates/stripe/${name}.ts.hbs`, import.meta.url),
          'utf8',
        ),
      ]),
    ),
  ) as Record<(typeof TEMPLATE_NAMES)[number], string>;
}

async function executable<T>(source: string, prelude = ''): Promise<T> {
  const withoutImports = source.replace(/^import[\s\S]*?;\n/gmu, '');
  const javascript = transpileModule(`${prelude}\n${withoutImports}`, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  )) as T;
}

interface StripeSubscriptionState {
  readonly stripeSubscriptionId: string;
  readonly stripeCustomerId: string;
  readonly tier: string;
  readonly status: string;
  readonly currentPeriodEnd: Date;
  readonly trialEnd: Date | null;
}

interface SubscriptionStore {
  applyEvent(
    eventId: string,
    eventCreated: number,
    state: StripeSubscriptionState | undefined,
  ): Promise<'applied' | 'duplicate' | 'stale'>;
  findSubscriptionByCustomer(customerId: string): Promise<StripeSubscriptionState | undefined>;
}

interface SyncModule {
  readonly StripeWebhookEventSchema: typeof z.ZodType;
  createPostgresStripeSubscriptionStore(
    databaseUrl: string,
  ): SubscriptionStore & { close(): Promise<void> };
  syncStripeSubscriptionEvent(
    dependencies: { readonly store: SubscriptionStore },
    event: unknown,
  ): Promise<'applied' | 'duplicate' | 'ignored' | 'stale'>;
}

interface CheckoutModule {
  bootstrapStripeTestProducts(
    stripe: {
      readonly products: {
        search(input: unknown): Promise<{ readonly data: readonly unknown[] }>;
        create(input: unknown): Promise<{ readonly id: string }>;
      };
      readonly prices: {
        list(input: unknown): Promise<{ readonly data: readonly unknown[] }>;
        create(input: {
          readonly recurring: { readonly interval: 'month' | 'year' };
        }): Promise<{ readonly id: string }>;
      };
    },
    input: {
      readonly tier: string;
      readonly productName: string;
      readonly currency: string;
      readonly monthlyAmount: number;
      readonly annualAmount: number;
    },
  ): Promise<{ readonly month: string; readonly year: string }>;
  createStripeCheckoutSession(
    stripe: {
      readonly customers: {
        list(input: unknown): Promise<{ readonly data: readonly unknown[] }>;
        create(input: unknown): Promise<{ readonly id: string }>;
      };
      readonly checkout: {
        readonly sessions: {
          create(input: unknown): Promise<{ readonly id: string; readonly url: string | null }>;
        };
      };
    },
    input: {
      readonly email: string;
      readonly tier: string;
      readonly interval: 'month' | 'year';
      readonly successUrl: string;
      readonly cancelUrl: string;
    },
  ): Promise<{ readonly id: string; readonly url: string | null }>;
}

interface WebhookModule {
  handleStripeWebhook(
    dependencies: {
      readonly stripe: {
        readonly webhooks: {
          constructEvent(body: string, signature: string, secret: string): unknown;
        };
        readonly subscriptions: { retrieve(id: string): Promise<unknown> };
      };
      readonly webhookSecret: string;
      readonly sync: (event: unknown) => Promise<unknown>;
    },
    request: { readonly rawBody: string; readonly signature: string | undefined },
  ): Promise<{ readonly status: number; readonly body: { readonly received?: true } }>;
}

interface AccessModule {
  hasSubscriptionAccess(
    store: SubscriptionStore,
    request: { readonly stripeCustomerId: string },
    tier: string,
    now?: Date,
  ): Promise<boolean>;
}

function subscription(status: 'active' | 'canceled') {
  return {
    id: 'sub_fixture',
    customer: 'cus_fixture',
    status,
    trial_end: null,
    metadata: { tier: 'pro' },
    items: { data: [{ current_period_end: 1_800_000_000 }] },
  };
}

describe('INT-9 generated-app Stripe flow', () => {
  it('synchronizes checkout access and revokes it after cancellation', async () => {
    const rendered = renderStripeAdapterTemplates({
      adapterId: 'next',
      templates: await templates(),
    });
    const source = (name: 'checkout' | 'webhook' | 'sync' | 'access') => {
      const contents = rendered.find(({ template }) => template === name)?.contents;
      if (contents === undefined) throw new Error(`missing rendered ${name} adapter`);
      return contents;
    };

    const globals = globalThis as typeof globalThis & {
      __zappStripeFlowZod?: typeof z;
      __zappStripeFlowSync?: SyncModule;
    };
    globals.__zappStripeFlowZod = z;
    const checkout = await executable<CheckoutModule>(source('checkout'));
    const sync = await executable<SyncModule>(
      source('sync'),
      'const z = globalThis.__zappStripeFlowZod;',
    );
    globals.__zappStripeFlowSync = sync;
    const webhook = await executable<WebhookModule>(
      source('webhook'),
      'const z = globalThis.__zappStripeFlowZod; const StripeWebhookEventSchema = globalThis.__zappStripeFlowSync.StripeWebhookEventSchema;',
    );
    const access = await executable<AccessModule>(source('access'));

    const receipts = new Set<string>();
    let state: StripeSubscriptionState | undefined;
    const store: SubscriptionStore = {
      applyEvent(eventId, _eventCreated, next) {
        if (receipts.has(eventId)) return Promise.resolve('duplicate');
        receipts.add(eventId);
        state = next;
        return Promise.resolve('applied');
      },
      findSubscriptionByCustomer(customerId) {
        return Promise.resolve(state?.stripeCustomerId === customerId ? state : undefined);
      },
    };
    const previousRestrictedKey = process.env['GENERATED_APP_STRIPE_RESTRICTED_KEY'];
    const previousPrice = process.env['STRIPE_PRICE_PRO_MONTH'];
    process.env['GENERATED_APP_STRIPE_RESTRICTED_KEY'] = 'rk_test_fixture';
    try {
      const stripe = {
        products: {
          search() {
            return Promise.resolve({ data: [] });
          },
          create() {
            return Promise.resolve({ id: 'prod_fixture' });
          },
        },
        prices: {
          list() {
            return Promise.resolve({ data: [] });
          },
          create(input: { readonly recurring: { readonly interval: 'month' | 'year' } }) {
            return Promise.resolve({ id: `price_${input.recurring.interval}` });
          },
        },
        customers: {
          list() {
            return Promise.resolve({ data: [] });
          },
          create() {
            return Promise.resolve({ id: 'cus_fixture' });
          },
        },
        checkout: {
          sessions: {
            create() {
              return Promise.resolve({
                id: 'cs_fixture',
                url: 'https://checkout.stripe.test/cs_fixture',
              });
            },
          },
        },
        webhooks: {
          constructEvent(body: string, signature: string, secret: string) {
            if (signature !== 'valid-fixture-signature' || secret !== 'fixture-webhook-secret') {
              throw new Error('invalid signature');
            }
            return JSON.parse(body) as unknown;
          },
        },
        subscriptions: {
          retrieve(id: string) {
            expect(id).toBe('sub_fixture');
            return Promise.resolve(subscription('active'));
          },
        },
      };

      const prices = await checkout.bootstrapStripeTestProducts(stripe, {
        tier: 'pro',
        productName: 'Fixture Pro',
        currency: 'usd',
        monthlyAmount: 1_500,
        annualAmount: 15_000,
      });
      expect(prices).toEqual({ month: 'price_month', year: 'price_year' });
      process.env['STRIPE_PRICE_PRO_MONTH'] = prices.month;
      const session = await checkout.createStripeCheckoutSession(stripe, {
        email: 'subscriber@fixture.test',
        tier: 'pro',
        interval: 'month',
        successUrl: 'https://fixture.test/billing/success',
        cancelUrl: 'https://fixture.test/billing/cancel',
      });
      expect(session).toEqual({
        id: 'cs_fixture',
        url: 'https://checkout.stripe.test/cs_fixture',
      });
      const deliver = (event: unknown) =>
        webhook.handleStripeWebhook(
          {
            stripe,
            webhookSecret: 'fixture-webhook-secret',
            sync: (value) => sync.syncStripeSubscriptionEvent({ store }, value),
          },
          {
            rawBody: JSON.stringify(event),
            signature: 'valid-fixture-signature',
          },
        );

      await expect(
        deliver({
          id: 'evt_checkout_complete',
          created: 1_799_999_000,
          type: 'checkout.session.completed',
          data: {
            object: { id: session.id, customer: 'cus_fixture', subscription: 'sub_fixture' },
          },
        }),
      ).resolves.toEqual({ status: 200, body: { received: true } });
      await expect(
        access.hasSubscriptionAccess(
          store,
          { stripeCustomerId: 'cus_fixture' },
          'pro',
          new Date('2027-01-01T00:00:00.000Z'),
        ),
      ).resolves.toBe(true);

      await expect(
        deliver({
          id: 'evt_subscription_deleted',
          created: 1_799_999_100,
          type: 'customer.subscription.deleted',
          data: { object: subscription('canceled') },
        }),
      ).resolves.toEqual({ status: 200, body: { received: true } });
      await expect(
        access.hasSubscriptionAccess(
          store,
          { stripeCustomerId: 'cus_fixture' },
          'pro',
          new Date('2027-01-01T00:00:00.000Z'),
        ),
      ).resolves.toBe(false);
    } finally {
      delete globals.__zappStripeFlowZod;
      delete globals.__zappStripeFlowSync;
      if (previousRestrictedKey === undefined) {
        delete process.env['GENERATED_APP_STRIPE_RESTRICTED_KEY'];
      } else {
        process.env['GENERATED_APP_STRIPE_RESTRICTED_KEY'] = previousRestrictedKey;
      }
      if (previousPrice === undefined) {
        delete process.env['STRIPE_PRICE_PRO_MONTH'];
      } else {
        process.env['STRIPE_PRICE_PRO_MONTH'] = previousPrice;
      }
    }
  });
});

const LIVE_STRIPE_ENV = [
  'STRIPE_GENERATED_APP_RESTRICTED_KEY',
  'STRIPE_GENERATED_APP_ACCOUNT_ID',
  'DATABASE_URL',
] as const;
const missingLiveStripe = LIVE_STRIPE_ENV.filter((name) => !process.env[name]);
if (missingLiveStripe.length > 0) {
  process.stderr.write(
    `[@zapp/agent-tools] INT-9 live Stripe flow SKIPPED — not run, not passed: ${missingLiveStripe.join(', ')} ${missingLiveStripe.length === 1 ? 'is' : 'are'} unset\n`,
  );
}

describe('INT-9 live Stripe test-mode checkout', () => {
  it.skipIf(missingLiveStripe.length > 0)(
    'installs a generated Next app and admits then revokes access through Stripe and Postgres',
    async () => {
      const restrictedKey = process.env['STRIPE_GENERATED_APP_RESTRICTED_KEY'] ?? '';
      const accountId = process.env['STRIPE_GENERATED_APP_ACCOUNT_ID'] ?? '';
      const databaseUrl = process.env['DATABASE_URL'] ?? '';
      const stripe = new Stripe(restrictedKey);
      const account = z
        .object({ id: z.string().min(1) })
        .parse(await stripe.rawRequest('GET', '/v1/account'));
      expect(account.id).toBe(accountId);

      const unique = [Date.now(), Math.floor(Math.random() * 1_000_000)].join('_');
      const fixtureRoot = await mkdtemp(join(tmpdir(), 'zapp-int9-next-'));
      const runtime = new MemoryWorkspaceRuntime(fixtureRoot);
      const installed = await installStripeAdapterTemplates({
        adapterId: 'next',
        templates: await templates(),
        runtime,
      });
      const source = (name: 'checkout' | 'webhook' | 'sync' | 'access') => {
        const artifact = installed.find(({ template }) => template === name);
        if (artifact === undefined) throw new Error(`missing installed ${name} adapter`);
        return artifact;
      };
      await expect(readFile(join(fixtureRoot, source('checkout').path), 'utf8')).resolves.toBe(
        source('checkout').contents,
      );

      const globals = globalThis as typeof globalThis & {
        __zappStripeFlowPostgres?: typeof postgres;
        __zappStripeFlowSync?: SyncModule;
        __zappStripeFlowZod?: typeof z;
      };
      globals.__zappStripeFlowPostgres = postgres;
      globals.__zappStripeFlowZod = z;
      const checkout = await executable<CheckoutModule>(source('checkout').contents);
      const sync = await executable<SyncModule>(
        source('sync').contents,
        'const z = globalThis.__zappStripeFlowZod; const postgres = globalThis.__zappStripeFlowPostgres;',
      );
      globals.__zappStripeFlowSync = sync;
      const webhook = await executable<WebhookModule>(
        source('webhook').contents,
        'const z = globalThis.__zappStripeFlowZod; const StripeWebhookEventSchema = globalThis.__zappStripeFlowSync.StripeWebhookEventSchema;',
      );
      const access = await executable<AccessModule>(source('access').contents);

      const tier = `int9_${unique}`;
      const priceEnvironment = `STRIPE_PRICE_${tier.toUpperCase()}_MONTH`;
      const email = `int9-${unique}@fixture.zapp.build`;
      const schema = `int9_${unique}`;
      const schemaUrl = new URL(databaseUrl);
      schemaUrl.searchParams.set('options', `-c search_path=${schema}`);
      const admin = postgres(databaseUrl, { max: 1 });
      const previousRestrictedKey = process.env['GENERATED_APP_STRIPE_RESTRICTED_KEY'];
      const previousPrice = process.env[priceEnvironment];
      const webhookSecret = 'whsec_int9_generated_fixture';
      let clockId: string | undefined;
      let customerId: string | undefined;
      let sessionId: string | undefined;
      let subscriptionId: string | undefined;
      let subscriptionCanceled = false;
      let priceIds: readonly string[] = [];
      let productId: string | undefined;
      let store: (SubscriptionStore & { close(): Promise<void> }) | undefined;
      try {
        await admin.unsafe(`create schema "${schema}"`);
        const migrations = postgres(schemaUrl.toString(), { max: 1 });
        try {
          await migrations.unsafe(STRIPE_SUBSCRIPTION_MIGRATION_SQL);
        } finally {
          await migrations.end();
        }
        const liveStore = sync.createPostgresStripeSubscriptionStore(schemaUrl.toString());
        store = liveStore;

        process.env['GENERATED_APP_STRIPE_RESTRICTED_KEY'] = restrictedKey;
        const clock = await stripe.testHelpers.testClocks.create({
          frozen_time: Math.floor(Date.now() / 1_000),
          name: `zapp INT-9 ${unique}`,
        });
        clockId = clock.id;
        const customer = await stripe.customers.create({
          email,
          payment_method: 'pm_card_visa',
          test_clock: clock.id,
          invoice_settings: { default_payment_method: 'pm_card_visa' },
          metadata: { fixture: 'INT-9' },
        });
        customerId = customer.id;
        const prices = await checkout.bootstrapStripeTestProducts(
          stripe as unknown as Parameters<CheckoutModule['bootstrapStripeTestProducts']>[0],
          {
            tier,
            productName: `zapp INT-9 ${unique}`,
            currency: 'usd',
            monthlyAmount: 1_500,
            annualAmount: 15_000,
          },
        );
        priceIds = [prices.month, prices.year];
        const monthlyPrice = await stripe.prices.retrieve(prices.month);
        productId =
          typeof monthlyPrice.product === 'string' ? monthlyPrice.product : monthlyPrice.product.id;
        process.env[priceEnvironment] = prices.month;
        const session = await checkout.createStripeCheckoutSession(stripe, {
          email,
          tier,
          interval: 'month',
          successUrl: 'https://fixture.zapp.build/billing/success',
          cancelUrl: 'https://fixture.zapp.build/billing/cancel',
        });
        sessionId = session.id;
        expect(session.id).toMatch(/^cs_test_/u);
        expect(session.url).toMatch(/^https:\/\/checkout\.stripe\.com\//u);

        const createdSubscription = await stripe.subscriptions.create({
          customer: customer.id,
          default_payment_method: 'pm_card_visa',
          items: [{ price: prices.month }],
          metadata: { tier },
          payment_behavior: 'error_if_incomplete',
        });
        subscriptionId = createdSubscription.id;
        expect(createdSubscription.status).toBe('active');

        const deliver = async (event: unknown) => {
          const rawBody = JSON.stringify(event);
          const signature = stripe.webhooks.generateTestHeaderString({
            payload: rawBody,
            secret: webhookSecret,
          });
          return await webhook.handleStripeWebhook(
            {
              stripe,
              webhookSecret,
              sync: (value) => sync.syncStripeSubscriptionEvent({ store: liveStore }, value),
            },
            { rawBody, signature },
          );
        };
        const eventCreated = Math.floor(Date.now() / 1_000);
        await expect(
          deliver({
            id: `evt_int9_checkout_${unique}`,
            created: eventCreated,
            type: 'checkout.session.completed',
            data: {
              object: {
                id: session.id,
                customer: customer.id,
                subscription: createdSubscription.id,
              },
            },
          }),
        ).resolves.toEqual({ status: 200, body: { received: true } });

        const stateSql = postgres(schemaUrl.toString(), { max: 1 });
        try {
          const [activeRow] = await stateSql<
            Array<{ status: string; stripe_customer_id: string; tier: string }>
          >`select status, stripe_customer_id, tier from stripe_subscription_state`;
          expect(activeRow).toEqual({
            status: 'active',
            stripe_customer_id: customer.id,
            tier,
          });
        } finally {
          await stateSql.end();
        }
        await expect(
          access.hasSubscriptionAccess(
            store,
            { stripeCustomerId: customer.id },
            tier,
            new Date(clock.frozen_time * 1_000),
          ),
        ).resolves.toBe(true);

        const canceledSubscription = await stripe.subscriptions.cancel(createdSubscription.id);
        subscriptionCanceled = true;
        await expect(
          deliver({
            id: `evt_int9_canceled_${unique}`,
            created: eventCreated + 1,
            type: 'customer.subscription.deleted',
            data: { object: canceledSubscription },
          }),
        ).resolves.toEqual({ status: 200, body: { received: true } });
        await expect(
          access.hasSubscriptionAccess(
            store,
            { stripeCustomerId: customer.id },
            tier,
            new Date(clock.frozen_time * 1_000),
          ),
        ).resolves.toBe(false);
        const canceledSql = postgres(schemaUrl.toString(), { max: 1 });
        try {
          const [canceledRow] = await canceledSql<Array<{ status: string }>>`
            select status from stripe_subscription_state
             where stripe_subscription_id = ${createdSubscription.id}
          `;
          expect(canceledRow?.status).toBe('canceled');
        } finally {
          await canceledSql.end();
        }
      } finally {
        try {
          if (sessionId !== undefined) await stripe.checkout.sessions.expire(sessionId);
          if (subscriptionId !== undefined && !subscriptionCanceled) {
            await stripe.subscriptions.cancel(subscriptionId);
          }
          await Promise.all(priceIds.map((id) => stripe.prices.update(id, { active: false })));
          if (productId !== undefined) {
            await stripe.products.update(productId, { active: false });
          }
          if (customerId !== undefined) await stripe.customers.del(customerId);
          if (clockId !== undefined) await stripe.testHelpers.testClocks.del(clockId);
        } finally {
          try {
            if (store !== undefined) await store.close();
            try {
              await admin.unsafe(`drop schema if exists "${schema}" cascade`);
            } finally {
              await admin.end();
            }
          } finally {
            delete globals.__zappStripeFlowPostgres;
            delete globals.__zappStripeFlowSync;
            delete globals.__zappStripeFlowZod;
            if (previousRestrictedKey === undefined) {
              delete process.env['GENERATED_APP_STRIPE_RESTRICTED_KEY'];
            } else {
              process.env['GENERATED_APP_STRIPE_RESTRICTED_KEY'] = previousRestrictedKey;
            }
            if (previousPrice === undefined) {
              Reflect.deleteProperty(process.env, priceEnvironment);
            } else {
              process.env[priceEnvironment] = previousPrice;
            }
            await rm(fixtureRoot, { recursive: true, force: true });
          }
        }
      }
    },
    120_000,
  );
});
