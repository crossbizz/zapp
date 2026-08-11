import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { GitCommandInput, GitCommandRunner } from '../src/import/git.js';
import {
  GitMirrorConflictError,
  createGitMirror,
  type GitMirror,
} from '../src/import/mirror.js';
import {
  createFakeProvider,
  createFakeTokenService,
  newProject,
  serviceHeaders,
  serviceToken,
  signer,
} from './support/harness.js';

const exec = promisify(execFile);
const SHA = 'a'.repeat(40);
const SOURCE_TOKEN = 'ghs_source-token-must-not-leak';
const TARGET_TOKEN = 'forgejo-target-token-must-not-leak';
const BRANCH = 'feature/import';
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function git(arguments_: readonly string[], cwd?: string): Promise<string> {
  const result = await exec('git', [...arguments_], {
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  return result.stdout.trim();
}

async function fixture(): Promise<{
  root: string;
  source: string;
  target: string;
  sourceHead: string;
  sourceHistory: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'zapp-import-mirror-test-'));
  temporaryRoots.push(root);
  const source = join(root, 'source.git');
  const target = join(root, 'target.git');
  const work = join(root, 'source-work');
  await git(['init', '--bare', source]);
  await git(['clone', source, work]);
  await git(['config', 'user.name', 'Import Test'], work);
  await git(['config', 'user.email', 'import@test.invalid'], work);
  await git(['checkout', '-b', BRANCH], work);
  await writeFile(join(work, 'first.txt'), 'first\n');
  await git(['add', 'first.txt'], work);
  await git(['commit', '-m', 'first import commit'], work);
  await writeFile(join(work, 'second.txt'), 'second\n');
  await git(['add', 'second.txt'], work);
  await git(['commit', '-m', 'second import commit'], work);
  await git(['push', 'origin', BRANCH], work);
  await git(['init', '--bare', target]);
  return {
    root,
    source,
    target,
    sourceHead: await git(['rev-parse', 'HEAD'], work),
    sourceHistory: (await git(['rev-list', '--reverse', 'HEAD'], work)).split('\n'),
  };
}

function input(source: string, target: string) {
  return {
    sourceCloneUrl: source,
    sourceToken: SOURCE_TOKEN,
    sourceBranch: BRANCH,
    targetCloneUrl: target,
    targetUsername: 'zapp-import-writer',
    targetToken: TARGET_TOKEN,
  };
}

class RecordingRunner implements GitCommandRunner {
  readonly calls: GitCommandInput[] = [];
  failWith: Error | undefined;
  targetHead = '';

  run(call: GitCommandInput): Promise<{ stdout: string }> {
    this.calls.push(call);
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    if (call.args[0] === 'rev-parse') return Promise.resolve({ stdout: `${SHA}\n` });
    if (call.args[0] === 'ls-remote') {
      return Promise.resolve({
        stdout: this.targetHead === '' ? '' : `${this.targetHead}\trefs/heads/${BRANCH}\n`,
      });
    }
    return Promise.resolve({ stdout: '' });
  }
}

async function seedUnrelatedTargetRef(
  seeded: Awaited<ReturnType<typeof fixture>>,
  kind: 'branch' | 'tag',
): Promise<string> {
  const ref =
    kind === 'branch' ? 'refs/heads/unrelated-target' : 'refs/tags/authoritative-tag';
  await git(['--git-dir', seeded.target, 'update-ref', ref, seeded.sourceHead]);
  return ref;
}

