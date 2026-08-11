import { createHash } from 'node:crypto';

import { CreditStateSchema, idSchema, type CreditState } from '@zapp/contracts';
import {
  USAGE_CATEGORIES,
  accountingLeaderLeases,
  agentRuns,
  runCreditAccounts,
  runCreditCeilingAdjustments,
  usageLedger,
  usageOutbox,
  usageReconciliationCorrections,
  type Database,
  type UsageCategory,
} from '@zapp/db';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { RedisCommands } from '../redis/client.js';
import {
  FlexpriceUsageEventSchema,
  type FlexpriceIngestPort,
} from './outbox.js';

export interface CreditMirror {
  write(runId: string, credits: CreditState): Promise<void>;
}

export function createRedisCreditMirror(redis: RedisCommands, ttlMs = 120_000): CreditMirror {
  return {
    async write(runId, credits) {
      await redis.set(
        `run:${runId}:credits`,
        JSON.stringify(CreditStateSchema.parse(credits)),
        ttlMs,
      );
    },
  };
}

export interface AccountingReconcilerOptions {
  readonly database: Database;
  readonly mirror: CreditMirror;
  readonly owner: string;
  readonly now?: () => Date;
  readonly leaseMs?: number;
}

export function createAccountingReconciler(options: AccountingReconcilerOptions) {
  const now = options.now ?? ((): Date => new Date());
  const leaseMs = options.leaseMs ?? 60_000;

  return {
    async runOnce(rawLimit: number): Promise<{ acquired: boolean; mirrored: number }> {
      const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
      return await options.database.transaction(async (tx) => {
        const instant = now();
        const [lease] = await tx
          .insert(accountingLeaderLeases)
          .values({
            name: 'run-credit-reconciliation',
            owner: options.owner,
            expiresAt: new Date(instant.getTime() + leaseMs),
          })
          .onConflictDoUpdate({
            target: accountingLeaderLeases.name,
            set: {
              owner: options.owner,
              expiresAt: new Date(instant.getTime() + leaseMs),
            },
            setWhere: sql`${accountingLeaderLeases.expiresAt} <= ${instant.toISOString()}::timestamptz or ${accountingLeaderLeases.owner} = ${options.owner}`,
          })
          .returning({
            owner: accountingLeaderLeases.owner,
            cursorRunId: accountingLeaderLeases.cursorRunId,
          });
        if (lease?.owner !== options.owner) return { acquired: false, mirrored: 0 };

        const activeScope = and(
          eq(agentRuns.organizationId, runCreditAccounts.organizationId),
          inArray(agentRuns.status, ['queued', 'running', 'paused']),
        );
        const accountsAfterCursor = await tx
          .select({
            runId: runCreditAccounts.runId,
            used: runCreditAccounts.usedCredits,
            reserved: runCreditAccounts.reservedCredits,
            baseCeiling: runCreditAccounts.baseCeiling,
            version: runCreditAccounts.version,
          })
          .from(runCreditAccounts)
          .innerJoin(agentRuns, eq(agentRuns.id, runCreditAccounts.runId))
          .where(
            and(
              activeScope,
              lease.cursorRunId === null
                ? undefined
                : gt(runCreditAccounts.runId, lease.cursorRunId),
            ),
          )
          .orderBy(asc(runCreditAccounts.runId))
          .limit(limit);
        const accounts = [...accountsAfterCursor];
        if (lease.cursorRunId !== null && accounts.length < limit) {
          const wrapped = await tx
            .select({
              runId: runCreditAccounts.runId,
              used: runCreditAccounts.usedCredits,
              reserved: runCreditAccounts.reservedCredits,
              baseCeiling: runCreditAccounts.baseCeiling,
              version: runCreditAccounts.version,
            })
            .from(runCreditAccounts)
            .innerJoin(agentRuns, eq(agentRuns.id, runCreditAccounts.runId))
            .where(and(activeScope, lte(runCreditAccounts.runId, lease.cursorRunId)))
            .orderBy(asc(runCreditAccounts.runId))
            .limit(limit - accounts.length);
          accounts.push(...wrapped);
        }

        for (const account of accounts) {
          const [adjustment] = await tx
            .select({ absoluteCeiling: runCreditCeilingAdjustments.absoluteCeiling })
            .from(runCreditCeilingAdjustments)
            .where(eq(runCreditCeilingAdjustments.runId, account.runId))
            .orderBy(
              desc(runCreditCeilingAdjustments.createdAt),
              desc(runCreditCeilingAdjustments.id),
            )
            .limit(1);
          await options.mirror.write(account.runId, {
            used: normalize(account.used),
            reserved: normalize(account.reserved),
            ceiling: normalize(adjustment?.absoluteCeiling ?? account.baseCeiling),
            version: account.version,
          });
        }
        const lastAccount = accounts.at(-1);
        if (lastAccount !== undefined) {
          await tx
            .update(accountingLeaderLeases)
            .set({ cursorRunId: lastAccount.runId })
            .where(
              and(
                eq(accountingLeaderLeases.name, 'run-credit-reconciliation'),
                eq(accountingLeaderLeases.owner, options.owner),
              ),
            );
        }
        return { acquired: true, mirrored: accounts.length };
      });
    },
  };
}

