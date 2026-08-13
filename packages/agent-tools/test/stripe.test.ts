import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createProgram,
  flattenDiagnosticMessageText,
  getPreEmitDiagnostics,
  transpileModule,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
} from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MemoryWorkspaceRuntime } from '@zapp/workspace-runtime';

import {
  installStripeAdapterTemplates,
  renderStripeAdapterTemplates,
  StripeAdapterInstallConflictError,
} from '../src/integrations/stripe.js';

const TEMPLATE_NAMES = ['checkout', 'portal', 'webhook', 'sync', 'access'] as const;

async function templates(): Promise<Record<(typeof TEMPLATE_NAMES)[number], string>> {
  return Object.fromEntries(
    await Promise.all(
      TEMPLATE_NAMES.map(async (name) => [
        name,
        await readFile(
          new URL(`../../../templates/stripe/${name}.ts.hbs`, import.meta.url),
          'utf8',
        ),
      ]),
    ),
  ) as Record<(typeof TEMPLATE_NAMES)[number], string>;
}

async function executable<T>(source: string): Promise<T> {
  const withoutImports = source.replace(/^import[\s\S]*?;\n/gmu, '');
  const javascript = transpileModule(
    `const z = globalThis.__zappStripeTestZod;\n${withoutImports}`,
    {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    },
  ).outputText;
  const globals = globalThis as typeof globalThis & { __zappStripeTestZod?: typeof z };
  globals.__zappStripeTestZod = z;
  try {
    return (await import(
      `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
    )) as T;
  } finally {
    delete globals.__zappStripeTestZod;
  }
}

async function typecheckRendered(
  files: readonly { path: string; contents: string }[],
): Promise<string[]> {
  const root = await mkdtemp(fileURLToPath(new URL('../.stripe-typecheck-', import.meta.url)));
  try {
    const typeScriptFiles: string[] = [];
    for (const file of files) {
      if (!file.path.endsWith('.ts')) continue;
      const target = join(root, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, 'utf8');
      typeScriptFiles.push(target);
    }
    const program = createProgram(typeScriptFiles, {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      types: ['node'],
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    });
    return getPreEmitDiagnostics(program).map((diagnostic) =>
      flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface WebhookModule {
  handleStripeWebhook(
    dependencies: {
      readonly stripe: {
        readonly webhooks: {
          constructEvent(body: string, signature: string, secret: string): unknown;
        };
      };
      readonly webhookSecret: string;
      readonly sync: (event: unknown) => Promise<unknown>;
    },
    request: { readonly rawBody: string; readonly signature: string | undefined },
  ): Promise<{ readonly status: number; readonly body: { readonly error?: string } }>;
}

interface SyncModule {
  syncStripeSubscriptionEvent(
    dependencies: {
      readonly store: {
        applyEvent(
          eventId: string,
          eventCreated: number,
          input: unknown,
        ): Promise<'applied' | 'duplicate' | 'stale'>;
      };
    },
    event: unknown,
  ): Promise<'applied' | 'duplicate' | 'ignored'>;
}

describe('generated-app Stripe templates', () => {
  it(
    'renders project-adapter-specific route locations without unresolved template tokens',
    async () => {
      const bundle = await templates();
      const next = renderStripeAdapterTemplates({ adapterId: 'next', templates: bundle });
      const express = renderStripeAdapterTemplates({
        adapterId: 'express-fastify',
        serverFramework: 'express',
        templates: bundle,
      });

      expect(next.map(({ path }) => path)).toEqual([
      'src/app/api/stripe/checkout/route.ts',
      'src/app/api/stripe/portal/route.ts',
      'src/app/api/stripe/webhook/route.ts',
      'src/lib/stripe/sync.ts',
      'src/lib/stripe/access.ts',
      'migrations/20260811000000_zapp_stripe_subscriptions.sql',
    ]);
      expect(express.map(({ path }) => path)).toEqual([
      'src/routes/stripe/checkout.ts',
      'src/routes/stripe/portal.ts',
      'src/routes/stripe/webhook.ts',
      'src/integrations/stripe/sync.ts',
      'src/middleware/require-subscription.ts',
      'migrations/20260811000000_zapp_stripe_subscriptions.sql',
    ]);
      for (const file of [...next, ...express]) {
        expect(file.contents).not.toMatch(/\{\{[^}]+\}\}/u);
      }
      expect(next.find(({ template }) => template === 'webhook')?.contents).toContain(
        'export async function POST',
      );
      expect(express.find(({ template }) => template === 'webhook')?.contents).toContain(
        'export function registerStripeWebhookRoute',
      );
      const checkout = next.find(({ template }) => template === 'checkout')?.contents ?? '';
      expect(checkout).toContain('ensureStripeCustomer');
      expect(checkout).toContain('createStripeCheckoutRouteHandler');
      expect(checkout).toContain('bootstrapStripeTestProducts');
      expect(checkout).toContain("month: await price('month'");
      expect(checkout).toContain("year: await price('year'");
      expect(checkout).toContain('trial_period_days');
      expect(checkout).toContain('GENERATED_APP_STRIPE_RESTRICTED_KEY');
      expect(next.find(({ template }) => template === 'portal')?.contents).toContain(
        'createStripePortalRouteHandler',
      );
      expect(next.find(({ template }) => template === 'access')?.contents).toContain(
        'requireSubscription',
      );
      expect(next.find(({ template }) => template === 'migration')?.contents).toContain(
        'last_event_created bigint not null',
      );
      expect(() =>
        renderStripeAdapterTemplates({
          adapterId: 'express-fastify',
          serverFramework: 'fastify',
          templates: bundle,
        }),
      ).toThrow('explicit Express project hint');
      await expect(
        typecheckRendered([
          ...next.map((file) => ({ ...file, path: join('next', file.path) })),
          ...express.map((file) => ({ ...file, path: join('express', file.path) })),
        ]),
      ).resolves.toEqual([]);
    },
    60_000,
  );

  it('rejects a webhook fixture with a bad Stripe signature before sync', async () => {
    const rendered = renderStripeAdapterTemplates({
      adapterId: 'next',
      templates: await templates(),
    });
    const source = rendered.find(({ template }) => template === 'webhook')?.contents;
    if (source === undefined) throw new Error('webhook template was not rendered');
    const webhook = await executable<WebhookModule>(source);
    const sync = vi.fn(() => Promise.resolve('applied'));

    const response = await webhook.handleStripeWebhook(
      {
        stripe: {
          webhooks: {
            constructEvent() {
              throw new Error('signature mismatch');
            },
          },
        },
        webhookSecret: 'fixture-signing-secret',
        sync,
      },
      { rawBody: '{"id":"evt_bad"}', signature: 'bad-signature' },
    );

    expect(response).toEqual({ status: 400, body: { error: 'invalid_signature' } });
    expect(sync).not.toHaveBeenCalled();
  });

  it('atomically installs route files and the subscription migration without overwriting edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-stripe-install-'));
    try {
      const runtime = new MemoryWorkspaceRuntime(root);
      const input = { adapterId: 'next' as const, templates: await templates(), runtime };
      const installed = await installStripeAdapterTemplates(input);
      expect(installed).toHaveLength(6);
      await expect(
        readFile(join(root, 'migrations/20260811000000_zapp_stripe_subscriptions.sql'), 'utf8'),
      ).resolves.toContain('stripe_subscription_state');
      await expect(installStripeAdapterTemplates(input)).resolves.toHaveLength(6);

      const checkout = join(root, 'src/app/api/stripe/checkout/route.ts');
      await writeFile(checkout, 'project-owned checkout route\n', 'utf8');
      await expect(installStripeAdapterTemplates(input)).rejects.toBeInstanceOf(
        StripeAdapterInstallConflictError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('claims a Stripe event id once and does not sync a duplicate delivery', async () => {
    const rendered = renderStripeAdapterTemplates({
      adapterId: 'express-fastify',
      serverFramework: 'express',
      templates: await templates(),
    });
    const source = rendered.find(({ template }) => template === 'sync')?.contents;
    if (source === undefined) throw new Error('sync template was not rendered');
    const sync = await executable<SyncModule>(source);
    const claimed = new Set<string>();
    const applyEvent = vi.fn((eventId: string, eventCreated: number, input: unknown) => {
      void eventCreated;
      void input;
      if (claimed.has(eventId)) return Promise.resolve('duplicate' as const);
      claimed.add(eventId);
      return Promise.resolve('applied' as const);
    });
    const store = {
      applyEvent,
    };
    const event = {
      id: 'evt_subscription_updated',
      created: 1_799_999_900,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_fixture',
          customer: 'cus_fixture',
          status: 'active',
          trial_end: null,
          metadata: { tier: 'pro' },
          items: { data: [{ current_period_end: 1_800_000_000 }] },
        },
      },
    };

    await expect(sync.syncStripeSubscriptionEvent({ store }, event)).resolves.toBe('applied');
    await expect(sync.syncStripeSubscriptionEvent({ store }, event)).resolves.toBe('duplicate');
    expect(applyEvent).toHaveBeenCalledTimes(2);
    expect(applyEvent.mock.calls[0]?.[2]).toMatchObject({
      stripeSubscriptionId: 'sub_fixture',
      tier: 'pro',
    });
  });

  it('does not let an older Stripe event restore access after cancellation', async () => {
    const rendered = renderStripeAdapterTemplates({
      adapterId: 'next',
      templates: await templates(),
    });
    const source = rendered.find(({ template }) => template === 'sync')?.contents;
    if (source === undefined) throw new Error('sync template was not rendered');
    const sync = await executable<SyncModule>(source);
    let latestCreated = -1;
    let latestState: unknown;
    const store = {
      applyEvent(_eventId: string, eventCreated: number, input: unknown) {
        if (eventCreated <= latestCreated) return Promise.resolve('stale' as const);
        latestCreated = eventCreated;
        latestState = input;
        return Promise.resolve('applied' as const);
      },
    };
    const event = (created: number, status: 'active' | 'canceled') => ({
      id: `evt_${status}_${String(created)}`,
      created,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_fixture',
          customer: 'cus_fixture',
          status,
          trial_end: null,
          metadata: { tier: 'pro' },
          items: { data: [{ current_period_end: 1_800_000_000 }] },
        },
      },
    });

    await expect(sync.syncStripeSubscriptionEvent({ store }, event(200, 'canceled'))).resolves.toBe(
      'applied',
    );
    await expect(sync.syncStripeSubscriptionEvent({ store }, event(100, 'active'))).resolves.toBe(
      'stale',
    );
    expect(latestState).toMatchObject({ status: 'canceled' });
  });
});
