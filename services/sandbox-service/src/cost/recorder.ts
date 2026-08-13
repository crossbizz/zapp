import { idSchema } from '@zapp/contracts';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import {
  getResourceProfile,
  ResourceProfileNameSchema,
} from '../provider/profiles.js';
import {
  createMemoryCostRecordingStateStore,
  type CostRecordingState,
  type CostRecordingStateStore,
} from './state.js';

const SAMPLE_INTERVAL_MS = 30_000;
const BYTES_PER_GIBIBYTE = 1024 ** 3;

const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);

const SandboxPricingSchema = z
  .object({
    cpuSecondUsd: z.number().finite().nonnegative(),
    memoryGibSecondUsd: z.number().finite().nonnegative(),
    creditsPerUsd: z.number().finite().nonnegative(),
  })
  .strict();

const PricingFileSchema = z
  .object({ sandbox: SandboxPricingSchema })
  .strict();

export type SandboxPricing = z.infer<typeof SandboxPricingSchema>;

const MetricsResponseSchema = z
  .object({
    at: z.string().datetime(),
    activeChildren: z.number().int().nonnegative(),
    cpu: z
      .object({
        userMicros: z.number().finite().nonnegative(),
        systemMicros: z.number().finite().nonnegative(),
      })
      .strict(),
    memory: z
      .object({
        rssBytes: z.number().finite().nonnegative(),
        heapTotalBytes: z.number().finite().nonnegative(),
        heapUsedBytes: z.number().finite().nonnegative(),
        externalBytes: z.number().finite().nonnegative(),
        arrayBuffersBytes: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();

const StartCostRecordingSchema = z
  .object({
    workspaceId: idSchema('ws'),
    providerWorkspaceId: z.string().min(1).optional(),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    runId: idSchema('run'),
    taskId: idSchema('task'),
    operationKey: OperationKeySchema.optional(),
    profile: ResourceProfileNameSchema,
    pricing: SandboxPricingSchema,
  })
  .strict();

export const SANDBOX_USAGE_CATEGORIES = [
  'sandbox_cpu_seconds',
  'sandbox_mem_gib_seconds',
] as const;

const UsageCategorySchema = z.enum(SANDBOX_USAGE_CATEGORIES);

export const UsageLedgerRowSchema = z
  .object({
    id: z.string().regex(/^usage_[a-f0-9]{64}_sandbox_(?:cpu_seconds|mem_gib_seconds)$/u),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    runId: idSchema('run'),
    taskId: idSchema('task'),
    category: UsageCategorySchema,
    provider: z.literal('modal'),
    quantity: z.string().regex(/^\d+(?:\.\d+)?$/u),
    unit: z.enum(['cpu_second', 'gib_second']),
    costUsd: z.string().regex(/^\d+\.\d{6}$/u),
    creditsCharged: z.string().regex(/^\d+\.\d{4}$/u),
    occurredAt: z.string().datetime(),
  })
  .strict();

export type UsageLedgerRow = z.infer<typeof UsageLedgerRowSchema>;

export interface CostRecorderDependencies {
  nowMs(): number;
  metrics: {
    sample(workspaceId: string): Promise<unknown>;
  };
  ledger: {
    appendIfAbsent(row: UsageLedgerRow): Promise<void>;
  };
  state?: CostRecordingStateStore;
  scheduler: {
    setInterval(callback: () => Promise<void>, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

export interface ActiveCostRecording {
  terminate(): Promise<readonly [UsageLedgerRow, UsageLedgerRow]>;
  close(): Promise<void>;
}

export async function loadSandboxPricing(filePath: string): Promise<SandboxPricing> {
  const raw = await readFile(filePath, 'utf8');
  return PricingFileSchema.parse(JSON.parse(raw) as unknown).sandbox;
}

export function createCostRecorder(dependencies: CostRecorderDependencies) {
  const stateStore = dependencies.state ?? createMemoryCostRecordingStateStore();
  return {
    async start(inputValue: unknown): Promise<ActiveCostRecording> {
      const input = StartCostRecordingSchema.parse(inputValue);
      const profile = getResourceProfile(input.profile);
      let restored = await stateStore.read(input.workspaceId);
      if (restored !== undefined) assertOperationKey(input.operationKey, restored.operationKey);
      if (restored === undefined || restored.finalizedAtMs === null) {
        let baseline: z.infer<typeof MetricsResponseSchema>;
        try {
          baseline = MetricsResponseSchema.parse(
            await dependencies.metrics.sample(input.providerWorkspaceId ?? input.workspaceId),
          );
        } catch {
          baseline = emptyMetrics(dependencies.nowMs());
        }
        restored = await advanceState({
          store: stateStore,
          input,
          profile,
          metrics: baseline,
          atMs: dependencies.nowMs(),
          finalize: false,
        });
      }
      let state: CostRecordingState = restored;
      let active = true;
      let sampling = Promise.resolve();
      let deliveryAttempt: Promise<readonly [UsageLedgerRow, UsageLedgerRow]> | undefined;

      const deliverFinalized = (): Promise<readonly [UsageLedgerRow, UsageLedgerRow]> => {
        if (deliveryAttempt !== undefined) return deliveryAttempt;
        const attempt = (async () => {
          const persisted = await stateStore.read(input.workspaceId);
          if (persisted === undefined || persisted.finalizedAtMs === null) {
            throw new Error('cost recording state was not finalized');
          }
          state = persisted;
          const rows = makeFinalizedLedgerRows(input, persisted);
          if (persisted.cpuDeliveredAtMs === null) {
            await dependencies.ledger.appendIfAbsent(rows[0]);
            state = await markCategoryDelivered(
              stateStore,
              input.workspaceId,
              'sandbox_cpu_seconds',
              dependencies.nowMs(),
            );
          }
          if (state.memoryDeliveredAtMs === null) {
            await dependencies.ledger.appendIfAbsent(rows[1]);
            state = await markCategoryDelivered(
              stateStore,
              input.workspaceId,
              'sandbox_mem_gib_seconds',
              dependencies.nowMs(),
            );
          }
          return rows;
        })();
        deliveryAttempt = attempt;
        void attempt.then(
          () => {
            if (deliveryAttempt === attempt) deliveryAttempt = undefined;
          },
          () => {
            if (deliveryAttempt === attempt) deliveryAttempt = undefined;
          },
        );
        return attempt;
      };

      const sample = async () => {
        const current = MetricsResponseSchema.parse(
          await dependencies.metrics.sample(input.providerWorkspaceId ?? input.workspaceId),
        );
        state = await advanceState({
          store: stateStore,
          input,
          profile,
          metrics: current,
          atMs: dependencies.nowMs(),
          finalize: false,
        });
      };

      const intervalHandle = dependencies.scheduler.setInterval(async () => {
        if (!active) return;
        sampling = sampling.then(async () => {
          const persisted = await stateStore.read(input.workspaceId);
          if (persisted?.finalizedAtMs !== null && persisted?.finalizedAtMs !== undefined) {
            state = persisted;
            try {
              await deliverFinalized();
            } catch {
              // Stable undelivered rows remain durable and are retried by this interval.
            }
            return;
          }
          try {
            await sample();
          } catch {
            // Keep the prior successful baseline. The next successful sample
            // accounts for the whole elapsed billing window.
          }
        });
        await sampling;
      }, SAMPLE_INTERVAL_MS);
      if (state.finalizedAtMs !== null) {
        void deliverFinalized().catch(() => {
          // Restart recovery remains non-blocking; the interval retries the durable row.
        });
      }

      return {
        terminate() {
          const attempt = (async () => {
            active = false;
            dependencies.scheduler.clearInterval(intervalHandle);
            await sampling;
            const persisted = await stateStore.read(input.workspaceId);
            if (persisted !== undefined) state = persisted;
            if (state.finalizedAtMs === null) {
              let current: z.infer<typeof MetricsResponseSchema> | undefined;
              try {
                current = MetricsResponseSchema.parse(
                  await dependencies.metrics.sample(
                    input.providerWorkspaceId ?? input.workspaceId,
                  ),
                );
              } catch {
                current = undefined;
              }
              if (current === undefined) {
                state = await finalizeWithRequestedUsage({
                  store: stateStore,
                  input,
                  profile,
                  atMs: dependencies.nowMs(),
                });
              } else {
                state = await advanceState({
                  store: stateStore,
                  input,
                  profile,
                  metrics: current,
                  atMs: dependencies.nowMs(),
                  finalize: true,
                });
              }
            }
            return await deliverFinalized();
          })();
          return attempt;
        },
        async close() {
          active = false;
          dependencies.scheduler.clearInterval(intervalHandle);
          await sampling;
        },
      };
    },
  };
}

async function markCategoryDelivered(
  store: CostRecordingStateStore,
  workspaceId: string,
  category: z.infer<typeof UsageCategorySchema>,
  deliveredAtMs: number,
): Promise<CostRecordingState> {
  return await store.mutate(workspaceId, (current) => {
    if (current === undefined || current.finalizedAtMs === null) {
      throw new Error('cost recording state was not finalized');
    }
    return category === 'sandbox_cpu_seconds'
      ? { ...current, cpuDeliveredAtMs: current.cpuDeliveredAtMs ?? deliveredAtMs }
      : { ...current, memoryDeliveredAtMs: current.memoryDeliveredAtMs ?? deliveredAtMs };
  });
}

function makeFinalizedLedgerRows(
  input: z.infer<typeof StartCostRecordingSchema>,
  state: CostRecordingState,
): readonly [UsageLedgerRow, UsageLedgerRow] {
  if (state.finalizedAtMs === null) throw new Error('cost recording state was not finalized');
  const occurredAt = new Date(state.finalizedAtMs).toISOString();
  const operationHash = state.operationKey.slice('op_'.length);
  return [
    makeLedgerRow({
      input,
      state,
      operationHash,
      category: 'sandbox_cpu_seconds',
      unit: 'cpu_second',
      quantity: state.cpuSeconds,
      rateUsd: state.cpuSecondUsd,
      occurredAt,
    }),
    makeLedgerRow({
      input,
      state,
      operationHash,
      category: 'sandbox_mem_gib_seconds',
      unit: 'gib_second',
      quantity: state.memoryGibSeconds,
      rateUsd: state.memoryGibSecondUsd,
      occurredAt,
    }),
  ];
}

async function advanceState(input: {
  readonly store: CostRecordingStateStore;
  readonly input: z.infer<typeof StartCostRecordingSchema>;
  readonly profile: ReturnType<typeof getResourceProfile>;
  readonly metrics: z.infer<typeof MetricsResponseSchema>;
  readonly atMs: number;
  readonly finalize: boolean;
}): Promise<CostRecordingState> {
  return input.store.mutate(input.input.workspaceId, (current) => {
    if (current === undefined) {
      return {
        workspaceId: input.input.workspaceId,
        operationKey:
          input.input.operationKey ?? stableRecoveryOperationKey(input.input.workspaceId),
        lastSampleAtMs: input.atMs,
        lastCpuMicros: totalCpuMicros(input.metrics),
        cpuSeconds: 0,
        memoryGibSeconds: 0,
        cpuSecondUsd: input.input.pricing.cpuSecondUsd,
        memoryGibSecondUsd: input.input.pricing.memoryGibSecondUsd,
        creditsPerUsd: input.input.pricing.creditsPerUsd,
        finalizedAtMs: input.finalize ? input.atMs : null,
        cpuDeliveredAtMs: null,
        memoryDeliveredAtMs: null,
      };
    }
    assertOperationKey(input.input.operationKey, current.operationKey);
    if (current.finalizedAtMs !== null) return current;
    const durationSeconds = Math.max(0, input.atMs - current.lastSampleAtMs) / 1000;
    const cpuMicros = totalCpuMicros(input.metrics);
    const observedCpuSeconds = Math.max(0, cpuMicros - current.lastCpuMicros) / 1_000_000;
    const observedMemoryGib = input.metrics.memory.rssBytes / BYTES_PER_GIBIBYTE;
    return {
      ...current,
      lastSampleAtMs: input.atMs,
      lastCpuMicros: cpuMicros,
      cpuSeconds:
        current.cpuSeconds +
        Math.max(input.profile.cpu.requested * durationSeconds, observedCpuSeconds),
      memoryGibSeconds:
        current.memoryGibSeconds +
        Math.max(input.profile.memoryGib.requested, observedMemoryGib) * durationSeconds,
      finalizedAtMs: input.finalize ? input.atMs : null,
    };
  });
}

async function finalizeWithRequestedUsage(input: {
  readonly store: CostRecordingStateStore;
  readonly input: z.infer<typeof StartCostRecordingSchema>;
  readonly profile: ReturnType<typeof getResourceProfile>;
  readonly atMs: number;
}): Promise<CostRecordingState> {
  return input.store.mutate(input.input.workspaceId, (current) => {
    if (current === undefined) throw new Error('cost recording state was not initialized');
    assertOperationKey(input.input.operationKey, current.operationKey);
    if (current.finalizedAtMs !== null) return current;
    const durationSeconds = Math.max(0, input.atMs - current.lastSampleAtMs) / 1000;
    return {
      ...current,
      lastSampleAtMs: input.atMs,
      cpuSeconds: current.cpuSeconds + input.profile.cpu.requested * durationSeconds,
      memoryGibSeconds:
        current.memoryGibSeconds + input.profile.memoryGib.requested * durationSeconds,
      finalizedAtMs: input.atMs,
    };
  });
}

function assertOperationKey(provided: string | undefined, persisted: string): void {
  if (provided !== undefined && provided !== persisted) {
    throw new Error('cost recording operation identity conflicts with durable state');
  }
}

function stableRecoveryOperationKey(workspaceId: string): string {
  return `op_${createHash('sha256').update(`legacy-workspace-usage:${workspaceId}`).digest('hex')}`;
}

function emptyMetrics(atMs: number): z.infer<typeof MetricsResponseSchema> {
  return MetricsResponseSchema.parse({
    at: new Date(atMs).toISOString(),
    activeChildren: 0,
    cpu: { userMicros: 0, systemMicros: 0 },
    memory: {
      rssBytes: 0,
      heapTotalBytes: 0,
      heapUsedBytes: 0,
      externalBytes: 0,
      arrayBuffersBytes: 0,
    },
  });
}

function totalCpuMicros(metrics: z.infer<typeof MetricsResponseSchema>): number {
  return metrics.cpu.userMicros + metrics.cpu.systemMicros;
}

function makeLedgerRow(input: {
  input: z.infer<typeof StartCostRecordingSchema>;
  state: CostRecordingState;
  operationHash: string;
  category: z.infer<typeof UsageCategorySchema>;
  unit: 'cpu_second' | 'gib_second';
  quantity: number;
  rateUsd: number;
  occurredAt: string;
}): UsageLedgerRow {
  const costUsd = input.quantity * input.rateUsd;
  return UsageLedgerRowSchema.parse({
    id: `usage_${input.operationHash}_${input.category}`,
    organizationId: input.input.organizationId,
    projectId: input.input.projectId,
    runId: input.input.runId,
    taskId: input.input.taskId,
    category: input.category,
    provider: 'modal',
    quantity: formatQuantity(input.quantity),
    unit: input.unit,
    costUsd: costUsd.toFixed(6),
    creditsCharged: (costUsd * input.state.creditsPerUsd).toFixed(4),
    occurredAt: input.occurredAt,
  });
}

function formatQuantity(value: number): string {
  return value.toFixed(6).replace(/(?:\.0+|(?<fraction>\.\d+?)0+)$/u, '$<fraction>');
}
