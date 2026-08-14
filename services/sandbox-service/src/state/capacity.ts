import { randomUUID } from 'node:crypto';

import { sandboxCapacityAdmissions, type Database } from '@zapp/db';
import { and, count, eq, isNull, lte, or, sql } from 'drizzle-orm';

import {
  ClaimExpiredInputSchema,
  ExpiredFenceInputSchema,
  GovernorAdmissionDecisionSchema,
  GovernorClaimInputSchema,
  GovernorExpiredClaimSchema,
  GovernorReleaseInputSchema,
  GovernorTerminationCandidateSchema,
  OrganizationListInputSchema,
  RenewExpiredInputSchema,
  type GovernorCapacityPort,
} from '../lifecycle/governor.js';

const advisoryNamespace = 1_727_001;

function sameIdentity(
  row: typeof sandboxCapacityAdmissions.$inferSelect,
  input: ReturnType<typeof GovernorClaimInputSchema.parse>,
): boolean {
  return (
    row.workspaceId === input.workspaceId &&
    row.organizationId === input.organizationId &&
    row.projectId === input.projectId &&
    row.runId === input.runId &&
    row.taskId === input.taskId &&
    row.purpose === input.purpose
  );
}

function expiredClaim(row: typeof sandboxCapacityAdmissions.$inferSelect) {
  return GovernorExpiredClaimSchema.parse({
    workspaceId: row.workspaceId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    runId: row.runId,
    taskId: row.taskId,
    purpose: row.purpose,
    deadlineAt: row.deadlineAt,
    leaseToken: row.leaseToken,
  });
}

function terminationCandidate(row: typeof sandboxCapacityAdmissions.$inferSelect) {
  return GovernorTerminationCandidateSchema.parse({
    workspaceId: row.workspaceId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    runId: row.runId,
    taskId: row.taskId,
    purpose: row.purpose,
    deadlineAt: row.deadlineAt,
  });
}

