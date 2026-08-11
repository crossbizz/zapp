import { createHash, randomUUID } from 'node:crypto';

import { CreditStateSchema, idSchema, type CreditState, type RunMode } from '@zapp/contracts';
import {
  USAGE_CATEGORIES,
  accountingLeaderLeases,
  agentRuns,
  creditExhaustionEpisodes,
  runCreditAccounts,
  runCreditCeilingAdjustments,
  usageLedger,
  usageOutbox,
  usageReconciliationCorrections,
  type Database,
  type Executor,
  type UsageCategory,
} from '@zapp/db';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { RedisCommands } from '../redis/client.js';
import type { OrchestratorPort } from '../orchestrator/port.js';
import { CreditBalanceExhaustedError, type CreditBalanceGate } from './limits.js';
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

export interface ActiveCreditRun {
  readonly runId: string;
  readonly temporalWorkflowId: string;
  readonly mode: RunMode;
}

export interface CreditExhaustionStore {
  claimOrganizations(limit: number): Promise<
    | { readonly acquired: false; readonly organizationIds: readonly [] }
    | {
        readonly acquired: true;
        readonly leaseToken: string;
        readonly renewAfterMs: number;
        readonly organizationIds: readonly string[];
      }
  >;
  renewLease(leaseToken: string): Promise<boolean>;
  releaseLease(leaseToken: string): Promise<void>;
  getOrOpenEpisode(leaseToken: string, organizationId: string): Promise<{
    readonly operationKey: string;
    readonly cursorRunId: string | null;
  }>;
  closeEpisode(leaseToken: string, organizationId: string): Promise<void>;
  listActiveRuns(
    leaseToken: string,
    organizationId: string,
    cursorRunId: string | null,
    limit: number,
  ): Promise<readonly ActiveCreditRun[]>;
  advanceEpisode(leaseToken: string, operationKey: string, cursorRunId: string): Promise<void>;
}

