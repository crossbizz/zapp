import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { ProjectExportGitPort } from '../../export/service.js';
import type { GitHubExportGitPort } from './export.js';
import type { GitHubSyncGitPort, GitHubSyncRelation } from './sync.js';

const execute = promisify(execFile);
const RefSchema = z.tuple([idSchema('org'), idSchema('proj')]);

function identity(ref: string): { organizationId: string; projectId: string } {
  const [organizationId, projectId] = RefSchema.parse(ref.split('/'));
  return { organizationId, projectId };
}

async function git(args: readonly string[], cwd: string, auth?: { username: string; token: string; askpass: string }): Promise<string> {
  const result = await execute('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...(auth === undefined ? {} : { GIT_ASKPASS: auth.askpass, ZAPP_GIT_USERNAME: auth.username, ZAPP_GIT_TOKEN: auth.token }),
    },
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function ancestor(cwd: string, left: string, right: string): Promise<boolean> {
  try {
    await git(['merge-base', '--is-ancestor', left, right], cwd);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) return false;
    throw error;
  }
}

export function createGitHubGitRuntime(bundle: ProjectExportGitPort): GitHubSyncGitPort & GitHubExportGitPort {
  async function prepare(ref: string, operationKey: string, mirror = false) {
    const root = await mkdtemp(join(tmpdir(), 'zapp-github-control-'));
    const bundlePath = join(root, 'source.bundle');
    const repositoryPath = join(root, mirror ? 'repository.git' : 'repository');
    const askpass = join(root, 'askpass.sh');
    const ids = identity(ref);
    await writeFile(bundlePath, await bundle.bundle({ ...ids, operationKey }));
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s" "$ZAPP_GIT_USERNAME";; *) printf "%s" "$ZAPP_GIT_TOKEN";; esac\n', { mode: 0o700 });
    await chmod(askpass, 0o700);
    await git(['clone', ...(mirror ? ['--mirror'] : []), bundlePath, repositoryPath], root);
    return { root, repositoryPath, askpass };
  }

  return {
    async fetchExternal(input) {
      const prepared = await prepare(input.internalRepoRef, input.operationKey);
      try {
        const auth = { username: 'x-access-token', token: input.externalToken, askpass: prepared.askpass };
        await git(['remote', 'add', 'github', input.externalCloneUrl], prepared.repositoryPath);
        await git(['fetch', '--no-tags', 'github', `refs/heads/${input.branch}:refs/remotes/github/${input.branch}`], prepared.repositoryPath, auth);
        const internalHeadSha = await git(['rev-parse', `refs/heads/${input.branch}`], prepared.repositoryPath);
        const externalHeadSha = await git(['rev-parse', `refs/remotes/github/${input.branch}`], prepared.repositoryPath);
        const state: GitHubSyncRelation = internalHeadSha === externalHeadSha
          ? 'in_sync'
          : await ancestor(prepared.repositoryPath, internalHeadSha, externalHeadSha)
            ? 'behind'
            : await ancestor(prepared.repositoryPath, externalHeadSha, internalHeadSha)
              ? 'ahead'
              : 'diverged';
        return { internalHeadSha, externalHeadSha, state };
      } finally {
        await rm(prepared.root, { recursive: true, force: true });
      }
    },
    async pushExternal(input) {
      const prepared = await prepare(input.internalRepoRef, input.operationKey);
      try {
        const auth = { username: 'x-access-token', token: input.externalToken, askpass: prepared.askpass };
        await git(['push', input.externalCloneUrl, `refs/heads/${input.sourceBranch}:refs/heads/${input.targetBranch}`], prepared.repositoryPath, auth);
        const internalHeadSha = await git(['rev-parse', `refs/heads/${input.sourceBranch}`], prepared.repositoryPath);
        const external = await git(['ls-remote', input.externalCloneUrl, `refs/heads/${input.targetBranch}`], prepared.repositoryPath, auth);
        return { internalHeadSha, externalHeadSha: external.split(/\s+/u)[0] ?? '' };
      } finally {
        await rm(prepared.root, { recursive: true, force: true });
      }
    },
    async pushFullHistory(input) {
      const prepared = await prepare(input.internalRepoRef, input.operationKey, true);
      try {
        const auth = { username: 'x-access-token', token: input.externalToken, askpass: prepared.askpass };
        const internalHeadSha = await git(['rev-parse', `refs/heads/${input.defaultBranch}`], prepared.repositoryPath);
        await git(['push', '--mirror', input.externalCloneUrl], prepared.repositoryPath, auth);
        const external = await git(['ls-remote', input.externalCloneUrl, `refs/heads/${input.defaultBranch}`], prepared.repositoryPath, auth);
        return { internalHeadSha, externalHeadSha: external.split(/\s+/u)[0] ?? '' };
      } finally {
        await rm(prepared.root, { recursive: true, force: true });
      }
    },
  };
}
