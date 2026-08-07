import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionContract } from '@zapp/contracts';
import {
  AtomicWriteConflictError,
  MemoryWorkspaceRuntime,
  PathViolationError,
} from '../src/runtime.js';

interface TestAtomicFileOperations {
  read(path: string): Promise<Uint8Array>;
  metadata(path: string): Promise<{ mode: number; dev: number; ino: number }>;
  write(path: string, data: Uint8Array, mode?: number): Promise<void>;
  replace(source: string, destination: string): Promise<void>;
  setMode(path: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
}

const nodeAtomicFileOperations: TestAtomicFileOperations = {
  read: async (path) => new Uint8Array(await readFile(path)),
  metadata: async (path) => {
    const metadata = await stat(path);
    return { mode: metadata.mode, dev: metadata.dev, ino: metadata.ino };
  },
  write: async (path, data, mode) =>
    writeFile(path, data, mode === undefined ? undefined : { mode }),
  replace: rename,
  setMode: chmod,
  remove: (path) => rm(path, { force: true }),
};

async function namesAliasOnFilesystem(
  parent: string,
  first: string,
  second: string,
): Promise<boolean> {
  const probe = await mkdtemp(join(parent, '.zapp-name-capability-'));
  try {
    await writeFile(join(probe, first), '', { flag: 'wx' });
    try {
      await writeFile(join(probe, second), '', { flag: 'wx' });
      return false;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return true;
      throw error;
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

async function withWorkspace(
  run: (root: string, runtime: MemoryWorkspaceRuntime) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'zapp-workspace-runtime-'));
  const runtime = new MemoryWorkspaceRuntime(root);

  try {
    await run(root, runtime);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  return address.port;
}

async function listenEventually(port: number, timeoutMs: number): Promise<Server> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const server = createServer();
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, '127.0.0.1', resolveListen);
      });
      return server;
    } catch (error: unknown) {
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'EADDRINUSE' ||
        performance.now() >= deadline
      ) {
        throw error;
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });
}

function executionContract(command: string, port: number): ExecutionContract {
  return {
    version: 1,
    package_manager: 'pnpm',
    workspace_root: '.',
    install: { command: 'true' },
    develop: { command, port },
  };
}

async function processIsGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (performance.now() >= deadline) {
      return false;
    }
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 25);
    });
  }
}

async function initializeGitRepository(runtime: MemoryWorkspaceRuntime): Promise<void> {
  for (const args of [
    ['init'],
    ['config', 'user.email', 'runtime@example.test'],
    ['config', 'user.name', 'Runtime Test'],
  ]) {
    await expect(runtime.exec({ cmd: 'git', args, timeoutMs: 5_000 })).resolves.toMatchObject({
      exitCode: 0,
    });
  }
  await runtime.writeFile('entry.txt', new TextEncoder().encode('workspace data'));
  await expect(
    runtime.exec({ cmd: 'git', args: ['add', 'entry.txt'], timeoutMs: 5_000 }),
  ).resolves.toMatchObject({ exitCode: 0 });
  await expect(
    runtime.exec({ cmd: 'git', args: ['commit', '-m', 'initial'], timeoutMs: 5_000 }),
  ).resolves.toMatchObject({ exitCode: 0 });
}

