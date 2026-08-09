import { idSchema } from '@zapp/contracts';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import {
  getResourceProfile,
  ResourceProfileNameSchema,
} from '../provider/profiles.js';

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
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    runId: idSchema('run'),
    taskId: idSchema('task'),
    operationKey: OperationKeySchema,
    profile: ResourceProfileNameSchema,
    pricing: SandboxPricingSchema,
  })
  .strict();

const UsageCategorySchema = z.enum([
  'sandbox_cpu_seconds',
  'sandbox_mem_gib_seconds',
]);

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
  scheduler: {
    setInterval(callback: () => Promise<void>, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

export interface ActiveCostRecording {
  terminate(): Promise<readonly [UsageLedgerRow, UsageLedgerRow]>;
}

export async function loadSandboxPricing(filePath: string): Promise<SandboxPricing> {
  const raw = await readFile(filePath, 'utf8');
  return PricingFileSchema.parse(JSON.parse(raw) as unknown).sandbox;
}

export function createCostRecorder(dependencies: CostRecorderDependencies) {
  return {
    async start(inputValue: unknown): Promise<ActiveCostRecording> {
      const input = StartCostRecordingSchema.parse(inputValue);
      const profile = getResourceProfile(input.profile);
      const baseline = MetricsResponseSchema.parse(
        await dependencies.metrics.sample(input.workspaceId),
      );

      let previousAtMs = dependencies.nowMs();
      let previousCpuMicros = totalCpuMicros(baseline);
      let cpuSeconds = 0;
      let memoryGibSeconds = 0;
      let active = true;
      let sampling = Promise.resolve();
      let finalized: Promise<readonly [UsageLedgerRow, UsageLedgerRow]> | undefined;
      let writeAttempt: Promise<readonly [UsageLedgerRow, UsageLedgerRow]> | undefined;

      const sample = async () => {
        const current = MetricsResponseSchema.parse(
          await dependencies.metrics.sample(input.workspaceId),
        );
        const currentAtMs = dependencies.nowMs();
        const durationSeconds = Math.max(0, currentAtMs - previousAtMs) / 1000;
        const currentCpuMicros = totalCpuMicros(current);
        const observedCpuSeconds =
          Math.max(0, currentCpuMicros - previousCpuMicros) / 1_000_000;
        const requestedCpuSeconds = profile.cpu.requested * durationSeconds;
        const observedMemoryGib = current.memory.rssBytes / BYTES_PER_GIBIBYTE;

        cpuSeconds += Math.max(requestedCpuSeconds, observedCpuSeconds);
        memoryGibSeconds +=
          Math.max(profile.memoryGib.requested, observedMemoryGib) * durationSeconds;
        previousAtMs = currentAtMs;
        previousCpuMicros = currentCpuMicros;
      };

      const finishWithRequestedUsage = () => {
        const currentAtMs = dependencies.nowMs();
        const durationSeconds = Math.max(0, currentAtMs - previousAtMs) / 1000;
        cpuSeconds += profile.cpu.requested * durationSeconds;
        memoryGibSeconds += profile.memoryGib.requested * durationSeconds;
        previousAtMs = currentAtMs;
      };

      const intervalHandle = dependencies.scheduler.setInterval(async () => {
        if (!active) return;
        sampling = sampling.then(async () => {
          try {
            await sample();
          } catch {
            // Keep the prior successful baseline. The next successful sample
            // accounts for the whole elapsed billing window.
          }
        });
        await sampling;
      }, SAMPLE_INTERVAL_MS);

      return {
        terminate() {
          finalized ??= (async () => {
            active = false;
            dependencies.scheduler.clearInterval(intervalHandle);
            await sampling;
            try {
              await sample();
            } catch {
              finishWithRequestedUsage();
            }

            const occurredAt = new Date(dependencies.nowMs()).toISOString();
            const operationHash = input.operationKey.slice('op_'.length);
            const cpuRow = makeLedgerRow({
              input,
              operationHash,
              category: 'sandbox_cpu_seconds',
              unit: 'cpu_second',
              quantity: cpuSeconds,
              rateUsd: input.pricing.cpuSecondUsd,
              occurredAt,
            });
            const memoryRow = makeLedgerRow({
              input,
              operationHash,
              category: 'sandbox_mem_gib_seconds',
              unit: 'gib_second',
              quantity: memoryGibSeconds,
              rateUsd: input.pricing.memoryGibSecondUsd,
              occurredAt,
            });
            return [cpuRow, memoryRow] as const;
          })();
          if (writeAttempt === undefined) {
            const attempt = finalized.then(async (rows) => {
              await dependencies.ledger.appendIfAbsent(rows[0]);
              await dependencies.ledger.appendIfAbsent(rows[1]);
              return rows;
            });
            writeAttempt = attempt;
            void attempt.catch(() => {
              if (writeAttempt === attempt) writeAttempt = undefined;
            });
          }
          return writeAttempt;
        },
      };
    },
  };
}

function totalCpuMicros(metrics: z.infer<typeof MetricsResponseSchema>): number {
  return metrics.cpu.userMicros + metrics.cpu.systemMicros;
}

function makeLedgerRow(input: {
  input: z.infer<typeof StartCostRecordingSchema>;
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
    creditsCharged: (costUsd * input.input.pricing.creditsPerUsd).toFixed(4),
    occurredAt: input.occurredAt,
  });
}

function formatQuantity(value: number): string {
  return value.toFixed(6).replace(/(?:\.0+|(?<fraction>\.\d+?)0+)$/u, '$<fraction>');
}
