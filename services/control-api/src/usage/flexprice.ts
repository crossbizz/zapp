import { idSchema } from '@zapp/contracts';
import { USAGE_CATEGORIES } from '@zapp/db';
import { z } from 'zod';

export const FlexpriceUsageEventSchema = z
  .object({
    event_name: z.enum(USAGE_CATEGORIES),
    external_customer_id: idSchema('org'),
    event_id: z.string().trim().min(1),
    timestamp: z.string().datetime({ offset: true }),
    properties: z
      .object({
        project_id: idSchema('proj').nullable(),
        run_id: idSchema('run').nullable(),
        task_id: idSchema('task').nullable(),
        quantity: z.number().finite(),
        unit: z.string().trim().min(1),
        provider: z.string().trim().min(1).nullable(),
        correction_of: z
          .string()
          .regex(/^usage_[A-Za-z0-9_-]+$/u)
          .optional(),
        model: z.string().trim().min(1).optional(),
      })
      .strict()
      .transform((properties) => ({
        project_id: properties.project_id,
        run_id: properties.run_id,
        task_id: properties.task_id,
        quantity: properties.quantity,
        unit: properties.unit,
        provider: properties.provider,
        ...(properties.correction_of === undefined
          ? {}
          : { correction_of: properties.correction_of }),
      })),
  })
  .strict();

export type FlexpriceUsageEvent = z.infer<typeof FlexpriceUsageEventSchema>;

export interface FlexpriceIngestPort {
  ingest(event: FlexpriceUsageEvent): Promise<void>;
}

export function createFlexpriceIngestClient(options: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
}): FlexpriceIngestPort {
  const request = options.fetch ?? globalThis.fetch;
  const endpoint = new URL('events', `${options.baseUrl.replace(/\/+$/u, '')}/`);
  return {
    async ingest(rawEvent) {
      const event = FlexpriceUsageEventSchema.parse(rawEvent);
      const response = await request(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
        },
        body: JSON.stringify(event),
      });
      if (response.status !== 202) {
        throw new Error(`Flexprice event ingestion failed with status ${String(response.status)}`);
      }
    },
  };
}

export const FLEXPRICE_USAGE_CATEGORIES = USAGE_CATEGORIES;

const ResourceProfileSchema = z.enum(['small', 'standard', 'large']);
const PlanDefinitionSchema = z
  .object({
    concurrentAutonomousRuns: z.number().int().positive(),
    concurrentSandboxes: z.number().int().positive(),
    maxResourceProfile: ResourceProfileSchema,
    maxRunBudgetCredits: z.number().positive(),
    maxPreviewLifetimeHours: z.number().positive(),
    artifactRetentionDays: z.number().int().positive(),
    monthlyCredits: z.number().nonnegative(),
    seats: z.number().int().positive(),
  })
  .strict();

export const PlanCatalogSchema = z
  .object({ plans: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/u), PlanDefinitionSchema) })
  .strict()
  .refine((catalog) => Object.keys(catalog.plans).length > 0, {
    message: 'plans must contain at least one plan',
    path: ['plans'],
  });

export type PlanCatalog = z.infer<typeof PlanCatalogSchema>;

interface CatalogFeature {
  readonly id: string;
  readonly meterId: string;
}

interface CatalogPlan {
  readonly id: string;
}

export interface FlexpriceCatalogPort {
  featureByLookupKey(lookupKey: string): Promise<CatalogFeature | undefined>;
  createMeteredFeature(input: {
    readonly name: string;
    readonly lookupKey: string;
    readonly eventName: string;
    readonly aggregation: { readonly type: 'SUM'; readonly field: 'quantity' };
  }): Promise<CatalogFeature>;
  planByLookupKey(lookupKey: string): Promise<CatalogPlan | undefined>;
  createPlan(input: { readonly name: string; readonly lookupKey: string }): Promise<CatalogPlan>;
  hasEntitlement(planId: string, featureId: string): Promise<boolean>;
  createEntitlement(input: { readonly planId: string; readonly featureId: string }): Promise<void>;
}

