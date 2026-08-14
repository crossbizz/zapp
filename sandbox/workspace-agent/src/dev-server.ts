import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, readlink } from 'node:fs/promises';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import type { ExecutionContract } from '@zapp/contracts';
import { resolveInRoot } from '@zapp/workspace-runtime';

const START_TIMEOUT_MS = 5_000;
const LOG_CAPACITY_BYTES = 10 * 1_024 * 1_024;
const CRASH_WINDOW_MS = 5 * 60_000;
const MAX_CRASH_RESTARTS = 3;

export type DevServerState = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed';

export interface DevServerLogEntry {
  readonly cursor: number;
  readonly at: string;
  readonly stream: 'stdout' | 'stderr';
  readonly message: string;
}

export interface DevServerLogPage {
  readonly entries: readonly DevServerLogEntry[];
  readonly nextCursor: number;
  readonly truncated: boolean;
  readonly state: DevServerState;
  /** Stable while a terminal crash circuit remains open; null for non-terminal states. */
  readonly failureId: string | null;
}

export interface DevServerEvidence {
  readonly port: number;
  readonly pid: number;
  readonly supervisorId: string;
  readonly owned: boolean;
  readonly httpReady: boolean;
}

export interface DevServerStartResult {
  readonly port: number;
  readonly pid: number;
  readonly supervisorId: string;
  readonly ownership: 'process_group';
}

interface ActiveDevServer {
  readonly child: ChildProcess;
  readonly contract: ExecutionContract;
  readonly groupId: number;
  readonly port: number;
  readonly healthPath: string;
  readonly supervisorId: string;
}

async function commandOutput(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
    });
    child.once('error', () => {
      resolveOutput('');
    });
    child.once('close', () => {
      resolveOutput(stdout);
    });
  });
}

async function linuxListenerPids(port: number): Promise<number[]> {
  const inodes = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const row of (await readFile(table, 'utf8')).split('\n').slice(1)) {
        const fields = row.trim().split(/\s+/u);
        const local = fields[1]?.split(':');
        if (
          local?.[1] !== undefined &&
          Number.parseInt(local[1], 16) === port &&
          fields[3] === '0A' &&
          fields[9] !== undefined
        ) {
          inodes.add(fields[9]);
        }
      }
    } catch {
      // A missing proc table means no listener can be structurally attributed here.
    }
  }
  if (inodes.size === 0) return [];
  let processEntries: string[];
  try {
    processEntries = await readdir('/proc');
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const entry of processEntries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      for (const descriptor of await readdir(`/proc/${entry}/fd`)) {
        const target = await readlink(`/proc/${entry}/fd/${descriptor}`);
        const match = /^socket:\[(\d+)\]$/u.exec(target);
        if (match?.[1] !== undefined && inodes.has(match[1])) {
          pids.push(Number(entry));
          break;
        }
      }
    } catch {
      // Exited or inaccessible processes cannot supply ownership evidence.
    }
  }
  return pids;
}

async function listenerPids(port: number): Promise<number[]> {
  if (process.platform === 'linux') return linuxListenerPids(port);
  if (process.platform === 'win32') return [];
  return (await commandOutput('lsof', ['-nP', '-t', `-iTCP:${String(port)}`, '-sTCP:LISTEN']))
    .split('\n')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function processGroupId(pid: number): Promise<number | undefined> {
  if (process.platform === 'linux') {
    try {
      const row = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
      const fields = row.slice(row.lastIndexOf(')') + 1).trim().split(/\s+/u);
      const group = Number(fields[2]);
      return Number.isInteger(group) && group > 0 ? group : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'win32') return undefined;
  const group = Number((await commandOutput('ps', ['-o', 'pgid=', '-p', String(pid)])).trim());
  return Number.isInteger(group) && group > 0 ? group : undefined;
}

async function listenerBelongsToProcessGroup(port: number, groupId: number): Promise<boolean> {
  const groups = await Promise.all((await listenerPids(port)).map(processGroupId));
  return groups.includes(groupId);
}

async function httpProbeSucceeds(port: number, path: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      signal: AbortSignal.timeout(250),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) =>
    child.once('close', () => {
      resolve();
    }),
  );
}

export class DevServerSupervisor {
  private active: ActiveDevServer | undefined;
  private readonly logEntries: DevServerLogEntry[] = [];
  private logBytes = 0;
  private logsDropped = false;
  private nextLogCursor = 1;
  private crashRestarts: number[] = [];
  private state: DevServerState = 'idle';
  private failureId: string | null = null;
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {}

  private async withTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.transitionTail;
    let release: () => void = () => undefined;
    this.transitionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async stopActive(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    if (active === undefined) return;
    if (process.platform !== 'win32') {
      try {
        process.kill(-active.groupId, 'SIGKILL');
      } catch {
        active.child.kill('SIGKILL');
      }
    } else {
      active.child.kill('SIGKILL');
    }
    await waitForClose(active.child);
  }

  private appendLog(stream: DevServerLogEntry['stream'], chunk: Buffer | string): void {
    let message = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let bytes = Buffer.byteLength(message);
    if (bytes > LOG_CAPACITY_BYTES) {
      message = Buffer.from(message).subarray(bytes - LOG_CAPACITY_BYTES).toString('utf8');
      bytes = Buffer.byteLength(message);
      this.logsDropped = true;
    }
    const entry: DevServerLogEntry = {
      cursor: this.nextLogCursor,
      at: new Date().toISOString(),
      stream,
      message,
    };
    this.nextLogCursor += 1;
    this.logEntries.push(entry);
    this.logBytes += bytes;
    while (this.logBytes > LOG_CAPACITY_BYTES) {
      const removed = this.logEntries.shift();
      if (removed === undefined) break;
      this.logBytes -= Buffer.byteLength(removed.message);
      this.logsDropped = true;
    }
  }