describe('GitHub branch mirror', () => {
  it('imports the selected branch lineage and reports the exact source head', async () => {
    const seeded = await fixture();
    const mirror = createGitMirror();

    const result = await mirror.mirror(input(seeded.source, seeded.target));

    expect(result).toEqual({ headCommitSha: seeded.sourceHead });
    expect(await git(['--git-dir', seeded.target, 'rev-parse', `refs/heads/${BRANCH}`])).toBe(
      seeded.sourceHead,
    );
    expect(
      (await git(['--git-dir', seeded.target, 'rev-list', '--reverse', `refs/heads/${BRANCH}`])).split(
        '\n',
      ),
    ).toEqual(seeded.sourceHistory);
  });

  it('is an idempotent no-op when the target branch already equals the source', async () => {
    const seeded = await fixture();
    const mirror = createGitMirror();
    await mirror.mirror(input(seeded.source, seeded.target));
    const before = await git(['--git-dir', seeded.target, 'show-ref']);

    await expect(mirror.mirror(input(seeded.source, seeded.target))).resolves.toEqual({
      headCommitSha: seeded.sourceHead,
    });
    expect(await git(['--git-dir', seeded.target, 'show-ref'])).toBe(before);
  });

  it('refuses a target branch at a different commit without overwriting it', async () => {
    const seeded = await fixture();
    const targetWork = join(seeded.root, 'target-work');
    await git(['clone', seeded.target, targetWork]);
    await git(['config', 'user.name', 'Target Test'], targetWork);
    await git(['config', 'user.email', 'target@test.invalid'], targetWork);
    await git(['checkout', '-b', BRANCH], targetWork);
    await writeFile(join(targetWork, 'target.txt'), 'target lineage\n');
    await git(['add', 'target.txt'], targetWork);
    await git(['commit', '-m', 'different target commit'], targetWork);
    await git(['push', 'origin', BRANCH], targetWork);
    const targetHead = await git(['rev-parse', 'HEAD'], targetWork);

    await expect(createGitMirror().mirror(input(seeded.source, seeded.target))).rejects.toBeInstanceOf(
      GitMirrorConflictError,
    );
    expect(await git(['--git-dir', seeded.target, 'rev-parse', `refs/heads/${BRANCH}`])).toBe(
      targetHead,
    );
  });

  it.each(['branch', 'tag'] as const)(
    'refuses an equal-head target containing an unrelated authoritative %s ref',
    async (kind) => {
      const seeded = await fixture();
      await createGitMirror().mirror(input(seeded.source, seeded.target));
      const ref = await seedUnrelatedTargetRef(seeded, kind);
      const before = await git(['--git-dir', seeded.target, 'show-ref']);

      await expect(
        createGitMirror().mirror(input(seeded.source, seeded.target)),
      ).rejects.toBeInstanceOf(GitMirrorConflictError);

      expect(await git(['--git-dir', seeded.target, 'show-ref'])).toBe(before);
      expect(await git(['--git-dir', seeded.target, 'rev-parse', ref])).toMatch(/^[0-9a-f]{40}$/u);
      expect(await git(['--git-dir', seeded.target, 'rev-parse', `refs/heads/${BRANCH}`])).toBe(
        seeded.sourceHead,
      );
    },
  );

  it('uses separate askpass environments, bounded token-free argv, and never force-pushes', async () => {
    const runner = new RecordingRunner();
    const work = await mkdtemp(join(tmpdir(), 'zapp-import-command-test-'));
    temporaryRoots.push(work);
    const mirror = createGitMirror({
      runner,
      timeoutMs: 12_345,
      createTemporaryDirectory: async () => {
        const directory = join(work, 'mirror');
        await mkdir(directory);
        return directory;
      },
      removeTemporaryDirectory: () => Promise.resolve(),
    });

    await mirror.mirror(
      input('https://github.test/zapp/example.git', 'https://forgejo.test/org/proj.git'),
    );

    const serializedArgs = JSON.stringify(runner.calls.map((call) => call.args));
    expect(serializedArgs).not.toContain(SOURCE_TOKEN);
    expect(serializedArgs).not.toContain(TARGET_TOKEN);
    expect(serializedArgs).not.toContain('--force');
    expect(runner.calls.every((call) => call.timeoutMs === 12_345)).toBe(true);
    const sourceCall = runner.calls.find((call) => call.args[0] === 'clone');
    const targetCall = runner.calls.find((call) => call.args[0] === 'ls-remote');
    expect(sourceCall?.env['ZAPP_GIT_PASSWORD']).toBe(SOURCE_TOKEN);
    expect(targetCall?.env['ZAPP_GIT_PASSWORD']).toBe(TARGET_TOKEN);
    expect(targetCall?.args).toEqual(['ls-remote', 'target']);
    expect(sourceCall?.env['GIT_ASKPASS']).not.toBe(targetCall?.env['GIT_ASKPASS']);
    expect(await readFile(sourceCall?.env['GIT_ASKPASS'] ?? '', 'utf8')).not.toContain(SOURCE_TOKEN);
  });

  it('redacts command failures and removes its temporary directory', async () => {
    const runner = new RecordingRunner();
    runner.failWith = new Error(`remote echoed ${SOURCE_TOKEN} and ${TARGET_TOKEN}`);
    const root = await mkdtemp(join(tmpdir(), 'zapp-import-cleanup-test-'));
    temporaryRoots.push(root);
    const directory = join(root, 'mirror');
    let removed = false;
    const mirror = createGitMirror({
      runner,
      createTemporaryDirectory: async () => {
        await mkdir(directory);
        return directory;
      },
      removeTemporaryDirectory: async (value) => {
        removed = true;
        await rm(value, { recursive: true, force: true });
      },
    });

    const failure = await mirror
      .mirror(input('https://github.test/zapp/example.git', 'https://forgejo.test/org/proj.git'))
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('expected mirror failure');
    expect(failure.message).not.toContain(SOURCE_TOKEN);
    expect(failure.message).not.toContain(TARGET_TOKEN);
    expect(removed).toBe(true);
  });
});