export async function syncFlexpriceCatalog(
  catalog: FlexpriceCatalogPort,
  rawPlans: unknown,
): Promise<void> {
  const configured = PlanCatalogSchema.parse(rawPlans);
  const features: CatalogFeature[] = [];
  for (const category of FLEXPRICE_USAGE_CATEGORIES) {
    const lookupKey = `zapp_usage_${category}`;
    const feature =
      (await catalog.featureByLookupKey(lookupKey)) ??
      (await catalog.createMeteredFeature({
        name: title(category),
        lookupKey,
        eventName: category,
        aggregation: { type: 'SUM', field: 'quantity' },
      }));
    features.push(feature);
  }

  for (const planKey of Object.keys(configured.plans).sort()) {
    const lookupKey = `zapp_${planKey}`;
    const plan =
      (await catalog.planByLookupKey(lookupKey)) ??
      (await catalog.createPlan({ name: title(planKey), lookupKey }));
    for (const feature of features) {
      if (!(await catalog.hasEntitlement(plan.id, feature.id))) {
        await catalog.createEntitlement({ planId: plan.id, featureId: feature.id });
      }
    }
  }
}

const CatalogFeatureSchema = z
  .object({ id: z.string().min(1), meter_id: z.string().min(1) })
  .passthrough();
const CatalogPlanSchema = z.object({ id: z.string().min(1) }).passthrough();
const CatalogEntitlementSchema = z.object({ feature_id: z.string().min(1) }).passthrough();

export function createFlexpriceCatalogClient(options: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
}): FlexpriceCatalogPort {
  const request = options.fetch ?? globalThis.fetch;
  const base = `${options.baseUrl.replace(/\/+$/u, '')}/`;

  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const headers = new Headers(init?.headers);
    headers.set('content-type', 'application/json');
    headers.set('x-api-key', options.apiKey);
    const response = await request(new URL(path, base), {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw new Error(`Flexprice catalog request failed with status ${String(response.status)}`);
    }
    return await response.json();
  }

  async function queryItems(path: string): Promise<unknown[]> {
    const response = await json(path);
    const parsed = z
      .object({ items: z.array(z.unknown()).default([]) })
      .passthrough()
      .parse(response);
    return parsed.items;
  }

  return {
    async featureByLookupKey(lookupKey) {
      const items = await queryItems(`features?lookup_key=${encodeURIComponent(lookupKey)}`);
      const found = items[0];
      if (found === undefined) return undefined;
      const feature = CatalogFeatureSchema.parse(found);
      return { id: feature.id, meterId: feature.meter_id };
    },
    async createMeteredFeature(input) {
      const feature = CatalogFeatureSchema.parse(
        await json('features', {
          method: 'POST',
          body: JSON.stringify({
            name: input.name,
            lookup_key: input.lookupKey,
            type: 'metered',
            unit_singular: 'unit',
            unit_plural: 'units',
            meter: {
              name: input.eventName,
              event_name: input.eventName,
              aggregation: { type: input.aggregation.type, field: input.aggregation.field },
              filters: [],
              reset_usage: 'BILLING_PERIOD',
            },
          }),
        }),
      );
      return { id: feature.id, meterId: feature.meter_id };
    },
    async planByLookupKey(lookupKey) {
      const items = await queryItems(`plans?lookup_key=${encodeURIComponent(lookupKey)}`);
      const found = items[0];
      if (found === undefined) return undefined;
      const plan = CatalogPlanSchema.parse(found);
      return { id: plan.id };
    },
    async createPlan(input) {
      const plan = CatalogPlanSchema.parse(
        await json('plans', {
          method: 'POST',
          body: JSON.stringify({ name: input.name, lookup_key: input.lookupKey }),
        }),
      );
      return { id: plan.id };
    },
    async hasEntitlement(planId, featureId) {
      const items = await queryItems(`plans/${encodeURIComponent(planId)}/entitlements`);
      return items.some(
        (item) => CatalogEntitlementSchema.safeParse(item).data?.feature_id === featureId,
      );
    },
    async createEntitlement(input) {
      await json('entitlements', {
        method: 'POST',
        body: JSON.stringify({
          plan_id: input.planId,
          feature_id: input.featureId,
          feature_type: 'metered',
          is_enabled: true,
          is_soft_limit: true,
          usage_reset_period: 'MONTHLY',
        }),
      });
    },
  };
}

function title(value: string): string {
  return value
    .split(/[-_]/u)
    .filter((part) => part !== '')
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
