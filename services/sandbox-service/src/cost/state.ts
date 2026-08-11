import { workspaces, type Database } from '@zapp/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);

export const CostRecordingStateSchema = z
  .object({
    workspaceId: z.string().min(1),
    operationKey: OperationKeySchema,
    lastSampleAtMs: z.number().int().nonnegative(),
    lastCpuMicros: z.number().finite().nonnegative(),
    cpuSeconds: z.number().finite().nonnegative(),
    memoryGibSeconds: z.number().finite().nonnegative(),
    cpuSecondUsd: z.number().finite().nonnegative(),
    memoryGibSecondUsd: z.number().finite().nonnegative(),
    creditsPerUsd: z.number().finite().nonnegative(),
    finalizedAtMs: z.number().int().nonnegative().nullable(),
    cpuDeliveredAtMs: z.number().int().nonnegative().nullable(),
    memoryDeliveredAtMs: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type CostRecordingState = z.infer<typeof CostRecordingStateSchema>;

export interface CostRecordingStateStore {
  read(workspaceId: string): Promise<CostRecordingState | undefined>;
  mutate(
    workspaceId: string,
    transform: (current: CostRecordingState | undefined) => CostRecordingState,
  ): Promise<CostRecordingState>;
}

export function createMemoryCostRecordingStateStore(): CostRecordingStateStore {
  const states = new Map<string, CostRecordingState>();
  let serialized = Promise.resolve();
  return {
    async read(workspaceId) {
      await serialized;
      return states.get(workspaceId);
    },
    async mutate(workspaceId, transform) {
      let result: CostRecordingState | undefined;
      serialized = serialized.then(() => {
        const next = canonicalState(transform(states.get(workspaceId)));
        assertStableState(workspaceId, states.get(workspaceId), next);
        states.set(workspaceId, next);
        result = next;
      });
      await serialized;
      if (result === undefined) throw new Error('cost recording state mutation did not complete');
      return result;
    },
  };
}

export function createDatabaseCostRecordingStateStore(
  database: Database,
): CostRecordingStateStore {
  return {
    async read(workspaceId) {
      const [row] = await database
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (row === undefined) throw new Error('workspace cost recording row was not found');
      return stateFromRow(row);
    },
    async mutate(workspaceId, transform) {
      return await database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1)
          .for('update');
        if (row === undefined) throw new Error('workspace cost recording row was not found');
        const current = stateFromRow(row);
        const next = canonicalState(transform(current));
        assertStableState(workspaceId, current, next);
        const [updated] = await tx
          .update(workspaces)
          .set({
            usageOperationKey: next.operationKey,
            usageLastSampleAt: new Date(next.lastSampleAtMs),
            usageLastCpuMicros: next.lastCpuMicros,
            usageCpuSeconds: formatDecimal(next.cpuSeconds),
            usageMemoryGibSeconds: formatDecimal(next.memoryGibSeconds),
            usageCpuSecondUsd: formatDecimal(next.cpuSecondUsd, 12),
            usageMemoryGibSecondUsd: formatDecimal(next.memoryGibSecondUsd, 12),
            usageCreditsPerUsd: formatDecimal(next.creditsPerUsd),
            usageFinalizedAt:
              next.finalizedAtMs === null ? null : new Date(next.finalizedAtMs),
            usageCpuDeliveredAt:
              next.cpuDeliveredAtMs === null ? null : new Date(next.cpuDeliveredAtMs),
            usageMemoryDeliveredAt:
              next.memoryDeliveredAtMs === null ? null : new Date(next.memoryDeliveredAtMs),
          })
          .where(eq(workspaces.id, workspaceId))
          .returning({ id: workspaces.id });
        if (updated === undefined) throw new Error('workspace cost recording state was not saved');
        return next;
      });
    },
  };
}

function stateFromRow(row: typeof workspaces.$inferSelect): CostRecordingState | undefined {
  if (row.usageOperationKey === null) return undefined;
  if (
    row.usageLastSampleAt === null ||
    row.usageLastCpuMicros === null ||
    row.usageCpuSeconds === null ||
    row.usageMemoryGibSeconds === null ||
    row.usageCpuSecondUsd === null ||
    row.usageMemoryGibSecondUsd === null ||
    row.usageCreditsPerUsd === null
  ) {
    throw new Error('workspace cost recording state is incomplete');
  }
  return CostRecordingStateSchema.parse({
    workspaceId: row.id,
    operationKey: row.usageOperationKey,
    lastSampleAtMs: row.usageLastSampleAt.getTime(),
    lastCpuMicros: row.usageLastCpuMicros,
    cpuSeconds: Number(row.usageCpuSeconds),
    memoryGibSeconds: Number(row.usageMemoryGibSeconds),
    cpuSecondUsd: Number(row.usageCpuSecondUsd),
    memoryGibSecondUsd: Number(row.usageMemoryGibSecondUsd),
    creditsPerUsd: Number(row.usageCreditsPerUsd),
    finalizedAtMs: row.usageFinalizedAt?.getTime() ?? null,
    cpuDeliveredAtMs: row.usageCpuDeliveredAt?.getTime() ?? null,
    memoryDeliveredAtMs: row.usageMemoryDeliveredAt?.getTime() ?? null,
  });
}

function assertStableState(
  workspaceId: string,
  current: CostRecordingState | undefined,
  next: CostRecordingState,
): void {
  if (next.workspaceId !== workspaceId) {
    throw new Error('cost recording state belongs to another workspace');
  }
  if (current !== undefined && current.operationKey !== next.operationKey) {
    throw new Error('cost recording operation identity cannot change');
  }
  if (current?.finalizedAtMs !== null && current?.finalizedAtMs !== undefined) {
    const { cpuDeliveredAtMs: currentCpu, memoryDeliveredAtMs: currentMemory, ...currentTotals } =
      current;
    const { cpuDeliveredAtMs: nextCpu, memoryDeliveredAtMs: nextMemory, ...nextTotals } = next;
    if (JSON.stringify(currentTotals) !== JSON.stringify(nextTotals)) {
      throw new Error('finalized cost recording state is immutable');
    }
    if (
      (currentCpu !== null && currentCpu !== nextCpu) ||
      (currentMemory !== null && currentMemory !== nextMemory) ||
      (nextCpu === null && nextMemory === null && (currentCpu !== null || currentMemory !== null))
    ) {
      throw new Error('cost recording delivery state cannot move backwards');
    }
  }
  if (
    next.finalizedAtMs === null &&
    (next.cpuDeliveredAtMs !== null || next.memoryDeliveredAtMs !== null)
  ) {
    throw new Error('cost recording cannot be delivered before finalization');
  }
}

function formatDecimal(value: number, scale = 6): string {
  return value.toFixed(scale);
}

function canonicalState(value: CostRecordingState): CostRecordingState {
  const parsed = CostRecordingStateSchema.parse(value);
  return CostRecordingStateSchema.parse({
    ...parsed,
    cpuSeconds: Number(formatDecimal(parsed.cpuSeconds)),
    memoryGibSeconds: Number(formatDecimal(parsed.memoryGibSeconds)),
    cpuSecondUsd: Number(formatDecimal(parsed.cpuSecondUsd, 12)),
    memoryGibSecondUsd: Number(formatDecimal(parsed.memoryGibSecondUsd, 12)),
    creditsPerUsd: Number(formatDecimal(parsed.creditsPerUsd)),
  });
}
