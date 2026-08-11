import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { newId } from '@zapp/contracts';
import { createDb } from '@zapp/db';
import type {
  FailureModelClassificationRequest,
  RepairBuilderInput,
  RepairCheckResult,
  RepairEscalation,
  RepairLoopInput,
} from '@zapp/verification-engine';
import { RepairLoopInputSchema } from '@zapp/verification-engine';
import type { ExecResult, WorkspaceRuntime } from '@zapp/workspace-runtime';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRepairActivities } from '../../src/activities/repair.js';
import {
  createModelGatewayFailureClassifier,
  createPostgresRepairLifecycle,
  createWorkspaceRepairCommitPort,
} from '../../src/activities/repair-production.js';

const executeFile = promisify(execFile);
const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/drizzle', import.meta.url),
);
const fixtureRoots: string[] = [];
const ids = {
  runId: 'run_01J00000000000000000000000',
  phaseId: 'phase_01J00000000000000000000000',
  taskId: 'task_01J00000000000000000000000',
  organizationId: 'org_01J00000000000000000000000',
  projectId: 'proj_01J00000000000000000000000',
} as const;

async function vf13TestDatabaseUrl(): Promise<string> {
  const configured = process.env['DATABASE_URL'];
  if (configured === undefined || configured === '') {
    throw new Error('VF-13 Postgres integration requires DATABASE_URL');
  }
  const testUrl = new URL(configured);
  const sourceName = decodeURIComponent(testUrl.pathname.replace(/^\//u, ''));
  const testName = `${sourceName.replace(/_vf13_test$/u, '')}_vf13_test`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(testName)) {
    throw new Error('VF-13 integration database name is invalid');
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
  } finally {
    await admin.end();
  }
  return testUrl.toString();
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await executeFile('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

async function runtimeExec(root: string, command: string, args: string[]): Promise<ExecResult> {
  try {
    const result = await executeFile(command, args, { cwd: root, encoding: 'utf8' });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: 0,
      truncated: false,
    };
  } catch (error: unknown) {
    return {
      exitCode:
        error instanceof Error && 'code' in error && typeof error.code === 'number'
          ? error.code
          : 1,
      stdout:
        error instanceof Error && 'stdout' in error && typeof error.stdout === 'string'
          ? error.stdout
          : '',
      stderr:
        error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr
          : String(error),
      durationMs: 0,
      truncated: false,
    };
  }
}

async function createFixture(options: { readonly contradictory: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zapp-vf13-'));
  fixtureRoots.push(root);
  await git(root, 'init');
  await git(root, 'config', 'user.name', 'zapp repair test');
  await git(root, 'config', 'user.email', 'zapp-repair@example.invalid');
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'test'));
  await writeFile(
    join(root, 'src/math.mjs'),
    options.contradictory
      ? 'export function add(left, right) { return left + right; }\n'
      : 'export function add(left, right) { return left - right; }\n',
  );
  await writeFile(
    join(root, 'test/math.test.mjs'),
    options.contradictory
      ? [
          "import assert from 'node:assert/strict';",
          "import test from 'node:test';",
          "import { add } from '../src/math.mjs';",
          "test('contradictory fixture', () => {",
          '  assert.equal(add(1, 1), 2);',
          '  assert.equal(add(1, 1), 3);',
          '});',
          '',
        ].join('\n')
      : [
          "import assert from 'node:assert/strict';",
          "import test from 'node:test';",
          "import { add } from '../src/math.mjs';",
          "test('adds numbers', () => assert.equal(add(1, 1), 2));",
          '',
        ].join('\n'),
  );
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'seed failing test');
  return root;
}

