import { createHash } from 'node:crypto';

import {
  CompletionRecordSchema,
  CreditCeilingIncreaseRequestSchema,
  ModelCompletionClaimRequestSchema,
  ModelCompletionClaimResponseSchema,
  ModelCompletionCommitRequestSchema,
  type CompletionRecord,
  type CreditCeilingIncreaseRequest,
  type CreditState,
  type ModelCompletionClaimRequest,
  type ModelCompletionClaimResponse,
  type ModelCompletionCommitRequest,
  type ModelCompletionCommitResponse,
} from '@zapp/contracts';
import {
  agentPhases,
  agentRuns,
  agentTasks,
  approvals,
  modelCompletionJournal,
  runCreditAccounts,
  runCreditCeilingAdjustments,
  usageLedger,
  usageOutbox,
  type Database,
  type Executor,
} from '@zapp/db';
import { and, desc, eq, sql } from 'drizzle-orm';

import { loadPricingConfig, priceTokenUsage, worstCaseReservation } from './pricing.js';
import type { CreditMirror } from './reconciliation.js';

export class CompletionConflictError extends Error {
  public constructor() {
    super('completion identity conflicts with the durable journal');
    this.name = 'CompletionConflictError';
  }
}

export class CompletionClaimLostError extends Error {
  public constructor() {
    super('completion claim is no longer owned by this caller');
    this.name = 'CompletionClaimLostError';
  }
}

export class CompletionUsageExceedsReservationError extends Error {
  public constructor() {
    super('completion usage exceeds its durable reservation');
    this.name = 'CompletionUsageExceedsReservationError';
  }
}

export class CompletionNotFoundError extends Error {
  public constructor() {
    super('completion or run was not found in this tenant');
    this.name = 'CompletionNotFoundError';
  }
}

export class CreditCeilingIncreaseRejectedError extends Error {
  public constructor(public readonly reason: 'approval_not_resolved' | 'not_an_increase') {
    super(
      reason === 'approval_not_resolved'
        ? 'credit ceiling increase requires a matching resolved approval'
        : 'credit ceiling increase must strictly increase the absolute ceiling',
    );
    this.name = 'CreditCeilingIncreaseRejectedError';
  }
}

export interface ModelCompletionRepositoryOptions {
  readonly database: Database;
  readonly now?: () => Date;
  readonly mirror?: CreditMirror;
  readonly onMirrorError?: (error: Error) => void;
}

export interface ModelCompletionRepository {
  claim(input: ModelCompletionClaimRequest): Promise<ModelCompletionClaimResponse>;
  commit(input: ModelCompletionCommitRequest): Promise<ModelCompletionCommitResponse>;
  get(organizationId: string, completionId: string): Promise<CompletionRecord | undefined>;
  increaseCeiling(input: CreditCeilingIncreaseRequest): Promise<CreditState>;
}

