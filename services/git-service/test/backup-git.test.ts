import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createGitBundleCommands,
  type GitCommandCall,
  type GitCommandExecutor,
} from '../src/backup.js';

const run = promisify(execFile);
const USERNAME = 'backup-admin';
const PASSWORD = 'forgejo-admin-value-never-log';
const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'zapp-backup-git-test-'));
  workspaces.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('createGitBundleCommands', () => {
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
  });

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
      return { stdout: '' };
    };
    const git = createGitBundleCommands({
      username: USERNAME,
      password: PASSWORD,
      timeoutMs: 5_000,
      executor,
    });

    await git.createBundle('https://git.test/org/repository.git', '/tmp/controller.bundle');
    await git.mirrorPush('/tmp/controller.bundle', 'https://git.test/drill/repository.git');

    expect(calls.map((call) => call.args)).toEqual([
      ['clone', '--mirror', 'https://git.test/org/repository.git', expect.any(String)],
      ['-C', expect.any(String), 'bundle', 'create', '/tmp/controller.bundle', '--all'],
      ['clone', '--mirror', '/tmp/controller.bundle', expect.any(String)],
      ['-C', expect.any(String), 'push', '--mirror', 'https://git.test/drill/repository.git'],
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

    await expect(git.remoteRefs('https://git.test/org/repository.git')).resolves.toEqual(
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
    await expect(malformed.remoteRefs('https://git.test/org/repository.git')).rejects.toThrow(
      'Git remote ref listing was invalid',
    );
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
      git.createBundle(
        'https://forbidden:credential@git.test/org/repository.git',
        '/tmp/controller.bundle',
      ),
    ).rejects.toThrow('Invalid Git URL');
    expect(calls).toBe(0);
  });
});