async function gitStdout(runtime: MemoryWorkspaceRuntime, args: string[]): Promise<string> {
  const result = await runtime.exec({ cmd: 'git', args, timeoutMs: 5_000 });
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

describe('MemoryWorkspaceRuntime path safety', () => {
  it('lists files whose paths stay within the workspace root', async () => {
    await withWorkspace(async (_root, runtime) => {
      await runtime.writeFile('entry.txt', new TextEncoder().encode('workspace data'));

      await expect(runtime.listFiles('.')).resolves.toEqual([{ path: 'entry.txt', type: 'file' }]);
    });
  });

  it('rejects ../etc/passwd before it can read outside the workspace', async () => {
    await withWorkspace(async (_root, runtime) => {
      await expect(runtime.readFile('../etc/passwd')).rejects.toBeInstanceOf(PathViolationError);
    });
  });

  it('rejects a/../../x before normalization can escape the workspace', async () => {
    await withWorkspace(async (_root, runtime) => {
      await expect(runtime.writeFile('a/../../x', new Uint8Array())).rejects.toBeInstanceOf(
        PathViolationError,
      );
    });
  });

  it('rejects a symlink whose target escapes the workspace root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'zapp-workspace-runtime-outside-'));
    const outsideFile = join(outside, 'secret.txt');
    await writeFile(outsideFile, 'not workspace data');

    try {
      await withWorkspace(async (root, runtime) => {
        await symlink(outside, join(root, 'escape'));
        await expect(runtime.readFile('escape/secret.txt')).rejects.toBeInstanceOf(
          PathViolationError,
        );
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('validates every path before writing an atomic file batch', async () => {
    await withWorkspace(async (_root, runtime) => {
      await runtime.writeFile('first.txt', new TextEncoder().encode('first'));
      await runtime.writeFile('second.txt', new TextEncoder().encode('second'));

      await expect(
        runtime.writeFilesAtomically([
          { path: 'first.txt', data: new TextEncoder().encode('changed first') },
          { path: '../outside.txt', data: new TextEncoder().encode('escape') },
        ]),
      ).rejects.toBeInstanceOf(PathViolationError);
      await expect(runtime.readFile('first.txt')).resolves.toEqual(
        new TextEncoder().encode('first'),
      );

      await expect(
        runtime.writeFilesAtomically([
          { path: 'first.txt', data: new TextEncoder().encode('changed first') },
          { path: 'second.txt', data: new TextEncoder().encode('changed second') },
        ]),
      ).resolves.toBeUndefined();
      await expect(runtime.readFile('first.txt')).resolves.toEqual(
        new TextEncoder().encode('changed first'),
      );
      await expect(runtime.readFile('second.txt')).resolves.toEqual(
        new TextEncoder().encode('changed second'),
      );
    });
  });

  it('fails closed when guarded writes lack a provider revision CAS', async () => {
    await withWorkspace(async (_root, runtime) => {
      await runtime.writeFile('target.txt', new TextEncoder().encode('expected\n'));

      await expect(runtime.readFileForUpdate('target.txt')).rejects.toBeInstanceOf(
        AtomicWriteConflictError,
      );
      await expect(
        runtime.writeFilesAtomically([
          {
            path: 'target.txt',
            data: new TextEncoder().encode('patched\n'),
            expectedRevision: 'unavailable-revision',
          },
        ]),
      ).rejects.toBeInstanceOf(AtomicWriteConflictError);
      await expect(runtime.readFile('target.txt')).resolves.toEqual(
        new TextEncoder().encode('expected\n'),
      );
    });
  });

  it('serializes ordinary runtime writes after an in-flight atomic replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-atomic-write-serialization-'));
    const target = join(root, 'target.txt');
    const expected = new TextEncoder().encode('expected\n');
    const patched = new TextEncoder().encode('patched\n');
    const concurrent = new TextEncoder().encode('concurrent\n');
    const events: string[] = [];
    let concurrentWrite: Promise<void> | undefined;
    const runtime = new MemoryWorkspaceRuntime(root, {
      atomicFileOperations: {
        ...nodeAtomicFileOperations,
        replace: async (source, destination) => {
          events.push('replace-started');
          concurrentWrite = runtime.writeFile('target.txt', concurrent).then(() => {
            events.push('ordinary-write-completed');
          });
          await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
          await nodeAtomicFileOperations.replace(source, destination);
          events.push('replace-completed');
        },
      },
    });

    try {
      await writeFile(target, expected);

      await expect(
        runtime.writeFilesAtomically([{ path: 'target.txt', data: patched }]),
      ).resolves.toBeUndefined();
      await concurrentWrite;

      expect(events).toEqual([
        'replace-started',
        'replace-completed',
        'ordinary-write-completed',
      ]);
      await expect(readFile(target)).resolves.toEqual(Buffer.from(concurrent));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects duplicate lexical targets before staging any atomic write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-atomic-duplicate-'));
    let stagingWrites = 0;
    const runtime = new MemoryWorkspaceRuntime(root, {
      atomicFileOperations: {
        ...nodeAtomicFileOperations,
        write: async (path, data, mode) => {
          stagingWrites += 1;
          await writeFile(path, data, mode === undefined ? undefined : { mode });
        },
      },
    });

    try {
      await runtime.writeFile('file.txt', new TextEncoder().encode('original\n'));
      await expect(
        runtime.writeFilesAtomically([
          { path: 'file.txt', data: new TextEncoder().encode('first edit\n') },
          { path: './file.txt', data: new TextEncoder().encode('second edit\n') },
        ]),
      ).rejects.toThrow('duplicate targets');
      expect(stagingWrites).toBe(0);
      await expect(runtime.readFile('file.txt')).resolves.toEqual(
        new TextEncoder().encode('original\n'),
      );
      expect((await readdir(root)).filter((name) => name.startsWith('.zapp-atomic-'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects existing canonical and same-inode atomic-write aliases before staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-atomic-inode-alias-'));
    let stagingWrites = 0;
    const runtime = new MemoryWorkspaceRuntime(root, {
      atomicFileOperations: {
        ...nodeAtomicFileOperations,
        write: async (path, data, mode) => {
          stagingWrites += 1;
          await writeFile(path, data, mode === undefined ? undefined : { mode });
        },
      },
    });

    try {
      await mkdir(join(root, 'real'));
      await runtime.writeFile('real/file.txt', new TextEncoder().encode('canonical\n'));
      await symlink('real', join(root, 'alias'), 'dir');
      await expect(
        runtime.writeFilesAtomically([
          { path: 'real/file.txt', data: new TextEncoder().encode('first\n') },
          { path: 'alias/file.txt', data: new TextEncoder().encode('second\n') },
        ]),
      ).rejects.toThrow('duplicate targets');

      await runtime.writeFile('hard-source.txt', new TextEncoder().encode('hard linked\n'));
      await link(join(root, 'hard-source.txt'), join(root, 'hard-alias.txt'));
      await expect(
        runtime.writeFilesAtomically([
          { path: 'hard-source.txt', data: new TextEncoder().encode('first\n') },
          { path: 'hard-alias.txt', data: new TextEncoder().encode('second\n') },
        ]),
      ).rejects.toThrow('duplicate targets');

      expect(stagingWrites).toBe(0);
      await expect(runtime.readFile('real/file.txt')).resolves.toEqual(
        new TextEncoder().encode('canonical\n'),
      );
      await expect(runtime.readFile('hard-source.txt')).resolves.toEqual(
        new TextEncoder().encode('hard linked\n'),
      );
      await expect(runtime.readFile('hard-alias.txt')).resolves.toEqual(
        new TextEncoder().encode('hard linked\n'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a leaf symlink anywhere in an atomic batch before staging or changing topology', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-atomic-leaf-symlink-'));
    let stagingWrites = 0;
    const runtime = new MemoryWorkspaceRuntime(root, {
      atomicFileOperations: {
        ...nodeAtomicFileOperations,
        write: async (path, data, mode) => {
          stagingWrites += 1;
          await writeFile(path, data, mode === undefined ? undefined : { mode });
        },
      },
    });

    try {
      await runtime.writeFile('ordinary.txt', new TextEncoder().encode('ordinary before\n'));
      await runtime.writeFile('referent.txt', new TextEncoder().encode('referent before\n'));
      await symlink('referent.txt', join(root, 'leaf.txt'), 'file');

      await expect(
        runtime.writeFilesAtomically([
          { path: 'ordinary.txt', data: new TextEncoder().encode('ordinary after\n') },
          { path: 'leaf.txt', data: new TextEncoder().encode('referent after\n') },
        ]),
      ).rejects.toThrow('symbolic link');

      expect(stagingWrites).toBe(0);
      expect((await lstat(join(root, 'leaf.txt'))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(root, 'leaf.txt'))).toBe('referent.txt');
      await expect(runtime.readFile('ordinary.txt')).resolves.toEqual(
        new TextEncoder().encode('ordinary before\n'),
      );
      await expect(runtime.readFile('referent.txt')).resolves.toEqual(
        new TextEncoder().encode('referent before\n'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses parent-filesystem name semantics to reject absent atomic target aliases', async () => {
    const pairs = [
      ['CaseFold.txt', 'casefold.txt'],
      ['caf\u00e9.txt', 'cafe\u0301.txt'],
    ] as const;

    await withWorkspace(async (root, runtime) => {
      for (const [index, [first, second]] of pairs.entries()) {
        const directory = `names-${String(index)}`;
        const parent = join(root, directory);
        await mkdir(parent);
        const aliases = await namesAliasOnFilesystem(parent, first, second);
        expect(await readdir(parent)).toEqual([]);

        const operation = runtime.writeFilesAtomically([
          { path: `${directory}/${first}`, data: new TextEncoder().encode('first\n') },
          { path: `${directory}/${second}`, data: new TextEncoder().encode('second\n') },
        ]);
        if (aliases) {
          await expect(operation).rejects.toThrow('duplicate targets');
          expect(await readdir(parent)).toEqual([]);
        } else {
          await expect(operation).resolves.toBeUndefined();
          await expect(runtime.readFile(`${directory}/${first}`)).resolves.toEqual(
            new TextEncoder().encode('first\n'),
          );
          await expect(runtime.readFile(`${directory}/${second}`)).resolves.toEqual(
            new TextEncoder().encode('second\n'),
          );
        }
      }
    });
  });

  it('removes absent-name probes before the first atomic staging write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-atomic-name-probe-cleanup-'));
    await mkdir(join(root, 'parent'));
    let stagingWrites = 0;
    const runtime = new MemoryWorkspaceRuntime(root, {
      atomicFileOperations: {
        ...nodeAtomicFileOperations,
        write: async (path, data, mode) => {
          expect(
            (await readdir(join(root, 'parent'))).filter((name) =>
              name.startsWith('.zapp-name-probe-'),
            ),
          ).toEqual([]);
          stagingWrites += 1;
          await writeFile(path, data, mode === undefined ? undefined : { mode });
        },
      },
    });

    try {
      await runtime.writeFilesAtomically([
        { path: 'parent/alpha.txt', data: new TextEncoder().encode('alpha\n') },
        { path: 'parent/beta.txt', data: new TextEncoder().encode('beta\n') },
      ]);
      expect(stagingWrites).toBe(2);
      expect((await readdir(join(root, 'parent'))).sort()).toEqual(['alpha.txt', 'beta.txt']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('owns ripgrep path validation and execution in one typed search operation', async () => {
    await withWorkspace(async (_root, runtime) => {
      await runtime.writeFile('inside.txt', new TextEncoder().encode('inside marker\n'));

      const result = await runtime.search({
        pattern: 'inside',
        path: 'inside.txt',
        fixedStrings: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('inside marker');
      await expect(
        runtime.search({ pattern: 'outside', path: '../outside.txt' }),
      ).rejects.toBeInstanceOf(PathViolationError);
    });
  });

  it('deletes only regular files without recursive directory behavior', async () => {
    await withWorkspace(async (root, runtime) => {
      await runtime.writeFile('victim.txt', new TextEncoder().encode('victim'));
      await expect(runtime.deleteFile('victim.txt')).resolves.toBeUndefined();
      await expect(readFile(join(root, 'victim.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

      await runtime.writeFile('keep.txt', new TextEncoder().encode('keep'));
      let deletionError: unknown;
      try {
        await runtime.deleteFile('.');
      } catch (error: unknown) {
        deletionError = error;
      }
      expect(deletionError).toBeInstanceOf(Error);
      expect(
        deletionError instanceof Error && 'code' in deletionError
          ? String(deletionError.code)
          : '',
      ).toMatch(/EISDIR|EPERM/u);
      await expect(runtime.readFile('keep.txt')).resolves.toEqual(
        new TextEncoder().encode('keep'),
      );
    });
  });

  it('treats a repeated nonrecursive file deletion as already complete', async () => {
    await withWorkspace(async (root, runtime) => {
      await runtime.writeFile('repeat.txt', new TextEncoder().encode('delete once'));

      await expect(runtime.deleteFile('repeat.txt')).resolves.toBeUndefined();
      await expect(runtime.deleteFile('repeat.txt')).resolves.toBeUndefined();
      await expect(readFile(join(root, 'repeat.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('atomically renames with replace semantics and rejects self-renames before mutation', async () => {
    await withWorkspace(async (root, runtime) => {
      await runtime.writeFile('source.txt', new TextEncoder().encode('source'));
      await runtime.writeFile('destination.txt', new TextEncoder().encode('destination'));

      await expect(
        runtime.renameFile({
          source: 'source.txt',
          destination: 'destination.txt',
          overwrite: 'replace',
        }),
      ).resolves.toBeUndefined();
      await expect(runtime.readFile('destination.txt')).resolves.toEqual(
        new TextEncoder().encode('source'),
      );
      await expect(readFile(join(root, 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

      await runtime.writeFile('same.txt', new TextEncoder().encode('same'));
      await expect(
        runtime.renameFile({
          source: 'same.txt',
          destination: './same.txt',
          overwrite: 'replace',
        }),
      ).rejects.toThrow('source and destination must differ');
      await expect(runtime.readFile('same.txt')).resolves.toEqual(new TextEncoder().encode('same'));
    });
  });

  it('rejects normalized, parent-symlink, and hard-link aliases of one rename object', async () => {
    await withWorkspace(async (root, runtime) => {
      await runtime.writeFile('normalized.txt', new TextEncoder().encode('normalized'));

      await mkdir(join(root, 'real'));
      await runtime.writeFile('real/parent.txt', new TextEncoder().encode('parent alias'));
      await symlink('real', join(root, 'alias'), 'dir');

      await runtime.writeFile('hard-source.txt', new TextEncoder().encode('hard alias'));
      await link(join(root, 'hard-source.txt'), join(root, 'hard-alias.txt'));

      for (const [source, destination] of [
        ['normalized.txt', './normalized.txt'],
        ['alias/parent.txt', 'real/parent.txt'],
        ['hard-source.txt', 'hard-alias.txt'],
      ] as const) {
        await expect(
          runtime.renameFile({ source, destination, overwrite: 'replace' }),
        ).rejects.toThrow('source and destination must differ');
      }

      await expect(runtime.readFile('normalized.txt')).resolves.toEqual(
        new TextEncoder().encode('normalized'),
      );
      await expect(runtime.readFile('real/parent.txt')).resolves.toEqual(
        new TextEncoder().encode('parent alias'),
      );
      await expect(runtime.readFile('alias/parent.txt')).resolves.toEqual(
        new TextEncoder().encode('parent alias'),
      );
      await expect(runtime.readFile('hard-source.txt')).resolves.toEqual(
        new TextEncoder().encode('hard alias'),
      );
      await expect(runtime.readFile('hard-alias.txt')).resolves.toEqual(
        new TextEncoder().encode('hard alias'),
      );
    });
  });

  it('preserves executable modes on successful atomic writes', async () => {
    await withWorkspace(async (root, runtime) => {
      const script = join(root, 'script.sh');
      await runtime.writeFile('script.sh', new TextEncoder().encode('before\n'));
      await chmod(script, 0o755);

      await runtime.writeFilesAtomically([
        { path: 'script.sh', data: new TextEncoder().encode('after\n') },
      ]);

      expect((await lstat(script)).mode & 0o777).toBe(0o755);
      await expect(runtime.readFile('script.sh')).resolves.toEqual(
        new TextEncoder().encode('after\n'),
      );
    });
  });

  it('rolls back bytes and modes and cleans staging after failures following commits 1, 2, and 3', async () => {
    for (const failAfter of [1, 2, 3]) {
      const root = await mkdtemp(join(tmpdir(), 'zapp-atomic-fault-'));
      let commitCount = 0;
      const operations: TestAtomicFileOperations = {
        ...nodeAtomicFileOperations,
        replace: async (source, destination) => {
          await nodeAtomicFileOperations.replace(source, destination);
          commitCount += 1;
          if (commitCount === failAfter) throw new Error(`commit ${String(failAfter)} failed`);
        },
      };
      const runtime = new MemoryWorkspaceRuntime(root, { atomicFileOperations: operations });

      try {
        for (const [index, name] of ['first.txt', 'second.txt', 'third.txt'].entries()) {
          await runtime.writeFile(name, new TextEncoder().encode(`${name} before\n`));
          await chmod(join(root, name), 0o750 + index);
        }

        await expect(
          runtime.writeFilesAtomically(
            ['first.txt', 'second.txt', 'third.txt'].map((path) => ({
              path,
              data: new TextEncoder().encode(`${path} after\n`),
            })),
          ),
        ).rejects.toMatchObject({ code: 'atomic_commit_failed' });

        for (const [index, name] of ['first.txt', 'second.txt', 'third.txt'].entries()) {
          await expect(runtime.readFile(name)).resolves.toEqual(
            new TextEncoder().encode(`${name} before\n`),
          );
          expect((await lstat(join(root, name))).mode & 0o777).toBe(0o750 + index);
        }
        expect((await readdir(root)).filter((name) => name.startsWith('.zapp-atomic-'))).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('reports rollback and cleanup failures without claiming atomic restoration', async () => {
    for (const failure of ['rollback', 'cleanup'] as const) {
      const root = await mkdtemp(join(tmpdir(), `zapp-atomic-${failure}-`));
      let commitFailed = false;
      const operations: TestAtomicFileOperations = {
        ...nodeAtomicFileOperations,
        replace: async (source, destination) => {
          await nodeAtomicFileOperations.replace(source, destination);
          commitFailed = true;
          throw new Error('commit failed after rename');
        },
        write: async (path, data, mode) => {
          if (failure === 'rollback' && commitFailed && path.endsWith('first.txt')) {
            throw new Error('rollback write failed');
          }
          await writeFile(path, data, mode === undefined ? undefined : { mode });
        },
        remove: async (path) => {
          if (failure === 'cleanup' && path.includes('.zapp-atomic-')) {
            throw new Error('cleanup failed');
          }
          await rm(path, { force: true });
        },
      };
      const runtime = new MemoryWorkspaceRuntime(root, { atomicFileOperations: operations });

      try {
        await runtime.writeFile('first.txt', new TextEncoder().encode('before\n'));
        await chmod(join(root, 'first.txt'), 0o755);
        await expect(
          runtime.writeFilesAtomically([
            { path: 'first.txt', data: new TextEncoder().encode('after\n') },
            { path: 'second.txt', data: new TextEncoder().encode('new\n') },
          ]),
        ).rejects.toMatchObject({
          code: failure === 'rollback' ? 'atomic_rollback_failed' : 'atomic_cleanup_failed',
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});

describe('MemoryWorkspaceRuntime git safety', () => {
  it('allows normal operation flags while rejecting escape options and paths', async () => {
    await withWorkspace(async (_root, runtime) => {
      await initializeGitRepository(runtime);

      for (const op of [
        { operation: 'diff' as const, args: ['--cached'] },
        { operation: 'log' as const, args: ['--oneline'] },
        { operation: 'show' as const, args: ['--stat'] },
        { operation: 'checkout' as const, args: ['--detach'] },
      ]) {
        await expect(runtime.git(op)).resolves.toMatchObject({ exitCode: 0 });
      }

      await expect(
        runtime.git({ operation: 'status', args: ['-C', '/outside'] }),
      ).rejects.toBeInstanceOf(PathViolationError);
      await expect(
        runtime.git({ operation: 'diff', args: ['--no-index', '/outside', '/outside'] }),
      ).rejects.toBeInstanceOf(PathViolationError);
      await expect(
        runtime.git({ operation: 'checkout', args: ['--', '../outside'] }),
      ).rejects.toBeInstanceOf(PathViolationError);
      await expect(
        runtime.git({ operation: 'add_commit', paths: ['../outside'], message: 'escape' }),
      ).rejects.toBeInstanceOf(PathViolationError);
    });
  });

  it('merges a validated branch ref and reverts a validated commit id', async () => {
    await withWorkspace(async (_root, runtime) => {
      await initializeGitRepository(runtime);
      const baseBranch = await gitStdout(runtime, ['branch', '--show-current']);

      expect(
        (
          await runtime.exec({
            cmd: 'git',
            args: ['checkout', '-b', 'feature/runtime-git'],
            timeoutMs: 5_000,
          })
        ).exitCode,
      ).toBe(0);
      await runtime.writeFile('entry.txt', new TextEncoder().encode('feature data'));
      expect(
        (
          await runtime.exec({
            cmd: 'git',
            args: ['add', 'entry.txt'],
            timeoutMs: 5_000,
          })
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await runtime.exec({
            cmd: 'git',
            args: ['commit', '-m', 'feature change'],
            timeoutMs: 5_000,
          })
        ).exitCode,
      ).toBe(0);
      const featureCommit = await gitStdout(runtime, ['rev-parse', 'HEAD']);
      expect(
        (
          await runtime.exec({
            cmd: 'git',
            args: ['checkout', baseBranch],
            timeoutMs: 5_000,
          })
        ).exitCode,
      ).toBe(0);

      await expect(
        runtime.git({ operation: 'merge', ref: 'feature/runtime-git' }),
      ).resolves.toMatchObject({ exitCode: 0 });
      await expect(runtime.readFile('entry.txt')).resolves.toEqual(
        new TextEncoder().encode('feature data'),
      );

      await expect(
        runtime.git({ operation: 'revert', commit: featureCommit }),
      ).resolves.toMatchObject({ exitCode: 0 });
      await expect(runtime.readFile('entry.txt')).resolves.toEqual(
        new TextEncoder().encode('workspace data'),
      );
    });
  });

  it('rejects merge and revert option injection, ref traversal, and non-commit ids', async () => {
    await withWorkspace(async (_root, runtime) => {
      await initializeGitRepository(runtime);

      for (const ref of ['--strategy=ours', '../outside', 'feature..outside', 'feature@{1}']) {
        await expect(runtime.git({ operation: 'merge', ref })).rejects.toBeInstanceOf(
          PathViolationError,
        );
      }
      for (const commit of ['--no-edit', '../outside', 'HEAD', 'abc123;touch-pwned']) {
        await expect(runtime.git({ operation: 'revert', commit })).rejects.toBeInstanceOf(
          PathViolationError,
        );
      }
    });
  });
});

describe('MemoryWorkspaceRuntime development server', () => {
  it('rejects a process-owned raw TCP listener without a successful HTTP probe', async () => {
    await withWorkspace(async (_root, runtime) => {
      const port = await availablePort();
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require('node:net').createServer((socket) => socket.destroy()).listen(${String(port)}, '127.0.0.1'); setInterval(() => {}, 1000);`,
      )}`;
      const starting = runtime.startDevServer(executionContract(command, port));

      try {
        await expect(starting).rejects.toThrow('Development server did not become ready');
      } finally {
        const unexpected = await starting.catch(() => undefined);
        if (unexpected !== undefined) {
          try {
            process.kill(process.platform === 'win32' ? unexpected.pid : -unexpected.pid, 'SIGKILL');
          } catch {
            // A process that exited during the failed assertion needs no cleanup.
          }
        }
      }
    });
  }, 8_000);

  it('restarts by stopping the managed process before starting a replacement pid', async () => {
    await withWorkspace(async (_root, runtime) => {
      const port = await availablePort();
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require('node:http').createServer((_request, response) => { response.writeHead(204); response.end(); }).listen(${String(port)}, '127.0.0.1'); setInterval(() => {}, 1000);`,
      )}`;
      let replacementPid: number | undefined;

      try {
        const initial = await runtime.startDevServer(executionContract(command, port));
        const replacement = await runtime.restartDevServer(executionContract(command, port));
        replacementPid = replacement.pid;

        expect(replacement.port).toBe(port);
        expect(replacement.pid).not.toBe(initial.pid);
        await expect(processIsGone(initial.pid, 1_000)).resolves.toBe(true);
      } finally {
        if (replacementPid !== undefined) {
          try {
            process.kill(process.platform === 'win32' ? replacementPid : -replacementPid, 'SIGKILL');
          } catch {
            // The replacement can already be gone during failed setup.
          }
        }
      }
    });
  });

  it('rejects restart readiness when an unrelated contender owns the contracted port', async () => {
    await withWorkspace(async (_root, runtime) => {
      const port = await availablePort();
      const servingCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require('node:http').createServer((_request, response) => { response.writeHead(204); response.end(); }).listen(${String(port)}, '127.0.0.1'); setInterval(() => {}, 1000);`,
      )}`;
      const idleCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        'setInterval(() => {}, 1000);',
      )}`;
      const initial = await runtime.startDevServer(executionContract(servingCommand, port));
      const restarting = runtime.restartDevServer(executionContract(idleCommand, port));
      const contender = await listenEventually(port, 2_000);

      try {
        await expect(restarting).rejects.toThrow('Development server did not become ready');
        await expect(processIsGone(initial.pid, 1_000)).resolves.toBe(true);
      } finally {
        await closeServer(contender);
      }
    });
  }, 8_000);

  it('rejects a dev command that exits before its contract port is ready', async () => {
    await withWorkspace(async (_root, runtime) => {
      const port = await availablePort();

      await expect(
        runtime.startDevServer(executionContract('zapp-command-that-does-not-exist', port)),
      ).rejects.toThrow('Development server exited before readiness');
    });
  });

  it('kills a dev command that never opens its contract port', async () => {
    await withWorkspace(async (root, runtime) => {
      const port = await availablePort();
      const pidFile = join(root, 'unready-dev-server.pid');
      let pid: number | undefined;

      try {
        const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
        )}`;
        await expect(runtime.startDevServer(executionContract(command, port))).rejects.toThrow(
          'Development server did not become ready',
        );

        pid = Number(await readFile(pidFile, 'utf8'));
        const capturedPid = pid;
        await expect(processIsGone(capturedPid, 500)).resolves.toBe(true);
      } finally {
        if (pid === undefined) {
          try {
            pid = Number(await readFile(pidFile, 'utf8'));
          } catch {
            // The process may fail before writing its pid.
          }
        }
        if (pid !== undefined) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // A terminated child does not require cleanup.
          }
        }
      }
    });
  }, 8_000);
});

describe('MemoryWorkspaceRuntime exec safety', () => {
  it('yields stdout before the streamed command completes', async () => {
    await withWorkspace(async (_root, runtime) => {
      const iterator = runtime
        .execStream({
          providerWorkspaceId: 'workspace',
          command: process.execPath,
          args: [
            '-e',
            "process.stdout.write('first'); setTimeout(() => process.stdout.write('second'), 650)",
          ],
          timeoutMs: 2_000,
        })
        [Symbol.asyncIterator]();
      const startedAt = performance.now();

      const first = await iterator.next();

      expect(performance.now() - startedAt).toBeLessThan(400);
      expect(first).toMatchObject({ done: false, value: { stream: 'stdout', data: 'first' } });
      expect(await iterator.next()).toMatchObject({
        done: false,
        value: { stream: 'stdout', data: 'second' },
      });
    });
  });

  it('kills a process when its execution timeout elapses', async () => {
    await withWorkspace(async (root, runtime) => {
      const pidFile = join(root, 'timed-out.pid');
      const result = await runtime.exec({
        cmd: process.execPath,
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
        ],
        timeoutMs: 1_000,
      });

      const pid = Number(await readFile(pidFile, 'utf8'));
      expect(result.exitCode).toBe(124);
      expect(result.durationMs).toBeLessThan(2_000);
      expect(() => process.kill(pid, 0)).toThrow();
    });
  });

  it('kills descendant processes that keep inherited output pipes open after a timeout', async () => {
    await withWorkspace(async (root, runtime) => {
      const descendantPidFile = join(root, 'descendant.pid');
      let descendantPid: number | undefined;

      try {
        const resultOrTimeout = await Promise.race([
          runtime.exec({
            cmd: process.execPath,
            args: [
              '-e',
              `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); require('node:fs').writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid)); setInterval(() => {}, 1000);`,
            ],
            timeoutMs: 500,
          }),
          new Promise<'timed out waiting for exec result'>((resolveTimeout) => {
            setTimeout(() => {
              resolveTimeout('timed out waiting for exec result');
            }, 1_500);
          }),
        ]);

        expect(resultOrTimeout).not.toBe('timed out waiting for exec result');
        expect(resultOrTimeout).toMatchObject({ exitCode: 124 });
        const capturedDescendantPid = Number(await readFile(descendantPidFile, 'utf8'));
        descendantPid = capturedDescendantPid;
        expect(() => process.kill(capturedDescendantPid, 0)).toThrow();
      } finally {
        if (descendantPid === undefined) {
          try {
            descendantPid = Number(await readFile(descendantPidFile, 'utf8'));
          } catch {
            // The child did not reach its pid write before a failed setup.
          }
        }
        if (descendantPid !== undefined) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // A killed process has no pid to clean up.
          }
        }
      }
    });
  });

  it('truncates command output at exactly one MiB', async () => {
    await withWorkspace(async (_root, runtime) => {
      const result = await runtime.exec({
        cmd: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(1024 * 1024 + 1))"],
        timeoutMs: 1_000,
      });

      expect(Buffer.byteLength(result.stdout)).toBe(1_024 * 1_024);
      expect(result.stderr).toBe('');
      expect(result.truncated).toBe(true);
    });
  });

  it('keeps truncated UTF-8 output within one MiB without replacement characters', async () => {
    await withWorkspace(async (_root, runtime) => {
      const result = await runtime.exec({
        cmd: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(1024 * 1024 - 1) + '€')"],
        timeoutMs: 1_000,
      });

      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_024 * 1_024);
      expect(result.stdout).not.toContain('\uFFFD');
      expect(result.truncated).toBe(true);
    });
  });
});
