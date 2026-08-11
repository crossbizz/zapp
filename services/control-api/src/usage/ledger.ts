import { createHash } from 'node:crypto';

import { idSchema } from '@zapp/contracts';
import { USAGE_CATEGORIES, usageLedger, usageOutbox, type Database } from '@zapp/db';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { FlexpriceUsageEventSchema, type FlexpriceUsageEvent } from './outbox.js';

const DecimalSchema = z.string().regex(/^-?\d+(?:\.\d{1,6})?$/u);
const CreditDecimalSchema = z.string().regex(/^-?\d+(?:\.\d{1,4})?$/u);

const UsageMetadataSchema = z
  .object({ correction_of: z.string().trim().min(1).optional() })
  .strict();

export const UsageEntrySchema = z
  .object({
    operationKey: z.string().trim().min(1).max(200),
    organizationId: idSchema('org'),
    projectId: idSchema('proj').nullable(),
    runId: idSchema('run').nullable(),
    taskId: idSchema('task').nullable(),
    category: z.enum(USAGE_CATEGORIES),
    provider: z.string().trim().min(1).max(200).nullable(),
    quantity: DecimalSchema,
    unit: z.string().trim().min(1).max(100),
    costUsd: DecimalSchema,
    creditsCharged: CreditDecimalSchema,
    occurredAt: z.string().datetime({ offset: true }),
    metadata: UsageMetadataSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    const quantity = decimalUnits(entry.quantity, 6);
    if (quantity === 0n) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'quantity must not be zero' });
    }
    if (quantity < 0n && entry.metadata.correction_of === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'negative entries require correction_of metadata',
        path: ['metadata'],
      });
    }
    if (quantity > 0n && entry.metadata.correction_of !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'correction_of metadata requires a negative quantity',
        path: ['metadata', 'correction_of'],
      });
    }
  });

export type UsageEntry = z.infer<typeof UsageEntrySchema>;

const UsageWindowSchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(({ from, to }) => new Date(from).getTime() < new Date(to).getTime(), {
    message: 'window end must be after its start',
    path: ['to'],
  });

export type UsageWindow = z.infer<typeof UsageWindowSchema>;

export interface UsageSummary {
  readonly byCategory: readonly {
    readonly category: (typeof USAGE_CATEGORIES)[number];
    readonly quantity: string;
  }[];
  readonly byProject: readonly { readonly projectId: string | null; readonly quantity: string }[];
  readonly byRun: readonly { readonly runId: string | null; readonly quantity: string }[];
}

export interface RecordedUsage {
  readonly ledgerRowId: string;
  readonly row: typeof usageLedger.$inferSelect;
  readonly event: FlexpriceUsageEvent;
}

export class UsageOperationConflictError extends Error {
  public constructor() {
    super('usage operation identity conflicts with its immutable ledger row');
    this.name = 'UsageOperationConflictError';
  }
}

export interface UsageLedgerRepository {
  recordUsage(entry: UsageEntry): Promise<RecordedUsage>;
  getUsageSummary(organizationId: string, window: UsageWindow): Promise<UsageSummary>;
}

