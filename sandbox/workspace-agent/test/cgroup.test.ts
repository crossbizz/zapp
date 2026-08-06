import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CgroupV2Containment } from '../src/containment/cgroup.js';
import {
  ContainmentCleanupError,
  ContainmentUnavailableError,
  type Containment,
  type ExecutionContainment,
} from '../src/containment/types.js';
import { ExecManager, ExecPreflightError } from '../src/exec.js';

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

class CleanupRecoveryExecutionContainment implements ExecutionContainment {
  private resolveInitialWaited: () => void = () => undefined;
  private resolveEmpty: () => void = () => undefined;
  private resolveRemoved: () => void = () => undefined;
  readonly initialWaited = new Promise<void>((resolve) => {
    this.resolveInitialWaited = resolve;
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
    private readonly remainUnavailable: boolean,
  ) {}

  kill(): Promise<void> {
    this.killCalls += 1;
    return Promise.resolve();
  }

  async waitForEmpty(): Promise<void> {
    this.waitCalls += 1;
    if (this.waitCalls === 1) {
      this.resolveInitialWaited();
      throw new Error('initial authoritative empty wait failed');
    }
    if (this.remainUnavailable) {
      throw new Error('authoritative empty wait remains unavailable');
    }
    await new Promise<void>((resolve) => {
      this.resolveEmpty = resolve;
    });
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

class CleanupRecoveryContainment implements Containment {
  readonly executions: CleanupRecoveryExecutionContainment[] = [];

  constructor(
    private readonly root: string,
    private readonly remainUnavailable: boolean,
  ) {}

  async create(): Promise<ExecutionContainment> {
    const id = `cleanup-recovery-${String(this.executions.length + 1)}`;
    const directory = join(this.root, id);
    const procsPath = join(directory, 'cgroup.procs');
    await mkdir(directory);
    await writeFile(procsPath, '');
    const execution = new CleanupRecoveryExecutionContainment(
      id,
      procsPath,
      this.remainUnavailable,
    );
    this.executions.push(execution);
    return execution;
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
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(join(workspaceRoot, 'started'))}, 'yes')`,
          ],
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
      expect(manager.kill(startedPid, randomUUID())).toBe(false);

      execution.markEmpty();
      await execution.removed;
      expect(execution.removeCalls).toBe(1);
    } finally {
      const execution = containment.executions[0];
      execution?.markEmpty();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('acknowledges an exact execution only after authoritative empty-state cleanup finishes', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-cgroup-ack-'));
    const containment = new ManualContainment(workspaceRoot);
    const manager = new ExecManager(workspaceRoot, containment);
    const cleanupId = randomUUID();
    let acknowledged = false;

    try {
      const result = await manager.run(
        {
          cmd: process.execPath,
          args: ['-e', 'process.exit(0)'],
          timeoutMs: 2_000,
        },
        undefined,
        cleanupId,
      );
      const acknowledgement = manager.acknowledgeCleanup(cleanupId).then(() => {
        acknowledged = true;
      });

      expect(result.exitCode).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(acknowledged).toBe(false);
      expect(containment.executions[0]?.removeCalls).toBe(0);

      containment.executions[0]?.markEmpty();
      await acknowledgement;
      expect(acknowledged).toBe(true);
      expect(containment.executions[0]?.removeCalls).toBe(1);
      await expect(manager.acknowledgeCleanup(cleanupId)).resolves.toBe(true);
    } finally {
      containment.executions[0]?.markEmpty();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('rejects an exact cleanup acknowledgement when the authoritative signal fails', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-cgroup-ack-failure-'));
    const containment = new CleanupRecoveryContainment(workspaceRoot, true);
    const manager = new ExecManager(workspaceRoot, containment);
    const cleanupId = randomUUID();

    try {
      await manager.run(
        {
          cmd: process.execPath,
          args: ['-e', 'process.exit(0)'],
          timeoutMs: 2_000,
        },
        undefined,
        cleanupId,
      );

      await expect(manager.acknowledgeCleanup(cleanupId)).rejects.toBeInstanceOf(
        ContainmentCleanupError,
      );
      await expect(manager.acknowledgeCleanup(cleanupId)).rejects.toBeInstanceOf(
        ContainmentCleanupError,
      );
      expect(containment.executions[0]?.removeCalls).toBe(0);
      expect(manager.activeContainmentCount()).toBe(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('evicts terminal preflight cleanup receipts without exhausting pending receipt capacity', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-cgroup-ack-capacity-'));
    const manager = new ExecManager(workspaceRoot, new ManualContainment(workspaceRoot));
    let newestCleanupId = '';

    try {
      for (let index = 0; index < 257; index += 1) {
        newestCleanupId = randomUUID();
        await expect(
          manager.run(
            {
              cmd: 'zapp-command-that-does-not-exist',
              args: [],
              timeoutMs: 2_000,
            },
            undefined,
            newestCleanupId,
          ),
        ).rejects.toBeInstanceOf(ExecPreflightError);
      }

      await expect(manager.acknowledgeCleanup(newestCleanupId)).rejects.toBeInstanceOf(
        ContainmentCleanupError,
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('requires the started execution generation before killing a reused active PID', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-cgroup-generation-'));
    const containment = new ManualContainment(workspaceRoot);
    const manager = new ExecManager(workspaceRoot, containment);
    let generationA: string | undefined;
    let generationB: string | undefined;
    let pidB: number | undefined;
    let runB: Promise<unknown> | undefined;

    try {
      await manager.run(
        { cmd: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 2_000 },
        (record) => {
          if (record.type === 'started') generationA = record.executionId;
        },
      );
      containment.executions[0]?.markEmpty();
      await containment.executions[0]?.removed;

      runB = manager.run(
        {
          cmd: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1_000)'],
          timeoutMs: 10_000,
        },
        (record) => {
          if (record.type === 'started') {
            pidB = record.pid;
            generationB = record.executionId;
          }
        },
      );
      await waitFor(
        () => pidB !== undefined && generationB !== undefined,
        'second execution identity',
      );
      if (pidB === undefined || generationA === undefined || generationB === undefined) {
        throw new Error('Expected two execution generations and an active PID');
      }

      expect(manager.kill(pidB, generationA)).toBe(false);
      expect(manager.kill(pidB, generationB)).toBe(true);
      process.kill(-pidB, 'SIGKILL');
      await runB;
      containment.executions[1]?.markEmpty();
      await containment.executions[1]?.removed;
    } finally {
      if (pidB !== undefined) {
        try {
          process.kill(-pidB, 'SIGKILL');
        } catch {
          // The process group already exited.
        }
      }
      for (const execution of containment.executions) execution.markEmpty();
      await runB?.catch(() => undefined);
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
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(join(workspaceRoot, 'pty-started'))}, 'yes')`,
          ],
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
      expect(manager.kill(startedPid, randomUUID())).toBe(false);
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

  test('kills and re-observes the authoritative empty signal before cleanup ownership ends', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-cgroup-cleanup-recovery-'));
    const containment = new CleanupRecoveryContainment(workspaceRoot, false);
    const manager = new ExecManager(workspaceRoot, containment);

    try {
      await manager.run({
        cmd: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 2_000,
      });
      const execution = containment.executions[0];
      if (execution === undefined) {
        throw new Error('Expected an execution containment');
      }

      await execution.initialWaited;
      await waitFor(() => execution.killCalls === 1, 'containment kill after empty wait failure');
      await waitFor(() => execution.waitCalls === 2, 'second authoritative empty wait');
      expect(manager.activeContainmentCount()).toBe(1);
      expect(execution.removeCalls).toBe(0);

      execution.markEmpty();
      await execution.removed;
      await waitFor(() => manager.activeContainmentCount() === 0, 'cleanup ownership release');
      expect(execution.removeCalls).toBe(1);
    } finally {
      containment.executions[0]?.markEmpty();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('retains cleanup ownership for shutdown recovery when the post-kill empty wait fails', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-cgroup-cleanup-unavailable-'));
    const containment = new CleanupRecoveryContainment(workspaceRoot, true);
    const manager = new ExecManager(workspaceRoot, containment);

    try {
      await manager.run({
        cmd: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 2_000,
      });
      const execution = containment.executions[0];
      if (execution === undefined) {
        throw new Error('Expected an execution containment');
      }

      await execution.initialWaited;
      await waitFor(() => execution.killCalls === 1, 'containment kill after empty wait failure');
      await waitFor(() => execution.waitCalls === 2, 'post-kill empty wait');
      expect(execution.removeCalls).toBe(0);
      expect(manager.activeContainmentCount()).toBe(1);

      await expect(manager.killAll()).rejects.toBeInstanceOf(ContainmentCleanupError);
      expect(execution.killCalls).toBe(2);
      expect(manager.activeContainmentCount()).toBe(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
