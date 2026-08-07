import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGitBundleCommands,
  restoreRepositoryBackup,
  runNightlyBackups,
  type BackupObjectStore,
  type BackupUploadSource,
  type GitCommandCall,
  type GitCommandExecutor,
} from '../src/backup.js';

const run = promisify(execFile);
const USERNAME = 'backup-admin';
const PASSWORD = 'forgejo-admin-value-never-log';
const workspaces: string[] = [];

class BundleStore implements BackupObjectStore {
  readonly values = new Map<string, Buffer>();

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.values.has(key));
  }

  async put(key: string, source: BackupUploadSource) {
    if (this.values.has(key)) {
      return 'existing' as const;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of source.open()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    this.values.set(key, Buffer.concat(chunks));
    return 'created' as const;
  }

  get(key: string): Promise<Readable> {
    const value = this.values.get(key);
    return value === undefined
      ? Promise.reject(new Error('not found'))
      : Promise.resolve(Readable.from(value));
  }

  list(prefix: string) {
    return Promise.resolve({
      objects: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, lastModified: new Date('2026-08-04T09:30:00.000Z') })),
    });
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'zapp-backup-git-test-'));
  workspaces.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('createGitBundleCommands', () => {
  it('applies operational backup deadlines through the approved two-hour ceiling', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const git = createGitBundleCommands({
      username: USERNAME,
      password: PASSWORD,
      timeoutMs: 900_000,
      executor: () => Promise.resolve({ stdout: '' }),
    });

    await git.verifyBundle('/tmp/controller.bundle');

    expect(timeout).toHaveBeenCalledWith(900_000);
    expect(() =>
      createGitBundleCommands({
        username: USERNAME,
        password: PASSWORD,
        timeoutMs: 7_200_000,
        executor: () => Promise.resolve({ stdout: '' }),
      }),
    ).not.toThrow();
    expect(() =>
      createGitBundleCommands({
        username: USERNAME,
        password: PASSWORD,
        timeoutMs: 7_200_001,
        executor: () => Promise.resolve({ stdout: '' }),
      }),
    ).toThrow();
  });

  it('recomputes remaining budget from one absolute deadline for each credential-bound command', async () => {
    const root = await workspace();
    const bundle = join(root, 'repository.bundle');
    const mirror = join(root, 'repository.git');
    await writeFile(bundle, 'bundle bytes');
    const calls: GitCommandCall[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    let nowMs = new Date('2026-08-04T09:30:00.000Z').getTime();
    const git = createGitBundleCommands({
      username: USERNAME,
      password: PASSWORD,
      timeoutMs: 240_000,
      now: () => new Date(nowMs),
      executor: (call) => {
        calls.push(call);
        return Promise.resolve({
          stdout: call.args[0] === 'ls-remote' ? `${'a'.repeat(40)}\trefs/heads/main\n` : '',
        });
      },
    });
    const deadlineGit = git as unknown as {
      prepareRestore?: (
        bundlePath: string,
        mirrorPath: string,
      ) => Promise<{ readonly kind: 'bundle'; readonly mirrorPath: string }>;
      pushMirror?: (mirrorPath: string, cloneUrl: string, deadlineAt: Date) => Promise<void>;
      remoteRefs(cloneUrl: string, deadlineAt: Date): Promise<ReadonlyMap<string, string>>;
    };

    expect(deadlineGit.prepareRestore).toBeTypeOf('function');
    expect(deadlineGit.pushMirror).toBeTypeOf('function');
    if (deadlineGit.prepareRestore === undefined || deadlineGit.pushMirror === undefined) {
      return;
    }
    await deadlineGit.prepareRestore(bundle, mirror);
    const deadlineAt = new Date(nowMs + 10_000);
    await deadlineGit.pushMirror(mirror, 'https://git.test/drill/repository.git', deadlineAt);
    nowMs += 7_500;
    await deadlineGit.remoteRefs('https://git.test/drill/repository.git', deadlineAt);

    expect(calls.map((call) => call.args)).toEqual([
      ['clone', '--mirror', bundle, mirror],
      ['-C', mirror, 'push', '--mirror', 'https://git.test/drill/repository.git'],
      ['ls-remote', '--refs', 'https://git.test/drill/repository.git'],
    ]);
    expect(timeout).toHaveBeenNthCalledWith(1, 240_000);
    expect(timeout).toHaveBeenNthCalledWith(2, 10_000);
    expect(timeout).toHaveBeenNthCalledWith(3, 2_500);
  });

  it('does not launch Git when askpass setup consumes the absolute credential deadline', async () => {
    let nowMs = 0;
    let executorCalls = 0;
    const filesystemCalls: string[] = [];
    const git = createGitBundleCommands({
      username: USERNAME,
      password: PASSWORD,
      timeoutMs: 240_000,
      now: () => new Date(nowMs),
      askpassFileSystem: {
        mkdtemp: () => {
          filesystemCalls.push('mkdtemp');
          nowMs += 40;
          return Promise.resolve('/tmp/zapp-delayed-askpass');
        },
        writeFile: () => {
          filesystemCalls.push('writeFile');
          nowMs += 40;
          return Promise.resolve();
        },
        chmod: () => {
          filesystemCalls.push('chmod');
          nowMs += 40;
          return Promise.resolve();
        },
        rm: () => {
          filesystemCalls.push('rm');
          return Promise.resolve();
        },
      },
      executor: () => {
        executorCalls += 1;
        return Promise.resolve({ stdout: '' });
      },
    });

    await expect(
      git.pushMirror(
        '/tmp/controller-mirror.git',
        'https://git.test/drill/repository.git',
        new Date(100),
      ),
    ).rejects.toThrow('Git mirror push command failed');
    expect(filesystemCalls).toEqual(['mkdtemp', 'writeFile', 'chmod', 'rm']);
    expect(executorCalls).toBe(0);
  });

  it('creates a verified bundle containing every head, tag, and other ref', async () => {
    const root = await workspace();
    const source = join(root, 'source');
    const bundle = join(root, 'repository.bundle');
    await run('git', ['init', source]);
    await run('git', ['-C', source, 'config', 'user.email', 'backup@zapp.test']);
    await run('git', ['-C', source, 'config', 'user.name', 'backup suite']);
    await writeFile(join(source, 'README.md'), 'main\n');
    await run('git', ['-C', source, 'add', 'README.md']);
    await run('git', ['-C', source, 'commit', '-m', 'main']);
    await run('git', ['-C', source, 'branch', '-M', 'main']);
    await run('git', ['-C', source, 'branch', 'feature/x']);
    await run('git', ['-C', source, 'tag', 'v1']);
    const { stdout: head } = await run('git', ['-C', source, 'rev-parse', 'HEAD']);
    await run('git', ['-C', source, 'update-ref', 'refs/notes/zapp-backup', head.trim()]);

    const git = createGitBundleCommands({
      username: USERNAME,
      password: PASSWORD,
      timeoutMs: 5_000,
    });
    await git.createBundle(new URL(`file://${source}`).toString(), bundle);
    await git.verifyBundle(bundle);

    const { stdout } = await run('git', ['bundle', 'list-heads', bundle]);
    expect(stdout).toContain(' refs/heads/main\n');
    expect(stdout).toContain(' refs/heads/feature/x\n');
    expect(stdout).toContain(' refs/tags/v1\n');
    expect(stdout).toContain(' refs/notes/zapp-backup\n');
  }, 15_000);

  it('backs up an empty repository and mirror-pushes it to clear a previously non-empty target', async () => {
    const root = await workspace();
    const source = join(root, 'empty.git');
    const seed = join(root, 'seed');
    const target = join(root, 'target.git');
    await run('git', ['init', '--bare', source]);
    await run('git', ['init', '--bare', target]);
    await run('git', ['--git-dir', target, 'config', 'receive.denyDeleteCurrent', 'ignore']);
    await run('git', ['init', seed]);
    await run('git', ['-C', seed, 'config', 'user.email', 'backup@zapp.test']);
    await run('git', ['-C', seed, 'config', 'user.name', 'backup suite']);
    await writeFile(join(seed, 'README.md'), 'stale target history\n');
    await run('git', ['-C', seed, 'add', 'README.md']);
    await run('git', ['-C', seed, 'commit', '-m', 'stale target']);
    await run('git', ['-C', seed, 'branch', '-M', 'main']);
    await run('git', ['-C', seed, 'push', new URL(`file://${target}`).toString(), 'main']);
    const store = new BundleStore();
    const git = createGitBundleCommands({
      username: USERNAME,
      password: PASSWORD,
      timeoutMs: 5_000,
    });
    const repository = {
      organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
      projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7N8',
      internalRepoRef: 'org_01j8me7yqzj2v9q0x3t5b6k7n9/proj_01j8me7yqzj2v9q0x3t5b6k7n8',
      cloneUrl: new URL(`file://${source}`).toString(),
      defaultBranch: 'main',
    } as const;
    const report = await runNightlyBackups({
      inventory: {
        listProvisionedRepositories: () => Promise.resolve([repository]),
        expectedBranches: () => Promise.resolve([{ name: 'main', headCommitSha: null }]),
      },
      store,
      git,
      now: () => new Date('2026-08-04T09:30:00.000Z'),
    });

    expect(report).toMatchObject({ succeeded: 1, failed: 0 });
    const uploaded = report.repositories[0];
    if (uploaded === undefined || uploaded.status === 'failed') {
      throw new Error('empty backup was not uploaded');
    }
    expect(store.values.get(uploaded.key)?.byteLength).toBeGreaterThan(0);
    const issuedAt = Date.now();
    const restored = await restoreRepositoryBackup(
      {
        store,
        git,
        resolveTarget: () =>
          Promise.resolve({
            cloneUrl: new URL(`file://${target}`).toString(),
            git,
            expiresAt: new Date(issuedAt + 300_000),
            deadlineAt: new Date(issuedAt + 240_000),
            release: () => Promise.resolve(),
          }),
      },
      { key: uploaded.key, expectedBranches: [{ name: 'main', headCommitSha: null }] },
    );

    expect(restored).toEqual({ checkedBranches: 0, branches: [], refs: [] });
    await expect(run('git', ['--git-dir', target, 'for-each-ref', '--format=%(refname)'])).resolves
      .toMatchObject({ stdout: '' });
  }, 15_000);

  it('uses argv arrays, an askpass environment, disabled prompts, and removes all credential scratch paths', async () => {
    const calls: GitCommandCall[] = [];
    const askpassPaths: string[] = [];
    const mirrorPaths: string[] = [];
    const executor: GitCommandExecutor = async (call) => {
      calls.push(call);
      expect(call.args.join(' ')).not.toContain(USERNAME);
      expect(call.args.join(' ')).not.toContain(PASSWORD);
      expect(call.env['ZAPP_GIT_USERNAME']).toBe(USERNAME);
      expect(call.env['ZAPP_GIT_PASSWORD']).toBe(PASSWORD);
      expect(call.env['GIT_TERMINAL_PROMPT']).toBe('0');
      expect(call.env['GIT_ASKPASS_REQUIRE']).toBe('force');
      expect(call.signal).toBeInstanceOf(AbortSignal);
      const askpass = call.env['GIT_ASKPASS'];
      expect(askpass).toBeTypeOf('string');
      await expect(access(askpass ?? '')).resolves.toBeUndefined();
      askpassPaths.push(askpass ?? '');
      if (call.args[0] === 'clone') {
        mirrorPaths.push(call.args.at(-1) ?? '');
      }
      return {
        stdout: call.args.includes('for-each-ref') ? 'refs/heads/main\n' : '',
      };
    };
    const git = createGitBundleCommands({
      username: USERNAME,
      password: PASSWORD,
      timeoutMs: 5_000,
      executor,
    });

    await git.createBundle('https://git.test/org/repository.git', '/tmp/controller.bundle');
    await git.pushMirror(
      '/tmp/controller-mirror.git',
      'https://git.test/drill/repository.git',
      new Date(Date.now() + 5_000),
    );

    expect(calls.map((call) => call.args)).toEqual([
      ['clone', '--mirror', 'https://git.test/org/repository.git', expect.any(String)],
      ['-C', expect.any(String), 'for-each-ref', '--format=%(refname)'],
      ['-C', expect.any(String), 'bundle', 'create', '/tmp/controller.bundle', '--all'],
      [
        '-C',
        '/tmp/controller-mirror.git',
        'push',
        '--mirror',
        'https://git.test/drill/repository.git',
      ],
    ]);
    for (const path of [...new Set([...askpassPaths, ...mirrorPaths])]) {
      await expect(access(path)).rejects.toThrow();
    }
  });

  it('collects every actual remote ref and refuses malformed output', async () => {
    const calls: string[][] = [];
    const executor: GitCommandExecutor = (call) => {
      calls.push([...call.args]);
      return Promise.resolve({
        stdout: `${'a'.repeat(40)}\trefs/heads/main\n${'b'.repeat(40)}\trefs/heads/feature/x\n${'c'.repeat(40)}\trefs/tags/v1\n${'d'.repeat(40)}\trefs/notes/restore\n`,
      });
    };
    const git = createGitBundleCommands({
      username: USERNAME,
      password: PASSWORD,
      timeoutMs: 5_000,
      executor,
    });

    await expect(
      git.remoteRefs('https://git.test/org/repository.git', new Date(Date.now() + 5_000)),
    ).resolves.toEqual(
      new Map([
        ['refs/heads/main', 'a'.repeat(40)],
        ['refs/heads/feature/x', 'b'.repeat(40)],
        ['refs/tags/v1', 'c'.repeat(40)],
        ['refs/notes/restore', 'd'.repeat(40)],
      ]),
    );
    expect(calls).toEqual([['ls-remote', '--refs', 'https://git.test/org/repository.git']]);

    const malformed = createGitBundleCommands({
      username: USERNAME,
      password: PASSWORD,
      timeoutMs: 5_000,
      executor: () => Promise.resolve({ stdout: 'not-a-sha\trefs/heads/main\n' }),
    });
    await expect(
      malformed.remoteRefs(
        'https://git.test/org/repository.git',
        new Date(Date.now() + 5_000),
      ),
    ).rejects.toThrow('Git remote ref listing was invalid');
  });

  it('never returns a dependency error containing the credential', async () => {
    const git = createGitBundleCommands({
      username: USERNAME,
      password: PASSWORD,
      timeoutMs: 5_000,
      executor: () => Promise.reject(new Error(`command failed with ${PASSWORD}`)),
    });

    let failure: Error | undefined;
    try {
      await git.createBundle('https://git.test/org/repository.git', '/tmp/controller.bundle');
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe('Git clone for backup failed');
    expect(failure?.message).not.toContain(PASSWORD);
  });

  it('rejects credentials in a URL before invoking Git', async () => {
    let calls = 0;
    const forbiddenUrl = new URL('https://git.test/org/repository.git');
    forbiddenUrl.username = 'forbidden';
    forbiddenUrl.password = 'credential';
    const git = createGitBundleCommands({
      username: USERNAME,
      password: PASSWORD,
      timeoutMs: 5_000,
      executor: () => {
        calls += 1;
        return Promise.resolve({ stdout: '' });
      },
    });

    await expect(
      git.createBundle(forbiddenUrl.toString(), '/tmp/controller.bundle'),
    ).rejects.toThrow('Invalid Git URL');
    expect(calls).toBe(0);
  });
});