export function createUsageLedgerRepository(options: {
  readonly database: Database;
  readonly now?: () => Date;
}): UsageLedgerRepository {
  const now = options.now ?? ((): Date => new Date());

  return {
    async recordUsage(rawEntry) {
      const entry = UsageEntrySchema.parse(rawEntry);
      return await options.database.transaction(async (tx) => {
        const ledgerRowId = deterministicId('usage', entry.organizationId, entry.operationKey);
        const event = flexpriceEvent(entry, ledgerRowId);
        const instant = now();
        const [inserted] = await tx
          .insert(usageLedger)
          .values({
            id: ledgerRowId,
            operationKey: entry.operationKey,
            organizationId: entry.organizationId,
            projectId: entry.projectId,
            runId: entry.runId,
            taskId: entry.taskId,
            category: entry.category,
            provider: entry.provider,
            quantity: entry.quantity,
            unit: entry.unit,
            costUsd: entry.costUsd,
            creditsCharged: entry.creditsCharged,
            metadata: entry.metadata,
            occurredAt: new Date(entry.occurredAt),
          })
          .onConflictDoNothing()
          .returning();

        if (inserted !== undefined) {
          await tx.insert(usageOutbox).values({
            id: deterministicId('outbox', ledgerRowId),
            organizationId: entry.organizationId,
            ledgerRowId,
            eventJson: event,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: instant,
            createdAt: instant,
            publishedAt: null,
          });
          return { ledgerRowId, row: inserted, event };
        }

        const [existing] = await tx
          .select()
          .from(usageLedger)
          .where(
            and(
              eq(usageLedger.organizationId, entry.organizationId),
              eq(usageLedger.operationKey, entry.operationKey),
            ),
          )
          .limit(1);
        if (existing === undefined || !matchesEntry(existing, entry)) {
          throw new UsageOperationConflictError();
        }
        const [outbox] = await tx
          .select({ eventJson: usageOutbox.eventJson })
          .from(usageOutbox)
          .where(eq(usageOutbox.ledgerRowId, existing.id))
          .limit(1);
        if (outbox === undefined) throw new Error('immutable usage ledger row has no outbox event');
        return {
          ledgerRowId: existing.id,
          row: existing,
          event: FlexpriceUsageEventSchema.parse(outbox.eventJson),
        };
      });
    },

    async getUsageSummary(rawOrganizationId, rawWindow) {
      const organizationId = idSchema('org').parse(rawOrganizationId);
      const window = UsageWindowSchema.parse(rawWindow);
      const where = and(
        eq(usageLedger.organizationId, organizationId),
        gte(usageLedger.occurredAt, new Date(window.from)),
        lt(usageLedger.occurredAt, new Date(window.to)),
      );
      const [byCategory, byProject, byRun] = await Promise.all([
        options.database
          .select({
            category: usageLedger.category,
            quantity: sql<string>`sum(${usageLedger.quantity})::text`,
          })
          .from(usageLedger)
          .where(where)
          .groupBy(usageLedger.category)
          .orderBy(usageLedger.category),
        options.database
          .select({
            projectId: usageLedger.projectId,
            quantity: sql<string>`sum(${usageLedger.quantity})::text`,
          })
          .from(usageLedger)
          .where(where)
          .groupBy(usageLedger.projectId)
          .orderBy(usageLedger.projectId),
        options.database
          .select({
            runId: usageLedger.runId,
            quantity: sql<string>`sum(${usageLedger.quantity})::text`,
          })
          .from(usageLedger)
          .where(where)
          .groupBy(usageLedger.runId)
          .orderBy(usageLedger.runId),
      ]);
      return { byCategory, byProject, byRun };
    },
  };
}

function flexpriceEvent(entry: UsageEntry, ledgerRowId: string): FlexpriceUsageEvent {
  return FlexpriceUsageEventSchema.parse({
    event_name: entry.category,
    external_customer_id: entry.organizationId,
    event_id: ledgerRowId,
    timestamp: entry.occurredAt,
    properties: {
      project_id: entry.projectId,
      run_id: entry.runId,
      task_id: entry.taskId,
      quantity: Number(entry.quantity),
      unit: entry.unit,
      provider: entry.provider,
    },
  });
}

function matchesEntry(row: typeof usageLedger.$inferSelect, entry: UsageEntry): boolean {
  return (
    row.projectId === entry.projectId &&
    row.runId === entry.runId &&
    row.taskId === entry.taskId &&
    row.category === entry.category &&
    row.provider === entry.provider &&
    row.quantity === entry.quantity &&
    row.unit === entry.unit &&
    row.costUsd === entry.costUsd &&
    row.creditsCharged === entry.creditsCharged &&
    row.occurredAt.toISOString() === new Date(entry.occurredAt).toISOString() &&
    JSON.stringify(row.metadata) === JSON.stringify(entry.metadata)
  );
}

function deterministicId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${prefix}_${digest}`;
}

function decimalUnits(value: string, scale: number): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  return (negative ? -1n : 1n) * BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
}
