import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CgroupV2Containment } from '../src/containment/cgroup.js';
import {
  ContainmentUnavailableError,
  type Containment,
  type ExecutionContainment,
} from '../src/containment/types.js';
import { ExecManager } from '../src/exec.js';

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

class ManualExecutionContainment implements ExecutionContainment {
  private resolveEmpty: () => void = () => undefined;
  private resolveRemoved: () => void = () => undefined;
  readonly empty = new Promise<void>((resolve) => {
    this.resolveEmpty = resolve;
  });
  readonly removed = new Promise<void>((resolve) => {
    this.resolveRemoved = resolve;
  });
  killCalls = 0;
  waitCalls = 0;
  removeCalls = 0;

  constructor(
    readonly id: string,
    readonly procsPath: string,
  ) {}

  kill(): Promise<void> {
    this.killCalls += 1;
    return Promise.resolve();
  }

  async waitForEmpty(): Promise<void> {
    this.waitCalls += 1;
    await this.empty;
  }

  remove(): Promise<void> {
    this.removeCalls += 1;
    this.resolveRemoved();
    return Promise.resolve();
  }

  markEmpty(): void {
    this.resolveEmpty();
  }
}

class ManualContainment implements Containment {
  readonly executions: ManualExecutionContainment[] = [];

  constructor(private readonly root: string) {}

  async create(): Promise<ExecutionContainment> {
    const id = `execution-${String(this.executions.length + 1)}`;
    const directory = join(this.root, id);
    const procsPath = join(directory, 'cgroup.procs');
    await mkdir(directory);
    await writeFile(procsPath, '');
    const execution = new ManualExecutionContainment(id, procsPath);
    this.executions.push(execution);
    return execution;
  }
}

class BadJoinExecutionContainment implements ExecutionContainment {
  readonly id = 'bad-join';
  readonly procsPath = join(tmpdir(), 'zapp-missing-cgroup.procs');
  killCalls = 0;
  waitCalls = 0;
  removeCalls = 0;

  kill(): Promise<void> {
    this.killCalls += 1;
    return Promise.resolve();
  }

  waitForEmpty(): Promise<void> {
    this.waitCalls += 1;
    return Promise.resolve();
  }

  remove(): Promise<void> {
    this.removeCalls += 1;
    return Promise.resolve();
  }
}

class BadJoinContainment implements Containment {
  readonly executions: BadJoinExecutionContainment[] = [];

  create(): Promise<ExecutionContainment> {
    const execution = new BadJoinExecutionContainment();
    this.executions.push(execution);
    return Promise.resolve(execution);
  }
}

