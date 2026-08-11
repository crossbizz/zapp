import { fileURLToPath } from 'node:url';

import { newId } from '@zapp/contracts';
import { Worker } from '@temporalio/worker';
import { createDb } from '@zapp/db';
import type { GateContext, GateId } from '@zapp/verification-engine';
import { decideVerification } from '@zapp/verification-engine';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import { executeIdempotentActivity } from '../../src/activities/idempotency.js';
import {
  createVerifyPhaseActivities,
  createPostgresPhaseVerificationCompletionPort,
  CompletePhaseVerificationInputSchema,
  PhaseVerificationContextSchema,
  type CompletePhaseVerificationInput,
} from '../../src/activities/verify-phase.js';
import { createProductionVerificationWorker } from '../../src/worker.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
if (DATABASE_URL === '') {
  throw new Error('VF-10 Postgres integration requires DATABASE_URL');
}
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../../../packages/db/drizzle', import.meta.url),
);
const DUPLICATE_DATABASE = '42P04';

async function vf10TestDatabaseUrl(): Promise<string> {
  const testUrl = new URL(DATABASE_URL);
  const sourceName = decodeURIComponent(testUrl.pathname.replace(/^\//u, ''));
  const testName = `${sourceName.replace(/_vf10_test$/u, '')}_vf10_test`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(testName)) {
    throw new Error('VF-10 integration database name is invalid');
  }
  testUrl.pathname = `/${testName}`;
  const maintenanceUrl = new URL(testUrl);
  maintenanceUrl.pathname = '/postgres';
  const admin = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => undefined });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      select exists(select 1 from pg_database where datname = ${testName}) as exists
    `;
    if (existing[0]?.exists !== true) await admin.unsafe(`create database "${testName}"`);
  } catch (error: unknown) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      (error as { readonly code?: unknown }).code !== DUPLICATE_DATABASE
    ) {
      throw error;
    }
  } finally {
    await admin.end();
  }
  return testUrl.toString();
}

const ids = {
  runId: 'run_01J00000000000000000000000',
  phaseId: 'phase_01J00000000000000000000000',
  taskId: 'task_01J00000000000000000000000',
  organizationId: 'org_01J00000000000000000000000',
  projectId: 'proj_01J00000000000000000000000',
} as const;
const commitSha = 'a'.repeat(40);
const phaseContext = {
  ...ids,
  supportLevel: 'verified',
  projectPolicy: { waivers: [] },
  criticalCriterionIds: ['AC-1'],
  criterionAssembly: {
    specificationVersion: 3,
    criteria: [{ criterionId: 'AC-1' }],
    tasks: [{ taskId: ids.taskId, acceptanceCriteriaIds: ['AC-1'] }],
    testCases: [],
    waivers: [],
  },
} as const;

describe('VF-10 verifier decision engine', () => {
  test('uses evidence precedence for all three decision outcomes', () => {
    const passedCriterion = {
      criterionId: 'AC-1',
      specificationVersion: 1,
      taskIds: [ids.taskId],
      testCaseIds: ['tcase_01'],
      result: 'passed' as const,
      evidenceArtifactIds: ['art_01'],
      verifierComments: [],
    };

    expect(
      decideVerification({ gateEvaluations: [], criteria: [passedCriterion], criticalCriterionIds: [] })
        .decision,
    ).toBe('approved');
    expect(
      decideVerification({
        gateEvaluations: [],
        criteria: [{ ...passedCriterion, testCaseIds: [], result: 'unverified' }],
        criticalCriterionIds: [],
      }).decision,
    ).toBe('needs_human');
    expect(
      decideVerification({
        gateEvaluations: [
          {
            gateId: 'unit_tests',
            class: 'required',
            result: { status: 'failed', evidenceArtifactIds: ['art_gate'], details: {} },
          },
        ],
        criteria: [passedCriterion],
        criticalCriterionIds: [],
      }).decision,
    ).toBe('rejected');
  });

  test('rejects a gate-originated waiver without an actor-attributed policy waiver', () => {
    expect(() =>
      decideVerification({
        gateEvaluations: [
          {
            gateId: 'typecheck',
            class: 'required_or_explicit_waiver',
            result: { status: 'waived', evidenceArtifactIds: [], details: {} },
          },
        ],
        criteria: [
          {
            criterionId: 'AC-1',
            specificationVersion: 1,
            taskIds: [ids.taskId],
            testCaseIds: ['tcase_01'],
            result: 'passed',
            evidenceArtifactIds: ['art_01'],
            verifierComments: [],
          },
        ],
        criticalCriterionIds: [],
      }),
    ).toThrow('verifier_unauthorized_gate_waiver');
  });

  test('rejects a successful blocking gate that produced no evidence artifact', () => {
    const result = decideVerification({
      gateEvaluations: [
        {
          gateId: 'secret_scan',
          class: 'required',
          result: { status: 'passed', evidenceArtifactIds: [], details: {} },
        },
      ],
      criteria: [
        {
          criterionId: 'AC-1',
          specificationVersion: 1,
          taskIds: [ids.taskId],
          testCaseIds: ['tcase_01'],
          result: 'passed',
          evidenceArtifactIds: ['art_01'],
          verifierComments: [],
        },
      ],
      criticalCriterionIds: [],
    });

    expect(result.decision).toBe('rejected');
    expect(result.risks).toContainEqual(
      expect.objectContaining({ code: 'gate_evidence_missing', gateId: 'secret_scan' }),
    );
  });
});

describe('VF-10 independent verifyPhase activity', () => {
  test('rejects preloaded test cases at the phase-context trust boundary', () => {
    expect(
      PhaseVerificationContextSchema.safeParse({
        ...phaseContext,
        criterionAssembly: {
          ...phaseContext.criterionAssembly,
          testCases: [
            {
              testCaseId: 'tcase_builder',
              name: '[AC-1] Builder-claimed pass',
              status: 'passed',
              evidenceArtifactIds: [],
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  test('rejects a completion whose operation key does not match its scoped payload', () => {
    expect(
      CompletePhaseVerificationInputSchema.safeParse({
        operationKey: 'verify-phase:another-scope',
        row: {
          organizationId: ids.organizationId,
          runId: ids.runId,
          taskId: ids.taskId,
          commitSha,
          decision: 'approved',
          criteriaResultsJson: [
            {
              criterionId: 'AC-1',
              specificationVersion: 1,
              taskIds: [ids.taskId],
              testCaseIds: ['tcase_01'],
              result: 'passed',
              evidenceArtifactIds: ['art_01'],
              verifierComments: [],
            },
          ],
          risksJson: [],
        },
        task: { taskId: ids.taskId, status: 'passed' },
        event: {
          organizationId: ids.organizationId,
          projectId: ids.projectId,
          runId: ids.runId,
          phaseId: ids.phaseId,
          taskId: ids.taskId,
          agentId: 'verifier',
          type: 'verification.completed',
          visibility: 'user',
          payload: {
            decision: 'approved',
            commitSha,
            criteriaCount: 1,
            riskCount: 0,
          },
        },
      }).success,
    ).toBe(false);
  });

  test('rejects a Builder done claim when an independently rerun gate fails', async () => {
    const builderSessionReport = {
      status: 'done',
      claimedGateResults: { unit_tests: 'passed' },
    } as const;
    const gateCalls: GateId[] = [];
    const workspaceOpenCalls: unknown[] = [];
    const contextLoadCalls: unknown[] = [];
    const antiSlopRun = vi.fn(() =>
      Promise.resolve([
        {
          id: 'states-check' as const,
          severity: 'warning' as const,
          locations: [{ path: 'src/routes/checkout.tsx', line: 12 }],
          autofixable: false,
        },
      ]),
    );
    let workspaceClosed = false;
    let completion: CompletePhaseVerificationInput | undefined;

    const activities = createVerifyPhaseActivities({
      phaseContext: {
        load(runId, phaseId) {
          contextLoadCalls.push({ runId, phaseId });
          return Promise.resolve(phaseContext);
        },
      },
      workspaces: {
        open(input) {
          workspaceOpenCalls.push(input);
          return Promise.resolve({
            resolvedCommitSha: commitSha,
            gateContext: { commit: commitSha } as GateContext,
            close() {
              workspaceClosed = true;
              return Promise.resolve();
            },
          });
        },
      },
      gates: {
        run(gateId) {
          gateCalls.push(gateId);
          if (gateId === 'browser_acceptance') {
            return Promise.resolve({
              result: { status: 'passed', evidenceArtifactIds: ['art_browser'], details: {} },
              testCases: [
                {
                  testCaseId: 'tcase_01',
                  name: '[AC-1] completes the critical flow',
                  status: 'passed',
                  evidenceArtifactIds: ['art_browser'],
                },
              ],
            });
          }
          return Promise.resolve({
            result:
              gateId === 'unit_tests'
                ? { status: 'failed', evidenceArtifactIds: ['art_unit'], details: { exitCode: 1 } }
                : { status: 'passed', evidenceArtifactIds: [`art_${gateId}`], details: {} },
            testCases: [],
          });
        },
      },
      antiSlop: { run: antiSlopRun },
      completion: {
        complete(input) {
          completion = input;
          return Promise.resolve({
            verificationResultId: 'vr_01J00000000000000000000000',
          });
        },
      },
    });

    const verifyPhase = activities.verifyPhase.bind(activities);
    expect(verifyPhase).toHaveLength(3);
    const result = await verifyPhase(ids.runId, ids.phaseId, commitSha);

    expect(builderSessionReport).toEqual({
      status: 'done',
      claimedGateResults: { unit_tests: 'passed' },
    });
    expect(contextLoadCalls).toEqual([{ runId: ids.runId, phaseId: ids.phaseId }]);
    expect(workspaceOpenCalls).toEqual([
      {
        runId: ids.runId,
        phaseId: ids.phaseId,
        commitSha,
        networkProfile: 'restricted_verification',
      },
    ]);
    expect(gateCalls).toContain('browser_acceptance');
    expect(gateCalls).toContain('unit_tests');
    expect(gateCalls).not.toContain('observability_check');
    expect(workspaceClosed).toBe(true);
    expect(antiSlopRun).toHaveBeenCalledWith(
      expect.objectContaining({ supportLevel: 'verified' }),
    );
    expect(result.decision).toBe('rejected');
    const policyRisk = result.risks.find(({ code }) => code === 'policy_signal');
    expect(policyRisk).toMatchObject({ code: 'policy_signal', severity: 'warning' });
    expect(policyRisk?.policySignal?.id).toBe('states-check');
    expect(result.criteriaResults).toEqual([
      expect.objectContaining({ criterionId: 'AC-1', result: 'passed' }),
    ]);
    expect(completion).toBeDefined();
    if (completion === undefined) throw new Error('verification completion missing');
    expect(completion.operationKey).toBe(`verify-phase:${ids.runId}:${ids.phaseId}:${commitSha}`);
    expect(completion.row).toMatchObject({
      runId: ids.runId,
      taskId: ids.taskId,
      commitSha,
      decision: 'rejected',
      criteriaResultsJson: result.criteriaResults,
      risksJson: result.risks,
    });
    expect(completion.task).toEqual({ taskId: ids.taskId, status: 'repairing' });
    expect(completion.event).toMatchObject({
      runId: ids.runId,
      phaseId: ids.phaseId,
      taskId: ids.taskId,
      agentId: 'verifier',
      type: 'verification.completed',
      visibility: 'user',
    });
    expect(completion.event.payload['decision']).toBe('rejected');
    expect(completion.event.payload['commitSha']).toBe(commitSha);
    expect(completion.event.payload).not.toHaveProperty('verificationResultId');
    expect(result.verificationResultId).toBe('vr_01J00000000000000000000000');
  });

  test('uses only browser acceptance cases to settle critical-flow criteria', async () => {
    const activity = createVerifyPhaseActivities({
      phaseContext: { load: () => Promise.resolve(phaseContext) },
      workspaces: {
        open: () =>
          Promise.resolve({
            resolvedCommitSha: commitSha,
            gateContext: { commit: commitSha } as GateContext,
            close: () => Promise.resolve(),
          }),
      },
      gates: {
        run(gateId) {
          return Promise.resolve({
            result: { status: 'passed', evidenceArtifactIds: [`art_${gateId}`], details: {} },
            testCases:
              gateId === 'unit_tests'
                ? [
                    {
                      testCaseId: 'tcase_unit_01',
                      name: '[AC-1] unit-level name collision',
                      status: 'passed',
                      evidenceArtifactIds: ['art_unit_tests'],
                    },
                  ]
                : [],
          });
        },
      },
      antiSlop: { run: () => Promise.resolve([]) },
      completion: {
        complete: () =>
          Promise.resolve({ verificationResultId: 'vr_01J00000000000000000000001' }),
      },
    });

    const result = await activity.verifyPhase(ids.runId, ids.phaseId, commitSha);

    expect(result.decision).toBe('rejected');
    expect(result.criteriaResults).toEqual([
      expect.objectContaining({ criterionId: 'AC-1', result: 'unverified' }),
    ]);
  });

  test('runs Compatible advisory dependency scans and records their warning result', async () => {
    const gateCalls: GateId[] = [];
    const complete = vi.fn(() =>
      Promise.resolve({ verificationResultId: 'vr_01J00000000000000000000003' }),
    );
    const activity = createVerifyPhaseActivities({
      phaseContext: {
        load: () => Promise.resolve({ ...phaseContext, supportLevel: 'compatible' as const }),
      },
      workspaces: {
        open: () =>
          Promise.resolve({
            resolvedCommitSha: commitSha,
            gateContext: { commit: commitSha } as GateContext,
            close: () => Promise.resolve(),
          }),
      },
      gates: {
        run(gateId) {
          gateCalls.push(gateId);
          return Promise.resolve({
            result:
              gateId === 'dependency_scan'
                ? {
                    status: 'failed',
                    evidenceArtifactIds: ['art_dependency_scan'],
                    details: { criticalCount: 1 },
                  }
                : {
                    status: 'passed',
                    evidenceArtifactIds: [`art_${gateId}`],
                    details: {},
                  },
            testCases: [],
          });
        },
      },
      antiSlop: { run: () => Promise.resolve([]) },
      completion: { complete },
    });

    const result = await activity.verifyPhase(ids.runId, ids.phaseId, commitSha);

    expect(gateCalls).toContain('dependency_scan');
    expect(result.risks).toContainEqual(
      expect.objectContaining({
        code: 'gate_failed',
        severity: 'warning',
        gateId: 'dependency_scan',
      }),
    );
    expect(complete).toHaveBeenCalledOnce();
  });

  test('derives an exact retry key for the three-argument verifier activity', async () => {
    const claim = vi.fn(() => Promise.resolve({ status: 'acquired' as const }));
    const complete = vi.fn(() => Promise.resolve(true));
    const next = vi.fn(() =>
      Promise.resolve({ verificationResultId: 'vr_01J00000000000000000000002' }),
    );

    await executeIdempotentActivity({
      store: {
        claim,
        renew: () => Promise.resolve(true),
        complete,
        release: () => Promise.resolve(),
      },
      activityType: 'verifyPhase',
      args: [ids.runId, ids.phaseId, commitSha],
      ownerId: 'worker-1',
      leaseMs: 30_000,
      renewIntervalMs: 10_000,
      next,
    });

    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `verify-phase:${ids.runId}:${ids.phaseId}:${commitSha}`,
      }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('registers verifyPhase with the production verification worker', async () => {
    const created = { run: vi.fn() };
    const create = vi.spyOn(Worker, 'create').mockResolvedValueOnce(created as never);
    const scanProjectCapabilities = vi.fn();
    const verifyPhase = vi.fn();
    const verifyFixCandidate = vi.fn();
    const repairTask = vi.fn();
    try {
      await expect(
        createProductionVerificationWorker({
          connection: {} as never,
          activities: { scanProjectCapabilities, verifyPhase, verifyFixCandidate, repairTask },
          database: {} as never,
        }),
      ).resolves.toBe(created);
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        taskQueue: 'verification',
        activities: { scanProjectCapabilities, verifyPhase, verifyFixCandidate, repairTask },
      });
    } finally {
      create.mockRestore();
    }
  });

  test('atomically replays one result, task transition, and sequenced event', async () => {
    const database = createDb(await vf10TestDatabaseUrl());
    const fixture = {
      organizationId: newId('org'),
      userId: newId('user'),
      projectId: newId('proj'),
      runId: newId('run'),
      phaseId: newId('phase'),
      taskId: newId('task'),
    };
    const fixtureCommit = 'b'.repeat(40);
    let schemaReady = false;
    try {
      await migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER });
      schemaReady = true;
      await database.sql`
        insert into users (id, email, display_name)
        values (${fixture.userId}, ${`${fixture.userId}@example.test`}, 'Verifier test')
      `;
      await database.sql`
        insert into organizations (id, name, slug)
        values (${fixture.organizationId}, 'Verifier test', ${fixture.organizationId})
      `;
      await database.sql`
        insert into projects
          (id, organization_id, name, slug, source_type, support_level, created_by)
        values
          (${fixture.projectId}, ${fixture.organizationId}, 'Verifier test', ${fixture.projectId},
           'prompt', 'verified', ${fixture.userId})
      `;
      await database.sql`
        insert into agent_runs
          (id, organization_id, project_id, mode, app_type, request_fingerprint, status, started_by)
        values
          (${fixture.runId}, ${fixture.organizationId}, ${fixture.projectId}, 'build', 'web',
           ${'c'.repeat(64)}, 'running', ${fixture.userId})
      `;
      await database.sql`
        insert into agent_phases
          (id, organization_id, run_id, sequence, title, status, acceptance_criteria_json)
        values
          (${fixture.phaseId}, ${fixture.organizationId}, ${fixture.runId}, 1, 'Verify', 'running', '[]')
      `;
      await database.sql`
        insert into agent_tasks
          (id, organization_id, phase_id, title, status, risk_level,
           acceptance_criteria_json, dependencies_json)
        values
          (${fixture.taskId}, ${fixture.organizationId}, ${fixture.phaseId}, 'Verify', 'verifying',
           'high', '[]', '[]')
      `;

      const completion = createPostgresPhaseVerificationCompletionPort(database.db);
      const input: CompletePhaseVerificationInput = {
        operationKey: `verify-phase:${fixture.runId}:${fixture.phaseId}:${fixtureCommit}`,
        row: {
          organizationId: fixture.organizationId,
          runId: fixture.runId,
          taskId: fixture.taskId,
          commitSha: fixtureCommit,
          decision: 'rejected',
          criteriaResultsJson: [
            {
              criterionId: 'AC-1',
              specificationVersion: 1,
              taskIds: [fixture.taskId],
              testCaseIds: [],
              result: 'unverified',
              evidenceArtifactIds: [],
              verifierComments: ['No browser evidence.'],
            },
          ],
          risksJson: [
            {
              code: 'critical_criterion_unverified',
              severity: 'blocking',
              criterionId: 'AC-1',
              summary: 'AC-1 has no browser evidence.',
            },
          ],
        },
        task: { taskId: fixture.taskId, status: 'repairing' },
        event: {
          runId: fixture.runId,
          organizationId: fixture.organizationId,
          projectId: fixture.projectId,
          phaseId: fixture.phaseId,
          taskId: fixture.taskId,
          agentId: 'verifier',
          type: 'verification.completed',
          visibility: 'user',
          payload: {
            decision: 'rejected',
            commitSha: fixtureCommit,
            criteriaCount: 1,
            riskCount: 1,
          },
        },
      };

      const first = await completion.complete(input);
      const replay = await completion.complete(input);

      expect(replay).toEqual(first);
      const [state] = await database.sql<
        Array<{ status: string; result_count: number; event_count: number; event_result_id: string }>
      >`
        select t.status,
               (select count(*)::int from verification_results where run_id = ${fixture.runId}) as result_count,
               (select count(*)::int from agent_events where run_id = ${fixture.runId}) as event_count,
               (select payload_json->>'verificationResultId' from agent_events
                 where run_id = ${fixture.runId} limit 1) as event_result_id
          from agent_tasks t
         where t.id = ${fixture.taskId}
      `;
      expect(state).toMatchObject({
        status: 'repairing',
        result_count: 1,
        event_count: 1,
        event_result_id: first.verificationResultId,
      });
    } finally {
      if (schemaReady) {
        await database.sql`delete from agent_events where run_id = ${fixture.runId}`;
        await database.sql`delete from run_event_counters where run_id = ${fixture.runId}`;
        await database.sql`delete from verification_results where run_id = ${fixture.runId}`;
        await database.sql`delete from agent_tasks where id = ${fixture.taskId}`;
        await database.sql`delete from agent_phases where id = ${fixture.phaseId}`;
        await database.sql`delete from agent_runs where id = ${fixture.runId}`;
        await database.sql`delete from projects where id = ${fixture.projectId}`;
        await database.sql`delete from organizations where id = ${fixture.organizationId}`;
        await database.sql`delete from users where id = ${fixture.userId}`;
      }
      await database.close();
    }
  }, 30_000);
});
