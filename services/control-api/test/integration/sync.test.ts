import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createDbGitHubSyncStore,
  createGitHubSyncEngine,
  type GitHubSyncGitPort,
  type GitHubSyncProviderPort,
  type GitHubSyncState,
  type GitHubSyncStore,
  type GitHubSyncTarget,
  type RecordInboundSyncInput,
  type RecordOutboundSyncInput,
} from '../../src/integrations/github/sync.js';
import { hasDatabase, setUpTestDatabase } from './helpers.js';

const exec = promisify(execFile);
const roots: string[] = [];

async function git(args: readonly string[], cwd?: string): Promise<string> {
  return (await exec('git', [...args], { ...(cwd === undefined ? {} : { cwd }) })).stdout.trim();
}

async function isAncestor(
  repository: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(['merge-base', '--is-ancestor', ancestor, descendant], repository);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 1
    ) {
      return false;
    }
    throw error;
  }
}

interface GitFixture {
  readonly internal: string;
  readonly external: string;
  commit(remote: 'internal' | 'external', label: string): Promise<string>;
  head(remote: 'internal' | 'external', branch?: string): Promise<string>;
  reflog(remote: 'internal' | 'external', branch?: string): Promise<readonly string[]>;
}

async function createGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), 'zapp-int3-sync-'));
  roots.push(root);
  const internal = join(root, 'internal.git');
  const external = join(root, 'external.git');
  await git(['init', '--bare', internal]);
  await git(['init', '--bare', external]);
  await git(['--git-dir', internal, 'config', 'core.logAllRefUpdates', 'true']);
  await git(['--git-dir', external, 'config', 'core.logAllRefUpdates', 'true']);

  async function commit(remote: 'internal' | 'external', label: string): Promise<string> {
    const worktree = await mkdtemp(join(root, `${remote}-work-`));
    const repository = remote === 'internal' ? internal : external;
    await git(['clone', repository, worktree]);
    const hasMain = await git([
      '--git-dir',
      repository,
      'show-ref',
      '--verify',
      '--hash',
      'refs/heads/main',
    ])
      .then(() => true)
      .catch(() => false);
    if (hasMain) await git(['checkout', 'main'], worktree);
    else await git(['checkout', '-b', 'main'], worktree);
    await git(['config', 'user.name', 'zapp sync test'], worktree);
    await git(['config', 'user.email', 'sync@example.test'], worktree);
    await writeFile(join(worktree, `${label}.txt`), `${label}\n`, 'utf8');
    await git(['add', '.'], worktree);
    await git(['commit', '-m', label], worktree);
    await git(['push', 'origin', 'main'], worktree);
    await git(['--git-dir', repository, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    return await git(['rev-parse', 'HEAD'], worktree);
  }

  const first = await commit('internal', 'initial');
  const seed = await mkdtemp(join(root, 'seed-'));
  await git(['clone', internal, seed]);
  await git(['remote', 'add', 'external', external], seed);
  await git(['push', 'external', 'main'], seed);
  await git(['--git-dir', external, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  expect(await git(['--git-dir', external, 'rev-parse', 'refs/heads/main'])).toBe(first);

  return {
    internal,
    external,
    commit,
    head(remote, branch = 'main') {
      return git([
        '--git-dir',
        remote === 'internal' ? internal : external,
        'rev-parse',
        `refs/heads/${branch}`,
      ]);
    },
    async reflog(remote, branch = 'main') {
      const output = await git([
        '--git-dir',
        remote === 'internal' ? internal : external,
        'reflog',
        'show',
        '--format=%H',
        `refs/heads/${branch}`,
      ]);
      return output === '' ? [] : output.split('\n');
    },
  };
}

function localGitPort(fixture: GitFixture): GitHubSyncGitPort {
  async function cloneInternal(): Promise<string> {
    const worktree = await mkdtemp(join(tmpdir(), 'zapp-int3-operation-'));
    roots.push(worktree);
    await git(['clone', fixture.internal, worktree]);
    await git(['remote', 'add', 'github', fixture.external], worktree);
    return worktree;
  }

  return {
    async fetchExternal(input) {
      const worktree = await cloneInternal();
      await git(
        [
          'fetch',
          '--no-tags',
          'github',
          `refs/heads/${input.branch}:refs/remotes/github/${input.branch}`,
        ],
        worktree,
      );
      const internalHeadSha = await git(['rev-parse', `refs/heads/${input.branch}`], worktree);
      const externalHeadSha = await git(
        ['rev-parse', `refs/remotes/github/${input.branch}`],
        worktree,
      );
      const state =
        internalHeadSha === externalHeadSha
          ? 'in_sync'
          : (await isAncestor(worktree, internalHeadSha, externalHeadSha))
            ? 'behind'
            : (await isAncestor(worktree, externalHeadSha, internalHeadSha))
              ? 'ahead'
              : 'diverged';
      return { internalHeadSha, externalHeadSha, state };
    },
    async pushExternal(input) {
      const worktree = await cloneInternal();
      await git(
        ['push', 'github', `refs/heads/${input.sourceBranch}:refs/heads/${input.targetBranch}`],
        worktree,
      );
      return {
        internalHeadSha: await git(['rev-parse', `refs/heads/${input.sourceBranch}`], worktree),
        externalHeadSha: await fixture.head('external', input.targetBranch),
      };
    },
  };
}

class MemorySyncStore implements GitHubSyncStore {
  readonly targets = new Map<string, GitHubSyncTarget>();
  readonly tasks = new Map<string, { baseCommitSha: string; status: string }>();
  readonly events: { taskId: string; type: string; externalHeadSha: string }[] = [];
  readonly conflicts: { deliveryId: string; internalHeadSha: string; externalHeadSha: string }[] =
    [];
  state: GitHubSyncState | undefined;

  resolveInbound(input: { installationId: string; externalRepoRef: string; branch: string }) {
    return Promise.resolve(this.targets.get(`${input.externalRepoRef}:${input.branch}`));
  }

  resolveOutbound(input: { organizationId: string; projectId: string }) {
    return Promise.resolve(this.targets.get(`${input.organizationId}:${input.projectId}`));
  }

  recordInbound(input: RecordInboundSyncInput) {
    const blockedTaskIds: string[] = [];
    if (input.previousExternalHeadSha !== input.externalHeadSha) {
      for (const [taskId, task] of this.tasks) {
        if (
          ['queued', 'ready', 'running', 'waiting_for_approval', 'verifying', 'repairing'].includes(
            task.status,
          ) &&
          task.baseCommitSha !== input.externalHeadSha
        ) {
          task.status = 'blocked';
          blockedTaskIds.push(taskId);
          this.events.push({
            taskId,
            type: 'task.blocked',
            externalHeadSha: input.externalHeadSha,
          });
        }
      }
    }
    if (
      input.state === 'diverged' &&
      !this.conflicts.some((conflict) => conflict.deliveryId === input.deliveryId)
    ) {
      this.conflicts.push({
        deliveryId: input.deliveryId,
        internalHeadSha: input.internalHeadSha,
        externalHeadSha: input.externalHeadSha,
      });
    }
    this.state = {
      projectId: input.target.projectId,
      branch: input.target.branch,
      internalHeadSha: input.internalHeadSha,
      externalHeadSha: input.externalHeadSha,
      state: input.state,
    };
    return Promise.resolve({ blockedTaskIds, conflictCreated: input.state === 'diverged' });
  }

  recordOutbound(input: RecordOutboundSyncInput) {
    this.state = {
      projectId: input.target.projectId,
      branch: input.target.branch,
      internalHeadSha: input.internalHeadSha,
      externalHeadSha: input.externalHeadSha,
      state: input.internalHeadSha === input.externalHeadSha ? 'in_sync' : 'ahead',
    };
    return Promise.resolve();
  }
}

function provider(): GitHubSyncProviderPort & { pullRequests: { head: string; base: string }[] } {
  const pullRequests: { head: string; base: string }[] = [];
  return {
    pullRequests,
    prepareRepository() {
      return Promise.resolve({
        cloneUrl: 'https://github.example.test/zapp/example.git',
        token: 'test',
      });
    },
    openPullRequest(input) {
      pullRequests.push({ head: input.head, base: input.base });
      return Promise.resolve({
        number: 17,
        url: 'https://github.example.test/zapp/example/pull/17',
      });
    },
  };
}

function target(input: {
  fixture: GitFixture;
  policy: 'direct_push' | 'pull_request';
  previousExternalHeadSha: string;
}): GitHubSyncTarget {
  return {
    organizationId: newId('org'),
    projectId: newId('proj'),
    installationId: '41122',
    internalRepoRef: input.fixture.internal,
    externalRepoRef: 'zapp/example',
    branchId: newId('br'),
    branch: 'main',
    syncPolicy: input.policy,
    previousExternalHeadSha: input.previousExternalHeadSha,
  };
}

function pushMessage(input: { deliveryId: string; head: string }): string {
  return JSON.stringify({
    deliveryId: input.deliveryId,
    eventName: 'push',
    installationId: '41122',
    payload: {
      ref: 'refs/heads/main',
      after: input.head,
      deleted: false,
      repository: { full_name: 'zapp/example' },
      installation: { id: 41122 },
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('INT-3 GitHub synchronization engine', () => {
  it.skipIf(!hasDatabase)(
    'persists stale-base invalidation, its event, and both sync heads atomically',
    async () => {
      const database = await setUpTestDatabase();
      try {
        await database.truncateIdentity();
        const organizationId = newId('org');
        const userId = newId('user');
        const projectId = newId('proj');
        const repositoryId = newId('repo');
        const branchId = newId('br');
        const otherBranchId = newId('br');
        const runId = newId('run');
        const otherRunId = newId('run');
        const phaseId = newId('phase');
        const otherPhaseId = newId('phase');
        const taskId = newId('task');
        const otherTaskId = newId('task');
        const commonHead = 'a'.repeat(40);
        const externalHead = 'b'.repeat(40);
        const internalHead = 'c'.repeat(40);
        await database.sql`
          insert into users (id, email, display_name)
          values (${userId}, 'sync-db@example.test', 'Sync DB')
        `;
        await database.sql`
          insert into organizations (id, name, slug)
          values (${organizationId}, 'Sync DB', ${`sync-db-${organizationId}`})
        `;
        await database.sql`
          insert into projects
            (id, organization_id, name, slug, description, source_type, support_level, created_by)
          values
            (${projectId}, ${organizationId}, 'Sync project', ${`sync-${projectId}`}, null,
             'github_import', 'verified', ${userId})
        `;
        await database.sql`
          insert into repositories
            (id, organization_id, project_id, provider, internal_repo_ref, external_repo_ref,
             default_branch, sync_policy, provisioned_at)
          values
            (${repositoryId}, ${organizationId}, ${projectId}, 'internal',
             ${`${organizationId}/${projectId}`}, 'zapp/example', 'main', 'direct_push', now())
        `;
        await database.sql`
          insert into branches
            (id, organization_id, project_id, name, head_commit_sha, base_branch_id, status)
          values
            (${branchId}, ${organizationId}, ${projectId}, 'main', ${commonHead}, null, 'active'),
            (${otherBranchId}, ${organizationId}, ${projectId}, 'feature/other', ${commonHead},
             ${branchId}, 'active')
        `;
        await database.sql`
          insert into github_imports
            (project_id, organization_id, installation_id, repo, branch, operation_key, status,
             external_repo_ref, head_commit_sha, scan_id, error_code, created_at, updated_at)
          values
            (${projectId}, ${organizationId}, '41122', 'zapp/example', 'main',
             'sync-db-import-operation', 'scan_accepted', 'zapp/example', ${commonHead},
             ${`github-import:${projectId}`}, null, now(), now())
        `;
        await database.sql`
          insert into conversations
            (id, organization_id, project_id, created_by, title)
          values
            (${`conv_${runId.slice(4)}`}, ${organizationId}, ${projectId}, ${userId}, 'Sync run'),
            (${`conv_${otherRunId.slice(4)}`}, ${organizationId}, ${projectId}, ${userId}, 'Other sync run')
        `;
        await database.sql`
          insert into agent_runs
            (id, organization_id, project_id, conversation_id, conversation_run_number,
             branch_id, mode, model, request_fingerprint, status,
             specification_id, temporal_workflow_id, started_by, budget_json, plan_max_credits)
          values
            (${runId}, ${organizationId}, ${projectId}, ${`conv_${runId.slice(4)}`}, 1,
             ${branchId}, 'build', null,
             'sync-db-fingerprint', 'running', null, 'sync-db-workflow', ${userId}, null, 1000),
            (${otherRunId}, ${organizationId}, ${projectId}, ${`conv_${otherRunId.slice(4)}`}, 1,
             ${otherBranchId}, 'build', null,
             'sync-db-other-fingerprint', 'running', null, 'sync-db-other-workflow', ${userId}, null, 1000)
        `;
        await database.sql`
          insert into agent_phases
            (id, organization_id, run_id, sequence, title, status, acceptance_criteria_json)
          values
            (${phaseId}, ${organizationId}, ${runId}, 1, 'Sync phase', 'running', '[]'::jsonb),
            (${otherPhaseId}, ${organizationId}, ${otherRunId}, 1, 'Other phase', 'running', '[]'::jsonb)
        `;
        await database.sql`
          insert into agent_tasks
            (id, organization_id, phase_id, parent_task_id, title, status, risk_level,
             base_commit_sha, output_commit_sha, acceptance_criteria_json, dependencies_json,
             assigned_agent_role)
          values
            (${taskId}, ${organizationId}, ${phaseId}, null, 'Active edit', 'running', 'medium',
             ${commonHead}, null, '["AC-1"]'::jsonb, '[]'::jsonb, 'backend'),
            (${otherTaskId}, ${organizationId}, ${otherPhaseId}, null, 'Other branch edit', 'running',
             'medium', ${commonHead}, null, '["AC-2"]'::jsonb, '[]'::jsonb, 'backend')
        `;

        const engine = createGitHubSyncEngine({
          store: createDbGitHubSyncStore(database.db),
          provider: provider(),
          git: {
            fetchExternal: () =>
              Promise.resolve({
                internalHeadSha: internalHead,
                externalHeadSha: externalHead,
                state: 'diverged' as const,
              }),
            pushExternal: () => Promise.reject(new Error('not used')),
          },
          now: () => new Date('2026-08-11T12:00:00.000Z'),
        });

        await database.sql`
          update repositories set sync_policy = 'manual_push' where id = ${repositoryId}
        `;
        await expect(
          engine.processWebhook(
            pushMessage({ deliveryId: 'delivery-db-unconfigured', head: externalHead }),
          ),
        ).resolves.toEqual({ action: 'ignored' });
        await database.sql`
          update repositories set sync_policy = 'direct_push' where id = ${repositoryId}
        `;

        await expect(
          engine.processWebhook(pushMessage({ deliveryId: 'delivery-db-1', head: externalHead })),
        ).resolves.toMatchObject({
          state: 'diverged',
          blockedTaskIds: [taskId],
          conflictCreated: true,
        });
        await expect(
          engine.processWebhook(pushMessage({ deliveryId: 'delivery-db-1', head: externalHead })),
        ).resolves.toMatchObject({
          state: 'diverged',
          blockedTaskIds: [taskId],
          conflictCreated: true,
        });
        const [task] = await database.sql<{ status: string }[]>`
          select status from agent_tasks where id = ${taskId}
        `;
        expect(task?.status).toBe('blocked');
        const [otherTask] = await database.sql<{ status: string }[]>`
          select status from agent_tasks where id = ${otherTaskId}
        `;
        expect(otherTask?.status).toBe('running');
        const events = await database.sql<
          { type: string; task_id: string; payload_json: { externalHeadSha?: string } }[]
        >`
          select type, task_id, payload_json
            from agent_events
           where run_id = ${runId} and task_id = ${taskId}
           order by sequence
        `;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: 'task.blocked',
          task_id: taskId,
          payload_json: { externalHeadSha: externalHead },
        });
        const conflicts = await database.sql<{ id: string; status: string }[]>`
          select id, status
            from agent_tasks
           where phase_id = ${phaseId} and title = 'Resolve GitHub divergence'
        `;
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.status).toBe('blocked');
        const [state] = await database.sql<
          {
            project_id: string | null;
            configuration_json: GitHubSyncState & { lastDeliveryId: string };
          }[]
        >`
          select project_id, configuration_json
            from integration_connections
           where provider = 'github' and project_id = ${projectId}
        `;
        expect(state).toMatchObject({
          project_id: projectId,
          configuration_json: {
            branch: 'main',
            internalHeadSha: internalHead,
            externalHeadSha: externalHead,
            state: 'diverged',
            lastDeliveryId: 'delivery-db-1',
          },
        });
      } finally {
        await database.close();
      }
    },
    180_000,
  );

  it('blocks stale active task bases and emits task.blocked after an external push', async () => {
    const fixture = await createGitFixture();
    const commonHead = await fixture.head('external');
    const externalHead = await fixture.commit('external', 'external-change');
    const store = new MemorySyncStore();
    const syncTarget = target({
      fixture,
      policy: 'direct_push',
      previousExternalHeadSha: commonHead,
    });
    store.targets.set(`${syncTarget.externalRepoRef}:main`, syncTarget);
    const taskId = newId('task');
    store.tasks.set(taskId, { baseCommitSha: commonHead, status: 'running' });
    const engine = createGitHubSyncEngine({
      store,
      provider: provider(),
      git: localGitPort(fixture),
    });

    await expect(
      engine.processWebhook(pushMessage({ deliveryId: 'delivery-external-1', head: externalHead })),
    ).resolves.toMatchObject({ state: 'behind', blockedTaskIds: [taskId] });
    expect(store.tasks.get(taskId)?.status).toBe('blocked');
    expect(store.events).toEqual([{ taskId, type: 'task.blocked', externalHeadSha: externalHead }]);
    expect(store.state).toMatchObject({
      internalHeadSha: commonHead,
      externalHeadSha: externalHead,
      state: 'behind',
    });
  });

  it('propagates an integration commit under direct_push without a force-push option', async () => {
    const fixture = await createGitFixture();
    const commonHead = await fixture.head('external');
    const internalHead = await fixture.commit('internal', 'integration-change');
    const store = new MemorySyncStore();
    const syncTarget = target({
      fixture,
      policy: 'direct_push',
      previousExternalHeadSha: commonHead,
    });
    store.targets.set(`${syncTarget.organizationId}:${syncTarget.projectId}`, syncTarget);
    const engine = createGitHubSyncEngine({
      store,
      provider: provider(),
      git: localGitPort(fixture),
    });

    await expect(
      engine.syncCommit({
        organizationId: syncTarget.organizationId,
        projectId: syncTarget.projectId,
        runId: newId('run'),
        sourceBranch: 'main',
      }),
    ).resolves.toMatchObject({
      action: 'direct_push',
      head: 'main',
      externalHeadSha: internalHead,
    });
    expect(await fixture.head('external')).toBe(internalHead);
    expect(store.state).toMatchObject({
      internalHeadSha: internalHead,
      externalHeadSha: internalHead,
      state: 'in_sync',
    });
  });

  it('pushes a run branch and opens a pull request under pull_request policy', async () => {
    const fixture = await createGitFixture();
    const commonHead = await fixture.head('external');
    const internalHead = await fixture.commit('internal', 'pull-request-change');
    const store = new MemorySyncStore();
    const syncTarget = target({
      fixture,
      policy: 'pull_request',
      previousExternalHeadSha: commonHead,
    });
    store.targets.set(`${syncTarget.organizationId}:${syncTarget.projectId}`, syncTarget);
    const github = provider();
    const runId = newId('run');
    const engine = createGitHubSyncEngine({ store, provider: github, git: localGitPort(fixture) });

    const result = await engine.syncCommit({
      organizationId: syncTarget.organizationId,
      projectId: syncTarget.projectId,
      runId,
      sourceBranch: 'main',
    });
    const head = `zapp/run-${runId}`;
    expect(result).toMatchObject({ action: 'pull_request', head, externalHeadSha: internalHead });
    expect(await fixture.head('external', head)).toBe(internalHead);
    expect(github.pullRequests).toEqual([{ head, base: 'main' }]);
  });

  it('creates a conflict task for divergence and leaves both branch reflogs untouched', async () => {
    const fixture = await createGitFixture();
    const commonHead = await fixture.head('external');
    const internalHead = await fixture.commit('internal', 'internal-divergence');
    const externalHead = await fixture.commit('external', 'external-divergence');
    const internalReflogBefore = await fixture.reflog('internal');
    const externalReflogBefore = await fixture.reflog('external');
    const store = new MemorySyncStore();
    const syncTarget = target({
      fixture,
      policy: 'direct_push',
      previousExternalHeadSha: commonHead,
    });
    store.targets.set(`${syncTarget.externalRepoRef}:main`, syncTarget);
    store.tasks.set(newId('task'), { baseCommitSha: commonHead, status: 'running' });
    const engine = createGitHubSyncEngine({
      store,
      provider: provider(),
      git: localGitPort(fixture),
    });

    await expect(
      engine.processWebhook(pushMessage({ deliveryId: 'delivery-diverged-1', head: externalHead })),
    ).resolves.toMatchObject({ state: 'diverged', conflictCreated: true });
    expect(store.conflicts).toEqual([
      {
        deliveryId: 'delivery-diverged-1',
        internalHeadSha: internalHead,
        externalHeadSha: externalHead,
      },
    ]);
    expect(await fixture.head('internal')).toBe(internalHead);
    expect(await fixture.head('external')).toBe(externalHead);
    expect(await fixture.reflog('internal')).toEqual(internalReflogBefore);
    expect(await fixture.reflog('external')).toEqual(externalReflogBefore);
  });
});
