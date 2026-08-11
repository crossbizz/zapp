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

export interface FlexpriceBootstrapPort {
  get(kind: 'feature' | 'meter' | 'plan' | 'entitlement', id: string): Promise<unknown>;
  put(
    kind: 'feature' | 'meter' | 'plan' | 'entitlement',
    id: string,
    value: Record<string, unknown>,
  ): Promise<void>;
}

export interface FlexpriceBootstrapDiff {
  readonly kind: 'feature' | 'meter' | 'plan' | 'entitlement';
  readonly id: string;
}

/**
 * Converges the code-owned Flexprice product catalogue. The port intentionally
 * owns provider transport and lookup-key mechanics; this module owns the
 * desired catalogue and makes repeat execution a no-op when it already matches.
 */
export async function reconcileFlexpriceBootstrap(
  port: FlexpriceBootstrapPort,
  rawInput: FlexpriceBootstrapInput,
): Promise<readonly FlexpriceBootstrapDiff[]> {
  const input = validateInput(rawInput);
  const desired: readonly {
    readonly kind: FlexpriceBootstrapDiff['kind'];
    readonly id: string;
    readonly value: Record<string, unknown>;
  }[] = [
    ...input.categories.flatMap((category) => [
      {
        kind: 'feature' as const,
        id: category,
        value: { lookupKey: category, type: 'metered', eventName: category },
      },
      {
        kind: 'meter' as const,
        id: category,
        value: {
          aggregation: 'SUM',
          eventName: category,
          valueProperty: 'properties.quantity',
        },
      },
    ]),
    ...Object.entries(input.plans).flatMap(([planId, plan]) => [
      { kind: 'plan' as const, id: planId, value: { lookupKey: planId, ...plan } },
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

async function main(): Promise<void> {
  // Credentials and the Flexprice HTTP adapter are injected only by deployment
  // automation. Keeping this script's convergence function transport-agnostic
  // makes its idempotence executable with a fake and avoids a second setup path.
  const plansPath = new URL('../config/plans.json', import.meta.url);
  const plans = JSON.parse(await readFile(plansPath, 'utf8')) as unknown;
  const port = (globalThis as { flexpriceBootstrapPort?: FlexpriceBootstrapPort })
    .flexpriceBootstrapPort;
  if (port === undefined) {
    throw new Error('Flexprice bootstrap requires a configured deployment port');
  }
  const diff = await reconcileFlexpriceBootstrap(port, {
    categories: USAGE_CATEGORIES,
    plans: plans as Record<string, FlexpricePlanInput>,
  });
  process.stdout.write(`${JSON.stringify(diff)}\n`);
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
  void main();
}