export interface CreditBalanceExhaustionProducer {
  runOnce(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/** Durable, leased producer for the next-task credit gate; partial delivery retries the batch. */
export function createCreditBalanceExhaustionProducer(options: {
  readonly store: CreditExhaustionStore;
  readonly creditBalance: CreditBalanceGate;
  readonly orchestrator: OrchestratorPort;
  readonly organizationBatchSize?: number;
  readonly batchSize: number;
  readonly signalConcurrency: number;
  readonly signalTimeoutMs?: number;
  readonly balanceTimeoutMs?: number;
}): CreditBalanceExhaustionProducer {
  const lateSignals = new Set<Promise<unknown>>();
  const signalConcurrency = Math.max(1, Math.min(32, Math.floor(options.signalConcurrency)));
  const signalTimeoutMs = options.signalTimeoutMs ?? 3_000;
  return {
    async runOnce(signal = new AbortController().signal): Promise<void> {
      const batchSize = Math.max(1, Math.min(100, Math.floor(options.batchSize)));
      const organizationBatchSize = Math.max(
        1,
        Math.min(10, Math.floor(options.organizationBatchSize ?? 1)),
      );
      const claimed = await options.store.claimOrganizations(organizationBatchSize);
      if (!claimed.acquired) return;
      const leaseController = new AbortController();
      const leaseEnded = (): boolean => leaseController.signal.aborted;
      const abortFromCaller = (): void => {
        leaseController.abort(signal.reason);
      };
      signal.addEventListener('abort', abortFromCaller, { once: true });
      let leaseLost = false;
      let stopped = false;
      let renewalTimer: ReturnType<typeof setTimeout> | undefined;
      let renewal: Promise<void> | undefined;
      const scheduleRenewal = (): void => {
        if (stopped || leaseLost) return;
        renewalTimer = setTimeout(() => {
          renewal = options.store.renewLease(claimed.leaseToken)
            .then((renewed) => {
              if (!renewed) {
                leaseLost = true;
                leaseController.abort(new Error('credit exhaustion lease ownership was lost'));
              }
            })
            .catch(() => {
              leaseLost = true;
              leaseController.abort(new Error('credit exhaustion lease renewal failed'));
            })
            .finally(() => {
              renewal = undefined;
              scheduleRenewal();
            });
        }, claimed.renewAfterMs);
      };
      scheduleRenewal();
      try {
        for (const organizationId of claimed.organizationIds) {
          if (leaseEnded()) return;
          try {
            await boundedSignal(
              options.creditBalance.requireRunAdmission(organizationId),
              options.balanceTimeoutMs ?? 3_000,
              leaseController.signal,
            );
            if (leaseEnded()) return;
            await options.store.closeEpisode(claimed.leaseToken, organizationId);
            continue;
          } catch (error) {
            if (!(error instanceof CreditBalanceExhaustedError)) continue;
          }
          if (leaseEnded()) return;
          const episode = await options.store.getOrOpenEpisode(
            claimed.leaseToken,
            organizationId,
          );
          const runs = await options.store.listActiveRuns(
            claimed.leaseToken,
            organizationId,
            episode.cursorRunId,
            batchSize,
          );
          await mapConcurrent(
            runs,
            signalConcurrency,
            async (run) => {
              if (leaseEnded()) throw leaseController.signal.reason;
              if (lateSignals.size >= signalConcurrency) {
                throw new Error('Temporal exhaustion signal capacity is occupied');
              }
              const delivery = options.orchestrator.signalRun({
                runId: run.runId,
                workflowId: run.temporalWorkflowId,
                mode: run.mode,
                signal: 'credit_balance_exhausted',
                operationKey: episode.operationKey,
              });
              lateSignals.add(delivery);
              void delivery.finally(() => lateSignals.delete(delivery)).catch(() => undefined);
              return await boundedSignal(
                delivery,
                signalTimeoutMs,
                leaseController.signal,
              );
            },
          );
          if (leaseEnded()) return;
          const last = runs.at(-1);
          if (last !== undefined) {
            await options.store.advanceEpisode(
              claimed.leaseToken,
              episode.operationKey,
              last.runId,
            );
          }
        }
      } finally {
        stopped = true;
        if (renewalTimer !== undefined) clearTimeout(renewalTimer);
        await renewal?.catch(() => undefined);
        signal.removeEventListener('abort', abortFromCaller);
        await options.store.releaseLease(claimed.leaseToken).catch(() => undefined);
      }
    },
    async close(): Promise<void> {
      const pending = [...lateSignals];
      if (pending.length === 0) return;
      await boundedDrain(pending, signalTimeoutMs);
      lateSignals.clear();
    },
  };
}

async function boundedDrain(promises: readonly Promise<unknown>[], rawTimeoutMs: number): Promise<void> {
  const timeoutMs = Math.max(1, Math.min(5_000, Math.floor(rawTimeoutMs)));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(promises),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
}

async function boundedSignal<T>(
  promise: Promise<T>,
  rawTimeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  const timeoutMs = Math.max(1, Math.min(5_000, Math.floor(rawTimeoutMs)));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Temporal exhaustion signal timed out'));
    }, timeoutMs);
    onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('exhaustion signal aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, boundary]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  rawConcurrency: number,
  action: (value: T) => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = Array.from({ length: values.length });
  const concurrency = Math.max(1, Math.min(32, Math.floor(rawConcurrency)));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      const value = values[index];
      if (value === undefined) continue;
      try {
        results[index] = { status: 'fulfilled', value: await action(value) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));
  return results;
}

export function createDatabaseCreditExhaustionStore(options: {
  readonly database: Database;
  readonly owner: string;
  readonly now?: () => Date;
  readonly leaseMs?: number;
}): CreditExhaustionStore {
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 60_000;
  const leaseName = 'credit-exhaustion-producer';
  const assertLease = async (database: Executor, leaseToken: string): Promise<void> => {
    const instant = now();
    const [lease] = await database.select({
      owner: accountingLeaderLeases.owner,
      expiresAt: accountingLeaderLeases.expiresAt,
    }).from(accountingLeaderLeases).where(
      eq(accountingLeaderLeases.name, leaseName),
    ).limit(1).for('update');
    if (lease?.owner !== leaseToken || lease.expiresAt.getTime() <= instant.getTime()) {
      throw new Error('credit exhaustion lease ownership was lost');
    }
  };
  return {
    async claimOrganizations(rawLimit) {
      const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
      return await options.database.transaction(async (tx) => {
        const instant = now();
        const leaseToken = `${options.owner}:${randomUUID()}`;
        const [lease] = await tx.insert(accountingLeaderLeases).values({
          name: leaseName,
          owner: leaseToken,
          expiresAt: new Date(instant.getTime() + leaseMs),
        }).onConflictDoUpdate({
          target: accountingLeaderLeases.name,
          set: { owner: leaseToken, expiresAt: new Date(instant.getTime() + leaseMs) },
          setWhere: sql`${accountingLeaderLeases.expiresAt} <= ${instant.toISOString()}::timestamptz`,
        }).returning({ owner: accountingLeaderLeases.owner, cursorRunId: accountingLeaderLeases.cursorRunId });
        if (lease?.owner !== leaseToken) return { acquired: false as const, organizationIds: [] };

        const activeOrganizations = await tx.select({ organizationId: agentRuns.organizationId })
          .from(agentRuns)
          .where(and(
            inArray(agentRuns.status, ['queued', 'running', 'paused', 'waiting_for_approval']),
            lease.cursorRunId === null ? undefined : gt(agentRuns.organizationId, lease.cursorRunId),
          ))
          .groupBy(agentRuns.organizationId)
          .orderBy(asc(agentRuns.organizationId))
          .limit(limit);
        const openEpisodes = await tx.select({ organizationId: creditExhaustionEpisodes.organizationId })
          .from(creditExhaustionEpisodes)
          .where(and(
            isNull(creditExhaustionEpisodes.recoveredAt),
            lease.cursorRunId === null ? undefined : gt(creditExhaustionEpisodes.organizationId, lease.cursorRunId),
          ))
          .orderBy(asc(creditExhaustionEpisodes.organizationId))
          .limit(limit);
        const organizationIds = [...new Set([...activeOrganizations, ...openEpisodes]
          .map((row) => row.organizationId))].sort().slice(0, limit);
        const last = organizationIds.at(-1);
        await tx.update(accountingLeaderLeases)
          .set({ cursorRunId: last ?? null })
          .where(and(
            eq(accountingLeaderLeases.name, 'credit-exhaustion-producer'),
            eq(accountingLeaderLeases.owner, leaseToken),
            sql`${accountingLeaderLeases.expiresAt} > ${instant.toISOString()}::timestamptz`,
          ));
        return {
          acquired: true as const,
          leaseToken,
          renewAfterMs: Math.max(1, Math.floor(leaseMs / 3)),
          organizationIds,
        };
      });
    },
    async renewLease(leaseToken) {
      const instant = now();
      const [renewed] = await options.database.update(accountingLeaderLeases)
        .set({ expiresAt: new Date(instant.getTime() + leaseMs) })
        .where(and(
          eq(accountingLeaderLeases.name, leaseName),
          eq(accountingLeaderLeases.owner, leaseToken),
          sql`${accountingLeaderLeases.expiresAt} > ${instant.toISOString()}::timestamptz`,
        )).returning({ name: accountingLeaderLeases.name });
      return renewed !== undefined;
    },
    async releaseLease(leaseToken) {
      await options.database.update(accountingLeaderLeases)
        .set({ expiresAt: now() })
        .where(and(
          eq(accountingLeaderLeases.name, leaseName),
          eq(accountingLeaderLeases.owner, leaseToken),
        ));
    },
    async getOrOpenEpisode(leaseToken, organizationId) {
      return await options.database.transaction(async (tx) => {
        await assertLease(tx, leaseToken);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${organizationId}))`);
        const [existing] = await tx.select({
          operationKey: creditExhaustionEpisodes.operationKey,
          cursorRunId: creditExhaustionEpisodes.cursorRunId,
        }).from(creditExhaustionEpisodes).where(and(
          eq(creditExhaustionEpisodes.organizationId, organizationId),
          isNull(creditExhaustionEpisodes.recoveredAt),
        )).limit(1);
        if (existing !== undefined) return existing;
        const operationKey = `op_${createHash('sha256')
          .update(`${organizationId}:${randomUUID()}`)
          .digest('hex')}`;
        const [created] = await tx.insert(creditExhaustionEpisodes).values({
          operationKey,
          organizationId,
          exhaustedAt: now(),
        }).returning({
          operationKey: creditExhaustionEpisodes.operationKey,
          cursorRunId: creditExhaustionEpisodes.cursorRunId,
        });
        if (created === undefined) throw new Error('credit exhaustion episode insert returned no row');
        return created;
      });
    },
    async closeEpisode(leaseToken, organizationId) {
      await options.database.transaction(async (tx) => {
        await assertLease(tx, leaseToken);
        await tx.update(creditExhaustionEpisodes)
          .set({ recoveredAt: now() })
          .where(and(
            eq(creditExhaustionEpisodes.organizationId, organizationId),
            isNull(creditExhaustionEpisodes.recoveredAt),
          ));
      });
    },
    async listActiveRuns(leaseToken, organizationId, cursorRunId, rawLimit) {
      const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
      return await options.database.transaction(async (tx) => {
      await assertLease(tx, leaseToken);
      const afterCursor = await tx.select({
        runId: agentRuns.id,
        temporalWorkflowId: agentRuns.temporalWorkflowId,
        mode: agentRuns.mode,
      }).from(agentRuns).where(and(
        eq(agentRuns.organizationId, organizationId),
        inArray(agentRuns.status, ['queued', 'running', 'paused', 'waiting_for_approval']),
        isNotNull(agentRuns.temporalWorkflowId),
        cursorRunId === null ? undefined : gt(agentRuns.id, cursorRunId),
      )).orderBy(asc(agentRuns.id)).limit(limit);
      const rows = [...afterCursor];
      if (cursorRunId !== null && rows.length < limit) {
        const wrapped = await tx.select({
          runId: agentRuns.id,
          temporalWorkflowId: agentRuns.temporalWorkflowId,
          mode: agentRuns.mode,
        }).from(agentRuns).where(and(
          eq(agentRuns.organizationId, organizationId),
          inArray(agentRuns.status, ['queued', 'running', 'paused', 'waiting_for_approval']),
          isNotNull(agentRuns.temporalWorkflowId),
          lte(agentRuns.id, cursorRunId),
        )).orderBy(asc(agentRuns.id)).limit(limit - rows.length);
        rows.push(...wrapped);
      }
      return rows.map((row) => ({
        runId: row.runId,
        temporalWorkflowId: row.temporalWorkflowId as string,
        mode: row.mode,
      }));
      });
    },
    async advanceEpisode(leaseToken, operationKey, cursorRunId) {
      await options.database.transaction(async (tx) => {
        await assertLease(tx, leaseToken);
        await tx.update(creditExhaustionEpisodes)
          .set({ cursorRunId })
          .where(and(
            eq(creditExhaustionEpisodes.operationKey, operationKey),
            isNull(creditExhaustionEpisodes.recoveredAt),
          ));
      });
    },
  };
}

type CreditExhaustionTimer = number | object;

export function createCreditBalanceExhaustionLifecycle(options: {
  readonly producer: {
    runOnce(signal: AbortSignal): Promise<void>;
    close?(): Promise<void>;
  };
  readonly intervalMs: number;
  readonly onError?: (error: Error) => void;
  readonly timers?: {
    setTimeout(callback: () => void, delayMs: number): CreditExhaustionTimer;
    clearTimeout(handle: CreditExhaustionTimer): void;
  };
}) {
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (handle: CreditExhaustionTimer) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  const controller = new AbortController();
  let timeout: CreditExhaustionTimer | undefined;
  let active: Promise<void> | undefined;
  let closed = false;
  const poll = (): void => {
    if (closed || active !== undefined) return;
    active = options.producer.runOnce(controller.signal)
      .catch((error: unknown) => {
        try {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
        } catch {
          // Error reporting is isolated from producer lifecycle completion.
        }
      })
      .finally(() => {
        active = undefined;
        if (!closed) timeout = timers.setTimeout(poll, options.intervalMs);
      });
  };
  return {
    start(): Promise<void> {
      if (closed) return Promise.reject(new Error('credit exhaustion lifecycle is closed'));
      poll();
      return Promise.resolve();
    },
    async close(): Promise<void> {
      closed = true;
      controller.abort(new Error('credit exhaustion lifecycle closed'));
      if (timeout !== undefined) timers.clearTimeout(timeout);
      await active?.catch(() => undefined);
      await options.producer.close?.().catch(() => undefined);
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
      readonly observedQuantity: string;
      readonly deltaQuantity: string;
    },
  ): Promise<'submitted' | 'pending' | 'confirmed'>;
  confirm(
    input: WindowedUsageReconciliationScope & {
      readonly category: UsageCategory;
      readonly targetQuantity: string;
      readonly observedQuantity: string;
    },
  ): Promise<'none' | 'confirmed'>;
}

export function createDatabaseUsageCorrectionJournal(options: {
  readonly database: Database;
  readonly ingest: FlexpriceIngestPort;
  readonly now?: () => Date;
}): UsageCorrectionPort {
  const now = options.now ?? ((): Date => new Date());
  const baseSchema = z
    .object({
      organizationId: idSchema('org'),
      projectId: idSchema('proj').nullable(),
      runId: idSchema('run').nullable(),
      taskId: idSchema('task').nullable(),
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      category: z.enum(USAGE_CATEGORIES),
      targetQuantity: UsageQuantitySchema,
      observedQuantity: UsageQuantitySchema,
    })
    .strict();
  const correctionSchema = baseSchema.extend({ deltaQuantity: UsageQuantitySchema }).strict();
  type CorrectionScope = z.infer<typeof baseSchema>;
  const submissionClaimMs = 5 * 60_000;

  const scopePredicate = (input: CorrectionScope) =>
    and(
      eq(usageReconciliationCorrections.organizationId, input.organizationId),
      nullableCorrectionPredicate(usageReconciliationCorrections.projectId, input.projectId),
      nullableCorrectionPredicate(usageReconciliationCorrections.runId, input.runId),
      nullableCorrectionPredicate(usageReconciliationCorrections.taskId, input.taskId),
      eq(usageReconciliationCorrections.category, input.category),
      eq(usageReconciliationCorrections.windowFrom, new Date(input.from)),
      eq(usageReconciliationCorrections.windowTo, new Date(input.to)),
    );
  const scopeLockIdentity = (input: CorrectionScope): string =>
    JSON.stringify([
      input.organizationId,
      input.projectId,
      input.runId,
      input.taskId,
      input.category,
      input.from,
      input.to,
    ]);

  return {
    async correct(rawInput) {
      const input = correctionSchema.parse(rawInput);
      if (
        quantityUnits(input.targetQuantity) - quantityUnits(input.observedQuantity) !==
        quantityUnits(input.deltaQuantity)
      ) {
        throw new Error('usage correction delta does not reach its target');
      }
      const decision = await options.database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${scopeLockIdentity(input)}, 0))`,
        );
        const [priorPending] = await tx
          .select()
          .from(usageReconciliationCorrections)
          .where(and(scopePredicate(input), eq(usageReconciliationCorrections.status, 'pending')))
          .orderBy(
            desc(usageReconciliationCorrections.createdAt),
            desc(usageReconciliationCorrections.id),
          )
          .limit(1);
        const claimedAt = now();
        if (priorPending !== undefined) {
          if (priorPending.deliveredAt === null) {
            if (
              priorPending.submissionClaimedAt !== null &&
              priorPending.submissionClaimedAt.getTime() > claimedAt.getTime() - submissionClaimMs
            ) {
              return { kind: 'pending' } as const;
            }
            const [claimed] = await tx
              .update(usageReconciliationCorrections)
              .set({
                attempts: priorPending.attempts + 1,
                submissionClaimedAt: claimedAt,
              })
              .where(
                and(
                  eq(usageReconciliationCorrections.id, priorPending.id),
                  eq(usageReconciliationCorrections.status, 'pending'),
                ),
              )
              .returning();
            if (claimed === undefined) return { kind: 'pending' } as const;
            return {
              kind: 'submit',
              id: claimed.id,
              event: FlexpriceUsageEventSchema.parse(claimed.eventJson),
            } as const;
          }
          if (priorPending.targetQuantity !== input.observedQuantity) {
            return { kind: 'pending' } as const;
          }
          await tx
            .update(usageReconciliationCorrections)
            .set({ status: 'confirmed', confirmedAt: claimedAt })
            .where(
              and(
                eq(usageReconciliationCorrections.id, priorPending.id),
                eq(usageReconciliationCorrections.status, 'pending'),
              ),
            );
          if (input.observedQuantity === input.targetQuantity) {
            return { kind: 'confirmed' } as const;
          }
        } else if (input.observedQuantity === input.targetQuantity) {
          return { kind: 'confirmed' } as const;
        }

        const [history] = await tx
          .select({ count: sql<number>`count(*)::integer` })
          .from(usageReconciliationCorrections)
          .where(scopePredicate(input));
        const generation = (history?.count ?? 0) + 1;
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
              input.observedQuantity,
              generation,
            ]),
          )
          .digest('hex')}`;
        const id = `usgcorr_${createHash('sha256').update(operationKey).digest('hex')}`;
        const event = FlexpriceUsageEventSchema.parse({
          event_name: input.category,
          external_customer_id: input.organizationId,
          event_id: id,
          timestamp: new Date(Date.parse(input.to) - 1).toISOString(),
          properties: {
            project_id: input.projectId,
            run_id: input.runId,
            task_id: input.taskId,
            quantity: Number(input.deltaQuantity),
            unit: 'reconciliation_delta',
            provider: null,
          },
        });
        const [row] = await tx
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
            attempts: 1,
            createdAt: claimedAt,
            submissionClaimedAt: claimedAt,
            deliveredAt: null,
            confirmedAt: null,
          })
          .returning();
        if (row === undefined) throw new Error('usage correction journal row is missing');
        return {
          kind: 'submit',
          id: row.id,
          event: FlexpriceUsageEventSchema.parse(row.eventJson),
        } as const;
      });
      if (decision.kind === 'pending') return 'pending';
      if (decision.kind === 'confirmed') return 'confirmed';
      try {
        await options.ingest.ingest(decision.event);
      } catch (error) {
        await options.database
          .update(usageReconciliationCorrections)
          .set({ submissionClaimedAt: null })
          .where(
            and(
              eq(usageReconciliationCorrections.id, decision.id),
              eq(usageReconciliationCorrections.status, 'pending'),
              isNull(usageReconciliationCorrections.deliveredAt),
            ),
          );
        throw error;
      }
      await options.database
        .update(usageReconciliationCorrections)
        .set({ submissionClaimedAt: null, deliveredAt: now() })
        .where(
          and(
            eq(usageReconciliationCorrections.id, decision.id),
            eq(usageReconciliationCorrections.status, 'pending'),
          ),
        );
      return 'submitted';
    },
    async confirm(rawInput) {
      const input = baseSchema.parse(rawInput);
      return await options.database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${scopeLockIdentity(input)}, 0))`,
        );
        const [pending] = await tx
          .select()
          .from(usageReconciliationCorrections)
          .where(and(scopePredicate(input), eq(usageReconciliationCorrections.status, 'pending')))
          .orderBy(
            desc(usageReconciliationCorrections.createdAt),
            desc(usageReconciliationCorrections.id),
          )
          .limit(1);
        if (
          pending === undefined ||
          pending.deliveredAt === null ||
          pending.targetQuantity !== input.observedQuantity
        ) {
          return 'none' as const;
        }
        const [confirmed] = await tx
          .update(usageReconciliationCorrections)
          .set({ status: 'confirmed', confirmedAt: now() })
          .where(
            and(
              eq(usageReconciliationCorrections.id, pending.id),
              eq(usageReconciliationCorrections.status, 'pending'),
            ),
          )
          .returning({ id: usageReconciliationCorrections.id });
        return confirmed === undefined ? ('none' as const) : ('confirmed' as const);
      });
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
          const ledgerQuantity = formatQuantity(ledgerUnits);
          const redisQuantity = formatQuantity(redisUnits);
          const flexpriceQuantity = formatQuantity(flexpriceUnits);
          if (!redisDrifted && !flexpriceDrifted) {
            const confirmation = await options.corrections.confirm({
              ...windowedScope,
              category,
              targetQuantity: ledgerQuantity,
              observedQuantity: flexpriceQuantity,
            });
            if (confirmation === 'confirmed') {
              flexpriceHealed += 1;
              await options.alerts.driftHealed({
                ...windowedScope,
                category,
                ledgerQuantity,
                redisQuantity,
                flexpriceQuantity,
                redisDrifted: false,
                flexpriceDrifted: true,
              });
            }
            continue;
          }
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
          let flexpriceState: 'submitted' | 'pending' | 'confirmed' | 'not-needed' =
            'not-needed';
          if (flexpriceDrifted) {
            flexpriceState = await options.corrections.correct({
              ...windowedScope,
              category,
              targetQuantity: ledgerQuantity,
              observedQuantity: flexpriceQuantity,
              deltaQuantity: formatQuantity(ledgerUnits - flexpriceUnits),
            });
            if (flexpriceState === 'confirmed') flexpriceHealed += 1;
          }
          if (!flexpriceDrifted || flexpriceState === 'confirmed') {
            await options.alerts.driftHealed(drift);
          }
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
          feature_id: z.string().min(1),
          meter_id: z.string().min(1),
          meter: z
            .object({
              id: z.string().min(1),
              event_name: z.enum(USAGE_CATEGORIES),
              name: z.string().min(1),
              environment_id: z.string().min(1),
              status: z.string().min(1),
            })
            .passthrough(),
          properties: z.record(z.string().nullable()).default({}),
          total_usage: z.union([z.string(), z.number().finite()]),
        })
        .passthrough()
        .refine((item) => item.meter.id === item.meter_id, {
          message: 'expanded meter identity does not match meter_id',
          path: ['meter', 'id'],
        }),
    ),
  })
  .passthrough();