interface AccountingReconciler {
  runOnce(limit: number): Promise<{ acquired: boolean; mirrored: number }>;
}

type ReconciliationTimerHandle = number | object;

interface ReconciliationTimers {
  setInterval(callback: () => void, delayMs: number): ReconciliationTimerHandle;
  clearInterval(handle: ReconciliationTimerHandle): void;
}

export interface AccountingReconcilerLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createAccountingReconcilerLifecycle(options: {
  readonly reconciler: AccountingReconciler;
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly onError?: (error: Error) => void;
  readonly timers?: ReconciliationTimers;
}): AccountingReconcilerLifecycle {
  const timers =
    options.timers ??
    ({
      setInterval: (callback, delayMs) => setInterval(callback, delayMs),
      clearInterval: (handle) => {
        clearInterval(handle as ReturnType<typeof setInterval>);
      },
    } satisfies ReconciliationTimers);
  let interval: ReconciliationTimerHandle | undefined;
  let active: Promise<void> | undefined;
  let closed = false;

  function poll(): void {
    if (closed || active !== undefined) return;
    active = options.reconciler
      .runOnce(options.batchSize)
      .then(() => undefined)
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        active = undefined;
      });
  }

  return {
    async start() {
      if (closed) throw new Error('accounting reconciliation lifecycle is closed');
      await options.reconciler.runOnce(options.batchSize);
      interval = timers.setInterval(poll, options.intervalMs);
    },
    async close() {
      closed = true;
      if (interval !== undefined) {
        timers.clearInterval(interval);
        interval = undefined;
      }
      await active;
    },
  };
}