export function createModelCompletionRepository(
  options: ModelCompletionRepositoryOptions,
): ModelCompletionRepository {
  const { database } = options;
  const now = options.now ?? ((): Date => new Date());

  return {
    async claim(rawInput) {
      const input = ModelCompletionClaimRequestSchema.parse(rawInput);
      const result = ModelCompletionClaimResponseSchema.parse(
        await database.transaction(async (tx) => {
          const account = await lockAccount(tx, input.organizationId, input.runId);
          await assertScope(tx, input);
          const ceiling = await effectiveCeiling(tx, input.runId, account.baseCeiling);
          const [existing] = await tx
            .select()
            .from(modelCompletionJournal)
            .where(eq(modelCompletionJournal.completionId, input.completionId))
            .for('update')
            .limit(1);

          if (existing !== undefined) {
            assertIdentity(existing, input);
            if (existing.state === 'completed') {
              return {
                status: 'completed',
                completion: completionRecord(existing),
                credits: creditState(account, ceiling),
              };
            }
            const claimExpiresAt = existing.claimExpiresAt;
            if (
              existing.claimOwner !== input.claimOwner &&
              claimExpiresAt !== null &&
              claimExpiresAt.getTime() > now().getTime()
            ) {
              return {
                status: 'leased',
                retryAfterMs: Math.max(1, claimExpiresAt.getTime() - now().getTime()),
              };
            }
            const renewedUntil = new Date(now().getTime() + input.leaseMs);
            await tx
              .update(modelCompletionJournal)
              .set({
                claimOwner: input.claimOwner,
                claimExpiresAt: renewedUntil,
                updatedAt: now(),
              })
              .where(eq(modelCompletionJournal.completionId, input.completionId));
            return {
              status: 'claimed',
              claimExpiresAt: renewedUntil.toISOString(),
              reservedCredits: normalizeCredits(existing.reservedCredits),
              credits: creditState(account, ceiling),
            };
          }

          const pricing = loadPricingConfig(account.pricingSnapshotJson);
          const required = worstCaseReservation(pricing, input.route);
          if (
            creditUnits(account.usedCredits) +
              creditUnits(account.reservedCredits) +
              creditUnits(required) >
            creditUnits(ceiling)
          ) {
            return {
              status: 'budget_exceeded',
              requiredCredits: required,
              credits: creditState(account, ceiling),
            };
          }

          const claimExpiresAt = new Date(now().getTime() + input.leaseMs);
          await tx.insert(modelCompletionJournal).values({
            completionId: input.completionId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            runId: input.runId,
            taskId: input.taskId ?? null,
            requestFingerprint: input.requestFingerprint,
            claimOwner: input.claimOwner,
            claimExpiresAt,
            reservedCredits: required,
            state: 'claimed',
            responseJson: null,
            terminalJson: null,
            createdAt: now(),
            updatedAt: now(),
          });
          const [updated] = await tx
            .update(runCreditAccounts)
            .set({
              reservedCredits: sql`${runCreditAccounts.reservedCredits} + ${required}::numeric`,
              version: sql`${runCreditAccounts.version} + 1`,
              updatedAt: now(),
            })
            .where(eq(runCreditAccounts.runId, input.runId))
            .returning();
          if (updated === undefined) throw new Error('locked run credit account disappeared');
          return {
            status: 'claimed',
            claimExpiresAt: claimExpiresAt.toISOString(),
            reservedCredits: required,
            credits: creditState(updated, ceiling),
          };
        }),
      );
      if ('credits' in result) await mirrorSafely(input.runId, result.credits);
      return result;
    },

    async commit(rawInput) {
      const input = ModelCompletionCommitRequestSchema.parse(rawInput);
      const result = await database.transaction(async (tx) => {
        const account = await lockAccount(tx, input.organizationId, input.runId);
        await assertScope(tx, input);
        const ceiling = await effectiveCeiling(tx, input.runId, account.baseCeiling);
        const [journal] = await tx
          .select()
          .from(modelCompletionJournal)
          .where(eq(modelCompletionJournal.completionId, input.completionId))
          .for('update')
          .limit(1);
        if (journal === undefined) throw new CompletionNotFoundError();
        assertIdentity(journal, input);
        if (journal.state === 'completed') {
          const completion = completionRecord(journal);
          return {
            completion,
            credits: creditState(account, ceiling),
            ledgerRowIds: ledgerRowIds(completion),
          };
        }
        if (
          journal.claimOwner !== input.claimOwner ||
          journal.claimExpiresAt === null ||
          journal.claimExpiresAt.getTime() < now().getTime()
        ) {
          throw new CompletionClaimLostError();
        }

        const pricing = loadPricingConfig(account.pricingSnapshotJson);
        const ledgerRows: (typeof usageLedger.$inferInsert)[] = [];
        const outboxRows: (typeof usageOutbox.$inferInsert)[] = [];
        let actualCredits = 0n;
        for (const [attemptIndex, usage] of input.usage.entries()) {
          const priced = priceTokenUsage(pricing, {
            provider: usage.provider,
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
          });
          const parts = [
            ['input', 'model_input_tokens', 'input_tokens', priced.input],
            ['output', 'model_output_tokens', 'output_tokens', priced.output],
            ['cache-read', 'model_cached_tokens', 'cache_read_input_tokens', priced.cacheRead],
            ['cache-write', 'model_cached_tokens', 'cache_write_input_tokens', priced.cacheWrite],
          ] as const;
          for (const [kind, category, unit, part] of parts) {
            const ledgerRowId = deterministicId('usage', input.completionId, attemptIndex, kind);
            actualCredits += creditUnits(part.credits);
            ledgerRows.push({
              id: ledgerRowId,
              organizationId: input.organizationId,
              projectId: input.projectId,
              runId: input.runId,
              taskId: input.taskId ?? null,
              category,
              provider: usage.provider,
              quantity: part.quantity,
              unit,
              costUsd: part.costUsd,
              creditsCharged: part.credits,
              occurredAt: new Date(usage.occurredAt),
            });
            outboxRows.push({
              id: deterministicId('outbox', ledgerRowId),
              organizationId: input.organizationId,
              ledgerRowId,
              eventJson: {
                event_name: category,
                external_customer_id: input.organizationId,
                event_id: ledgerRowId,
                timestamp: usage.occurredAt,
                properties: {
                  project_id: input.projectId,
                  run_id: input.runId,
                  task_id: input.taskId ?? null,
                  quantity: Number(part.quantity),
                  unit,
                  provider: usage.provider,
                },
              },
              status: 'pending',
              attempts: 0,
              nextAttemptAt: now(),
              createdAt: now(),
              publishedAt: null,
            });
          }
        }

        if (actualCredits > creditUnits(journal.reservedCredits)) {
          throw new CompletionUsageExceedsReservationError();
        }

        await tx.insert(usageLedger).values(ledgerRows);
        await tx.insert(usageOutbox).values(outboxRows);
        const [updated] = await tx
          .update(runCreditAccounts)
          .set({
            usedCredits: sql`${runCreditAccounts.usedCredits} + ${credits(actualCredits)}::numeric`,
            reservedCredits: sql`${runCreditAccounts.reservedCredits} - ${journal.reservedCredits}::numeric`,
            version: sql`${runCreditAccounts.version} + 1`,
            updatedAt: now(),
          })
          .where(eq(runCreditAccounts.runId, input.runId))
          .returning();
        if (updated === undefined) throw new Error('locked run credit account disappeared');
        const [completed] = await tx
          .update(modelCompletionJournal)
          .set({
            state: 'completed',
            responseJson: { events: input.events, usage: input.usage },
            terminalJson: input.terminal,
            claimOwner: null,
            claimExpiresAt: null,
            updatedAt: now(),
          })
          .where(eq(modelCompletionJournal.completionId, input.completionId))
          .returning();
        if (completed === undefined) throw new Error('locked completion journal disappeared');
        return {
          completion: completionRecord(completed),
          credits: creditState(updated, ceiling),
          ledgerRowIds: ledgerRows.map((row) => row.id),
        };
      });
      await mirrorSafely(input.runId, result.credits);
      return result;
    },

    async get(organizationId, completionId) {
      const [row] = await database
        .select()
        .from(modelCompletionJournal)
        .where(
          and(
            eq(modelCompletionJournal.organizationId, organizationId),
            eq(modelCompletionJournal.completionId, completionId),
            eq(modelCompletionJournal.state, 'completed'),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : completionRecord(row);
    },

    async increaseCeiling(rawInput) {
      const input = CreditCeilingIncreaseRequestSchema.parse(rawInput);
      const result = await database.transaction(async (tx) => {
        const account = await lockAccount(tx, input.organizationId, input.runId);
        await assertScope(tx, input);
        const [existing] = await tx
          .select()
          .from(runCreditCeilingAdjustments)
          .where(
            and(
              eq(runCreditCeilingAdjustments.runId, input.runId),
              eq(runCreditCeilingAdjustments.operationKey, input.operationKey),
            ),
          )
          .limit(1);
        if (existing !== undefined) {
          if (
            existing.organizationId !== input.organizationId ||
            existing.approvalId !== input.approvalId ||
            normalizeCredits(existing.absoluteCeiling) !== normalizeCredits(input.absoluteCeiling)
          ) {
            throw new CompletionConflictError();
          }
          return creditState(account, await effectiveCeiling(tx, input.runId, account.baseCeiling));
        }

        const [approval] = await tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.id, input.approvalId),
              eq(approvals.organizationId, input.organizationId),
              eq(approvals.runId, input.runId),
            ),
          )
          .limit(1);
        const approvalRequest = approval?.requestJson as { absoluteCeiling?: unknown } | undefined;
        if (
          approval === undefined ||
          approval.type !== 'budget_increase' ||
          approval.status !== 'approved' ||
          approval.resolvedAt === null ||
          approval.resolvedBy === null ||
          approvalRequest?.absoluteCeiling !== input.absoluteCeiling
        ) {
          throw new CreditCeilingIncreaseRejectedError('approval_not_resolved');
        }
        const latestAdjustment = await latestCeilingAdjustment(tx, input.runId);
        const currentCeiling = normalizeCredits(
          latestAdjustment?.absoluteCeiling ?? account.baseCeiling,
        );
        if (creditUnits(input.absoluteCeiling) <= creditUnits(currentCeiling)) {
          throw new CreditCeilingIncreaseRejectedError('not_an_increase');
        }
        const instant = now();
        const createdAt = new Date(
          Math.max(
            instant.getTime(),
            (latestAdjustment?.createdAt.getTime() ?? instant.getTime() - 1) + 1,
          ),
        );
        await tx.insert(runCreditCeilingAdjustments).values({
          id: deterministicId('ceiling', input.runId, input.operationKey),
          organizationId: input.organizationId,
          runId: input.runId,
          approvalId: input.approvalId,
          operationKey: input.operationKey,
          absoluteCeiling: input.absoluteCeiling,
          createdAt,
        });
        const [updated] = await tx
          .update(runCreditAccounts)
          .set({
            version: sql`${runCreditAccounts.version} + 1`,
            updatedAt: now(),
          })
          .where(eq(runCreditAccounts.runId, input.runId))
          .returning();
        if (updated === undefined) throw new Error('locked run credit account disappeared');
        return creditState(updated, input.absoluteCeiling);
      });
      await mirrorSafely(input.runId, result);
      return result;
    },
  };

  async function mirrorSafely(runId: string, credits: CreditState): Promise<void> {
    if (options.mirror === undefined) return;
    try {
      await options.mirror.write(runId, credits);
    } catch (error) {
      options.onMirrorError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

async function lockAccount(executor: Executor, organizationId: string, runId: string) {
  const [account] = await executor
    .select()
    .from(runCreditAccounts)
    .where(
      and(eq(runCreditAccounts.organizationId, organizationId), eq(runCreditAccounts.runId, runId)),
    )
    .for('update')
    .limit(1);
  if (account === undefined) throw new CompletionNotFoundError();
  return account;
}

async function assertScope(
  executor: Executor,
  input: Pick<ModelCompletionClaimRequest, 'organizationId' | 'projectId' | 'runId' | 'taskId'>,
): Promise<void> {
  const [run] = await executor
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, input.runId),
        eq(agentRuns.organizationId, input.organizationId),
        eq(agentRuns.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (run === undefined) throw new CompletionNotFoundError();
  if (input.taskId !== undefined) {
    const [task] = await executor
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .innerJoin(agentPhases, eq(agentPhases.id, agentTasks.phaseId))
      .where(
        and(
          eq(agentTasks.id, input.taskId),
          eq(agentTasks.organizationId, input.organizationId),
          eq(agentPhases.runId, input.runId),
        ),
      )
      .limit(1);
    if (task === undefined) throw new CompletionNotFoundError();
  }
}

async function effectiveCeiling(
  executor: Executor,
  runId: string,
  baseCeiling: string,
): Promise<string> {
  const latest = await latestCeilingAdjustment(executor, runId);
  return normalizeCredits(latest?.absoluteCeiling ?? baseCeiling);
}

async function latestCeilingAdjustment(executor: Executor, runId: string) {
  const [latest] = await executor
    .select({
      absoluteCeiling: runCreditCeilingAdjustments.absoluteCeiling,
      createdAt: runCreditCeilingAdjustments.createdAt,
    })
    .from(runCreditCeilingAdjustments)
    .where(eq(runCreditCeilingAdjustments.runId, runId))
    .orderBy(desc(runCreditCeilingAdjustments.createdAt), desc(runCreditCeilingAdjustments.id))
    .limit(1);
  return latest;
}

function assertIdentity(
  row: typeof modelCompletionJournal.$inferSelect,
  input: Pick<
    ModelCompletionClaimRequest,
    'organizationId' | 'projectId' | 'runId' | 'taskId' | 'requestFingerprint'
  >,
): void {
  if (row.organizationId !== input.organizationId) {
    throw new CompletionNotFoundError();
  }
  if (
    row.projectId !== input.projectId ||
    row.runId !== input.runId ||
    row.taskId !== (input.taskId ?? null) ||
    row.requestFingerprint !== input.requestFingerprint
  ) {
    throw new CompletionConflictError();
  }
}

function completionRecord(row: typeof modelCompletionJournal.$inferSelect): CompletionRecord {
  if (row.state !== 'completed' || row.responseJson === null || row.terminalJson === null) {
    throw new CompletionNotFoundError();
  }
  const response = row.responseJson as { events?: unknown; usage?: unknown };
  return CompletionRecordSchema.parse({
    completionId: row.completionId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    runId: row.runId,
    ...(row.taskId === null ? {} : { taskId: row.taskId }),
    requestFingerprint: row.requestFingerprint,
    events: response.events,
    usage: response.usage,
    terminal: row.terminalJson,
  });
}

function creditState(account: typeof runCreditAccounts.$inferSelect, ceiling: string): CreditState {
  return {
    used: normalizeCredits(account.usedCredits),
    reserved: normalizeCredits(account.reservedCredits),
    ceiling: normalizeCredits(ceiling),
    version: account.version,
  };
}

function normalizeCredits(value: string): string {
  return credits(creditUnits(value));
}

function creditUnits(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction.padEnd(4, '0').slice(0, 4)}`);
}

function credits(value: bigint): string {
  const digits = value.toString().padStart(5, '0');
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

function deterministicId(prefix: string, ...parts: readonly (string | number)[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join(':')).digest('hex')}`;
}

function ledgerRowIds(completion: CompletionRecord): string[] {
  return completion.usage.flatMap((_, index) =>
    ['input', 'output', 'cache-read', 'cache-write'].map((kind) =>
      deterministicId('usage', completion.completionId, index, kind),
    ),
  );
}
