import { CreditStateSchema, type CreditState } from '@zapp/contracts';
import {
  accountingLeaderLeases,
  agentRuns,
  runCreditAccounts,
  runCreditCeilingAdjustments,
  type Database,
} from '@zapp/db';
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';

import type { RedisCommands } from '../redis/client.js';

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