/** PostgreSQL is the sole capacity and expiry-lease authority for sandbox replicas. */
export function createSandboxCapacityRepository(database: Database): GovernorCapacityPort {
  return {
    async claim(inputValue) {
      const input = GovernorClaimInputSchema.parse(inputValue);
      return await database.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(${advisoryNamespace}, 0)`);
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${advisoryNamespace}, hashtext(${input.organizationId}))`,
        );

        const [existing] = await transaction
          .select()
          .from(sandboxCapacityAdmissions)
          .where(eq(sandboxCapacityAdmissions.operationKey, input.operationKey))
          .limit(1);
        if (existing !== undefined) {
          if (!sameIdentity(existing, input)) {
            throw new Error('Sandbox capacity operation key has a conflicting identity.');
          }
          if (existing.decision === 'queued') {
            return GovernorAdmissionDecisionSchema.parse({
              status: 'queued',
              queuePosition: existing.queuePosition,
            });
          }
          return GovernorAdmissionDecisionSchema.parse({
            status: 'replay',
            deadlineAt: existing.deadlineAt,
          });
        }

        const [globalRow] = await transaction
          .select({ value: count() })
          .from(sandboxCapacityAdmissions)
          .where(eq(sandboxCapacityAdmissions.active, true));
        const [organizationRow] = await transaction
          .select({ value: count() })
          .from(sandboxCapacityAdmissions)
          .where(
            and(
              eq(sandboxCapacityAdmissions.organizationId, input.organizationId),
              eq(sandboxCapacityAdmissions.active, true),
            ),
          );
        if (globalRow === undefined || organizationRow === undefined) {
          throw new Error('Sandbox capacity count query returned no row.');
        }
        const activeGlobal = globalRow.value;
        const activeOrganization = organizationRow.value;

        if (
          activeGlobal >= input.globalLimit ||
          activeOrganization >= input.organizationLimit
        ) {
          const queuePosition = activeOrganization + 1;
          await transaction.insert(sandboxCapacityAdmissions).values({
            workspaceId: input.workspaceId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            runId: input.runId,
            taskId: input.taskId,
            purpose: input.purpose,
            operationKey: input.operationKey,
            decision: 'queued',
            queuePosition,
            requestedAt: input.requestedAt,
            active: false,
          });
          return GovernorAdmissionDecisionSchema.parse({ status: 'queued', queuePosition });
        }

        const deadlineAt = new Date(input.requestedAt.getTime() + input.budgetMs);
        await transaction.insert(sandboxCapacityAdmissions).values({
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          runId: input.runId,
          taskId: input.taskId,
          purpose: input.purpose,
          operationKey: input.operationKey,
          decision: 'admitted',
          requestedAt: input.requestedAt,
          deadlineAt,
          active: true,
        });
        return GovernorAdmissionDecisionSchema.parse({ status: 'admitted', deadlineAt });
      });
    },

    async release(inputValue) {
      const input = GovernorReleaseInputSchema.parse(inputValue);
      await database
        .update(sandboxCapacityAdmissions)
        .set({
          active: false,
          releasedAt: new Date(),
          leaseOwnerId: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sandboxCapacityAdmissions.workspaceId, input.workspaceId),
            eq(sandboxCapacityAdmissions.organizationId, input.organizationId),
            eq(sandboxCapacityAdmissions.active, true),
          ),
        );
    },

    async claimExpired(inputValue) {
      const input = ClaimExpiredInputSchema.parse(inputValue);
      return await database.transaction(async (transaction) => {
        const candidates = await transaction
          .select()
          .from(sandboxCapacityAdmissions)
          .where(
            and(
              eq(sandboxCapacityAdmissions.active, true),
              lte(sandboxCapacityAdmissions.deadlineAt, input.now),
              or(
                isNull(sandboxCapacityAdmissions.leaseExpiresAt),
                lte(sandboxCapacityAdmissions.leaseExpiresAt, input.now),
              ),
            ),
          )
          .orderBy(sandboxCapacityAdmissions.deadlineAt, sandboxCapacityAdmissions.workspaceId)
          .limit(input.limit)
          .for('update', { skipLocked: true });
        const claims = [];
        for (const candidate of candidates) {
          const leaseToken = `${input.ownerId}:${randomUUID()}`;
          const [leased] = await transaction
            .update(sandboxCapacityAdmissions)
            .set({
              leaseOwnerId: input.ownerId,
              leaseToken,
              leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
              updatedAt: input.now,
            })
            .where(eq(sandboxCapacityAdmissions.workspaceId, candidate.workspaceId))
            .returning();
          if (leased !== undefined) claims.push(expiredClaim(leased));
        }
        return claims;
      });
    },

    async renewExpired(inputValue) {
      const input = RenewExpiredInputSchema.parse(inputValue);
      const now = new Date();
      const rows = await database
        .update(sandboxCapacityAdmissions)
        .set({ leaseExpiresAt: new Date(now.getTime() + input.leaseMs), updatedAt: now })
        .where(
          and(
            eq(sandboxCapacityAdmissions.workspaceId, input.workspaceId),
            eq(sandboxCapacityAdmissions.leaseToken, input.leaseToken),
            eq(sandboxCapacityAdmissions.active, true),
          ),
        )
        .returning({ workspaceId: sandboxCapacityAdmissions.workspaceId });
      return rows.length === 1;
    },

    async completeExpired(inputValue) {
      const input = ExpiredFenceInputSchema.parse(inputValue);
      const now = new Date();
      const rows = await database
        .update(sandboxCapacityAdmissions)
        .set({
          active: false,
          releasedAt: now,
          leaseOwnerId: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(sandboxCapacityAdmissions.workspaceId, input.workspaceId),
            eq(sandboxCapacityAdmissions.leaseToken, input.leaseToken),
            eq(sandboxCapacityAdmissions.active, true),
          ),
        )
        .returning({ workspaceId: sandboxCapacityAdmissions.workspaceId });
      if (rows.length !== 1) throw new Error('Sandbox capacity lease token does not match.');
    },

    async releaseExpired(inputValue) {
      const input = ExpiredFenceInputSchema.parse(inputValue);
      const rows = await database
        .update(sandboxCapacityAdmissions)
        .set({
          leaseOwnerId: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sandboxCapacityAdmissions.workspaceId, input.workspaceId),
            eq(sandboxCapacityAdmissions.leaseToken, input.leaseToken),
            eq(sandboxCapacityAdmissions.active, true),
          ),
        )
        .returning({ workspaceId: sandboxCapacityAdmissions.workspaceId });
      if (rows.length !== 1) throw new Error('Sandbox capacity lease token does not match.');
    },

    async listOrganization(inputValue) {
      const input = OrganizationListInputSchema.parse(inputValue);
      const rows = await database
        .select()
        .from(sandboxCapacityAdmissions)
        .where(
          and(
            eq(sandboxCapacityAdmissions.organizationId, input.organizationId),
            eq(sandboxCapacityAdmissions.active, true),
          ),
        )
        .orderBy(sandboxCapacityAdmissions.requestedAt, sandboxCapacityAdmissions.workspaceId);
      return rows.map(terminationCandidate);
    },
  };
}
