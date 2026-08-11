import { createHash } from 'node:crypto';

import { idSchema } from '@zapp/contracts';
import { usageLedger, usageOutbox, USAGE_CATEGORIES, type Database } from '@zapp/db';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { FlexpriceUsageEventSchema, type FlexpriceUsageEvent } from './flexprice.js';
import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';

const SignedDecimalSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u)
  .transform((value) => fixedDecimal(value, 6));
const SignedMoneySchema = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{6}$/u);
const SignedCreditsSchema = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{4}$/u);

export const UsageEntrySchema = z
  .object({
    id: z.string().regex(/^usage_[A-Za-z0-9_-]+$/u),
    organizationId: idSchema('org'),
    projectId: idSchema('proj').nullable(),
    runId: idSchema('run').nullable(),
    taskId: idSchema('task').nullable(),
    category: z.enum(USAGE_CATEGORIES),
    provider: z.string().trim().min(1).nullable(),
    quantity: SignedDecimalSchema,
    unit: z.string().trim().min(1),
    costUsd: SignedMoneySchema,
    creditsCharged: SignedCreditsSchema,
    correctionOf: z
      .string()
      .regex(/^usage_[A-Za-z0-9_-]+$/u)
      .optional(),
    occurredAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.quantity.startsWith('-') && entry.correctionOf === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'negative usage requires correctionOf metadata',
        path: ['correctionOf'],
      });
    }
  });

export type UsageEntry = z.infer<typeof UsageEntrySchema>;

export const UsageWindowSchema = z
  .object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((window) => new Date(window.start) < new Date(window.end), {
    message: 'end must be later than start',
    path: ['end'],
  });

export interface UsageSummaryRow {
  readonly category: UsageEntry['category'];
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly quantity: string;
  readonly costUsd: string;
  readonly creditsCharged: string;
}

interface StoredUsage {
  readonly entry: UsageEntry;
  readonly event: FlexpriceUsageEvent;
  readonly created: boolean;
}

export interface UsageStore {
  record(entry: UsageEntry, event: FlexpriceUsageEvent): Promise<StoredUsage>;
  summary(
    organizationId: string,
    window: { readonly start: Date; readonly end: Date },
  ): Promise<readonly UsageSummaryRow[]>;
}

export interface UsageService {
  recordUsage(entry: unknown): Promise<{ readonly ledgerRowId: string; readonly eventId: string }>;
  getUsageSummary(
    organizationId: string,
    window: z.input<typeof UsageWindowSchema>,
  ): Promise<readonly UsageSummaryRow[]>;
}

export function createUsageService(options: { readonly store: UsageStore }): UsageService {
  return {
    async recordUsage(rawEntry) {
      const entry = UsageEntrySchema.parse(rawEntry);
      const event = FlexpriceUsageEventSchema.parse({
        event_name: entry.category,
        external_customer_id: entry.organizationId,
        event_id: entry.id,
        timestamp: entry.occurredAt,
        properties: {
          project_id: entry.projectId,
          run_id: entry.runId,
          task_id: entry.taskId,
          quantity: Number(entry.quantity),
          unit: entry.unit,
          provider: entry.provider,
          ...(entry.correctionOf === undefined ? {} : { correction_of: entry.correctionOf }),
        },
      });
      const stored = await options.store.record(entry, event);
      if (!sameUsage(stored.entry, entry)) {
        throw new UsageIdentityConflictError(entry.id, 'ledger row');
      }
      if (!sameEvent(stored.event, event)) {
        throw new UsageIdentityConflictError(entry.id, 'outbox event');
      }
      return { ledgerRowId: stored.entry.id, eventId: stored.event.event_id };
    },
    async getUsageSummary(rawOrganizationId, rawWindow) {
      const organizationId = idSchema('org').parse(rawOrganizationId);
      const window = UsageWindowSchema.parse(rawWindow);
      return await options.store.summary(organizationId, {
        start: new Date(window.start),
        end: new Date(window.end),
      });
    },
  };
}

export class UsageIdentityConflictError extends Error {
  public constructor(id: string, record = 'ledger row') {
    super(`usage identity ${id} conflicts with an existing ${record}`);
    this.name = 'UsageIdentityConflictError';
  }
}

export const USAGE_INGEST_AUDIENCE = 'control-api:usage.ingest' as const;

const RecordUsageResponseSchema = z
  .object({ ledgerRowId: z.string().min(1), eventId: z.string().min(1) })
  .strict();