function normalize(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(4, '0').slice(0, 4)}`;
}

const ReconciliationWindowSchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(({ from, to }) => Date.parse(from) < Date.parse(to), {
    message: 'reconciliation window end must follow its start',
    path: ['to'],
  });

const UsageReconciliationScopeSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj').nullable(),
    runId: idSchema('run').nullable(),
    taskId: idSchema('task').nullable().default(null),
  })
  .strict();

const UsageQuantitySchema = z.string().regex(/^-?\d+(?:\.\d{1,6})?$/u);

type ReconciliationWindow = z.infer<typeof ReconciliationWindowSchema>;
type UsageReconciliationScope = z.infer<typeof UsageReconciliationScopeSchema>;
type WindowedUsageReconciliationScope = UsageReconciliationScope & ReconciliationWindow;

export interface UsageReconciliationScopePort {
  list(window: ReconciliationWindow): Promise<unknown>;
}

export interface UsageReconciliationLedgerPort {
  readTotal(scope: WindowedUsageReconciliationScope, category: UsageCategory): Promise<unknown>;
}

export interface UsageRunCounterPort {
  readTotal(scope: WindowedUsageReconciliationScope, category: UsageCategory): Promise<unknown>;
  writeTotal(
    input: WindowedUsageReconciliationScope & {
      readonly category: UsageCategory;
      readonly quantity: string;
    },
  ): Promise<void>;
}

interface FlexpriceAggregateReadPort {
  readAggregates(scope: WindowedUsageReconciliationScope): Promise<unknown>;
}

export interface UsageCorrectionPort {
  correct(
    input: WindowedUsageReconciliationScope & {
      readonly category: UsageCategory;
      readonly targetQuantity: string;
      readonly deltaQuantity: string;
    },
  ): Promise<void>;
}

export function createDatabaseUsageCorrectionJournal(options: {
  readonly database: Database;
  readonly ingest: FlexpriceIngestPort;
  readonly now?: () => Date;
}): UsageCorrectionPort {
  const now = options.now ?? ((): Date => new Date());
  return {
    async correct(rawInput) {
      const input = z
        .object({
          organizationId: idSchema('org'),
          projectId: idSchema('proj').nullable(),
          runId: idSchema('run').nullable(),
          taskId: idSchema('task').nullable(),
          from: z.string().datetime({ offset: true }),
          to: z.string().datetime({ offset: true }),
          category: z.enum(USAGE_CATEGORIES),
          targetQuantity: UsageQuantitySchema,
          deltaQuantity: UsageQuantitySchema,
        })
        .strict()
        .parse(rawInput);
      const operationKey = `ops2-flexprice-correction-${createHash('sha256')
        .update(
          JSON.stringify([
            input.organizationId,
            input.projectId,
            input.runId,
            input.taskId,
            input.category,
            input.from,
            input.to,
            input.targetQuantity,
          ]),
        )
        .digest('hex')}`;
      const id = `usgcorr_${createHash('sha256').update(operationKey).digest('hex')}`;
      const timestamp = new Date(Date.parse(input.to) - 1).toISOString();
      const event = FlexpriceUsageEventSchema.parse({
        event_name: input.category,
        external_customer_id: input.organizationId,
        event_id: id,
        timestamp,
        properties: {
          project_id: input.projectId,
          run_id: input.runId,
          task_id: input.taskId,
          quantity: Number(input.deltaQuantity),
          unit: 'reconciliation_delta',
          provider: null,
        },
      });
      await options.database
        .insert(usageReconciliationCorrections)
        .values({
          id,
          operationKey,
          organizationId: input.organizationId,
          projectId: input.projectId,
          runId: input.runId,
          taskId: input.taskId,
          category: input.category,
          windowFrom: new Date(input.from),
          windowTo: new Date(input.to),
          targetQuantity: input.targetQuantity,
          deltaQuantity: input.deltaQuantity,
          eventJson: event,
          status: 'pending',
          attempts: 0,
          createdAt: now(),
          deliveredAt: null,
        })
        .onConflictDoNothing({ target: usageReconciliationCorrections.operationKey });
      const [row] = await options.database
        .select()
        .from(usageReconciliationCorrections)
        .where(eq(usageReconciliationCorrections.operationKey, operationKey));
      if (row === undefined) throw new Error('usage correction journal row is missing');
      const persisted = FlexpriceUsageEventSchema.parse(row.eventJson);
      if (
        row.targetQuantity !== input.targetQuantity ||
        row.deltaQuantity !== input.deltaQuantity ||
        JSON.stringify(persisted) !== JSON.stringify(event)
      ) {
        throw new Error('usage correction operation conflicts with durable journal');
      }
      if (row.status === 'delivered') return;
      await options.database
        .update(usageReconciliationCorrections)
        .set({ attempts: row.attempts + 1 })
        .where(
          and(
            eq(usageReconciliationCorrections.id, row.id),
            eq(usageReconciliationCorrections.status, 'pending'),
          ),
        );
      await options.ingest.ingest(persisted);
      await options.database
        .update(usageReconciliationCorrections)
        .set({ status: 'delivered', deliveredAt: now() })
        .where(
          and(
            eq(usageReconciliationCorrections.id, row.id),
            eq(usageReconciliationCorrections.status, 'pending'),
          ),
        );
    },
  };
}

interface UsageDriftAlertPort {
  driftDetected(
    input: WindowedUsageReconciliationScope & {
      readonly category: UsageCategory;
      readonly ledgerQuantity: string;
      readonly redisQuantity: string;
      readonly flexpriceQuantity: string;
      readonly redisDrifted: boolean;
      readonly flexpriceDrifted: boolean;
    },
  ): Promise<void>;
  driftHealed(
    input: WindowedUsageReconciliationScope & {
      readonly category: UsageCategory;
      readonly ledgerQuantity: string;
      readonly redisQuantity: string;
      readonly flexpriceQuantity: string;
      readonly redisDrifted: boolean;
      readonly flexpriceDrifted: boolean;
    },
  ): Promise<void>;
}

/**
 * Compares every persisted category for every selected run. One percent is an
 * exclusive threshold: exactly one percent is noise, while any non-zero value
 * against a zero ledger total is drift. Only Redis and Flexprice are healed.
 */
export function createThreeWayUsageReconciler(options: {
  readonly scopes: UsageReconciliationScopePort;
  readonly ledger: UsageReconciliationLedgerPort;
  readonly redis: UsageRunCounterPort;
  readonly flexprice: FlexpriceAggregateReadPort;
  readonly corrections: UsageCorrectionPort;
  readonly alerts: UsageDriftAlertPort;
}) {
  return {
    async runOnce(rawWindow: ReconciliationWindow): Promise<{
      scopes: number;
      checked: number;
      drifted: number;
      redisHealed: number;
      flexpriceHealed: number;
    }> {
      const window = ReconciliationWindowSchema.parse(rawWindow);
      const scopes = z
        .array(UsageReconciliationScopeSchema)
        .parse(await options.scopes.list(window));
      let checked = 0;
      let drifted = 0;
      let redisHealed = 0;
      let flexpriceHealed = 0;

      for (const scope of scopes) {
        const windowedScope = { ...scope, ...window };
        const aggregateValues = z
          .record(z.enum(USAGE_CATEGORIES), UsageQuantitySchema)
          .parse(await options.flexprice.readAggregates(windowedScope));
        for (const category of USAGE_CATEGORIES) {
          const [rawLedger, rawRedis] = await Promise.all([
            options.ledger.readTotal(windowedScope, category),
            scope.runId === null
              ? Promise.resolve(undefined)
              : options.redis.readTotal(windowedScope, category),
          ]);
          const ledgerUnits = quantityUnits(rawLedger);
          const redisUnits = rawRedis === undefined ? ledgerUnits : quantityUnits(rawRedis);
          const flexpriceUnits = quantityUnits(aggregateValues[category] ?? '0');
          const redisDrifted =
            scope.runId !== null && driftOverOnePercent(ledgerUnits, redisUnits);
          const flexpriceDrifted = driftOverOnePercent(ledgerUnits, flexpriceUnits);
          checked += 1;
          if (!redisDrifted && !flexpriceDrifted) continue;

          const ledgerQuantity = formatQuantity(ledgerUnits);
          const redisQuantity = formatQuantity(redisUnits);
          const flexpriceQuantity = formatQuantity(flexpriceUnits);
          const drift = {
            ...windowedScope,
            category,
            ledgerQuantity,
            redisQuantity,
            flexpriceQuantity,
            redisDrifted,
            flexpriceDrifted,
          };
          await options.alerts.driftDetected(drift);
          drifted += 1;
          if (redisDrifted) {
            await options.redis.writeTotal({
              ...windowedScope,
              category,
              quantity: ledgerQuantity,
            });
            redisHealed += 1;
          }
          if (flexpriceDrifted) {
            await options.corrections.correct({
              ...windowedScope,
              category,
              targetQuantity: ledgerQuantity,
              deltaQuantity: formatQuantity(ledgerUnits - flexpriceUnits),
            });
            flexpriceHealed += 1;
          }
          await options.alerts.driftHealed(drift);
        }
      }

      return { scopes: scopes.length, checked, drifted, redisHealed, flexpriceHealed };
    },
  };
}

export interface UsageReconciliationCoordinatorPort {
  claim(window: ReconciliationWindow): Promise<'acquired' | 'completed' | 'busy'>;
  isOutboxDrained(window: ReconciliationWindow): Promise<boolean>;
  complete(window: ReconciliationWindow): Promise<void>;
}

export function createCoordinatedUsageReconciliationJob(options: {
  readonly coordinator: UsageReconciliationCoordinatorPort;
  readonly reconciler: UsageReconciliationJob;
}) {
  return {
    async runOnce(rawWindow: ReconciliationWindow): Promise<unknown> {
      const window = ReconciliationWindowSchema.parse(rawWindow);
      if ((await options.coordinator.claim(window)) !== 'acquired') {
        return { acquired: false, drained: false };
      }
      if (!(await options.coordinator.isOutboxDrained(window))) {
        return { acquired: true, drained: false };
      }
      const result = await options.reconciler.runOnce(window);
      await options.coordinator.complete(window);
      return result;
    },
  };
}

export function createDatabaseUsageReconciliationCoordinator(options: {
  readonly database: Database;
  readonly owner: string;
  readonly now?: () => Date;
  readonly leaseMs?: number;
}): UsageReconciliationCoordinatorPort {
  const now = options.now ?? ((): Date => new Date());
  const leaseMs = options.leaseMs ?? 60_000;
  const nameFor = (window: ReconciliationWindow): string =>
    `usage-reconciliation-${createHash('sha256')
      .update(`${window.from}:${window.to}`)
      .digest('hex')}`;
  return {
    async claim(rawWindow) {
      const window = ReconciliationWindowSchema.parse(rawWindow);
      const instant = now();
      const name = nameFor(window);
      const [claimed] = await options.database
        .insert(accountingLeaderLeases)
        .values({
          name,
          owner: options.owner,
          expiresAt: new Date(instant.getTime() + leaseMs),
        })
        .onConflictDoUpdate({
          target: accountingLeaderLeases.name,
          set: { owner: options.owner, expiresAt: new Date(instant.getTime() + leaseMs) },
          setWhere: sql`${accountingLeaderLeases.expiresAt} <= ${instant.toISOString()}::timestamptz and ${accountingLeaderLeases.owner} <> 'completed'`,
        })
        .returning({ owner: accountingLeaderLeases.owner });
      if (claimed?.owner === options.owner) return 'acquired';
      const [existing] = await options.database
        .select({ owner: accountingLeaderLeases.owner })
        .from(accountingLeaderLeases)
        .where(eq(accountingLeaderLeases.name, name));
      return existing?.owner === 'completed' ? 'completed' : 'busy';
    },
    async isOutboxDrained(rawWindow) {
      const window = ReconciliationWindowSchema.parse(rawWindow);
      const [undelivered] = await options.database
        .select({ id: usageLedger.id })
        .from(usageLedger)
        .leftJoin(usageOutbox, eq(usageOutbox.ledgerRowId, usageLedger.id))
        .where(
          and(
            gte(usageLedger.occurredAt, new Date(window.from)),
            lt(usageLedger.occurredAt, new Date(window.to)),
            or(isNull(usageOutbox.id), ne(usageOutbox.status, 'delivered')),
          ),
        )
        .limit(1);
      return undelivered === undefined;
    },
    async complete(rawWindow) {
      const window = ReconciliationWindowSchema.parse(rawWindow);
      const [completed] = await options.database
        .update(accountingLeaderLeases)
        .set({ owner: 'released', expiresAt: now() })
        .where(
          and(
            eq(accountingLeaderLeases.name, nameFor(window)),
            eq(accountingLeaderLeases.owner, options.owner),
          ),
        )
        .returning({ name: accountingLeaderLeases.name });
      if (completed === undefined) throw new Error('usage reconciliation lease ownership was lost');
    },
  };
}

interface UsageReconciliationJob {
  runOnce(window: ReconciliationWindow): Promise<unknown>;
}

interface UsageReconciliationTimers {
  setInterval(callback: () => void, delayMs: number): number | object;
  clearInterval(handle: number | object): void;
}

/** Runs three-way reconciliation at the Global Constraint's 60-second ceiling. */
export function createUsageReconciliationLifecycle(options: {
  readonly reconciler: UsageReconciliationJob;
  readonly now?: () => Date;
  readonly onError?: (error: Error) => void;
  readonly timers?: UsageReconciliationTimers;
}) {
  const now = options.now ?? ((): Date => new Date());
  const timers =
    options.timers ??
    ({
      setInterval: (callback, delayMs) => setInterval(callback, delayMs),
      clearInterval: (handle) => {
        clearInterval(handle as ReturnType<typeof setInterval>);
      },
    } satisfies UsageReconciliationTimers);
  let handle: number | object | undefined;
  let active: Promise<void> | undefined;
  let closed = false;

  const window = (): ReconciliationWindow => {
    const instant = now();
    const to = new Date(
      Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
    );
    return ReconciliationWindowSchema.parse({
      from: new Date(to.getTime() - 86_400_000).toISOString(),
      to: to.toISOString(),
    });
  };
  const poll = (): void => {
    if (closed || active !== undefined) return;
    active = options.reconciler
      .runOnce(window())
      .then(() => undefined)
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        active = undefined;
      });
  };

  return {
    async start(): Promise<void> {
      if (closed) throw new Error('usage reconciliation lifecycle is closed');
      try {
        await options.reconciler.runOnce(window());
      } catch (error: unknown) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      handle = timers.setInterval(poll, 60_000);
    },
    async close(): Promise<void> {
      closed = true;
      if (handle !== undefined) timers.clearInterval(handle);
      handle = undefined;
      await active;
    },
  };
}

/** Database boundary for every nullable attribution scope present in the closed ledger window. */
export function createDatabaseUsageReconciliationSource(database: Database): {
  scopes: UsageReconciliationScopePort;
  ledger: UsageReconciliationLedgerPort;
} {
  return {
    scopes: {
      async list(window) {
        return await database
          .select({
            organizationId: usageLedger.organizationId,
            projectId: usageLedger.projectId,
            runId: usageLedger.runId,
            taskId: usageLedger.taskId,
          })
          .from(usageLedger)
          .where(
            and(
              gte(usageLedger.occurredAt, new Date(window.from)),
              lt(usageLedger.occurredAt, new Date(window.to)),
            ),
          )
          .groupBy(
            usageLedger.organizationId,
            usageLedger.projectId,
            usageLedger.runId,
            usageLedger.taskId,
          )
          .orderBy(
            asc(usageLedger.organizationId),
            asc(usageLedger.projectId),
            asc(usageLedger.runId),
            asc(usageLedger.taskId),
          );
      },
    },
    ledger: {
      async readTotal(scope, category) {
        const [row] = await database
          .select({ quantity: sql<string>`coalesce(sum(${usageLedger.quantity}), 0)::text` })
          .from(usageLedger)
          .where(
            and(
              eq(usageLedger.organizationId, scope.organizationId),
              nullablePredicate(usageLedger.projectId, scope.projectId),
              nullablePredicate(usageLedger.runId, scope.runId),
              nullablePredicate(usageLedger.taskId, scope.taskId),
              eq(usageLedger.category, category),
              gte(usageLedger.occurredAt, new Date(scope.from)),
              lt(usageLedger.occurredAt, new Date(scope.to)),
            ),
          );
        return row?.quantity ?? '0';
      },
    },
  };
}

/** Redis hot-counter binding used by the three-way job. */
export function createRedisUsageRunCounter(
  redis: RedisCommands,
  ttlMs = 120_000,
): UsageRunCounterPort {
  return {
    async readTotal(scope, category) {
      if (scope.runId === null) return '0';
      return (await redis.get(usageCounterKey(scope, category))) ?? '0';
    },
    async writeTotal(input) {
      if (input.runId === null) return;
      await redis.set(usageCounterKey(input, input.category), input.quantity, ttlMs);
    },
  };
}

const FlexpriceAnalyticsResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          event_name: z.string().min(1),
          total_usage: z.union([z.string(), z.number().finite()]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Official Flexprice `/events/analytics` aggregate query, fetched once per attribution scope. */
export function createFlexpriceUsageAggregateClient(options: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
}): FlexpriceAggregateReadPort {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = `${options.baseUrl.replace(/\/+$/u, '')}/`;
  return {
    async readAggregates(scope) {
      const response = await request(new URL('events/analytics', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey },
        body: JSON.stringify({
          start_time: scope.from,
          end_time: scope.to,
          external_customer_id: scope.organizationId,
          group_by: ['event_name'],
          property_filters: {
            project_id: [scope.projectId],
            run_id: [scope.runId],
            task_id: [scope.taskId],
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`Flexprice usage analytics failed with status ${String(response.status)}`);
      }
      const body = FlexpriceAnalyticsResponseSchema.parse(await response.json());
      const aggregates: Partial<Record<UsageCategory, string>> = {};
      for (const item of body.items) {
        const category = z.enum(USAGE_CATEGORIES).safeParse(item.event_name);
        if (category.success) {
          aggregates[category.data] = formatQuantity(quantityUnits(item.total_usage));
        }
      }
      return Object.fromEntries(
        USAGE_CATEGORIES.map((category) => [category, aggregates[category] ?? '0.000000']),
      );
    },
  };
}

function usageCounterKey(
  scope: { readonly projectId: string | null; readonly runId: string | null; readonly taskId: string | null },
  category: UsageCategory,
): string {
  if (scope.runId === null) throw new Error('run usage counter requires run attribution');
  return `run:${scope.runId}:project:${scope.projectId ?? 'none'}:task:${scope.taskId ?? 'none'}:usage:${category}`;
}

function nullablePredicate(
  column: typeof usageLedger.projectId | typeof usageLedger.runId | typeof usageLedger.taskId,
  value: string | null,
) {
  return value === null ? isNull(column) : eq(column, value);
}

function quantityUnits(value: unknown): bigint {
  const parsed = UsageQuantitySchema.parse(typeof value === 'number' ? String(value) : value);
  const negative = parsed.startsWith('-');
  const unsigned = negative ? parsed.slice(1) : parsed;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return negative ? -units : units;
}

function formatQuantity(units: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / 1_000_000n;
  const fraction = String(absolute % 1_000_000n).padStart(6, '0');
  return `${negative ? '-' : ''}${String(whole)}.${fraction}`;
}

function driftOverOnePercent(arbiter: bigint, candidate: bigint): boolean {
  const difference = arbiter > candidate ? arbiter - candidate : candidate - arbiter;
  if (difference === 0n) return false;
  const baseline = arbiter < 0n ? -arbiter : arbiter;
  return baseline === 0n || difference * 100n > baseline;
}
