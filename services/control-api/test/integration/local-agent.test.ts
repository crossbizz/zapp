import { newId } from '@zapp/contracts';
import { auditEvents } from '@zapp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLocalAgentSessionRepository } from '../../src/local-agent/store.js';
import { createDbAuditSink } from '../../src/plugins/audit.js';
import { loadPlanLimitsConfig } from '../../src/usage/limits.js';
import { TEST_PRICING } from '../support/harness.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

const TEST_PLANS = loadPlanLimitsConfig({
  trial: {
    concurrentAutonomousRuns: 1, concurrentSandboxes: 1, maxResourceProfile: 'small',
    maxRunBudgetCredits: '10.0000', maxPreviewLifetimeHours: 1, artifactRetentionDays: 7,
    monthlyCredits: '10.0000', seats: 1,
  },
  builder: {
    concurrentAutonomousRuns: 3, concurrentSandboxes: 3, maxResourceProfile: 'standard',
    maxRunBudgetCredits: '100.0000', maxPreviewLifetimeHours: 24, artifactRetentionDays: 30,
    monthlyCredits: '100.0000', seats: 3,
  },
  studio: {
    concurrentAutonomousRuns: 10, concurrentSandboxes: 10, maxResourceProfile: 'large',
    maxRunBudgetCredits: '1000.0000', maxPreviewLifetimeHours: 168, artifactRetentionDays: 90,
    monthlyCredits: '1000.0000', seats: 10,
  },
});

describe.skipIf(!hasDatabase)('MAC-6 local-agent accounting scope', () => {
  let database: TestDatabase;
  let organizationId = '';
  let userId = '';

  beforeAll(async () => {
    database = await setUpTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.truncateIdentity();
    organizationId = newId('org');
    userId = newId('user');
    await database.sql.begin(async (tx) => {
      await tx`insert into users (id, email, display_name)
               values (${userId}, ${`${userId}@test.invalid`}, 'Desktop owner')`;
      await tx`insert into organizations (id, name, slug, plan)
               values (${organizationId}, 'Desktop local', ${organizationId}, 'trial')`;
    });
  });

  it('atomically creates and concurrently replays one hidden local run/task/accounting scope', async () => {
    const repository = createLocalAgentSessionRepository({
      database: database.db,
      pricing: TEST_PRICING,
      plans: TEST_PLANS,
    });
    const audit = createDbAuditSink(database.db);
    const sessionId = '01912f8f-6cb0-7a52-9d3d-2b24f32062b0';
    const now = new Date('2026-08-10T12:00:00.000Z');
    const input = {
      sessionId,
      organizationId,
      userId,
      localProjectName: 'Checkout prototype',
      now,
      audit: async (tx: Parameters<typeof audit.record>[0], session: { runId: string }) => {
        await audit.record(tx, {
          organizationId,
          actorType: 'user',
          actorId: userId,
          action: 'run.created',
          targetType: 'run',
          targetId: session.runId,
          metadata: { mode: 'local', sessionId },
          occurredAt: now,
        });
      },
    };

    const [first, replay] = await Promise.all([
      repository.ensure(input),
      repository.ensure({ ...input, localProjectName: 'Renamed locally' }),
    ]);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({ sessionId, organizationId });

    const [counts] = await database.sql<{
      sessions: string;
      projects: string;
      runs: string;
      phases: string;
      tasks: string;
      accounts: string;
      audits: string;
    }[]>`
      select
        (select count(*)::text from desktop_local_agent_sessions where organization_id = ${organizationId} and user_id = ${userId} and session_id = ${sessionId}) as sessions,
        (select count(*)::text from projects where organization_id = ${organizationId} and source_type = 'desktop_local' and archived_at is not null) as projects,
        (select count(*)::text from agent_runs where organization_id = ${organizationId} and temporal_workflow_id is null and status = 'running') as runs,
        (select count(*)::text from agent_phases where organization_id = ${organizationId}) as phases,
        (select count(*)::text from agent_tasks where organization_id = ${organizationId}) as tasks,
        (select count(*)::text from run_credit_accounts where organization_id = ${organizationId}) as accounts,
        (select count(*)::text from audit_events where organization_id = ${organizationId} and action = 'run.created') as audits
    `;
    expect(counts).toEqual({
      sessions: '1',
      projects: '1',
      runs: '1',
      phases: '1',
      tasks: '1',
      accounts: '1',
      audits: '1',
    });

    const [stored] = await database.sql<{
      projectId: string;
      runId: string;
      taskId: string;
      baseCeiling: string;
      planMaxCredits: string;
    }[]>`
      select session.project_id as "projectId", session.run_id as "runId",
             session.task_id as "taskId", account.base_ceiling::text as "baseCeiling",
             run.plan_max_credits::text as "planMaxCredits"
        from desktop_local_agent_sessions session
        join run_credit_accounts account on account.run_id = session.run_id
        join agent_runs run on run.id = session.run_id
       where session.organization_id = ${organizationId}
         and session.user_id = ${userId}
         and session.session_id = ${sessionId}
    `;
    expect(stored).toEqual({
      projectId: first.projectId,
      runId: first.runId,
      taskId: first.taskId,
      baseCeiling: '10.0000',
      planMaxCredits: '10.0000',
    });
    expect(
      await database.db
        .select({ id: auditEvents.id })
        .from(auditEvents),
    ).toHaveLength(1);
  });

  it('keeps a replay on its immutable trial cap and resolves a later session at builder cap', async () => {
    const repository = createLocalAgentSessionRepository({
      database: database.db,
      pricing: TEST_PRICING,
      plans: TEST_PLANS,
    });
    const now = new Date('2026-08-10T12:00:00.000Z');
    const makeInput = (sessionId: string) => ({
      sessionId,
      organizationId,
      userId,
      localProjectName: 'Immutable desktop budget',
      now,
      audit: async () => {
        await Promise.resolve();
      },
    });
    const trial = await repository.ensure(makeInput('01912f8f-6cb0-7a52-9d3d-2b24f32062c0'));
    await database.sql`update organizations set plan = 'builder' where id = ${organizationId}`;
    const replay = await repository.ensure(makeInput('01912f8f-6cb0-7a52-9d3d-2b24f32062c0'));
    const builder = await repository.ensure(makeInput('01912f8f-6cb0-7a52-9d3d-2b24f32062c1'));

    expect(replay).toEqual(trial);
    const caps = await database.sql<{ sessionId: string; planMax: string; baseCeiling: string }[]>`
      select session.session_id as "sessionId", run.plan_max_credits::text as "planMax",
             account.base_ceiling::text as "baseCeiling"
        from desktop_local_agent_sessions session
        join agent_runs run on run.id = session.run_id
        join run_credit_accounts account on account.run_id = session.run_id
       where session.organization_id = ${organizationId}
       order by session.session_id
    `;
    expect(caps).toEqual([
      { sessionId: trial.sessionId, planMax: '10.0000', baseCeiling: '10.0000' },
      { sessionId: builder.sessionId, planMax: '100.0000', baseCeiling: '100.0000' },
    ]);
  });
});