async function repairInput(root: string, output: string): Promise<RepairLoopInput> {
  return {
    ...ids,
    idempotencyKey: `${ids.runId}:${ids.taskId}:repair:unit-tests`,
    failingCommitSha: await git(root, 'rev-parse', 'HEAD'),
    affectedGateIds: ['unit_tests'],
    failure: {
      failureId: 'failure-unit-tests',
      gateId: 'unit_tests',
      fingerprint: 'unit-tests:add',
      output,
      evidenceArtifactIds: ['art_initial_failure'],
      relatedFiles: ['src/math.mjs', 'test/math.test.mjs'],
      criterion: { id: 'AC-1', text: 'Adding one and one returns two.' },
      diff: {
        changedFiles: ['src/math.mjs'],
        summary: `${root}: seeded arithmetic implementation`,
      },
      retriedPass: false,
      knownFlakeFingerprints: [],
      protectedFailure: null,
    },
  };
}

async function runTestCheck(
  root: string,
  kind: 'targeted' | 'affected',
  sequence: number,
): Promise<RepairCheckResult> {
  try {
    await executeFile('node', ['--test', 'test/math.test.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    return {
      status: 'passed',
      evidenceArtifactIds: [`art_${kind}_${String(sequence)}_passed`],
      output: `${kind} check passed`,
    };
  } catch (error: unknown) {
    const output =
      error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : String(error);
    return {
      status: 'failed',
      evidenceArtifactIds: [`art_${kind}_${String(sequence)}_failed`],
      output,
    };
  }
}

function createHarness(options: {
  readonly root: string;
  readonly contradictory?: boolean;
  readonly repairWithDistinctPassingCommits?: boolean;
  readonly affectedChecks?: readonly RepairCheckResult[];
}) {
  const builderInputs: RepairBuilderInput[] = [];
  const escalations: RepairEscalation[] = [];
  const successfulOutcomes: unknown[] = [];
  const calls: string[] = [];
  const stageKeys: string[] = [];
  const modelRequests: FailureModelClassificationRequest[] = [];
  let affectedIndex = 0;
  const modelClassifier = vi.fn((input: FailureModelClassificationRequest) => {
    modelRequests.push(input);
    return Promise.resolve({
      classification: 'product_code',
      reason: 'The changed implementation disagrees with the acceptance criterion.',
    });
  });
  const commitPort = createWorkspaceRepairCommitPort({
    resolve: () =>
      Promise.resolve({
        exec: (input: { readonly cmd: string; readonly args: string[] }) =>
          runtimeExec(options.root, input.cmd, input.args),
      } as unknown as WorkspaceRuntime),
  });

  const activities = createRepairActivities({
    redact: (value) => value.replaceAll(options.root, '<workspace>'),
    modelClassifier: { classify: modelClassifier },
    repairTasks: {
      create(input) {
        calls.push('task:create');
        stageKeys.push(input.idempotencyKey);
        expect(input.context.failingGate.output).not.toContain(options.root);
        expect(input.context).toEqual({
          criterion: { id: 'AC-1', text: 'Adding one and one returns two.' },
          failingGate: {
            gateId: 'unit_tests',
            output: input.context.failingGate.output,
            evidenceArtifactIds: ['art_initial_failure'],
          },
          relatedFiles: ['src/math.mjs', 'test/math.test.mjs'],
        });
        return Promise.resolve({ repairTaskId: 'task_01J00000000000000000000001' });
      },
    },
    builder: {
      async repair(input) {
        calls.push(`builder:${String(input.iteration)}`);
        stageKeys.push(input.idempotencyKey);
        builderInputs.push(input);
        const branchName = `task/${input.repairTaskId}`;
        if (input.iteration === 1) {
          await git(options.root, 'checkout', '-b', branchName);
        }
        const parentCommitSha = await git(options.root, 'rev-parse', 'HEAD');
        if (options.contradictory === true) {
          const file = join(options.root, 'src/math.mjs');
          const existing = await readFile(file, 'utf8');
          await writeFile(file, `${existing}// repair ${String(input.iteration)}\n`);
        } else if (options.repairWithDistinctPassingCommits === true) {
          const file = join(options.root, 'src/math.mjs');
          const existing =
            input.iteration === 1
              ? 'export function add(left, right) { return left + right; }\n'
              : await readFile(file, 'utf8');
          await writeFile(file, `${existing}// repair ${String(input.iteration)}\n`);
        } else {
          await writeFile(
            join(options.root, 'src/math.mjs'),
            'export function add(left, right) { return left + right; }\n',
          );
        }
        await git(options.root, 'add', '.');
        await git(options.root, 'commit', '-m', `repair iteration ${String(input.iteration)}`);
        return {
          receipt: {
            commitSha: await git(options.root, 'rev-parse', 'HEAD'),
            parentCommitSha,
            repairTaskId: input.repairTaskId,
            workspaceId: `workspace-${input.repairTaskId}`,
            branchName,
          },
        };
      },
    },
    commits: {
      async verify(input) {
        calls.push(`commit:verify:${input.receipt.commitSha}`);
        stageKeys.push(input.idempotencyKey);
        return commitPort.verify(input);
      },
    },
    checks: {
      targeted(input) {
        calls.push(`targeted:${String(input.iteration)}`);
        stageKeys.push(input.idempotencyKey);
        return runTestCheck(options.root, 'targeted', input.iteration);
      },
      affected(input) {
        calls.push(`${input.kind}:${String(input.attempt)}`);
        stageKeys.push(input.idempotencyKey);
        const configured = options.affectedChecks?.[affectedIndex];
        affectedIndex += 1;
        return configured === undefined
          ? runTestCheck(options.root, 'affected', input.attempt)
          : Promise.resolve(configured);
      },
    },
    outcomes: {
      succeeded(input) {
        calls.push('outcome:succeeded');
        stageKeys.push(input.idempotencyKey);
        successfulOutcomes.push(input);
        return Promise.resolve();
      },
      escalate(input) {
        calls.push('outcome:escalated');
        stageKeys.push(input.idempotencyKey);
        escalations.push(input);
        return Promise.resolve();
      },
    },
  });

  return {
    activities,
    builderInputs,
    escalations,
    successfulOutcomes,
    calls,
    stageKeys,
    modelClassifier,
    modelRequests,
  };
}

describe('VF-13 classified repair loop', () => {
  it('rejects an affected gate set that omits the gate which failed', async () => {
    const root = await createFixture({ contradictory: false });
    const input = await repairInput(root, 'unit test failed');
    input.affectedGateIds = ['lint'];

    expect(RepairLoopInputSchema.safeParse(input).success).toBe(false);
  });

  it('classifies through the official model-gateway stream contract', async () => {
    const requests: unknown[] = [];
    const classifier = createModelGatewayFailureClassifier({
      async *stream(request) {
        requests.push(request);
        await Promise.resolve();
        yield {
          type: 'text-delta',
          text: JSON.stringify({ classification: 'test_code', reason: 'The assertion is stale.' }),
        };
        yield { type: 'done' };
      },
    });
    const root = await createFixture({ contradictory: false });
    const input = await repairInput(root, 'assertion mismatch');

    await expect(
      classifier.classify(
        {
          failureId: input.failure.failureId,
          gateId: input.failure.gateId,
          output: input.failure.output,
          relatedFiles: input.failure.relatedFiles,
          criterion: input.failure.criterion,
          diff: input.failure.diff,
        },
        ids,
      ),
    ).resolves.toEqual({ classification: 'test_code', reason: 'The assertion is stale.' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ agentRole: 'verifier', taskId: ids.taskId });
  });

  it('repairs a seeded failing unit test in one new commit and reruns both check layers', async () => {
    const root = await createFixture({ contradictory: false });
    const initial = await runTestCheck(root, 'targeted', 0);
    expect(initial.status).toBe('failed');
    const harness = createHarness({ root });

    const result = await harness.activities.repairTask(await repairInput(root, initial.output));

    expect(result).toMatchObject({
      status: 'repaired',
      classification: 'product_code',
      repairIterations: 1,
      transientRetries: 0,
    });
    expect(result.commitShas).toHaveLength(1);
    expect(harness.builderInputs).toHaveLength(1);
    expect(harness.modelClassifier).toHaveBeenCalledOnce();
    expect(harness.modelRequests[0]?.diff.summary).not.toContain(root);
    expect(harness.builderInputs[0]?.context.failingGate.output).not.toContain(root);
    expect(harness.builderInputs[0]?.context).toEqual({
      criterion: { id: 'AC-1', text: 'Adding one and one returns two.' },
      failingGate: {
        gateId: 'unit_tests',
        output: harness.builderInputs[0]?.context.failingGate.output,
        evidenceArtifactIds: ['art_initial_failure'],
      },
      relatedFiles: ['src/math.mjs', 'test/math.test.mjs'],
    });
    expect(harness.calls).toEqual([
      'task:create',
      'builder:1',
      `commit:verify:${String(result.commitShas[0])}`,
      'targeted:1',
      'repair_iteration:1',
      'outcome:succeeded',
    ]);
    expect(new Set(harness.stageKeys).size).toBe(harness.stageKeys.length);
    expect(harness.stageKeys).toHaveLength(6);
    expect(harness.escalations).toEqual([]);
  });

  it('stops an unfixable contradictory test after exactly two repair commits and escalates', async () => {
    const root = await createFixture({ contradictory: true });
    const initial = await runTestCheck(root, 'targeted', 0);
    expect(initial.status).toBe('failed');
    const harness = createHarness({ root, contradictory: true });

    const result = await harness.activities.repairTask(await repairInput(root, initial.output));

    expect(result).toMatchObject({
      status: 'escalated',
      classification: 'product_code',
      repairIterations: 2,
      transientRetries: 0,
    });
    expect(result.commitShas).toHaveLength(2);
    expect(new Set(result.commitShas).size).toBe(2);
    expect(harness.builderInputs.map(({ iteration }) => iteration)).toEqual([1, 2]);
    expect(harness.successfulOutcomes).toEqual([]);
    expect(harness.escalations).toHaveLength(1);
    expect(harness.escalations[0]?.event.payload.blockerSummary).toContain(
      '2 repair iterations',
    );
    expect(harness.escalations[0]).toMatchObject({
      taskId: ids.taskId,
      status: 'failed',
      event: {
        type: 'task.failed',
        payload: {
          kind: 'repair_exhausted',
          classification: 'product_code',
          repairIterations: 2,
          transientRetries: 0,
        },
      },
    });
    expect(harness.escalations[0]?.event.payload.evidenceArtifactIds).toEqual([
      'art_initial_failure',
      'art_targeted_1_failed',
      'art_affected_1_failed',
      'art_targeted_2_failed',
      'art_affected_2_failed',
    ]);
  }, 15_000);

  it('retries an infrastructure failure without creating commits or consuming repair budget', async () => {
    const root = await createFixture({ contradictory: false });
    const harness = createHarness({
      root,
      affectedChecks: [
        {
          status: 'failed',
          evidenceArtifactIds: ['art_infra_retry_1'],
          output: 'sandbox workspace still unavailable',
        },
        {
          status: 'passed',
          evidenceArtifactIds: ['art_infra_retry_2'],
          output: 'sandbox recovered',
        },
      ],
    });
    const input = await repairInput(root, 'sandbox exec timed out after OOM kill');

    const result = await harness.activities.repairTask(input);

    expect(result).toMatchObject({
      status: 'recovered',
      classification: 'infrastructure',
      repairIterations: 0,
      transientRetries: 2,
      commitShas: [],
    });
    expect(harness.builderInputs).toEqual([]);
    expect(harness.modelClassifier).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([
      'task:create',
      'transient_retry:1',
      'transient_retry:2',
      'outcome:succeeded',
    ]);
    expect(harness.escalations).toEqual([]);
  });

  it('uses the same bounded retry lane for a recorded flaky dependency without model authority', async () => {
    const root = await createFixture({ contradictory: false });
    const harness = createHarness({
      root,
      affectedChecks: [
        {
          status: 'passed',
          evidenceArtifactIds: ['art_flake_retry_passed'],
          output: 'known dependency recovered',
        },
      ],
    });
    const input = await repairInput(root, 'dependency mirror returned a transient response');
    input.failure.knownFlakeFingerprints.push(input.failure.fingerprint);

    const result = await harness.activities.repairTask(input);

    expect(result).toMatchObject({
      status: 'recovered',
      classification: 'flaky_dependency',
      repairIterations: 0,
      transientRetries: 1,
      commitShas: [],
    });
    expect(harness.modelClassifier).not.toHaveBeenCalled();
    expect(harness.builderInputs).toEqual([]);
  });

  it('exhausts infrastructure retries at exactly three attempts with full evidence links', async () => {
    const root = await createFixture({ contradictory: false });
    const harness = createHarness({
      root,
      affectedChecks: [1, 2, 3].map((attempt) => ({
        status: 'failed' as const,
        evidenceArtifactIds: [`art_infra_retry_${String(attempt)}`],
        output: `sandbox unavailable on retry ${String(attempt)}`,
      })),
    });

    const result = await harness.activities.repairTask(
      await repairInput(root, 'sandbox workspace unavailable'),
    );

    expect(result).toMatchObject({
      status: 'escalated',
      classification: 'infrastructure',
      repairIterations: 0,
      transientRetries: 3,
      commitShas: [],
    });
    expect(harness.calls).toEqual([
      'task:create',
      'transient_retry:1',
      'transient_retry:2',
      'transient_retry:3',
      'outcome:escalated',
    ]);
    expect(harness.escalations[0]?.event.payload.evidenceArtifactIds).toEqual([
      'art_initial_failure',
      'art_infra_retry_1',
      'art_infra_retry_2',
      'art_infra_retry_3',
    ]);
  });

  it('never treats a waived security check as an automatic repair override', async () => {
    const root = await createFixture({ contradictory: false });
    const harness = createHarness({
      root,
      repairWithDistinctPassingCommits: true,
      affectedChecks: [1, 2].map((iteration) => ({
        status: 'waived' as const,
        evidenceArtifactIds: [`art_security_waiver_${String(iteration)}`],
        output: 'automatic waiver was proposed',
      })),
    });
    const input = await repairInput(root, 'security gate failed');
    input.failure.protectedFailure = 'security';

    const result = await harness.activities.repairTask(input);

    expect(result).toMatchObject({
      status: 'escalated',
      classification: 'product_code',
      repairIterations: 2,
      transientRetries: 0,
    });
    expect(harness.builderInputs).toHaveLength(2);
    expect(harness.successfulOutcomes).toEqual([]);
    expect(harness.escalations).toHaveLength(1);
  });

  it('atomically creates a keyed repair task and emits one replay-safe failure event', async () => {
    const database = createDb(await vf13TestDatabaseUrl());
    const fixture = {
      userId: newId('user'),
      organizationId: newId('org'),
      projectId: newId('proj'),
      runId: newId('run'),
      phaseId: newId('phase'),
      taskId: newId('task'),
    };
    let repairTaskId: string | undefined;
    try {
      await migrate(database.db, { migrationsFolder });
      await database.sql`
        insert into users (id, email, display_name)
        values (${fixture.userId}, ${`${fixture.userId}@example.test`}, 'Repair test')
      `;
      await database.sql`
        insert into organizations (id, name, slug)
        values (${fixture.organizationId}, 'Repair test', ${fixture.organizationId})
      `;
      await database.sql`
        insert into projects
          (id, organization_id, name, slug, source_type, support_level, created_by)
        values
          (${fixture.projectId}, ${fixture.organizationId}, 'Repair test', ${fixture.projectId},
           'prompt', 'verified', ${fixture.userId})
      `;
      await database.sql`
        insert into agent_runs
          (id, organization_id, project_id, mode, app_type, request_fingerprint, status, started_by, plan_max_credits)
        values
          (${fixture.runId}, ${fixture.organizationId}, ${fixture.projectId}, 'build', 'web',
           ${'d'.repeat(64)}, 'running', ${fixture.userId}, 1000)
      `;
      await database.sql`
        insert into agent_phases
          (id, organization_id, run_id, sequence, title, status, acceptance_criteria_json)
        values
          (${fixture.phaseId}, ${fixture.organizationId}, ${fixture.runId}, 1, 'Repair', 'running', '[]')
      `;
      await database.sql`
        insert into agent_tasks
          (id, organization_id, phase_id, title, status, risk_level, base_commit_sha,
           acceptance_criteria_json, dependencies_json)
        values
          (${fixture.taskId}, ${fixture.organizationId}, ${fixture.phaseId}, 'Original', 'repairing',
           'medium', ${'a'.repeat(40)}, '[]', '[]')
      `;

      const lifecycle = createPostgresRepairLifecycle(database.db);
      const created = await lifecycle.create({
        ...fixture,
        idempotencyKey: `${fixture.runId}:${fixture.taskId}:repair:create`,
        failingCommitSha: 'a'.repeat(40),
        classification: 'product_code',
        protectedFailure: null,
        context: {
          criterion: { id: 'AC-1', text: 'The repaired behavior passes.' },
          failingGate: {
            gateId: 'unit_tests',
            output: 'seeded failure',
            evidenceArtifactIds: ['art_initial'],
          },
          relatedFiles: ['src/math.ts'],
        },
      });
      repairTaskId = created.repairTaskId;
      const escalation = {
        ...fixture,
        repairTaskId,
        idempotencyKey: `${fixture.runId}:${fixture.taskId}:repair:failed`,
        status: 'failed' as const,
        event: {
          type: 'task.failed' as const,
          visibility: 'user' as const,
          payload: {
            kind: 'repair_exhausted' as const,
            classification: 'product_code' as const,
            repairIterations: 2,
            transientRetries: 0,
            blockerSummary: 'Failure remained after 2 repair iterations.',
            evidenceArtifactIds: ['art_initial', 'art_final'],
          },
        },
      };
      await lifecycle.escalate(escalation);
      await lifecycle.escalate(escalation);

      const [state] = await database.sql<
        Array<{ parent_status: string; repair_status: string; event_count: number }>
      >`
        select parent.status as parent_status,
               repair.status as repair_status,
               (select count(*)::int from agent_events
                 where run_id = ${fixture.runId} and type = 'task.failed') as event_count
          from agent_tasks parent
          join agent_tasks repair on repair.parent_task_id = parent.id
         where parent.id = ${fixture.taskId} and repair.id = ${repairTaskId}
      `;
      expect(state).toEqual({ parent_status: 'failed', repair_status: 'failed', event_count: 1 });
    } finally {
      if (repairTaskId !== undefined) {
        await database.sql`delete from agent_events where run_id = ${fixture.runId}`;
        await database.sql`delete from run_event_counters where run_id = ${fixture.runId}`;
        await database.sql`delete from agent_tasks where id = ${repairTaskId}`;
      }
      await database.sql`delete from agent_tasks where id = ${fixture.taskId}`;
      await database.sql`delete from agent_phases where id = ${fixture.phaseId}`;
      await database.sql`delete from agent_runs where id = ${fixture.runId}`;
      await database.sql`delete from projects where id = ${fixture.projectId}`;
      await database.sql`delete from organizations where id = ${fixture.organizationId}`;
      await database.sql`delete from users where id = ${fixture.userId}`;
      await database.close();
    }
  }, 30_000);
});
