import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import { internalRepoRef, newId } from '@zapp/contracts';

import {
  CommitComparisonTooLargeError,
  RepositorySeedConflictError,
  createRepositoryOperations,
} from '../src/provider/repository-operations.js';

const run = promisify(execFile);
const roots: string[] = [];
const SOURCE_IDENTITY = 'zapp-projects/saas-starter';
const TARGET_IDENTITY = internalRepoRef({
  organizationId: newId('org'),
  projectId: newId('proj'),
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return result.stdout.trim();
}

async function fixture(): Promise<{
  root: string;
  source: string;
  target: string;
  beforeSha: string;
  selectedSha: string;
  latestSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'zapp-repository-operations-'));
  roots.push(root);
  const work = join(root, 'source-work');
  const source = join(root, 'source.git');
  const target = join(root, 'target.git');

  await git(root, 'init', '--initial-branch=main', work);
  await git(work, 'config', 'user.name', 'Repository Operations');
  await git(work, 'config', 'user.email', 'repository-operations@zapp.test');
  await writeFile(join(work, 'app.txt'), 'before\n');
  await git(work, 'add', 'app.txt');
  await git(work, 'commit', '-m', 'before');
  const beforeSha = await git(work, 'rev-parse', 'HEAD');
  await writeFile(join(work, 'app.txt'), 'after\n');
  await git(work, 'commit', '-am', 'selected');
  const selectedSha = await git(work, 'rev-parse', 'HEAD');
  await writeFile(join(work, 'later.txt'), 'not part of the approved release\n');
  await git(work, 'add', 'later.txt');
  await git(work, 'commit', '-m', 'later');
  const latestSha = await git(work, 'rev-parse', 'HEAD');
  await git(root, 'clone', '--bare', work, source);
  await git(root, 'init', '--bare', '--initial-branch=main', target);
  return { root, source, target, beforeSha, selectedSha, latestSha };
}

function credential(cloneUrl: string) {
  return { cloneUrl, username: 'present', credential: 'present' } as const;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('repository operations', () => {
  it('returns a bounded exact before/after unified patch', async () => {
    const seeded = await fixture();
    const operations = createRepositoryOperations();

    const comparison = await operations.compare({
      repository: credential(seeded.source),
      beforeSha: seeded.beforeSha,
      afterSha: seeded.selectedSha,
    });

    expect(comparison).toMatchObject({
      beforeSha: seeded.beforeSha,
      afterSha: seeded.selectedSha,
    });
    expect(comparison.patch).toContain('-before');
    expect(comparison.patch).toContain('+after');
    expect(Buffer.byteLength(comparison.patch)).toBeLessThanOrEqual(512 * 1024);
  });

  it('fails closed instead of buffering or returning an oversized patch', async () => {
    const seeded = await fixture();
    const operations = createRepositoryOperations({ maxPatchBytes: 100 });

    await expect(
      operations.compare({
        repository: credential(seeded.source),
        beforeSha: seeded.beforeSha,
        afterSha: seeded.selectedSha,
      }),
    ).rejects.toBeInstanceOf(CommitComparisonTooLargeError);
  });

  it('atomically seeds the approved exact commit and replays only the same operation key', async () => {
    const seeded = await fixture();
    const operations = createRepositoryOperations();
    const input = {
      source: credential(seeded.source),
      target: credential(seeded.target),
      sourceCommitSha: seeded.selectedSha,
      sourceIdentity: SOURCE_IDENTITY,
      targetIdentity: TARGET_IDENTITY,
      operationKey: 'seed-operation-one',
    } as const;

    await expect(operations.seed(input)).resolves.toEqual({
      headCommitSha: seeded.selectedSha,
      replayed: false,
    });
    expect(await git(seeded.root, '--git-dir', seeded.target, 'rev-parse', 'refs/heads/main')).toBe(
      seeded.selectedSha,
    );
    expect(seeded.latestSha).not.toBe(seeded.selectedSha);

    await expect(operations.seed(input)).resolves.toEqual({
      headCommitSha: seeded.selectedSha,
      replayed: true,
    });
    await expect(
      operations.seed({ ...input, operationKey: 'seed-operation-two' }),
    ).rejects.toBeInstanceOf(RepositorySeedConflictError);
  });

  it('binds a replay receipt to the full source and target identity', async () => {
    const seeded = await fixture();
    const operations = createRepositoryOperations();
    const input = {
      source: credential(seeded.source),
      target: credential(seeded.target),
      sourceCommitSha: seeded.selectedSha,
      sourceIdentity: SOURCE_IDENTITY,
      targetIdentity: TARGET_IDENTITY,
      operationKey: 'seed-operation-bound',
    } as const;

    await expect(operations.seed(input)).resolves.toMatchObject({ replayed: false });
    await expect(operations.seed(input)).resolves.toMatchObject({ replayed: true });
    await expect(
      operations.seed({ ...input, sourceIdentity: 'zapp-projects/ai-chat' }),
    ).rejects.toBeInstanceOf(RepositorySeedConflictError);
  });

  it('leaves the target unborn when an atomic receipt update is refused', async () => {
    const seeded = await fixture();
    const updateHook = join(seeded.target, 'hooks', 'update');
    await mkdir(join(seeded.target, 'hooks'), { recursive: true });
    await writeFile(
      updateHook,
      '#!/bin/sh\ncase "$1" in refs/zapp/template-seeds/*) exit 1 ;; esac\nexit 0\n',
      { mode: 0o700 },
    );
    await chmod(updateHook, 0o700);

    await expect(
      createRepositoryOperations().seed({
        source: credential(seeded.source),
        target: credential(seeded.target),
        sourceCommitSha: seeded.selectedSha,
        sourceIdentity: SOURCE_IDENTITY,
        targetIdentity: TARGET_IDENTITY,
        operationKey: 'seed-operation-atomic',
      }),
    ).rejects.toThrow();
    await expect(
      git(seeded.root, '--git-dir', seeded.target, 'rev-parse', 'refs/heads/main'),
    ).rejects.toThrow();
  });

  it('refuses a non-empty divergent target without changing its head', async () => {
    const seeded = await fixture();
    const unrelated = join(seeded.root, 'unrelated');
    await git(seeded.root, 'init', '--initial-branch=main', unrelated);
    await git(unrelated, 'config', 'user.name', 'Unrelated');
    await git(unrelated, 'config', 'user.email', 'unrelated@zapp.test');
    await git(unrelated, 'commit', '--allow-empty', '-m', 'unrelated');
    const divergentHead = await git(unrelated, 'rev-parse', 'HEAD');
    await git(unrelated, 'push', seeded.target, 'HEAD:refs/heads/main');

    await expect(
      createRepositoryOperations().seed({
        source: credential(seeded.source),
        target: credential(seeded.target),
        sourceCommitSha: seeded.selectedSha,
        sourceIdentity: SOURCE_IDENTITY,
        targetIdentity: TARGET_IDENTITY,
        operationKey: 'seed-operation-conflict',
      }),
    ).rejects.toBeInstanceOf(RepositorySeedConflictError);
    expect(await git(seeded.root, '--git-dir', seeded.target, 'rev-parse', 'refs/heads/main')).toBe(
      divergentHead,
    );
  });
});