export function registerInternalUsageRoutes(app: AppInstance, service: UsageService): void {
  app.post(
    '/internal/usage',
    {
      onRequest: app.requireService({
        audience: USAGE_INGEST_AUDIENCE,
        callers: [
          'orchestrator-worker',
          'sandbox-service',
          'verification-service',
          'release-service',
          'git-service',
        ],
        singleUse: false,
      }),
      schema: {
        body: UsageEntrySchema,
        response: { 201: RecordUsageResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        return await reply.code(201).send(await service.recordUsage(request.body));
      } catch (error) {
        if (error instanceof UsageIdentityConflictError) {
          throw new ApiError(
            'usage_identity_conflict',
            409,
            'That usage identity conflicts with an existing ledger row.',
          );
        }
        throw error;
      }
    },
  );
}

export function createDbUsageStore(database: Database): UsageStore {
  return {
    async record(entry, event) {
      return await database.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(usageLedger)
          .values({
            id: entry.id,
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
            occurredAt: new Date(entry.occurredAt),
          })
          .onConflictDoNothing({ target: usageLedger.id })
          .returning();

        if (inserted !== undefined) {
          await tx.insert(usageOutbox).values({
            id: outboxId(entry.id),
            organizationId: entry.organizationId,
            ledgerRowId: entry.id,
            eventJson: event,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: new Date(),
            publishedAt: null,
          });
          return { entry, event, created: true };
        }

        const [existing] = await tx
          .select({ row: usageLedger, event: usageOutbox.eventJson })
          .from(usageLedger)
          .innerJoin(usageOutbox, eq(usageOutbox.ledgerRowId, usageLedger.id))
          .where(eq(usageLedger.id, entry.id))
          .limit(1);
        if (existing === undefined) {
          throw new Error(`usage ledger row ${entry.id} exists without its transactional outbox`);
        }
        return {
          entry: dbEntry(existing.row, FlexpriceUsageEventSchema.parse(existing.event)),
          event: FlexpriceUsageEventSchema.parse(existing.event),
          created: false,
        };
      });
    },
    async summary(organizationId, window) {
      const rows = await database
        .select({
          category: usageLedger.category,
          projectId: usageLedger.projectId,
          runId: usageLedger.runId,
          quantity: sql<string>`sum(${usageLedger.quantity})`,
          costUsd: sql<string>`sum(${usageLedger.costUsd})`,
          creditsCharged: sql<string>`sum(${usageLedger.creditsCharged})`,
        })
        .from(usageLedger)
        .where(
          and(
            eq(usageLedger.organizationId, organizationId),
            gte(usageLedger.occurredAt, window.start),
            lt(usageLedger.occurredAt, window.end),
          ),
        )
        .groupBy(usageLedger.category, usageLedger.projectId, usageLedger.runId)
        .orderBy(asc(usageLedger.category), asc(usageLedger.projectId), asc(usageLedger.runId));
      return rows.map((row) => ({
        ...row,
        quantity: fixedDecimal(row.quantity, 6),
        costUsd: fixedDecimal(row.costUsd, 6),
        creditsCharged: fixedDecimal(row.creditsCharged, 4),
      }));
    },
  };
}

function dbEntry(row: typeof usageLedger.$inferSelect, event: FlexpriceUsageEvent): UsageEntry {
  return UsageEntrySchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    runId: row.runId,
    taskId: row.taskId,
    category: row.category,
    provider: row.provider,
    quantity: row.quantity,
    unit: row.unit,
    costUsd: fixedDecimal(row.costUsd, 6),
    creditsCharged: fixedDecimal(row.creditsCharged, 4),
    ...(event.properties.correction_of === undefined
      ? {}
      : { correctionOf: event.properties.correction_of }),
    occurredAt: row.occurredAt.toISOString(),
  });
}

function outboxId(ledgerRowId: string): string {
  return `outbox_${createHash('sha256').update(ledgerRowId).digest('hex')}`;
}

function sameUsage(left: UsageEntry, right: UsageEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameEvent(left: FlexpriceUsageEvent, right: FlexpriceUsageEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fixedDecimal(value: string, scale: number): string {
  const match = /^(?<sign>-?)(?<whole>\d+)(?:\.(?<fraction>\d+))?$/u.exec(value);
  if (match?.groups === undefined) throw new Error('database returned an invalid usage decimal');
  const whole = match.groups['whole'] ?? '0';
  const fraction = match.groups['fraction'] ?? '';
  if (fraction.length > scale) {
    throw new Error(`usage decimal has more than ${String(scale)} places`);
  }
  const digits = `${whole}${fraction}`;
  const isZero = /^0+$/u.test(digits);
  const sign = match.groups['sign'] === '-' && !isZero ? '-' : '';
  return `${sign}${whole}.${fraction.padEnd(scale, '0')}`;
}