  private attachLogs(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer) => {
      this.appendLog('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.appendLog('stderr', chunk);
    });
  }

  private handleCrash(active: ActiveDevServer): void {
    if (this.active !== active) return;
    this.active = undefined;
    void this.withTransition(async () => {
      if (this.active !== undefined) return;
      for (;;) {
        const now = Date.now();
        this.crashRestarts = this.crashRestarts.filter(
          (occurredAt) => now - occurredAt <= CRASH_WINDOW_MS,
        );
        if (this.crashRestarts.length >= MAX_CRASH_RESTARTS) {
          this.state = 'failed';
          this.failureId ??= `devfail_${active.supervisorId}`;
          this.appendLog('stderr', 'Dev server restart limit exceeded.\n');
          return;
        }
        this.crashRestarts.push(now);
        this.state = 'restarting';
        this.appendLog('stderr', 'Dev server exited; restarting.\n');
        try {
          await this.startUnlocked(active.contract, 'restarting');
          return;
        } catch {
          // A replacement that exits before readiness consumes another restart.
        }
      }
    }).catch(() => {
      this.state = 'failed';
      this.failureId ??= `devfail_${active.supervisorId}`;
      this.appendLog('stderr', 'Dev server restart failed.\n');
    });
  }

  private async startUnlocked(
    contract: ExecutionContract,
    transitionState: 'starting' | 'restarting' = 'starting',
  ): Promise<DevServerStartResult> {
    if (this.active !== undefined && processGroupExists(this.active.groupId)) {
      throw new Error('Development server is already running');
    }
    this.active = undefined;
    this.state = transitionState;
    const cwd = await resolveInRoot(this.workspaceRoot, contract.workspace_root);
    const child = spawn(contract.develop.command, {
      cwd,
      env: { ...process.env, NODE_ENV: 'development' },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    if (child.pid === undefined) throw new Error('Could not start development server');
    const groupId = child.pid;
    let spawnFailure: Error | undefined;
    let observedClose = false;
    let activeOnReady: ActiveDevServer | undefined;
    child.once('error', (error) => {
      spawnFailure = error;
    });
    child.once('close', () => {
      observedClose = true;
      if (activeOnReady !== undefined) this.handleCrash(activeOnReady);
    });
    const hasClosed = (): boolean =>
      observedClose || child.exitCode !== null || child.signalCode !== null;
    this.attachLogs(child);
    const healthPath = contract.health?.path ?? '/';
    const deadline = Date.now() + START_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        if (spawnFailure !== undefined) throw spawnFailure;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error('Development server exited before readiness');
        }
        const owned = await listenerBelongsToProcessGroup(contract.develop.port, groupId);
        if (owned && (await httpProbeSucceeds(contract.develop.port, healthPath))) {
          const supervisorId = randomUUID();
          const active: ActiveDevServer = {
            child,
            contract,
            groupId,
            port: contract.develop.port,
            healthPath,
            supervisorId,
          };
          this.active = active;
          activeOnReady = active;
          this.state = 'ready';
          if (hasClosed()) {
            this.handleCrash(active);
          }
          return {
            port: contract.develop.port,
            pid: child.pid,
            supervisorId,
            ownership: 'process_group',
          };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Development server did not become ready');
    } catch (error: unknown) {
      this.active = {
        child,
        contract,
        groupId,
        port: contract.develop.port,
        healthPath,
        supervisorId: randomUUID(),
      };
      await this.stopActive();
      throw error;
    }
  }

  start(contract: ExecutionContract): Promise<DevServerStartResult> {
    return this.withTransition(async () => {
      this.crashRestarts = [];
      this.failureId = null;
      const active = this.active;
      if (
        active !== undefined &&
        processGroupExists(active.groupId) &&
        isDeepStrictEqual(active.contract, contract) &&
        (await listenerBelongsToProcessGroup(active.port, active.groupId)) &&
        (await httpProbeSucceeds(active.port, active.healthPath))
      ) {
        return {
          port: active.port,
          pid: active.child.pid ?? active.groupId,
          supervisorId: active.supervisorId,
          ownership: 'process_group',
        };
      }
      return await this.startUnlocked(contract);
    });
  }

  restart(contract: ExecutionContract): Promise<DevServerStartResult> {
    return this.withTransition(async () => {
      this.crashRestarts = [];
      this.failureId = null;
      await this.stopActive();
      return this.startUnlocked(contract);
    });
  }

  logs(after: number, limit: number): DevServerLogPage {
    const entries = this.logEntries.filter((entry) => entry.cursor > after).slice(0, limit);
    const oldestCursor = this.logEntries[0]?.cursor;
    return {
      entries,
      nextCursor: entries.at(-1)?.cursor ?? after,
      truncated:
        this.logsDropped || (oldestCursor !== undefined && after < Math.max(0, oldestCursor - 1)),
      state: this.state,
      failureId: this.failureId,
    };
  }

  status(): DevServerState {
    return this.state;
  }

  async evidence(): Promise<DevServerEvidence | null> {
    const active = this.active;
    if (active === undefined) return null;
    const [owned, httpReady] = await Promise.all([
      listenerBelongsToProcessGroup(active.port, active.groupId),
      httpProbeSucceeds(active.port, active.healthPath),
    ]);
    return {
      port: active.port,
      pid: active.child.pid ?? active.groupId,
      supervisorId: active.supervisorId,
      owned,
      httpReady,
    };
  }

  close(): Promise<void> {
    return this.withTransition(async () => {
      await this.stopActive();
      this.state = 'idle';
      this.failureId = null;
    });
  }
}
