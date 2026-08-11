import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const USAGE_CATEGORIES = [
  'model_input_tokens',
  'model_output_tokens',
  'model_cached_tokens',
  'sandbox_cpu_seconds',
  'sandbox_mem_gib_seconds',
  'storage_gib_hours',
  'deploy_provider',
  'artifact_storage',
] as const;

export type FlexpriceUsageCategory = (typeof USAGE_CATEGORIES)[number];

export interface FlexpricePlanInput {
  readonly monthlyCredits: string;
  readonly seats: number;
  readonly [key: string]: unknown;
}

export interface FlexpriceBootstrapInput {
  readonly categories: readonly FlexpriceUsageCategory[];
  readonly plans: Readonly<Record<string, FlexpricePlanInput>>;
}

type FlexpriceBootstrapKind = 'feature' | 'plan' | 'entitlement';

export interface FlexpriceBootstrapPort {
  get(kind: FlexpriceBootstrapKind, id: string): Promise<unknown>;
  put(kind: FlexpriceBootstrapKind, id: string, value: Record<string, unknown>): Promise<void>;
}

export interface FlexpriceBootstrapDiff {
  readonly kind: FlexpriceBootstrapKind;
  readonly id: string;
}

interface HttpBootstrapOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

interface CliOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly writeOutput?: (output: string) => void;
}

/** Converges the code-owned Flexprice catalogue through an injectable provider port. */
export async function reconcileFlexpriceBootstrap(
  port: FlexpriceBootstrapPort,
  rawInput: FlexpriceBootstrapInput,
): Promise<readonly FlexpriceBootstrapDiff[]> {
  const input = validateInput(rawInput);
  const desired: readonly {
    readonly kind: FlexpriceBootstrapKind;
    readonly id: string;
    readonly value: Record<string, unknown>;
  }[] = [
    ...input.categories.map((category) => ({
      kind: 'feature' as const,
      id: category,
      value: {
        lookupKey: category,
        type: 'metered',
        meter: {
          aggregation: 'SUM',
          eventName: category,
          resetUsage: 'BILLING_PERIOD',
          valueProperty: 'quantity',
        },
      },
    })),
    ...Object.entries(input.plans).flatMap(([planId, plan]) => [
      {
        kind: 'plan' as const,
        id: planId,
        value: {
          lookupKey: planId,
          metadata: Object.fromEntries(
            Object.entries(plan).map(([key, value]) => [key, String(value)]),
          ),
        },
      },
      ...input.categories.map((category) => ({
        kind: 'entitlement' as const,
        id: `${planId}:${category}`,
        value: {
          planId,
          featureId: category,
          featureType: 'metered',
          isEnabled: true,
          isSoftLimit: true,
          usageResetPeriod: 'MONTHLY',
        },
      })),
    ]),
  ];

  const diff: FlexpriceBootstrapDiff[] = [];
  for (const resource of desired) {
    const current = await port.get(resource.kind, resource.id);
    if (stableJson(current) === stableJson(resource.value)) continue;
    await port.put(resource.kind, resource.id, resource.value);
    diff.push({ kind: resource.kind, id: resource.id });
  }
  return diff;
}

