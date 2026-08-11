import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Context } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventActivities, PendingAgentEvent } from '../../src/activities/events.js';
import { createTemporalOrchestrator, TASK_QUEUES } from '../../src/worker.js';
import {
  FIX_DIFF_LIMITS,
  FixRegressionTestResultSchema,
  fixCancelSignal,
  fixWorkflow,
  type FixModeActivities,
  type FixVerificationActivities,
  type FixWorkflowInput,
} from '../../src/workflows/fix.js';

const executeFile = promisify(execFile);
const fixtureRoots: string[] = [];
const ids = {
  runId: 'run_01J00000000000000000000000',
  organizationId: 'org_01J00000000000000000000000',
  projectId: 'proj_01J00000000000000000000000',
  phaseId: 'phase_01J00000000000000000000000',
  taskId: 'task_01J00000000000000000000000',
} as const;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await executeFile('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

async function commandSucceeds(cwd: string, command: string, args: string[]): Promise<boolean> {
  try {
    await executeFile(command, args, { cwd, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

async function createSeededRepository(): Promise<{
  readonly root: string;
  readonly repository: string;
  readonly relevantCommitSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'zapp-ar19-'));
  fixtureRoots.push(root);
  const repository = join(root, 'repository');
  await mkdir(repository);
  await mkdir(join(repository, 'src'));
  await mkdir(join(repository, 'test'));
  await git(repository, 'init');
  await git(repository, 'config', 'user.name', 'zapp fix test');
  await git(repository, 'config', 'user.email', 'zapp-fix@example.invalid');
  await writeFile(
    join(repository, 'src/math.mjs'),
    'export function add(left, right) { return left - right; }\n',
  );
  await writeFile(
    join(repository, 'test/repro.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/math.mjs';",
      "assert.equal(add(1, 1), 2, 'production symptom: addition returns the wrong value');",
      '',
    ].join('\n'),
  );
  for (let index = 0; index <= FIX_DIFF_LIMITS.maxChangedFiles; index += 1) {
    await writeFile(join(repository, `unrelated-${String(index)}.txt`), 'stable fixture\n');
  }
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'seed planted arithmetic bug');
  return { root, repository, relevantCommitSha: await git(repository, 'rev-parse', 'HEAD') };
}

function workflowInput(relevantCommitSha: string): FixWorkflowInput {
  return {
    runId: ids.runId,
    workflowId: `${ids.runId}:fix`,
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    branchId: null,
    mode: 'fix',
    appType: 'web',
    model: null,
    prompt: 'Addition returns the wrong result in production.',
    budget: null,
    operationKey: `op_${'a'.repeat(64)}`,
    fixRequest: {
      source: 'error_report',
      summary: 'The add helper subtracts its operands.',
      relevantCommitSha,
      reproductionRef: 'test/repro.mjs',
      evidence: [
        {
          kind: 'preview_console',
          artifactId: 'art_01J00000000000000000000000',
          summary: 'Assertion reports -1 instead of 2.',
        },
        {
          kind: 'grafana_loki',
          url: 'https://grafana.example.test/explore?query=addition',
          summary: 'Captured error logs for the affected release.',
        },
      ],
    },
  };
}

interface FixFixture {
  readonly activities: FixModeActivities;
  readonly verifier: FixVerificationActivities;
  readonly events: PendingAgentEvent[];
  readonly calls: string[];
  readonly statuses: string[];
  readonly workspacePath: () => string;
  readonly patchStarted: Promise<void>;
}

function createFixFixture(options: {
  readonly repository: string;
  readonly relevantCommitSha: string;
  readonly oversized: boolean;
  readonly blockPatch?: boolean;
  readonly symptomStillFailing?: boolean;
}): FixFixture {
  const events: PendingAgentEvent[] = [];
  const calls: string[] = [];
  const statuses: string[] = [];
  let workspace = '';
  let resolvePatchStarted: (() => void) | undefined;
  const patchStarted = new Promise<void>((resolve) => {
    resolvePatchStarted = resolve;
  });

  const eventActivities: Pick<EventActivities, 'emitEvents' | 'transitionRunStatus'> = {
    emitEvents(input) {
      events.push(...input.events);
      return Promise.resolve();
    },
    transitionRunStatus(input) {
      statuses.push(input.status);
      return Promise.resolve();
    },
  };

  const activities: FixModeActivities = {
    ...eventActivities,
    loadFixCase(input) {
      calls.push('load');
      expect(input.fixRequest.evidence).toHaveLength(2);
      return Promise.resolve({
        ...ids,
        source: 'error_report',
        summary: 'The add helper subtracts its operands.',
        relevantCommitSha: options.relevantCommitSha,
        reproductionRef: 'test/repro.mjs',
        relatedFiles: ['src/math.mjs', 'test/repro.mjs'],
        evidence: input.fixRequest.evidence,
      });
    },
    async restoreFixWorkspace(input) {
      calls.push('restore');
      workspace = join(
        options.repository,
        '..',
        `workspace-${options.oversized ? 'large' : 'small'}`,
      );
      await git(join(options.repository, '..'), 'clone', options.repository, workspace);
      await git(workspace, 'config', 'user.name', 'zapp fix worker');
      await git(workspace, 'config', 'user.email', 'zapp-fix-worker@example.invalid');
      await git(workspace, 'checkout', '-b', `fix/${input.taskId}`, input.relevantCommitSha);
      return {
        workspaceId: `workspace-${input.taskId}`,
        restoredCommitSha: await git(workspace, 'rev-parse', 'HEAD'),
      };
    },
    async reproduceFix() {
      calls.push('reproduce');
      const passed = await commandSucceeds(workspace, 'node', ['test/repro.mjs']);
      if (passed) throw new Error('seeded reproduction unexpectedly passed');
      return {
        status: 'reproduced',
        failingCheck: 'node test/repro.mjs',
        evidenceArtifactIds: ['art_01J00000000000000000000001'],
      };
    },
    async prepareFixRegressionTest() {
      calls.push('regression-test');
      const regressionTestPath = 'test/math.regression.test.mjs';
      await writeFile(
        join(workspace, regressionTestPath),
        [
          "import assert from 'node:assert/strict';",
          "import test from 'node:test';",
          "import { add } from '../src/math.mjs';",
          "test('regression: addition returns the sum', () => assert.equal(add(1, 1), 2));",
          '',
        ].join('\n'),
      );
      const passed = await commandSucceeds(workspace, 'node', ['--test', regressionTestPath]);
      if (passed) throw new Error('regression test must fail before the patch');
      return {
        status: 'written',
        path: regressionTestPath,
        observedFailure: true,
        evidenceArtifactId: 'art_01J00000000000000000000002',
      };
    },
    async applyFixPatch() {
      calls.push('patch');
      resolvePatchStarted?.();
      if (options.blockPatch === true) {
        await new Promise<void>((resolve) => {
          const context = Context.current();
          const heartbeat = setInterval(() => {
            context.heartbeat();
          }, 25);
          const finish = (): void => {
            clearInterval(heartbeat);
            resolve();
          };
          context.cancellationSignal.addEventListener('abort', finish, { once: true });
          if (context.cancellationSignal.aborted) finish();
        });
        return { status: 'patched' };
      }
      await writeFile(
        join(workspace, 'src/math.mjs'),
        'export function add(left, right) { return left + right; }\n',
      );
      if (options.oversized) {
        for (let index = 0; index <= FIX_DIFF_LIMITS.maxChangedFiles; index += 1) {
          await writeFile(join(workspace, `unrelated-${String(index)}.txt`), 'unrelated churn\n');
        }
      }
      return { status: 'patched' };
    },
    async measureFixDiff(input) {
      calls.push('measure-diff');
      const output = await git(
        workspace,
        'diff',
        '--numstat',
        input.baseCommitSha,
        input.candidateCommitSha,
      );
      const entries = output
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          const [additions, deletions, path] = line.split('\t');
          if (additions === undefined || deletions === undefined || path === undefined) {
            throw new Error('invalid git numstat fixture output');
          }
          return { path, additions: Number(additions), deletions: Number(deletions) };
        });
      return {
        changedFiles: entries,
        changedLines: entries.reduce(
          (total, entry) => total + entry.additions + entry.deletions,
          0,
        ),
      };
    },
    async runFixTargetedChecks() {
      calls.push('targeted-checks');
      const passed = await commandSucceeds(workspace, 'node', [
        '--test',
        'test/math.regression.test.mjs',
      ]);
      return {
        status: passed ? 'passed' : 'failed',
        checks: ['node --test test/math.regression.test.mjs'],
        evidenceArtifactIds: ['art_01J00000000000000000000003'],
      };
    },
    async commitFixPatch(input) {
      calls.push('commit');
      await git(workspace, 'add', '.');
      await git(workspace, 'commit', '-m', input.message);
      return { commitSha: await git(workspace, 'rev-parse', 'HEAD') };
    },
    checkpointFixWorkspace() {
      calls.push('checkpoint');
      return Promise.resolve({ checkpointRef: 'checkpoint-fix-workspace' });
    },
    async verifyOriginalFixSymptom() {
      calls.push('verify-symptom');
      const passed =
        options.symptomStillFailing === true
          ? false
          : await commandSucceeds(workspace, 'node', ['test/repro.mjs']);
      return {
        status: passed ? 'resolved' : 'still_failing',
        evidenceArtifactIds: ['art_01J00000000000000000000005'],
      };
    },
    finalizeFixTask(input) {
      calls.push(`finalize:${input.outcome}`);
      return Promise.resolve();
    },
    failFixTask() {
      calls.push('fail-task');
      return Promise.resolve();
    },
  };

  const verifier: FixVerificationActivities = {
    async verifyFixCandidate(input) {
      calls.push('full-verification');
      expect({ runId: input.runId, phaseId: input.phaseId }).toEqual({
        runId: ids.runId,
        phaseId: ids.phaseId,
      });
      expect(input.candidateCommitSha).toBe(await git(workspace, 'rev-parse', 'HEAD'));
      const regressionPassed = await commandSucceeds(workspace, 'node', [
        '--test',
        'test/math.regression.test.mjs',
      ]);
      const reproductionPassed = await commandSucceeds(workspace, 'node', ['test/repro.mjs']);
      return {
        verificationResultId: 'vr_01J00000000000000000000000',
        decision: regressionPassed && reproductionPassed ? 'approved' : 'rejected',
        criteriaResults: [
          {
            criterionId: 'AC-FIX-1',
            specificationVersion: 1,
            taskIds: [ids.taskId],
            testCaseIds: ['tcase_01J00000000000000000000000'],
            result: 'passed',
            evidenceArtifactIds: ['art_01J00000000000000000000004'],
            verifierComments: [],
          },
        ],
        risks: [],
      };
    },
  };

  return {
    activities,
    verifier,
    events,
    calls,
    statuses,
    workspacePath: () => workspace,
    patchStarted,
  };
}

