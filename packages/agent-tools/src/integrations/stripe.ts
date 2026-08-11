import Handlebars from 'handlebars';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';

const StripeAdapterIdSchema = z.enum(['next', 'express-fastify']);
const StripeTemplateBundleSchema = z
  .object({
    checkout: z.string().min(1),
    portal: z.string().min(1),
    webhook: z.string().min(1),
    sync: z.string().min(1),
    access: z.string().min(1),
  })
  .strict();

export type StripeAdapterId = z.infer<typeof StripeAdapterIdSchema>;
export type StripeTemplateName = keyof z.infer<typeof StripeTemplateBundleSchema>;
export type StripeAdapterArtifact = StripeTemplateName | 'migration';

export interface RenderedStripeAdapterFile {
  readonly template: StripeAdapterArtifact;
  readonly path: string;
  readonly contents: string;
}

export interface StripeAdapterRenderInput {
  readonly adapterId: StripeAdapterId;
  readonly serverFramework?: 'express' | 'fastify';
  readonly templates: Record<StripeTemplateName, string>;
}

export class StripeAdapterInstallConflictError extends Error {
  constructor(readonly path: string) {
    super(`Stripe adapter target already has different contents: ${path}`);
    this.name = 'StripeAdapterInstallConflictError';
  }
}

export const STRIPE_ADAPTER_PACKAGES = ['stripe', 'postgres', 'zod'] as const;

export const STRIPE_SUBSCRIPTION_MIGRATION_SQL = `create table if not exists stripe_webhook_events (
  event_id text primary key,
  event_created bigint not null,
  received_at timestamptz not null default now()
);
create table if not exists stripe_subscription_state (
  stripe_subscription_id text primary key,
  stripe_customer_id text not null,
  tier text not null,
  status text not null,
  current_period_end timestamptz not null,
  trial_end timestamptz,
  last_event_created bigint not null,
  last_event_id text not null,
  updated_at timestamptz not null default now()
);
create index if not exists stripe_subscription_state_customer_idx
  on stripe_subscription_state(stripe_customer_id);
`;

const TARGETS: Record<StripeAdapterId, Record<StripeTemplateName, string>> = {
  next: {
    checkout: 'src/app/api/stripe/checkout/route.ts',
    portal: 'src/app/api/stripe/portal/route.ts',
    webhook: 'src/app/api/stripe/webhook/route.ts',
    sync: 'src/lib/stripe/sync.ts',
    access: 'src/lib/stripe/access.ts',
  },
  'express-fastify': {
    checkout: 'src/routes/stripe/checkout.ts',
    portal: 'src/routes/stripe/portal.ts',
    webhook: 'src/routes/stripe/webhook.ts',
    sync: 'src/integrations/stripe/sync.ts',
    access: 'src/middleware/require-subscription.ts',
  },
};

const TEMPLATE_ORDER: readonly StripeTemplateName[] = [
  'checkout',
  'portal',
  'webhook',
  'sync',
  'access',
];

export function renderStripeAdapterTemplates(
  input: StripeAdapterRenderInput,
): readonly RenderedStripeAdapterFile[] {
  const adapterId = StripeAdapterIdSchema.parse(input.adapterId);
  if (adapterId === 'express-fastify' && input.serverFramework !== 'express') {
    throw new Error('Stripe templates require an explicit Express project hint');
  }
  const templates = StripeTemplateBundleSchema.parse(input.templates);
  const isNext = adapterId === 'next';
  const files = TEMPLATE_ORDER.map((template) => {
    const context = {
      isNext,
      isExpress: !isNext,
      syncImport:
        template === 'webhook'
          ? isNext
            ? '../../../../lib/stripe/sync'
            : '../../integrations/stripe/sync'
          : isNext
            ? './sync'
            : '../integrations/stripe/sync',
    };
    const contents = Handlebars.compile(templates[template], {
      noEscape: true,
      strict: true,
    })(context);
    if (/\{\{[^}]+\}\}/u.test(contents)) {
      throw new Error(`Stripe template ${template} left an unresolved token`);
    }
    return { template, path: TARGETS[adapterId][template], contents };
  });
  return [
    ...files,
    {
      template: 'migration',
      path: 'migrations/20260811000000_zapp_stripe_subscriptions.sql',
      contents: STRIPE_SUBSCRIPTION_MIGRATION_SQL,
    },
  ];
}

export async function installStripeAdapterTemplates(
  input: StripeAdapterRenderInput & { readonly runtime: WorkspaceRuntime },
): Promise<readonly RenderedStripeAdapterFile[]> {
  const files = renderStripeAdapterTemplates(input);
  const directories = [
    ...new Set(files.map(({ path }) => path.slice(0, path.lastIndexOf('/')))),
  ];
  const created = await input.runtime.exec({
    cmd: 'mkdir',
    args: ['-p', ...directories],
    timeoutMs: 30_000,
  });
  if (created.exitCode !== 0) throw new Error('Could not create Stripe adapter directories');
  const existing = new Set(
    (await input.runtime.listFiles('.', { maxDepth: 12 }))
      .filter(({ type }) => type === 'file')
      .map(({ path }) => path),
  );
  const writes = await Promise.all(
    files.map(async (file) => {
      if (!existing.has(file.path)) {
        return { path: file.path, data: new TextEncoder().encode(file.contents) };
      }
      const data = await input.runtime.readFile(file.path);
      if (new TextDecoder().decode(data) !== file.contents) {
        throw new StripeAdapterInstallConflictError(file.path);
      }
      return { path: file.path, data };
    }),
  );
  await input.runtime.writeFilesAtomically(writes);
  return files;
}
