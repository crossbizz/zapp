import { createHash } from 'node:crypto';

import { newId } from '@zapp/contracts';
import {
  agentPhases,
  agentRuns,
  agentTasks,
  desktopLocalAgentSessions,
  projects,
  runCreditAccounts,
  type Database,
} from '@zapp/db';
import { and, eq, sql } from 'drizzle-orm';

import type { PricingConfig } from '../usage/pricing.js';
import {
  LocalAgentSessionSchema,
  type LocalAgentSession,
  type LocalAgentSessionRepository,
} from './port.js';

export interface LocalAgentSessionStoreOptions {
  readonly database: Database;
  readonly pricing: PricingConfig;
}

function scopeOf(row: typeof desktopLocalAgentSessions.$inferSelect): LocalAgentSession {
  return LocalAgentSessionSchema.parse({
    sessionId: row.sessionId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    runId: row.runId,
    taskId: row.taskId,
  });
}

/**
 * Creates the accounting identities a desktop-local AR-6 loop needs, without
 * dispatching a cloud workflow. An advisory transaction lock makes the UUID
 * replay boundary atomic even after an HTTP response is lost.
 */
export function createLocalAgentSessionRepository(
  options: LocalAgentSessionStoreOptions,
): LocalAgentSessionRepository {
  const { database, pricing } = options;

  return {
    async get(input) {
      const [row] = await database
        .select()
        .from(desktopLocalAgentSessions)
        .where(
          and(
            eq(desktopLocalAgentSessions.organizationId, input.organizationId),
            eq(desktopLocalAgentSessions.userId, input.userId),
            eq(desktopLocalAgentSessions.sessionId, input.sessionId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : scopeOf(row);
    },
    async ensure(input) {
      return await database.transaction(async (tx) => {
        const lockKey = `desktop-local-agent:${input.organizationId}:${input.userId}:${input.sessionId}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

        const [existing] = await tx
          .select()
          .from(desktopLocalAgentSessions)
          .where(
            and(
              eq(desktopLocalAgentSessions.organizationId, input.organizationId),
              eq(desktopLocalAgentSessions.userId, input.userId),
              eq(desktopLocalAgentSessions.sessionId, input.sessionId),
            ),
          )
          .limit(1);
        if (existing !== undefined) return scopeOf(existing);

        const projectId = newId('proj');
        const runId = newId('run');
        const phaseId = newId('phase');
        const taskId = newId('task');
        const requestFingerprint = createHash('sha256')
          .update(lockKey)
          .digest('hex');

        await tx.insert(projects).values({
          id: projectId,
          organizationId: input.organizationId,
          name: input.localProjectName,
          slug: `local-${projectId.slice('proj_'.length)}`,
          description: 'Private accounting scope for a desktop-local agent session.',
          sourceType: 'desktop_local',
          supportLevel: 'compatible',
          createdBy: input.userId,
          createdAt: input.now,
          archivedAt: input.now,
        });
        await tx.insert(agentRuns).values({
          id: runId,
          organizationId: input.organizationId,
          projectId,
          branchId: null,
          mode: 'build',
          appType: 'web',
          model: null,
          requestFingerprint,
          status: 'running',
          specificationId: null,
          temporalWorkflowId: null,
          startedBy: input.userId,
          budgetJson: { maxCredits: Number(pricing.defaultRunCreditCeiling) },
          startedAt: input.now,
          completedAt: null,
        });
        await tx.insert(agentPhases).values({
          id: phaseId,
          organizationId: input.organizationId,
          runId,
          sequence: 1,
          title: 'Desktop local agent',
          status: 'running',
          acceptanceCriteriaJson: [],
        });
        await tx.insert(agentTasks).values({
          id: taskId,
          organizationId: input.organizationId,
          phaseId,
          parentTaskId: null,
          title: 'Desktop local session',
          status: 'running',
          riskLevel: 'low',
          baseCommitSha: null,
          outputCommitSha: null,
          acceptanceCriteriaJson: [],
          dependenciesJson: [],
          assignedAgentRole: 'builder',
        });
        await tx.insert(runCreditAccounts).values({
          runId,
          organizationId: input.organizationId,
          baseCeiling: pricing.defaultRunCreditCeiling,
          pricingVersion: pricing.version,
          pricingSnapshotJson: pricing,
          usedCredits: '0',
          reservedCredits: '0',
          version: 0,
          updatedAt: input.now,
        });
        const [created] = await tx
          .insert(desktopLocalAgentSessions)
          .values({
            sessionId: input.sessionId,
            organizationId: input.organizationId,
            userId: input.userId,
            projectId,
            runId,
            taskId,
            createdAt: input.now,
          })
          .returning();
        if (created === undefined) throw new Error('local agent session insert returned no row');
        const session = scopeOf(created);
        await input.audit(tx, session);
        return session;
      });
    },
  };
}
