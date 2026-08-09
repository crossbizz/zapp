import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskWorkflowActivities } from '../../src/activities/merge.js';
import {
  createProductionRunWorker,
  TASK_QUEUES,
  type ProductionRunActivities,
} from '../../src/worker.js';
import {
  runTaskBatchWorkflow,
  taskWorkflow,
  TaskWorkflowInputSchema,
  type TaskBatchWorkflowInput,
  type TaskWorkflowInput,
} from '../../src/workflows/task.js';
import { taskWorkflow as productionTaskWorkflow } from '../../src/workflows/run.js';

const executeFile = promisify(execFile);
const ids = {
  runId: 'run_01J00000000000000000000000',
  organizationId: 'org_01J00000000000000000000000',
  projectId: 'proj_01J00000000000000000000000',
} as const;
const integrationBranch = `run/${ids.runId}`;

function task(taskId: string): TaskWorkflowInput {
  return {
    ...ids,
    taskId,
    mode: 'build',
    model: null,
    prompt: `Implement ${taskId}`,
    budget: null,
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await executeFile('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

interface GitTaskFixture {
  readonly root: string;
  readonly remote: string;
  readonly activities: TaskWorkflowActivities;
  readonly workspacePaths: Map<string, string>;
  readonly calls: string[];
  readonly taskStates: string[];
  readonly conflictRequests: unknown[];
  readonly blockedEvents: unknown[];
  readonly maxConcurrentSessions: () => number;
  readonly waitForTwoSessions: Promise<void>;
  releaseSessions(): void;
}

async function createGitTaskFixture(options: { readonly conflictingEdits: boolean }): Promise<GitTaskFixture> {
  const root = await mkdtemp(join(tmpdir(), 'zapp-ar12-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const merger = join(root, 'merger');
  await git(root, 'init', '--bare', remote);
  await mkdir(seed);
  await git(seed, 'init');
  await git(seed, 'config', 'user.name', 'zapp test');
  await git(seed, 'config', 'user.email', 'zapp-test@example.invalid');
  await mkdir(join(seed, 'src'));
  await writeFile(join(seed, 'src/shared.ts'), 'export const owner = "base";\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'seed');
  await git(seed, 'branch', '-M', integrationBranch);
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', integrationBranch);
  await git(root, 'clone', remote, merger);
  await git(merger, 'config', 'user.name', 'zapp merge');
  await git(merger, 'config', 'user.email', 'zapp-merge@example.invalid');

  const workspacePaths = new Map<string, string>();
  const calls: string[] = [];
  const taskStates: string[] = [];
  const conflictRequests: unknown[] = [];
  const blockedEvents: unknown[] = [];
  let activeSessions = 0;
  let maxConcurrentSessions = 0;
  let resolveTwoSessions: (() => void) | undefined;
  const waitForTwoSessions = new Promise<void>((resolve) => {
    resolveTwoSessions = resolve;
  });
  let resolveSessions: (() => void) | undefined;
  const sessionsReleased = new Promise<void>((resolve) => {
    resolveSessions = resolve;
  });
  let resolveTaskAMerged: (() => void) | undefined;
  const taskAMerged = new Promise<void>((resolve) => {
    resolveTaskAMerged = resolve;
  });
  let mergeTail = Promise.resolve();

  const activities: TaskWorkflowActivities = {
    async recordBaseCommit(input) {
      calls.push(`${input.taskId}:base`);
      return { baseCommitSha: await git(root, '--git-dir', remote, 'rev-parse', integrationBranch) };
    },
    async createTaskWorkspace(input) {
      const workspacePath = join(root, `workspace-${input.taskId}`);
      await git(root, 'clone', remote, workspacePath);
      await git(workspacePath, 'config', 'user.name', `zapp ${input.taskId}`);
      await git(workspacePath, 'config', 'user.email', `${input.taskId}@example.invalid`);
      await git(workspacePath, 'checkout', '-b', input.branchName, input.baseCommitSha);
      workspacePaths.set(input.taskId, workspacePath);
      calls.push(`${input.taskId}:workspace:${input.branchName}`);
      return { workspaceId: `workspace-${input.taskId}`, workspacePath };
    },
    transitionTaskState(input) {
      taskStates.push(`${input.taskId}:${input.status}`);
      calls.push(`${input.taskId}:status:${input.status}`);
      return Promise.resolve();
    },
    async runTaskBuilderSession(input) {
      const workspacePath = workspacePaths.get(input.taskId);
      if (workspacePath === undefined) throw new Error('task workspace was not created');
      calls.push(`${input.taskId}:session:start`);
      activeSessions += 1;
      maxConcurrentSessions = Math.max(maxConcurrentSessions, activeSessions);
      if (activeSessions === 2) resolveTwoSessions?.();
      if (options.conflictingEdits) {
        await writeFile(
          join(workspacePath, 'src/shared.ts'),
          `export const owner = ${JSON.stringify(input.taskId)};\n`,
        );
        if (input.taskId === 'task-b') await taskAMerged;
      } else {
        await writeFile(join(workspacePath, `src/${input.taskId}.ts`), `export const task = ${JSON.stringify(input.taskId)};\n`);
        await sessionsReleased;
      }
      activeSessions -= 1;
      calls.push(`${input.taskId}:session:end`);
      return { status: 'completed' };
    },
    async commitAndPushTask(input) {
      const workspacePath = workspacePaths.get(input.taskId);
      if (workspacePath === undefined) throw new Error('task workspace was not created');
      await git(workspacePath, 'add', '.');
      await git(workspacePath, 'commit', '-m', input.message);
      const commitSha = await git(workspacePath, 'rev-parse', 'HEAD');
      await git(workspacePath, 'push', 'origin', `${input.branchName}:${input.branchName}`);
      calls.push(`${input.taskId}:commit:${input.workspaceId}`);
      return { commitSha };
    },
    mergeTask(input) {
      const operation = mergeTail.then(async () => {
        calls.push(`${input.taskId}:merge:${input.integrationBranch}`);
        await git(merger, 'fetch', 'origin');
        await git(merger, 'checkout', '-B', input.integrationBranch, `origin/${input.integrationBranch}`);
        try {
          await git(merger, 'merge', '--no-edit', `origin/${input.sourceBranch}`);
          await git(merger, 'push', 'origin', input.integrationBranch);
          if (input.taskId === 'task-a') resolveTaskAMerged?.();
          return { outcome: 'merged' as const };
        } catch {
          const conflictingPaths = (await git(merger, 'diff', '--name-only', '--diff-filter=U'))
            .split('\n')
            .filter((path) => path !== '');
          const integrationHeadSha = await git(merger, 'rev-parse', 'HEAD');
          await git(merger, 'merge', '--abort');
          return { outcome: 'conflict' as const, conflictingPaths, integrationHeadSha };
        }
      });
      mergeTail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    createConflictTask(input) {
      conflictRequests.push(input);
      return Promise.resolve({ conflictTaskId: `${input.taskId}-conflict-1` });
    },
    emitTaskBlocked(input) {
      blockedEvents.push(input);
      return Promise.resolve();
    },
  };

  return {
    root,
    remote,
    activities,
    workspacePaths,
    calls,
    taskStates,
    conflictRequests,
    blockedEvents,
    maxConcurrentSessions: () => maxConcurrentSessions,
    waitForTwoSessions,
    releaseSessions: () => {
      resolveSessions?.();
    },
  };
}

describe('AR-12 isolated task workflows', () => {
  let environment: TestWorkflowEnvironment | undefined;
  let fixture: GitTaskFixture | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await environment?.teardown();
    if (fixture !== undefined) await rm(fixture.root, { recursive: true });
    environment = undefined;
    fixture = undefined;
  });

  it('derives the integration branch from the run and rejects caller branch injection', () => {
    expect(productionTaskWorkflow).toBe(taskWorkflow);
    expect(
      TaskWorkflowInputSchema.safeParse({
        ...task('task-a'),
        integrationBranch: 'run/run_01J00000000000000000000001',
      }).success,
    ).toBe(false);
  });

  it('registers task workflows and activities through the production worker factory', async () => {
    const create = vi.spyOn(Worker, 'create').mockResolvedValueOnce({} as never);
    const activities = {
      recordBaseCommit: vi.fn(),
      createTaskWorkspace: vi.fn(),
      transitionTaskState: vi.fn(),
      runTaskBuilderSession: vi.fn(),
      commitAndPushTask: vi.fn(),
      mergeTask: vi.fn(),
      createConflictTask: vi.fn(),
      emitTaskBlocked: vi.fn(),
    } as unknown as ProductionRunActivities;

    await createProductionRunWorker({
      connection: {} as never,
      taskQueue: TASK_QUEUES.agentRuns,
      activities,
      database: {} as never,
    });

    const workerOptions = create.mock.calls[0]?.[0];
    expect(workerOptions?.taskQueue).toBe(TASK_QUEUES.agentRuns);
    expect(workerOptions?.activities).toBe(activities);
    expect(typeof activities.mergeTask).toBe('function');
    expect(String(workerOptions?.workflowsPath)).toMatch(/workflows\/run\.(?:ts|js)$/u);
  });

  it('runs three children with a cap of two in distinct Git workspaces and merges their commits', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    fixture = await createGitTaskFixture({ conflictingEdits: false });
    const taskQueue = `ar12-parallel-${Date.now().toString(36)}`;
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/task.ts', import.meta.url).pathname,
      activities: fixture.activities,
    });

    await worker.runUntil(async () => {
      const running = environment?.client.workflow.execute(runTaskBatchWorkflow, {
        taskQueue,
        workflowId: `${ids.runId}:parallel`,
        args: [
          {
            runId: ids.runId,
            maxConcurrency: 2,
            tasks: [task('task-a'), task('task-b'), task('task-c')],
          } satisfies TaskBatchWorkflowInput,
        ],
      });
      if (running === undefined) throw new Error('Temporal environment was not created');
      await fixture?.waitForTwoSessions;
      fixture?.releaseSessions();
      await expect(running).resolves.toEqual([
        expect.objectContaining({ taskId: 'task-a', status: 'verifying' }),
        expect.objectContaining({ taskId: 'task-b', status: 'verifying' }),
        expect.objectContaining({ taskId: 'task-c', status: 'verifying' }),
      ]);
    });

    expect(fixture.maxConcurrentSessions()).toBe(2);
    expect(new Set(fixture.workspacePaths.values()).size).toBe(3);
    for (const taskId of ['task-a', 'task-b', 'task-c']) {
      const workspacePath = fixture.workspacePaths.get(taskId);
      if (workspacePath === undefined) throw new Error('workspace path missing');
      expect(await readdir(join(workspacePath, 'src'))).toContain(`${taskId}.ts`);
      expect(
        await git(fixture.root, '--git-dir', fixture.remote, 'show', `${integrationBranch}:src/${taskId}.ts`),
      ).toContain(taskId);
      expect(fixture.calls.filter((call) => call.startsWith(`${taskId}:`))).toEqual([
        `${taskId}:base`,
        `${taskId}:workspace:task/${taskId}`,
        `${taskId}:status:running`,
        `${taskId}:session:start`,
        `${taskId}:session:end`,
        `${taskId}:commit:workspace-${taskId}`,
        `${taskId}:status:verifying`,
        `${taskId}:merge:${integrationBranch}`,
      ]);
    }
  }, 30_000);

  it('turns a real same-line merge conflict into a conflict task and blocked event', async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    fixture = await createGitTaskFixture({ conflictingEdits: true });
    const taskQueue = `ar12-conflict-${Date.now().toString(36)}`;
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../src/workflows/task.ts', import.meta.url).pathname,
      activities: fixture.activities,
    });

    await worker.runUntil(async () => {
      const result = await environment?.client.workflow.execute(runTaskBatchWorkflow, {
        taskQueue,
        workflowId: `${ids.runId}:conflict`,
        args: [
          {
            runId: ids.runId,
            maxConcurrency: 2,
            tasks: [task('task-a'), task('task-b')],
          } satisfies TaskBatchWorkflowInput,
        ],
      });
      expect(result).toEqual([
        expect.objectContaining({ taskId: 'task-a', status: 'verifying' }),
        expect.objectContaining({ taskId: 'task-b', status: 'blocked', conflictTaskId: 'task-b-conflict-1' }),
      ]);
    });

    expect(await git(fixture.root, '--git-dir', fixture.remote, 'show', `${integrationBranch}:src/shared.ts`)).toContain('task-a');
    expect(fixture.conflictRequests).toEqual([
      expect.objectContaining({
        taskId: 'task-b',
        sourceBranch: 'task/task-b',
        integrationBranch,
        conflictingPaths: ['src/shared.ts'],
      }),
    ]);
    expect(fixture.blockedEvents).toEqual([
      expect.objectContaining({
        taskId: 'task-b',
        conflictTaskId: 'task-b-conflict-1',
        conflictingPaths: ['src/shared.ts'],
      }),
    ]);
    expect(fixture.taskStates).toEqual(
      expect.arrayContaining([
        'task-a:running',
        'task-a:verifying',
        'task-b:running',
        'task-b:verifying',
        'task-b:blocked',
      ]),
    );
    const taskBWorkspace = fixture.workspacePaths.get('task-b');
    if (taskBWorkspace === undefined) throw new Error('task-b workspace missing');
    expect(await readFile(join(taskBWorkspace, 'src/shared.ts'), 'utf8')).toContain('task-b');
  }, 30_000);
});
