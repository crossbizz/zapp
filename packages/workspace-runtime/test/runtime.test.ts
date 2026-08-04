import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

describe('MemoryWorkspaceRuntime exec safety', () => {
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
});
