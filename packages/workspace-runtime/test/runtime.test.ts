import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionContract } from '@zapp/contracts';
import { MemoryWorkspaceRuntime, PathViolationError } from '../src/runtime.js';

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