describe('POST /internal/git/repositories/:organizationId/:projectId/import', () => {
  it('mints a target write credential, verifies the pushed head, and sets the default branch', async () => {
    const project = newProject();
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    let branchReads = 0;
    const provider = Object.assign(
      createFakeProvider({
        getBranch(ref, branch) {
          calls.push({ method: 'getBranch', args: [ref, branch] });
          branchReads += 1;
          return Promise.resolve(
            branchReads === 1 ? undefined : { name: branch, headSha: SHA },
          );
        },
      }),
      {
        setDefaultBranch(ref: string, branch: string) {
          calls.push({ method: 'setDefaultBranch', args: [ref, branch] });
          return Promise.resolve();
        },
      },
    );
    const tokens = createFakeTokenService();
    tokens.minted = {
      token: TARGET_TOKEN,
      username: 'zapp-import-writer',
      cloneUrl: `https://forgejo.test/${project.ref}.git`,
      expiresAt: new Date('2026-08-10T12:05:00.000Z'),
    };
    const mirrorInputs: Parameters<GitMirror['mirror']>[0][] = [];
    const app = buildApp({
      logger: false,
      provider,
      tokens,
      signer,
      mirror: {
        mirror(inputValue) {
          mirrorInputs.push(inputValue);
          return Promise.resolve({ headCommitSha: SHA });
        },
      },
      importPoll: { attempts: 3, delay: () => Promise.resolve() },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/import`,
        headers: serviceHeaders(await serviceToken()),
        payload: {
          externalRepoRef: 'zapp/example',
          sourceCloneUrl: 'https://github.test/zapp/example.git',
          sourceToken: SOURCE_TOKEN,
          sourceBranch: BRANCH,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        externalRepoRef: 'zapp/example',
        branch: BRANCH,
        headCommitSha: SHA,
      });
      expect(response.body).not.toContain(SOURCE_TOKEN);
      expect(response.body).not.toContain(TARGET_TOKEN);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(tokens.calls).toEqual([
        expect.objectContaining({
          method: 'mint',
          args: [
            expect.objectContaining({
              organizationId: project.organizationId,
              projectId: project.projectId,
              access: 'write',
              ttlSec: 300,
              requestingService: 'control-api',
            }),
          ],
        }),
      ]);
      expect(mirrorInputs).toEqual([
        {
          sourceCloneUrl: 'https://github.test/zapp/example.git',
          sourceToken: SOURCE_TOKEN,
          sourceBranch: BRANCH,
          targetCloneUrl: tokens.minted.cloneUrl,
          targetUsername: tokens.minted.username,
          targetToken: TARGET_TOKEN,
        },
      ]);
      expect(calls).toEqual([
        { method: 'getBranch', args: [project.ref, BRANCH] },
        { method: 'getBranch', args: [project.ref, BRANCH] },
        { method: 'setDefaultBranch', args: [project.ref, BRANCH] },
      ]);
    } finally {
      await app.close();
    }
  });

  it('refuses unauthenticated or credential-shaped public fields before mirror execution', async () => {
    const project = newProject();
    const provider = Object.assign(createFakeProvider(), {
      setDefaultBranch: () => Promise.resolve(),
    });
    let mirrorCalls = 0;
    const app = buildApp({
      logger: false,
      provider,
      tokens: createFakeTokenService(),
      signer,
      mirror: {
        mirror() {
          mirrorCalls += 1;
          return Promise.resolve({ headCommitSha: SHA });
        },
      },
    });
    try {
      const payload = {
        externalRepoRef: 'zapp/example',
        sourceCloneUrl: 'https://github.test/zapp/example.git',
        sourceToken: SOURCE_TOKEN,
        sourceBranch: BRANCH,
      };
      const unauthenticated = await app.inject({
        method: 'POST',
        url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/import`,
        payload,
      });
      expect(unauthenticated.statusCode).toBe(401);

      const strict = await app.inject({
        method: 'POST',
        url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/import`,
        headers: serviceHeaders(await serviceToken()),
        payload: { ...payload, targetToken: TARGET_TOKEN },
      });
      expect(strict.statusCode).toBe(400);
      expect(strict.body).not.toContain(SOURCE_TOKEN);
      expect(strict.body).not.toContain(TARGET_TOKEN);
      expect(mirrorCalls).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('maps a divergent target to a stable conflict without leaking either token', async () => {
    const project = newProject();
    const provider = Object.assign(createFakeProvider(), {
      setDefaultBranch: () => Promise.resolve(),
    });
    const tokens = createFakeTokenService();
    tokens.minted = { ...tokens.minted, token: TARGET_TOKEN };
    const app = buildApp({
      logger: false,
      provider,
      tokens,
      signer,
      mirror: { mirror: () => Promise.reject(new GitMirrorConflictError()) },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/import`,
        headers: serviceHeaders(await serviceToken()),
        payload: {
          externalRepoRef: 'zapp/example',
          sourceCloneUrl: 'https://github.test/zapp/example.git',
          sourceToken: SOURCE_TOKEN,
          sourceBranch: BRANCH,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'git_import_conflict' } });
      expect(response.body).not.toContain(SOURCE_TOKEN);
      expect(response.body).not.toContain(TARGET_TOKEN);
    } finally {
      await app.close();
    }
  });
});