/** Current Flexprice OpenAPI adapter: nested meters plus search-to-provider-ID mapping. */
export function createFlexpriceHttpBootstrapPort(
  options: HttpBootstrapOptions,
): FlexpriceBootstrapPort {
  const apiKey = requiredValue(options.apiKey, 'FLEXPRICE_API_KEY');
  const baseUrl = parseBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const providerIds = new Map<string, string>();

  const request = async (
    method: 'POST' | 'PUT',
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetchImpl(new URL(path.slice(1), baseUrl), {
        method,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(`Flexprice ${method} ${path} request failed`);
    }
    if (!response.ok) {
      throw new Error(`Flexprice ${method} ${path} failed with status ${response.status}`);
    }
    try {
      return asRecord(await response.json());
    } catch {
      throw new Error(`Flexprice ${method} ${path} returned an invalid JSON response`);
    }
  };

  return {
    async get(kind, id) {
      if (kind === 'feature') {
        const response = await request('POST', '/features/search', {
          limit: 1,
          lookup_key: id,
          offset: 0,
          status: 'published',
        });
        const resource = exactItem(response, 'lookup_key', id);
        if (resource === undefined) return undefined;
        providerIds.set(resourceKey(kind, id), requiredString(resource, 'id'));
        return normalizeFeature(resource);
      }
      if (kind === 'plan') {
        const response = await request('POST', '/plans/search', {
          limit: 1,
          lookup_key: id,
          offset: 0,
          status: 'published',
        });
        const resource = exactItem(response, 'lookup_key', id);
        if (resource === undefined) return undefined;
        providerIds.set(resourceKey(kind, id), requiredString(resource, 'id'));
        return normalizePlan(resource);
      }

      const { featureLookupKey, planLookupKey } = entitlementId(id);
      const planId = requiredProviderId(providerIds, 'plan', planLookupKey);
      const featureId = requiredProviderId(providerIds, 'feature', featureLookupKey);
      const response = await request('POST', '/entitlements/search', {
        entity_type: 'PLAN',
        feature_ids: [featureId],
        limit: 1,
        offset: 0,
        plan_ids: [planId],
        status: 'published',
      });
      const resource = responseItems(response).find(
        (item) => item.plan_id === planId && item.feature_id === featureId,
      );
      if (resource === undefined) return undefined;
      providerIds.set(resourceKey(kind, id), requiredString(resource, 'id'));
      return normalizeEntitlement(resource, planLookupKey, featureLookupKey);
    },

    async put(kind, id, value) {
      const providerId = providerIds.get(resourceKey(kind, id));
      if (kind === 'feature') {
        if (providerId !== undefined) {
          throw new Error(
            `Flexprice feature ${id} has immutable meter drift; current API cannot update nested meters`,
          );
        }
        const meter = asRecord(value.meter);
        const created = await request('POST', '/features', {
          lookup_key: requiredString(value, 'lookupKey'),
          meter: {
            aggregation: {
              field: requiredString(meter, 'valueProperty'),
              type: requiredString(meter, 'aggregation'),
            },
            event_name: requiredString(meter, 'eventName'),
            name: `${id} usage`,
            reset_usage: requiredString(meter, 'resetUsage'),
          },
          name: id,
          type: requiredString(value, 'type'),
          unit_plural: 'units',
          unit_singular: 'unit',
        });
        providerIds.set(resourceKey(kind, id), requiredString(created, 'id'));
        return;
      }

      if (kind === 'plan') {
        const body = {
          lookup_key: requiredString(value, 'lookupKey'),
          metadata: stringRecord(value.metadata),
          name: id,
        };
        const saved =
          providerId === undefined
            ? await request('POST', '/plans', body)
            : await request('PUT', `/plans/${encodeURIComponent(providerId)}`, body);
        providerIds.set(resourceKey(kind, id), requiredString(saved, 'id'));
        return;
      }

      const { featureLookupKey, planLookupKey } = entitlementId(id);
      const planId = requiredProviderId(providerIds, 'plan', planLookupKey);
      const featureId = requiredProviderId(providerIds, 'feature', featureLookupKey);
      const body = {
        entity_id: planId,
        entity_type: 'PLAN',
        feature_id: featureId,
        feature_type: requiredString(value, 'featureType'),
        is_enabled: requiredBoolean(value, 'isEnabled'),
        is_soft_limit: requiredBoolean(value, 'isSoftLimit'),
        plan_id: planId,
        usage_reset_period: requiredString(value, 'usageResetPeriod'),
      };
      const saved =
        providerId === undefined
          ? await request('POST', '/entitlements', body)
          : await request('PUT', `/entitlements/${encodeURIComponent(providerId)}`, {
              is_enabled: body.is_enabled,
              is_soft_limit: body.is_soft_limit,
              usage_reset_period: body.usage_reset_period,
            });
      providerIds.set(resourceKey(kind, id), requiredString(saved, 'id'));
    },
  };
}

/** Executable CLI seam; tests inject fetch while deployments provide environment configuration. */
export async function runFlexpriceBootstrapCli(
  options: CliOptions = {},
): Promise<readonly FlexpriceBootstrapDiff[]> {
  const env = options.env ?? process.env;
  const apiKey = requiredValue(env.FLEXPRICE_API_KEY, 'FLEXPRICE_API_KEY');
  const baseUrl = requiredValue(env.FLEXPRICE_BASE_URL, 'FLEXPRICE_BASE_URL');
  const plansPath = new URL('../config/plans.json', import.meta.url);
  const plans = JSON.parse(await readFile(plansPath, 'utf8')) as Record<string, FlexpricePlanInput>;
  const portOptions: HttpBootstrapOptions = {
    apiKey,
    baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  const diff = await reconcileFlexpriceBootstrap(createFlexpriceHttpBootstrapPort(portOptions), {
    categories: USAGE_CATEGORIES,
    plans,
  });
  const writeOutput =
    options.writeOutput ??
    ((output: string): void => {
      process.stdout.write(output);
    });
  writeOutput(`${JSON.stringify(diff)}\n`);
  return diff;
}

function validateInput(input: FlexpriceBootstrapInput): FlexpriceBootstrapInput {
  if (
    input.categories.length !== USAGE_CATEGORIES.length ||
    input.categories.some((category, index) => category !== USAGE_CATEGORIES[index])
  ) {
    throw new Error('Flexprice bootstrap categories must match the persisted usage enum');
  }
  for (const [planId, plan] of Object.entries(input.plans)) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(planId)) throw new Error('Flexprice plan id is invalid');
    if (!/^\d+(?:\.\d{1,4})?$/u.test(plan.monthlyCredits)) {
      throw new Error(`Flexprice plan ${planId} has invalid monthlyCredits`);
    }
    if (!Number.isInteger(plan.seats) || plan.seats < 1) {
      throw new Error(`Flexprice plan ${planId} has invalid seats`);
    }
  }
  return input;
}