describe('cgroup-v2 containment', () => {
  test('fails closed when the delegated cgroup v2 root is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-cgroup-unavailable-'));
    try {
      await expect(new CgroupV2Containment(root).create()).rejects.toBeInstanceOf(
        ContainmentUnavailableError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('joins an injected containment before user code and removes it only after populated 0', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-cgroup-lifecycle-'));
    const containment = new ManualContainment(workspaceRoot);
    const manager = new ExecManager(workspaceRoot, containment);
    let startedPid: number | undefined;

    try {
      const result = await manager.run(
        {
          cmd: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(workspaceRoot, 'started'))}, 'yes')`],
          timeoutMs: 2_000,
        },
        (record) => {
          if (record.type === 'started') {
            startedPid = record.pid;
          }
        },
      );
      const execution = containment.executions[0];
      if (execution === undefined || startedPid === undefined) {
        throw new Error('Expected an execution containment and launcher PID');
      }

      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspaceRoot, 'started'), 'utf8')).toBe('yes');
      expect(await readFile(execution.procsPath, 'utf8')).toContain(`${String(startedPid)}\n`);
      expect(execution.waitCalls).toBe(1);
      expect(execution.removeCalls).toBe(0);
      expect(manager.kill(startedPid)).toBe(false);

      execution.markEmpty();
      await execution.removed;
      expect(execution.removeCalls).toBe(1);
    } finally {
      const execution = containment.executions[0];
      execution?.markEmpty();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('joins an injected containment before PTY user code', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-cgroup-pty-'));
    const containment = new ManualContainment(workspaceRoot);
    const manager = new ExecManager(workspaceRoot, containment);
    let startedPid: number | undefined;

    try {
      const result = await manager.run(
        {
          cmd: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(workspaceRoot, 'pty-started'))}, 'yes')`],
          pty: true,
          timeoutMs: 2_000,
        },
        (record) => {
          if (record.type === 'started') {
            startedPid = record.pid;
          }
        },
      );
      const execution = containment.executions[0];
      if (execution === undefined || startedPid === undefined) {
        throw new Error('Expected an execution containment and launcher PID');
      }

      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspaceRoot, 'pty-started'), 'utf8')).toBe('yes');
      expect(await readFile(execution.procsPath, 'utf8')).toContain(`${String(startedPid)}\n`);

      execution.markEmpty();
      await execution.removed;
    } finally {
      containment.executions[0]?.markEmpty();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('fails closed when buffered launcher cgroup join verification fails', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-cgroup-bad-buffered-'));
    const containment = new BadJoinContainment();
    const manager = new ExecManager(workspaceRoot, containment);

    try {
      await expect(
        manager.run({
          cmd: process.execPath,
          args: ['-e', 'process.stdout.write("must-not-run")'],
          timeoutMs: 2_000,
        }),
      ).rejects.toBeInstanceOf(ContainmentUnavailableError);
      expect(containment.executions[0]?.removeCalls).toBe(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('fails closed when PTY launcher cgroup join verification fails', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-cgroup-bad-pty-'));
    const containment = new BadJoinContainment();
    const manager = new ExecManager(workspaceRoot, containment);

    try {
      await expect(
        manager.run({
          cmd: process.execPath,
          args: ['-e', 'process.stdout.write("must-not-run")'],
          pty: true,
          timeoutMs: 2_000,
        }),
      ).rejects.toBeInstanceOf(ContainmentUnavailableError);
      expect(containment.executions[0]?.removeCalls).toBe(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('ends completed PID ownership before blocked output while retaining cgroup ownership until populated 0', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-cgroup-ownership-'));
    const containment = new ManualContainment(workspaceRoot);
    const manager = new ExecManager(workspaceRoot, containment);
    let startedPid: number | undefined;
    let releaseOutput: (() => void) | undefined;
    const outputGate = new Promise<void>((resolve) => {
      releaseOutput = resolve;
    });
    let run: Promise<unknown> | undefined;

    try {
      run = manager.run(
        {
          cmd: process.execPath,
          args: ['-e', 'process.stdout.write("held")'],
          timeoutMs: 2_000,
        },
        async (record) => {
          if (record.type === 'started') {
            startedPid = record.pid;
          }
          if (record.type === 'stdout') {
            await outputGate;
          }
        },
      );
      await waitFor(() => startedPid !== undefined, 'launcher PID');
      const execution = containment.executions[0];
      if (execution === undefined || startedPid === undefined) {
        throw new Error('Expected an execution containment and launcher PID');
      }

      await waitFor(() => execution.waitCalls === 1, 'cgroup empty wait after launcher exit');
      expect(manager.kill(startedPid)).toBe(false);
      expect(manager.activeContainmentCount()).toBe(1);
      expect(execution.removeCalls).toBe(0);

      if (releaseOutput === undefined) {
        throw new Error('Expected output gate release function');
      }
      releaseOutput();
      await run;
      execution.markEmpty();
      await execution.removed;
      await waitFor(() => manager.activeContainmentCount() === 0, 'containment ownership cleanup');
    } finally {
      releaseOutput?.();
      containment.executions[0]?.markEmpty();
      await run?.catch(() => undefined);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