describe('AR-19 reproduce-first Fix mode', () => {
  let environment: TestWorkflowEnvironment | undefined;
  const workers: Worker[] = [];
  const workerRuns: Promise<void>[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    workers.forEach((worker) => {
      worker.shutdown();
    });
    await Promise.all(workerRuns);
    await environment?.teardown();
    await Promise.all(
      fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
    workers.length = 0;
    workerRuns.length = 0;
    environment = undefined;
  });

  it('requires an explicit policy flag and reason whenever a regression test is infeasible', () => {
    expect(
      FixRegressionTestResultSchema.safeParse({
        status: 'skipped',
        reason: 'The upstream provider cannot be exercised in an isolated test workspace.',
      }).success,
    ).toBe(false);
    expect(
      FixRegressionTestResultSchema.parse({
        status: 'skipped',
        policyFlag: 'regression_test_not_feasible',
        reason: 'The upstream provider cannot be exercised in an isolated test workspace.',
      }),
    ).toEqual({
      status: 'skipped',
      policyFlag: 'regression_test_not_feasible',
      reason: 'The upstream provider cannot be exercised in an isolated test workspace.',
    });
    expect(
      FixRegressionTestResultSchema.safeParse({
        status: 'written',
        path: 'test/regression.test.ts',
        observedFailure: false,
        evidenceArtifactId: 'art_01J00000000000000000000000',
      }).success,
    ).toBe(false);
  });

  it('routes production Fix starts to the dedicated workflow with captured evidence intact', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const orchestrator = createTemporalOrchestrator({
      client: { workflow: { start } } as never,
    });
    const input = workflowInput('a'.repeat(40));

    await orchestrator.startRun(input);

    expect(start).toHaveBeenCalledWith(
      fixWorkflow,
      expect.objectContaining({
        taskQueue: TASK_QUEUES.agentRuns,
        workflowId: input.workflowId,
        args: [input],
      }),
    );
  });

  it('restores the implicated commit, proves the regression red, patches, verifies, and reruns the symptom', async () => {
    const seeded = await createSeededRepository();
    const fixture = createFixFixture({ ...seeded, oversized: false });
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar19-fix-${Date.now().toString(36)}`;
    const runWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/fix.ts', import.meta.url).pathname,
      activities: fixture.activities,
    });
    const verificationWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: TASK_QUEUES.verification,
      workflowsPath: new URL('../../src/workflows/fix.ts', import.meta.url).pathname,
      activities: fixture.verifier,
    });
    workers.push(runWorker, verificationWorker);
    workerRuns.push(runWorker.run(), verificationWorker.run());

    const result = await environment.client.workflow.execute(fixWorkflow, {
      taskQueue,
      workflowId: `${ids.runId}:successful-fix`,
      args: [workflowInput(seeded.relevantCommitSha)],
    });

    expect(result).toMatchObject({
      status: 'completed',
      regressionTestPath: 'test/math.regression.test.mjs',
      verificationResultId: 'vr_01J00000000000000000000000',
    });
    expect(await readFile(join(fixture.workspacePath(), 'src/math.mjs'), 'utf8')).toContain(
      'left + right',
    );
    expect(
      await readFile(join(fixture.workspacePath(), 'test/math.regression.test.mjs'), 'utf8'),
    ).toContain('regression: addition returns the sum');
    expect(await git(fixture.workspacePath(), 'log', '-1', '--pretty=%s')).toBe(
      'Fix: The add helper subtracts its operands.',
    );
    expect(fixture.calls).toEqual([
      'load',
      'restore',
      'reproduce',
      'regression-test',
      'patch',
      'commit',
      'measure-diff',
      'targeted-checks',
      'full-verification',
      'verify-symptom',
      'finalize:passed',
    ]);
    expect(
      fixture.events
        .filter((event) => event.type === 'task.updated')
        .map((event) => event.payload['step']),
    ).toEqual([
      'restore',
      'reproduce',
      'regression_test',
      'patch',
      'diff_guard',
      'targeted_checks',
      'full_verification',
      'symptom_check',
    ]);
    expect(fixture.statuses).toEqual(['running', 'completed']);
  }, 30_000);

  it('cancels an active patch, checkpoints it, and never commits or verifies', async () => {
    const seeded = await createSeededRepository();
    const fixture = createFixFixture({ ...seeded, oversized: false, blockPatch: true });
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar19-cancel-${Date.now().toString(36)}`;
    const runWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/fix.ts', import.meta.url).pathname,
      activities: fixture.activities,
    });
    workers.push(runWorker);
    workerRuns.push(runWorker.run());

    const input = workflowInput(seeded.relevantCommitSha);
    const handle = await environment.client.workflow.start(fixWorkflow, {
      taskQueue,
      workflowId: `${ids.runId}:cancelled-fix`,
      args: [input],
    });
    await fixture.patchStarted;
    const requestedAt = Date.now();
    await handle.signal(fixCancelSignal, {
      runId: input.runId,
      operationKey: `op_${'c'.repeat(64)}`,
    });

    await expect(handle.result()).resolves.toEqual({
      status: 'cancelled',
      reason: 'user_requested',
      checkpointRef: 'checkpoint-fix-workspace',
    });
    expect(Date.now() - requestedAt).toBeLessThan(5_000);
    expect(fixture.calls).toEqual([
      'load',
      'restore',
      'reproduce',
      'regression-test',
      'patch',
      'checkpoint',
      'finalize:cancelled',
    ]);
    expect(fixture.statuses).toEqual(['running', 'cancelled']);
    expect(fixture.events.map((event) => event.type)).toContain('run.cancelled');
    expect(await git(fixture.workspacePath(), 'log', '-1', '--pretty=%s')).toBe(
      'seed planted arithmetic bug',
    );
  }, 30_000);

  it('atomically fails the task when the post-gate symptom check still fails', async () => {
    const seeded = await createSeededRepository();
    const fixture = createFixFixture({
      ...seeded,
      oversized: false,
      symptomStillFailing: true,
    });
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar19-symptom-${Date.now().toString(36)}`;
    const runWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/fix.ts', import.meta.url).pathname,
      activities: fixture.activities,
    });
    const verificationWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: TASK_QUEUES.verification,
      workflowsPath: new URL('../../src/workflows/fix.ts', import.meta.url).pathname,
      activities: fixture.verifier,
    });
    workers.push(runWorker, verificationWorker);
    workerRuns.push(runWorker.run(), verificationWorker.run());

    let rejection: unknown;
    try {
      await environment.client.workflow.execute(fixWorkflow, {
        taskQueue,
        workflowId: `${ids.runId}:persistent-symptom`,
        args: [workflowInput(seeded.relevantCommitSha)],
      });
    } catch (error: unknown) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const cause = rejection instanceof Error ? rejection.cause : undefined;
    expect(cause).toMatchObject({ type: 'fix_symptom_still_present', nonRetryable: true });
    expect(fixture.calls).toContain('full-verification');
    expect(fixture.calls.slice(-2)).toEqual(['verify-symptom', 'fail-task']);
    expect(fixture.calls).not.toContain('finalize:passed');
    expect(fixture.statuses).toEqual(['running', 'failed']);
  }, 30_000);

  it('blocks an oversized immutable commit before targeted or full verification', async () => {
    const seeded = await createSeededRepository();
    const fixture = createFixFixture({ ...seeded, oversized: true });
    environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `ar19-churn-${Date.now().toString(36)}`;
    const runWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/fix.ts', import.meta.url).pathname,
      activities: fixture.activities,
    });
    workers.push(runWorker);
    workerRuns.push(runWorker.run());

    let rejection: unknown;
    try {
      await environment.client.workflow.execute(fixWorkflow, {
        taskQueue,
        workflowId: `${ids.runId}:oversized-fix`,
        args: [workflowInput(seeded.relevantCommitSha)],
      });
    } catch (error: unknown) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    const cause = rejection instanceof Error ? rejection.cause : undefined;
    expect(cause).toBeInstanceOf(Error);
    if (!(cause instanceof Error)) throw new Error('expected Temporal application failure');
    expect(cause.message).toContain('fix_diff_too_large');
    expect(cause).toMatchObject({ type: 'fix_diff_too_large', nonRetryable: true });

    expect(fixture.calls).toEqual([
      'load',
      'restore',
      'reproduce',
      'regression-test',
      'patch',
      'commit',
      'measure-diff',
      'fail-task',
    ]);
    expect(fixture.statuses).toEqual(['running', 'failed']);
    expect(await git(fixture.workspacePath(), 'status', '--short')).toBe('');
    expect(await git(fixture.workspacePath(), 'log', '-1', '--pretty=%s')).toBe(
      'Fix: The add helper subtracts its operands.',
    );
    expect(
      await git(fixture.workspacePath(), 'diff', '--name-only', seeded.relevantCommitSha, 'HEAD'),
    ).toContain('test/math.regression.test.mjs');
  }, 30_000);
});