function normalizeFeature(resource: Record<string, unknown>): Record<string, unknown> {
  const meter = asRecord(resource.meter);
  const aggregation = asRecord(meter.aggregation);
  return {
    lookupKey: requiredString(resource, 'lookup_key'),
    type: requiredString(resource, 'type'),
    meter: {
      aggregation: requiredString(aggregation, 'type'),
      eventName: requiredString(meter, 'event_name'),
      resetUsage: requiredString(meter, 'reset_usage'),
      valueProperty: requiredString(aggregation, 'field'),
    },
  };
}

function normalizePlan(resource: Record<string, unknown>): Record<string, unknown> {
  return {
    lookupKey: requiredString(resource, 'lookup_key'),
    metadata: stringRecord(resource.metadata),
  };
}

function normalizeEntitlement(
  resource: Record<string, unknown>,
  planLookupKey: string,
  featureLookupKey: string,
): Record<string, unknown> {
  return {
    planId: planLookupKey,
    featureId: featureLookupKey,
    featureType: requiredString(resource, 'feature_type'),
    isEnabled: requiredBoolean(resource, 'is_enabled'),
    isSoftLimit: requiredBoolean(resource, 'is_soft_limit'),
    usageResetPeriod: requiredString(resource, 'usage_reset_period'),
  };
}

function exactItem(
  response: Record<string, unknown>,
  field: string,
  value: string,
): Record<string, unknown> | undefined {
  return responseItems(response).find((item) => item[field] === value);
}

function responseItems(response: Record<string, unknown>): readonly Record<string, unknown>[] {
  if (!Array.isArray(response.items)) throw new Error('Flexprice search returned invalid items');
  return response.items.map(asRecord);
}

function entitlementId(id: string): { featureLookupKey: string; planLookupKey: string } {
  const separator = id.indexOf(':');
  if (separator < 1 || separator === id.length - 1) throw new Error('invalid entitlement identity');
  return { planLookupKey: id.slice(0, separator), featureLookupKey: id.slice(separator + 1) };
}

function requiredProviderId(
  providerIds: ReadonlyMap<string, string>,
  kind: 'feature' | 'plan',
  id: string,
): string {
  const providerId = providerIds.get(resourceKey(kind, id));
  if (providerId === undefined) throw new Error(`Flexprice ${kind} ${id} was not resolved`);
  return providerId;
}

function resourceKey(kind: FlexpriceBootstrapKind, id: string): string {
  return `${kind}:${id}`;
}

function parseBaseUrl(raw: string): URL {
  const value = requiredValue(raw, 'FLEXPRICE_BASE_URL');
  let url: URL;
  try {
    url = new URL(value.endsWith('/') ? value : `${value}/`);
  } catch {
    throw new Error('FLEXPRICE_BASE_URL must be a valid HTTP URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new Error('FLEXPRICE_BASE_URL must be a valid HTTP URL without credentials');
  }
  return url;
}

function requiredValue(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Flexprice returned an invalid object');
  }
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => {
      if (typeof child !== 'string') throw new Error('Flexprice metadata must contain strings');
      return [key, child];
    }),
  );
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Flexprice response field ${field} must be a string`);
  }
  return value;
}

function requiredBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') {
    throw new Error(`Flexprice response field ${field} must be a boolean`);
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runFlexpriceBootstrapCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Flexprice bootstrap failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