const FlexpriceAnalyticsRequestSchema = z
  .object({
    start_time: z.string().datetime({ offset: true }),
    end_time: z.string().datetime({ offset: true }),
    external_customer_id: idSchema('org'),
    group_by: z
      .array(
        z.union([
          z.literal('source'),
          z.literal('feature_id'),
          z.string().regex(/^properties\.[A-Za-z0-9_]+$/u),
        ]),
      )
      .min(1),
    expand: z.tuple([z.literal('meter')]),
    property_filters: z.record(z.array(z.string().min(1))).optional(),
  })
  .strict();

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
      const propertyFilters: Record<string, string[]> = {};
      const scopeProperties: readonly (readonly [string, string | null])[] = [
          ['project_id', scope.projectId],
          ['run_id', scope.runId],
          ['task_id', scope.taskId],
      ];
      for (const [field, value] of scopeProperties) {
        if (value !== null) propertyFilters[field] = [value];
      }
      const payload = FlexpriceAnalyticsRequestSchema.parse({
        start_time: scope.from,
        end_time: scope.to,
        external_customer_id: scope.organizationId,
        group_by: [
          'feature_id',
          'properties.project_id',
          'properties.run_id',
          'properties.task_id',
        ],
        expand: ['meter'],
        ...(Object.keys(propertyFilters).length === 0
          ? {}
          : { property_filters: propertyFilters }),
      });
      const response = await request(new URL('events/analytics', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`Flexprice usage analytics failed with status ${String(response.status)}`);
      }
      const body = FlexpriceAnalyticsResponseSchema.parse(await response.json());
      const aggregates: Partial<Record<UsageCategory, bigint>> = {};
      for (const item of body.items) {
        if (!matchesFlexpriceScope(item.properties, scope)) continue;
        const category = item.meter.event_name;
        aggregates[category] =
          (aggregates[category] ?? 0n) + quantityUnits(item.total_usage);
      }
      return Object.fromEntries(
        USAGE_CATEGORIES.map((category) => [
          category,
          formatQuantity(aggregates[category] ?? 0n),
        ]),
      );
    },
  };
}

function matchesFlexpriceScope(
  properties: Readonly<Record<string, string | null>>,
  scope: Pick<UsageReconciliationScope, 'projectId' | 'runId' | 'taskId'>,
): boolean {
  return (
    matchesNullableProperty(properties.project_id, scope.projectId) &&
    matchesNullableProperty(properties.run_id, scope.runId) &&
    matchesNullableProperty(properties.task_id, scope.taskId)
  );
}

function matchesNullableProperty(
  actual: string | null | undefined,
  expected: string | null,
): boolean {
  return expected === null ? actual === undefined || actual === null : actual === expected;
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

function nullableCorrectionPredicate(
  column:
    | typeof usageReconciliationCorrections.projectId
    | typeof usageReconciliationCorrections.runId
    | typeof usageReconciliationCorrections.taskId,
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
