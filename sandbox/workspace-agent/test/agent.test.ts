import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter, once as onceEvent } from 'node:events';
import { createRequire } from 'node:module';
import {
  access,
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execa } from 'execa';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CgroupV2Containment } from '../src/containment/cgroup.js';
import { consumeOutputChunks } from '../src/exec.js';
import { WorkspaceFileManager } from '../src/fs.js';
import type { Containment, ExecutionContainment } from '../src/containment/types.js';
import {
  buildWorkspaceAgent,
  closeWorkspaceAgentForSignal,
  writeNdjsonRecord,
} from '../src/main.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const OUTPUT_LIMIT = 1_024 * 1_024;

interface ProcessUsageRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly rssBytes: number;
  readonly systemMicros: number;
  readonly userMicros: number;
}

function parseCpuTime(value: string): number {
  const daySplit = value.split('-');
  const clock = daySplit.at(-1)?.split(':').map(Number) ?? [];
  if (clock.some((part) => !Number.isFinite(part))) {
    return 0;
  }
  const days = daySplit.length === 2 ? Number(daySplit[0]) : 0;
  const [hours = 0, minutes = 0, seconds = 0] =
    clock.length === 3 ? clock : [0, clock[0] ?? 0, clock[1] ?? 0];
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000_000;
}

function parseProcessUsage(output: string): ProcessUsageRow[] {
  const rows: ProcessUsageRow[] = [];
  for (const line of output.trim().split('\n')) {
    const [pid, parentPid, processGroupId, rssKiB, userTime, systemTime] = line
      .trim()
      .split(/\s+/u);
    if (
      pid === undefined ||
      parentPid === undefined ||
      processGroupId === undefined ||
      rssKiB === undefined ||
      userTime === undefined ||
      systemTime === undefined
    ) {
      continue;
    }
    const numeric = [pid, parentPid, processGroupId, rssKiB].map(Number);
    if (numeric.some((value) => !Number.isInteger(value) || value < 0)) {
      continue;
    }
    rows.push({
      pid: numeric[0] ?? 0,
      parentPid: numeric[1] ?? 0,
      processGroupId: numeric[2] ?? 0,
      rssBytes: (numeric[3] ?? 0) * 1_024,
      userMicros: parseCpuTime(userTime),
      systemMicros: parseCpuTime(systemTime),
    });
  }
  return rows;
}

function selectWorkspaceProcesses(
  rows: readonly ProcessUsageRow[],
  activeProcessGroups: readonly number[],
): ProcessUsageRow[] {
  const processGroups = new Set(activeProcessGroups);
  const selected = new Set<number>();
  for (const row of rows) {
    if (processGroups.has(row.processGroupId)) {
      selected.add(row.pid);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!selected.has(row.pid) && selected.has(row.parentPid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => selected.has(row.pid));
}

const portableMetricsSource = {
  async sample(activeProcessGroups: readonly number[]) {
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    let childUserMicros = 0;
    let childSystemMicros = 0;
    let childRssBytes = 0;
    if (activeProcessGroups.length > 0) {
      const result = await execa('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss=,utime=,stime='], {
        reject: false,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        extendEnv: false,
      });
      for (const row of selectWorkspaceProcesses(
        parseProcessUsage(result.stdout),
        activeProcessGroups,
      )) {
        childUserMicros += row.userMicros;
        childSystemMicros += row.systemMicros;
        childRssBytes += row.rssBytes;
      }
    }
    return {
      cpu: {
        userMicros: cpu.user + childUserMicros,
        systemMicros: cpu.system + childSystemMicros,
      },
      memory: {
        rssBytes: memory.rss + childRssBytes,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
    };
  },
};

interface StreamRecord {
  readonly type: 'started' | 'stdout' | 'stderr' | 'exit';
  readonly pid?: number;
  readonly executionId?: string;
  readonly data?: string;
  readonly at: string;
  readonly exitCode?: number;
  readonly truncated?: boolean;
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function requireNativePause(
  request: Promise<{ readonly statusCode: number }>,
  readyPath: string,
): Promise<void> {
  const first = await Promise.race([
    waitForFile(readyPath).then(() => 'paused' as const),
    request.then(() => 'completed' as const),
  ]);
  if (first === 'completed') {
    const response = await request;
    throw new Error(
      `Native helper did not pause before the request completed (${String(response.statusCode)})`,
    );
  }
}

function configureNativePause(readyPath: string, continuePath: string): () => void {
  const previousReady = process.env.ZAPP_NATIVE_TEST_READY_PATH;
  const previousContinue = process.env.ZAPP_NATIVE_TEST_CONTINUE_PATH;
  process.env.ZAPP_NATIVE_TEST_READY_PATH = readyPath;
  process.env.ZAPP_NATIVE_TEST_CONTINUE_PATH = continuePath;
  return () => {
    if (previousReady === undefined) delete process.env.ZAPP_NATIVE_TEST_READY_PATH;
    else process.env.ZAPP_NATIVE_TEST_READY_PATH = previousReady;
    if (previousContinue === undefined) delete process.env.ZAPP_NATIVE_TEST_CONTINUE_PATH;
    else process.env.ZAPP_NATIVE_TEST_CONTINUE_PATH = previousContinue;
  };
}

function configureNativeCasPause(readyPath: string, continuePath: string): () => void {
  const previousReady = process.env.ZAPP_NATIVE_TEST_CAS_READY_PATH;
  const previousContinue = process.env.ZAPP_NATIVE_TEST_CAS_CONTINUE_PATH;
  process.env.ZAPP_NATIVE_TEST_CAS_READY_PATH = readyPath;
  process.env.ZAPP_NATIVE_TEST_CAS_CONTINUE_PATH = continuePath;
  return () => {
    if (previousReady === undefined) delete process.env.ZAPP_NATIVE_TEST_CAS_READY_PATH;
    else process.env.ZAPP_NATIVE_TEST_CAS_READY_PATH = previousReady;
    if (previousContinue === undefined) delete process.env.ZAPP_NATIVE_TEST_CAS_CONTINUE_PATH;
    else process.env.ZAPP_NATIVE_TEST_CAS_CONTINUE_PATH = previousContinue;
  };
}

interface DetachedSetsidFixture {
  readonly childPidPath: string;
  readonly escapeMarker: string;
  readonly killMarker: string;
  readonly parentPidPath: string;
  readonly releasePath: string;
  readonly script: string;
}

function createDetachedSetsidFixture(workspaceRoot: string, label: string): DetachedSetsidFixture {
  const childPidPath = join(workspaceRoot, `${label}-child.pid`);
  const escapeMarker = join(workspaceRoot, `${label}-escaped`);
  const killMarker = join(workspaceRoot, `${label}-containment-killed`);
  const parentPidPath = join(workspaceRoot, `${label}-parent.pid`);
  const releasePath = join(workspaceRoot, `${label}-release`);
  const childScript = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
    'const timer = setInterval(() => {',
    `  if (!fs.existsSync(${JSON.stringify(releasePath)})) return;`,
    '  clearInterval(timer);',
    `  if (!fs.existsSync(${JSON.stringify(killMarker)})) fs.writeFileSync(${JSON.stringify(escapeMarker)}, 'escaped');`,
    '}, 10);',
  ].join('');
  const script = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: 'ignore' });`,
    'child.unref();',
    `fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('');
  return { childPidPath, escapeMarker, killMarker, parentPidPath, releasePath, script };
}

async function releaseDetachedSetsidFixture(fixture: DetachedSetsidFixture): Promise<void> {
  await writeFile(fixture.releasePath, 'release');
  const childPid = Number(await readFile(fixture.childPidPath, 'utf8').catch(() => '0'));
  if (Number.isSafeInteger(childPid) && childPid > 0) {
    await waitForProcessExit(childPid).catch(() => undefined);
  }
}

async function expectDetachedSetsidContainment(fixture: DetachedSetsidFixture): Promise<void> {
  expect(await waitForFile(fixture.killMarker)).toBe('killed');
  await releaseDetachedSetsidFixture(fixture);
  await expect(access(fixture.escapeMarker)).rejects.toMatchObject({ code: 'ENOENT' });
}

class MacosCgroupExecution implements ExecutionContainment {
  private killed = false;

  constructor(
    readonly id: string,
    private readonly directory: string,
    private readonly killMarker: () => string | undefined,
  ) {}

  get procsPath(): string {
    return join(this.directory, 'cgroup.procs');
  }

  private async memberProcessGroupId(): Promise<number | undefined> {
    const member = Number((await readFile(this.procsPath, 'utf8')).trim().split('\n')[0]);
    return Number.isSafeInteger(member) && member > 0 ? member : undefined;
  }

  async kill(): Promise<void> {
    if (this.killed) {
      return;
    }
    this.killed = true;
    await writeFile(join(this.directory, 'cgroup.kill'), '1\n');
    const marker = this.killMarker();
    if (marker !== undefined) {
      await writeFile(marker, 'killed');
    }
    const member = await this.memberProcessGroupId();
    if (member !== undefined) {
      // This is a macOS-only test double. Production never observes or kills a
      // PID/PGID; it writes cgroup.kill and waits for cgroup.events instead.
      try {
        process.kill(-member, 'SIGKILL');
      } catch {
        try {
          process.kill(member, 'SIGKILL');
        } catch {
          // The process can exit naturally between cgroup kill and this controlled test double.
        }
      }
    }
  }

  async waitForEmpty(): Promise<void> {
    const member = await this.memberProcessGroupId();
    if (member !== undefined) {
      // This polling exists only in the injected macOS double, where there is
      // no cgroup-v2 populated signal. The production implementation reads
      // cgroup.events and never observes process groups.
      await waitForProcessGroupExit(member);
    }
    await writeFile(join(this.directory, 'cgroup.events'), 'populated 0\n');
  }

  async remove(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
}

class MacosCgroupDouble implements Containment {
  private nextId = 0;
  private marker: string | undefined;

  constructor(private readonly root: string) {}

  setKillMarker(marker: string | undefined): void {
    this.marker = marker;
  }

  async create(): Promise<ExecutionContainment> {
    const id = `execution-${String((this.nextId += 1))}`;
    const directory = join(this.root, id);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, 'cgroup.procs'), ''),
      writeFile(join(directory, 'cgroup.events'), 'populated 1\n'),
      writeFile(join(directory, 'cgroup.kill'), ''),
    ]);
    return new MacosCgroupExecution(id, directory, () => this.marker);
  }
}

class CleanupStageFailureContainment implements Containment {
  private nextId = 0;

  constructor(
    private readonly root: string,
    private readonly stage: 'kill' | 'populated_wait' | 'remove',
  ) {}

  async create(): Promise<ExecutionContainment> {
    const id = `cleanup-stage-${String((this.nextId += 1))}`;
    const directory = join(this.root, id);
    const procsPath = join(directory, 'cgroup.procs');
    let waitCalls = 0;
    await mkdir(directory);
    await writeFile(procsPath, '');
    return {
      id,
      procsPath,
      kill: () =>
        this.stage === 'kill'
          ? Promise.reject(new Error('controlled kill failure'))
          : Promise.resolve(),
      waitForEmpty: () => {
        waitCalls += 1;
        if (this.stage === 'kill' && waitCalls === 1) {
          return Promise.reject(new Error('enter kill recovery'));
        }
        return this.stage === 'populated_wait'
          ? Promise.reject(new Error('controlled populated wait failure'))
          : Promise.resolve();
      },
      remove: () =>
        this.stage === 'remove'
          ? Promise.reject(new Error('controlled remove failure'))
          : Promise.resolve(),
    };
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${String(pid)} was not reaped`);
}

async function waitForProcessGroupExit(processGroupId: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process group ${String(processGroupId)} was not reaped`);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP server address');
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function executionContract(command: string, port: number) {
  return {
    version: 1 as const,
    package_manager: 'pnpm' as const,
    workspace_root: '.',
    install: { command: 'true' },
    develop: { command, port },
    health: { path: '/' },
  };
}

async function serverConnectionCount(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.getConnections((error, count) => {
      if (error === null) resolve(count);
      else reject(error);
    });
  });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('Operation did not settle'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForNoServerConnections(server: Server): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if ((await serverConnectionCount(server)) === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Server retained ${String(await serverConnectionCount(server))} connection(s)`);
}

function parseNdjson(body: string): StreamRecord[] {
  return body
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as StreamRecord);
}

interface LiveExecStream {
  readonly started: { readonly pid: number; readonly executionId: string };
  finish(): Promise<StreamRecord[]>;
}

async function startLiveExecStream(
  app: FastifyInstance,
  token: string,
  idempotencyKey: string,
  payload: {
    readonly cmd: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly pty?: boolean;
  },
): Promise<LiveExecStream> {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/exec?stream=1`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Expected a live execution stream, received ${String(response.status)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  while (!body.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error('Execution stream ended before the started record');
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  const first = parseNdjson(body.slice(0, body.indexOf('\n') + 1))[0];
  if (first?.type !== 'started' || first.pid === undefined || first.executionId === undefined) {
    throw new Error('Execution stream returned an invalid started record');
  }

  return {
    started: { pid: first.pid, executionId: first.executionId },
    async finish() {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      return parseNdjson(body);
    },
  };
}

describe('workspace-agent RPC daemon', () => {
  let workspaceRoot: string;
  let containmentRoot: string;
  let token: string;
  let app: FastifyInstance | undefined;
  let containment: MacosCgroupDouble;
  let idempotencySequence: number;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-workspace-agent-'));
    containmentRoot = await mkdtemp(join(tmpdir(), 'zapp-cgroup-double-'));
    token = randomBytes(32).toString('hex');
    idempotencySequence = 0;
    containment = new MacosCgroupDouble(containmentRoot);
    app = await buildWorkspaceAgent({ workspaceRoot, token, containment });
  });

  afterEach(async () => {
    try {
      if (app !== undefined) {
        await app.close();
      }
    } finally {
      await Promise.all([
        rm(workspaceRoot, { recursive: true, force: true }),
        rm(containmentRoot, { recursive: true, force: true }),
      ]);
    }
  });

  function authorization(
    value = token,
    idempotencyKey = `test-key-${String((idempotencySequence += 1))}`,
  ): { authorization: string; 'idempotency-key': string } {
    return { authorization: `Bearer ${value}`, 'idempotency-key': idempotencyKey };
  }

  function requireApp(): FastifyInstance {
    if (app === undefined) {
      throw new Error('Workspace agent is not available');
    }
    return app;
  }

  test('returns a compare snapshot and creates one attributed direct-edit commit', async () => {
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'workspace-agent@example.invalid'], {
      cwd: workspaceRoot,
    });
    await execFileAsync('git', ['config', 'user.name', 'Workspace Agent Test'], {
      cwd: workspaceRoot,
    });
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'before\n');
    await execFileAsync('git', ['add', '--', 'tracked.txt'], { cwd: workspaceRoot });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: workspaceRoot });

    const snapshot = await requireApp().inject({
      method: 'GET',
      url: '/files/update-snapshot?path=tracked.txt',
      headers: authorization(),
    });

    expect(snapshot.statusCode).toBe(200);
    const snapshotBody = snapshot.json<{
      dataBase64: string;
      byteLength: number;
      compareToken: string;
    }>();
    expect(snapshotBody).toMatchObject({
      dataBase64: Buffer.from('before\n').toString('base64'),
      byteLength: 7,
    });
    expect(snapshotBody.compareToken).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const edited = await requireApp().inject({
      method: 'POST',
      url: '/files/direct-edit',
      headers: authorization(token, 'direct-edit-happy-path'),
      payload: {
        path: 'tracked.txt',
        dataBase64: Buffer.from('after\n').toString('base64'),
        compareToken: snapshotBody.compareToken,
      },
    });

    expect(edited.statusCode).toBe(200);
    const editedBody = edited.json<{ commitSha: string }>();
    expect(editedBody.commitSha).toMatch(/^[a-f0-9]{40}$/u);
    await expect(readFile(join(workspaceRoot, 'tracked.txt'), 'utf8')).resolves.toBe('after\n');
    await expect(
      execFileAsync('git', ['show', '-s', '--format=%s', editedBody.commitSha], {
        cwd: workspaceRoot,
      }),
    ).resolves.toMatchObject({ stdout: 'manual edit via web\n' });
    await expect(
      execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: workspaceRoot }),
    ).resolves.toMatchObject({
      stdout: '2\n',
    });
  });

  test('rejects a stale direct-edit compare token without changing bytes or HEAD', async () => {
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'workspace-agent@example.invalid'], {
      cwd: workspaceRoot,
    });
    await execFileAsync('git', ['config', 'user.name', 'Workspace Agent Test'], {
      cwd: workspaceRoot,
    });
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'before\n');
    await execFileAsync('git', ['add', '--', 'tracked.txt'], { cwd: workspaceRoot });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: workspaceRoot });
    const snapshot = await requireApp().inject({
      method: 'GET',
      url: '/files/update-snapshot?path=tracked.txt',
      headers: authorization(),
    });
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'concurrent\n');
    const headBefore = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot });

    const rejected = await requireApp().inject({
      method: 'POST',
      url: '/files/direct-edit',
      headers: authorization(token, 'direct-edit-stale'),
      payload: {
        path: 'tracked.txt',
        dataBase64: Buffer.from('after\n').toString('base64'),
        compareToken: snapshot.json<{ compareToken: string }>().compareToken,
      },
    });

    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toEqual({ error: 'atomic_write_conflict' });
    await expect(readFile(join(workspaceRoot, 'tracked.txt'), 'utf8')).resolves.toBe(
      'concurrent\n',
    );
    await expect(
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot }),
    ).resolves.toMatchObject({
      stdout: headBefore.stdout,
    });
  });

  test('rolls back direct-edit bytes and index state when commit creation fails', async () => {
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'workspace-agent@example.invalid'], {
      cwd: workspaceRoot,
    });
    await execFileAsync('git', ['config', 'user.name', 'Workspace Agent Test'], {
      cwd: workspaceRoot,
    });
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'before\n');
    await execFileAsync('git', ['add', '--', 'tracked.txt'], { cwd: workspaceRoot });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: workspaceRoot });
    const snapshot = await requireApp().inject({
      method: 'GET',
      url: '/files/update-snapshot?path=tracked.txt',
      headers: authorization(),
    });
    const headBefore = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', '--unset', 'user.email'], { cwd: workspaceRoot });

    const rejected = await requireApp().inject({
      method: 'POST',
      url: '/files/direct-edit',
      headers: authorization(token, 'direct-edit-hook-failure'),
      payload: {
        path: 'tracked.txt',
        dataBase64: Buffer.from('after\n').toString('base64'),
        compareToken: snapshot.json<{ compareToken: string }>().compareToken,
      },
    });

    expect(rejected.statusCode).toBe(500);
    expect(rejected.json()).toEqual({ error: 'internal_error' });
    await expect(readFile(join(workspaceRoot, 'tracked.txt'), 'utf8')).resolves.toBe('before\n');
    await expect(
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot }),
    ).resolves.toMatchObject({
      stdout: headBefore.stdout,
    });
    await expect(
      execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: workspaceRoot }),
    ).resolves.toMatchObject({ stdout: '' });
  });

  test('rolls back direct-edit bytes when the commit boundary throws', async () => {
    const target = join(workspaceRoot, 'throwing-commit.txt');
    await writeFile(target, 'before');
    const manager = new WorkspaceFileManager(workspaceRoot);
    const snapshot = await manager.readForDirectEdit('throwing-commit.txt');

    await expect(
      manager.directEdit(
        {
          path: 'throwing-commit.txt',
          data: Buffer.from('after'),
          compareToken: snapshot.compareToken,
        },
        () => Promise.reject(new Error('git transport failed')),
      ),
    ).rejects.toMatchObject({ name: 'DirectEditCommitError' });
    await expect(readFile(target, 'utf8')).resolves.toBe('before');
  });

  test('commits only the direct-edit path and preserves unrelated staged work', async () => {
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'workspace-agent@example.invalid'], {
      cwd: workspaceRoot,
    });
    await execFileAsync('git', ['config', 'user.name', 'Workspace Agent Test'], {
      cwd: workspaceRoot,
    });
    await Promise.all([
      writeFile(join(workspaceRoot, 'tracked.txt'), 'before\n'),
      writeFile(join(workspaceRoot, 'other.txt'), 'other-before\n'),
    ]);
    await execFileAsync('git', ['add', '--', 'tracked.txt', 'other.txt'], { cwd: workspaceRoot });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: workspaceRoot });
    await writeFile(join(workspaceRoot, 'other.txt'), 'other-staged\n');
    await execFileAsync('git', ['add', '--', 'other.txt'], { cwd: workspaceRoot });
    const snapshot = await requireApp().inject({
      method: 'GET',
      url: '/files/update-snapshot?path=tracked.txt',
      headers: authorization(),
    });

    const edited = await requireApp().inject({
      method: 'POST',
      url: '/files/direct-edit',
      headers: authorization(token, 'direct-edit-preserves-index'),
      payload: {
        path: 'tracked.txt',
        dataBase64: Buffer.from('after\n').toString('base64'),
        compareToken: snapshot.json<{ compareToken: string }>().compareToken,
      },
    });

    expect(edited.statusCode).toBe(200);
    await expect(
      execFileAsync('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], {
        cwd: workspaceRoot,
      }),
    ).resolves.toMatchObject({ stdout: 'tracked.txt\n' });
    await expect(
      execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: workspaceRoot }),
    ).resolves.toMatchObject({ stdout: 'other.txt\n' });
    await expect(readFile(join(workspaceRoot, 'other.txt'), 'utf8')).resolves.toBe(
      'other-staged\n',
    );
  });

  test('serializes competing direct edits and replays the winning key without another commit', async () => {
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'workspace-agent@example.invalid'], {
      cwd: workspaceRoot,
    });
    await execFileAsync('git', ['config', 'user.name', 'Workspace Agent Test'], {
      cwd: workspaceRoot,
    });
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'before\n');
    await execFileAsync('git', ['add', '--', 'tracked.txt'], { cwd: workspaceRoot });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: workspaceRoot });
    const snapshot = await requireApp().inject({
      method: 'GET',
      url: '/files/update-snapshot?path=tracked.txt',
      headers: authorization(),
    });
    const compareToken = snapshot.json<{ compareToken: string }>().compareToken;
    const attempts = [
      { key: 'direct-edit-race-a', content: 'winner-a\n' },
      { key: 'direct-edit-race-b', content: 'winner-b\n' },
    ] as const;

    const responses = await Promise.all(
      attempts.map((attempt) =>
        requireApp().inject({
          method: 'POST',
          url: '/files/direct-edit',
          headers: authorization(token, attempt.key),
          payload: {
            path: 'tracked.txt',
            dataBase64: Buffer.from(attempt.content).toString('base64'),
            compareToken,
          },
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winnerIndex = responses.findIndex((response) => response.statusCode === 200);
    const winner = attempts[winnerIndex];
    expect(winner).toBeDefined();
    await expect(readFile(join(workspaceRoot, 'tracked.txt'), 'utf8')).resolves.toBe(
      winner?.content,
    );
    const replayed = await requireApp().inject({
      method: 'POST',
      url: '/files/direct-edit',
      headers: authorization(token, winner?.key),
      payload: {
        path: 'tracked.txt',
        dataBase64: Buffer.from(winner?.content ?? '').toString('base64'),
        compareToken,
      },
    });
    expect(replayed.body).toBe(responses[winnerIndex]?.body);
    await expect(
      execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: workspaceRoot }),
    ).resolves.toMatchObject({
      stdout: '2\n',
    });
  });

  test('rejects direct-edit request bodies over one MiB before mutation', async () => {
    await writeFile(join(workspaceRoot, 'bounded.txt'), 'before\n');
    const snapshot = await requireApp().inject({
      method: 'GET',
      url: '/files/update-snapshot?path=bounded.txt',
      headers: authorization(),
    });

    const rejected = await requireApp().inject({
      method: 'POST',
      url: '/files/direct-edit',
      headers: authorization(token, 'direct-edit-too-large'),
      payload: {
        path: 'bounded.txt',
        dataBase64: Buffer.alloc(1_024 * 1_024 + 1, 'x').toString('base64'),
        compareToken: snapshot.json<{ compareToken: string }>().compareToken,
      },
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: 'bad_request' });
    await expect(readFile(join(workspaceRoot, 'bounded.txt'), 'utf8')).resolves.toBe('before\n');
  });

  test('rejects snapshots over one MiB through the native bounded reader', async () => {
    await writeFile(join(workspaceRoot, 'oversized.txt'), Buffer.alloc(4 * 1_024 * 1_024, 'x'));

    const rejected = await requireApp().inject({
      method: 'GET',
      url: '/files/update-snapshot?path=oversized.txt',
      headers: authorization(),
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: 'bad_request' });
  });

  test('treats Git pathspec-looking direct-edit paths as literal filenames', async () => {
    const literalPath = ':(top)package.json';
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'workspace-agent@example.invalid'], {
      cwd: workspaceRoot,
    });
    await execFileAsync('git', ['config', 'user.name', 'Workspace Agent Test'], {
      cwd: workspaceRoot,
    });
    await Promise.all([
      writeFile(join(workspaceRoot, 'package.json'), 'root-before\n'),
      writeFile(join(workspaceRoot, literalPath), 'literal-before\n'),
    ]);
    await execFileAsync('git', ['--literal-pathspecs', 'add', '--', 'package.json', literalPath], {
      cwd: workspaceRoot,
    });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: workspaceRoot });
    const snapshot = await requireApp().inject({
      method: 'GET',
      url: `/files/update-snapshot?path=${encodeURIComponent(literalPath)}`,
      headers: authorization(),
    });

    const edited = await requireApp().inject({
      method: 'POST',
      url: '/files/direct-edit',
      headers: authorization(token, 'direct-edit-literal-path'),
      payload: {
        path: literalPath,
        dataBase64: Buffer.from('literal-after\n').toString('base64'),
        compareToken: snapshot.json<{ compareToken: string }>().compareToken,
      },
    });

    expect(edited.statusCode).toBe(200);
    await expect(readFile(join(workspaceRoot, literalPath), 'utf8')).resolves.toBe(
      'literal-after\n',
    );
    await expect(readFile(join(workspaceRoot, 'package.json'), 'utf8')).resolves.toBe(
      'root-before\n',
    );
    await expect(
      execFileAsync('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], {
        cwd: workspaceRoot,
      }),
    ).resolves.toMatchObject({ stdout: `${literalPath}\n` });
  });

  test('rejects an out-of-band mutation at the native compare-and-swap boundary', async () => {
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'workspace-agent@example.invalid'], {
      cwd: workspaceRoot,
    });
    await execFileAsync('git', ['config', 'user.name', 'Workspace Agent Test'], {
      cwd: workspaceRoot,
    });
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'before\n');
    await execFileAsync('git', ['add', '--', 'tracked.txt'], { cwd: workspaceRoot });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: workspaceRoot });
    const snapshot = await requireApp().inject({
      method: 'GET',
      url: '/files/update-snapshot?path=tracked.txt',
      headers: authorization(),
    });
    const readyPath = join(workspaceRoot, 'cas-ready');
    const continuePath = join(workspaceRoot, 'cas-continue');
    const restorePause = configureNativeCasPause(readyPath, continuePath);

    try {
      const request = requireApp().inject({
        method: 'POST',
        url: '/files/direct-edit',
        headers: authorization(token, 'direct-edit-native-cas'),
        payload: {
          path: 'tracked.txt',
          dataBase64: Buffer.from('after\n').toString('base64'),
          compareToken: snapshot.json<{ compareToken: string }>().compareToken,
        },
      });
      await requireNativePause(request, readyPath);
      await writeFile(join(workspaceRoot, 'tracked.txt'), 'concurrent\n');
      await writeFile(continuePath, 'continue');

      const rejected = await request;
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toEqual({ error: 'atomic_write_conflict' });
      await expect(readFile(join(workspaceRoot, 'tracked.txt'), 'utf8')).resolves.toBe(
        'concurrent\n',
      );
      await expect(
        execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: workspaceRoot }),
      ).resolves.toMatchObject({
        stdout: '1\n',
      });
    } finally {
      restorePause();
    }
  });

  test('atomically writes an unguarded file batch through the advanced route', async () => {
    await mkdir(join(workspaceRoot, 'nested'));
    const response = await requireApp().inject({
      method: 'POST',
      url: '/files/atomic-write',
      headers: authorization(),
      payload: {
        files: [
          { path: 'first.txt', dataBase64: Buffer.from('first').toString('base64') },
          { path: 'nested/second.txt', dataBase64: Buffer.from('second').toString('base64') },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await expect(readFile(join(workspaceRoot, 'first.txt'), 'utf8')).resolves.toBe('first');
    await expect(readFile(join(workspaceRoot, 'nested/second.txt'), 'utf8')).resolves.toBe(
      'second',
    );
  });

  test('returns guarded snapshots while failing unsupported guarded batches closed', async () => {
    await writeFile(join(workspaceRoot, 'guarded.txt'), 'before');

    const snapshot = await requireApp().inject({
      method: 'GET',
      url: '/files/update-snapshot?path=guarded.txt',
      headers: authorization(),
    });
    const batch = await requireApp().inject({
      method: 'POST',
      url: '/files/atomic-write',
      headers: authorization(),
      payload: {
        files: [
          {
            path: 'guarded.txt',
            dataBase64: Buffer.from('after').toString('base64'),
            expectedRevision: 'unavailable-revision',
          },
        ],
      },
    });

    expect(snapshot.statusCode).toBe(200);
    const snapshotBody = snapshot.json<{
      dataBase64: string;
      byteLength: number;
      compareToken: string;
    }>();
    expect(snapshotBody).toMatchObject({
      dataBase64: Buffer.from('before').toString('base64'),
      byteLength: 6,
    });
    expect(snapshotBody.compareToken).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(batch.statusCode).toBe(409);
    expect(batch.json()).toEqual({ error: 'atomic_write_conflict' });
    await expect(readFile(join(workspaceRoot, 'guarded.txt'), 'utf8')).resolves.toBe('before');
  });

  test.each([
    {
      name: 'lexical alias',
      files: [
        {
          path: 'target.txt',
          dataBase64: Buffer.alloc(256 * 1024, 'a').toString('base64'),
        },
        { path: './target.txt', dataBase64: Buffer.from('two').toString('base64') },
      ],
    },
    {
      name: 'same-inode alias',
      files: [
        { path: 'target.txt', dataBase64: Buffer.from('one').toString('base64') },
        { path: 'hard-alias.txt', dataBase64: Buffer.from('two').toString('base64') },
      ],
    },
    {
      name: 'canonical parent-symlink alias',
      files: [
        { path: 'real/canonical.txt', dataBase64: Buffer.from('one').toString('base64') },
        {
          path: 'parent-alias/canonical.txt',
          dataBase64: Buffer.from('two').toString('base64'),
        },
      ],
    },
    {
      name: 'leaf symlink',
      files: [{ path: 'leaf-alias.txt', dataBase64: Buffer.from('two').toString('base64') }],
    },
  ])('returns typed HTTP 400 for an atomic $name conflict with zero writes', async ({ files }) => {
    await writeFile(join(workspaceRoot, 'target.txt'), 'before', { mode: 0o640 });
    await link(join(workspaceRoot, 'target.txt'), join(workspaceRoot, 'hard-alias.txt'));
    await symlink('target.txt', join(workspaceRoot, 'leaf-alias.txt'));
    await mkdir(join(workspaceRoot, 'real'));
    await writeFile(join(workspaceRoot, 'real', 'canonical.txt'), 'canonical-before');
    await symlink('real', join(workspaceRoot, 'parent-alias'));

    const rejected = await requireApp().inject({
      method: 'POST',
      url: '/files/atomic-write',
      headers: authorization(),
      payload: { files },
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: 'bad_request' });
    await expect(readFile(join(workspaceRoot, 'target.txt'), 'utf8')).resolves.toBe('before');
    await expect(readFile(join(workspaceRoot, 'real', 'canonical.txt'), 'utf8')).resolves.toBe(
      'canonical-before',
    );
    expect((await lstat(join(workspaceRoot, 'target.txt'))).mode & 0o777).toBe(0o640);
    expect((await lstat(join(workspaceRoot, 'leaf-alias.txt'))).isSymbolicLink()).toBe(true);
    expect(
      (await readdir(workspaceRoot)).filter((name) => name.startsWith('.zapp-atomic-')),
    ).toEqual([]);
  });

  test('preserves file mode on a successful atomic replacement', async () => {
    await writeFile(join(workspaceRoot, 'target.txt'), 'before', { mode: 0o640 });
    const written = await requireApp().inject({
      method: 'POST',
      url: '/files/atomic-write',
      headers: authorization(),
      payload: {
        files: [{ path: 'target.txt', dataBase64: Buffer.from('after').toString('base64') }],
      },
    });
    expect(written.statusCode).toBe(200);
    expect((await lstat(join(workspaceRoot, 'target.txt'))).mode & 0o777).toBe(0o640);
    await chmod(join(workspaceRoot, 'target.txt'), 0o600);
  });

  test('rolls every target back with modes preserved when a later atomic commit fails', async () => {
    await writeFile(join(workspaceRoot, 'rollback-first.txt'), 'first-before', { mode: 0o640 });
    await writeFile(join(workspaceRoot, 'rollback-second.txt'), 'second-before', { mode: 0o600 });
    const previousFailureIndex = process.env.ZAPP_NATIVE_TEST_FAIL_ATOMIC_COMMIT_INDEX;
    process.env.ZAPP_NATIVE_TEST_FAIL_ATOMIC_COMMIT_INDEX = '1';
    try {
      const response = await requireApp().inject({
        method: 'POST',
        url: '/files/atomic-write',
        headers: authorization(),
        payload: {
          files: [
            {
              path: 'rollback-first.txt',
              dataBase64: Buffer.from('first-after').toString('base64'),
            },
            {
              path: 'rollback-second.txt',
              dataBase64: Buffer.from('second-after').toString('base64'),
            },
          ],
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'internal_error' });
      await expect(readFile(join(workspaceRoot, 'rollback-first.txt'), 'utf8')).resolves.toBe(
        'first-before',
      );
      await expect(readFile(join(workspaceRoot, 'rollback-second.txt'), 'utf8')).resolves.toBe(
        'second-before',
      );
      expect((await lstat(join(workspaceRoot, 'rollback-first.txt'))).mode & 0o777).toBe(0o640);
      expect((await lstat(join(workspaceRoot, 'rollback-second.txt'))).mode & 0o777).toBe(0o600);
      expect(
        (await readdir(workspaceRoot)).filter((name) => name.startsWith('.zapp-atomic-')),
      ).toEqual([]);
    } finally {
      if (previousFailureIndex === undefined) {
        delete process.env.ZAPP_NATIVE_TEST_FAIL_ATOMIC_COMMIT_INDEX;
      } else {
        process.env.ZAPP_NATIVE_TEST_FAIL_ATOMIC_COMMIT_INDEX = previousFailureIndex;
      }
    }
  });

  test('searches only the confined target and reports zero matches as an exec result', async () => {
    await mkdir(join(workspaceRoot, 'src'));
    await writeFile(join(workspaceRoot, 'src', 'match.ts'), 'Needle marker\n');
    await writeFile(join(workspaceRoot, 'src', 'ignored.txt'), 'Needle ignored\n');
    const originalPath = process.env.PATH;
    process.env.PATH = '/zapp-test-no-host-binaries';

    try {
      const matched = await requireApp().inject({
        method: 'POST',
        url: '/search',
        headers: authorization(),
        payload: {
          pattern: 'needle',
          path: 'src',
          glob: '*.ts',
          fixedStrings: true,
          ignoreCase: true,
        },
      });
      const absent = await requireApp().inject({
        method: 'POST',
        url: '/search',
        headers: authorization(),
        payload: { pattern: 'not-present', path: 'src', fixedStrings: true },
      });
      const escaped = await requireApp().inject({
        method: 'POST',
        url: '/search',
        headers: authorization(),
        payload: { pattern: 'outside', path: '../outside' },
      });

      expect(matched.statusCode).toBe(200);
      expect(matched.json()).toMatchObject({ exitCode: 0, stderr: '', truncated: false });
      expect(matched.json<{ stdout: string }>().stdout).toContain('match.ts');
      expect(matched.json<{ stdout: string }>().stdout).not.toContain('ignored.txt');
      expect(absent.statusCode).toBe(200);
      expect(absent.json()).toMatchObject({ exitCode: 1, stdout: '', truncated: false });
      expect(escaped.statusCode).toBe(400);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  test('deletes files idempotently, rejects directories, and renames with atomic replace', async () => {
    await writeFile(join(workspaceRoot, 'delete.txt'), 'delete');
    await mkdir(join(workspaceRoot, 'keep-dir'));
    const deleted = await requireApp().inject({
      method: 'DELETE',
      url: '/files?path=delete.txt',
      headers: authorization(),
    });
    const repeated = await requireApp().inject({
      method: 'DELETE',
      url: '/files?path=delete.txt',
      headers: authorization(),
    });
    const directory = await requireApp().inject({
      method: 'DELETE',
      url: '/files?path=keep-dir',
      headers: authorization(),
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, alreadyAbsent: false });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual({ ok: true, alreadyAbsent: true });
    expect(directory.statusCode).toBe(400);
    await expect(lstat(join(workspaceRoot, 'keep-dir'))).resolves.toMatchObject({});

    await writeFile(join(workspaceRoot, 'source.txt'), 'source');
    await writeFile(join(workspaceRoot, 'destination.txt'), 'destination');
    const renamed = await requireApp().inject({
      method: 'POST',
      url: '/files/rename',
      headers: authorization(),
      payload: { source: 'source.txt', destination: 'destination.txt', overwrite: 'replace' },
    });
    const same = await requireApp().inject({
      method: 'POST',
      url: '/files/rename',
      headers: authorization(),
      payload: {
        source: 'destination.txt',
        destination: './destination.txt',
        overwrite: 'replace',
      },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ ok: true });
    await expect(readFile(join(workspaceRoot, 'destination.txt'), 'utf8')).resolves.toBe('source');
    await expect(access(join(workspaceRoot, 'source.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(same.statusCode).toBe(400);
  });

  test('starts and restarts one supervisor-owned HTTP dev server with matching health evidence', async () => {
    const port = await availablePort();
    const script = `require('node:http').createServer((_request, response) => { response.end('ready'); }).listen(${String(port)}, '127.0.0.1'); setInterval(() => {}, 1000);`;
    const contract = executionContract(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      port,
    );

    const started = await requireApp().inject({
      method: 'POST',
      url: '/dev-server/start',
      headers: authorization(),
      payload: { contract },
    });
    expect(started.statusCode).toBe(200);
    const first = started.json<{
      port: number;
      pid: number;
      supervisorId: string;
      ownership: string;
    }>();
    expect(first).toMatchObject({ port, ownership: 'process_group' });
    expect(first.pid).toBeGreaterThan(0);
    expect(first.supervisorId).not.toBe('');

    const initialHealth = await requireApp().inject({
      method: 'GET',
      url: '/healthz',
      headers: authorization(),
    });
    expect(initialHealth.json()).toMatchObject({
      ok: true,
      devServer: {
        port,
        pid: first.pid,
        supervisorId: first.supervisorId,
        owned: true,
        httpReady: true,
      },
    });

    const restarted = await requireApp().inject({
      method: 'POST',
      url: '/dev-server/restart',
      headers: authorization(),
      payload: { contract },
    });
    expect(restarted.statusCode).toBe(200);
    const second = restarted.json<typeof first>();
    expect(second).toMatchObject({ port, ownership: 'process_group' });
    expect(second.pid).not.toBe(first.pid);
    expect(second.supervisorId).not.toBe(first.supervisorId);
    await waitForProcessExit(first.pid);
  });

  test('WS-13 streams bounded dev-server logs strictly after a cursor', async () => {
    const port = await availablePort();
    const script = [
      `process.stdout.write(${JSON.stringify('first-out\n')});`,
      `process.stderr.write(${JSON.stringify('first-error\n')});`,
      'process.stdout.write(Buffer.alloc(11*1024*1024,120));',
      `require('node:http').createServer((_request, response) => response.end('ready')).listen(${String(port)}, '127.0.0.1');`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const contract = executionContract(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      port,
    );

    const started = await requireApp().inject({
      method: 'POST',
      url: '/dev-server/start',
      headers: authorization(),
      payload: { contract },
    });
    expect(started.statusCode).toBe(200);

    const firstPage = await requireApp().inject({
      method: 'GET',
      url: '/dev-server/logs?after=0&limit=1000',
      headers: authorization(),
    });
    expect(firstPage.statusCode).toBe(200);
    const body = firstPage.json<{
      entries: Array<{
        cursor: number;
        at: string;
        stream: 'stdout' | 'stderr';
        message: string;
      }>;
      nextCursor: number;
      truncated: boolean;
      state: string;
    }>();
    expect(body.state).toBe('ready');
    expect(body.truncated).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
    expect(
      body.entries.every(
        (entry, index, entries) => index === 0 || entry.cursor > (entries[index - 1]?.cursor ?? -1),
      ),
    ).toBe(true);
    expect(
      body.entries.reduce((total, entry) => total + Buffer.byteLength(entry.message), 0),
    ).toBeLessThanOrEqual(10 * 1_024 * 1_024);

    const after = body.entries.at(-2)?.cursor ?? 0;
    const secondPage = await requireApp().inject({
      method: 'GET',
      url: `/dev-server/logs?after=${String(after)}&limit=1000`,
      headers: authorization(),
    });
    expect(secondPage.statusCode).toBe(200);
    expect(
      secondPage
        .json<{ entries: Array<{ cursor: number }> }>()
        .entries.every((entry) => entry.cursor > after),
    ).toBe(true);
  }, 15_000);

  test('WS-13 restarts three crashes in five minutes then opens the circuit', async () => {
    const port = await availablePort();
    const countPath = join(workspaceRoot, 'ws13-crash-count');
    const script = [
      "const fs=require('node:fs');",
      `const path=${JSON.stringify(countPath)};`,
      "const count=Number(fs.existsSync(path)?fs.readFileSync(path,'utf8'):'0')+1;",
      'fs.writeFileSync(path,String(count));',
      `const server=require('node:http').createServer((_request,response)=>{response.end('ready',()=>{setTimeout(()=>server.close(()=>process.exit(1)),25);});});`,
      `server.listen(${String(port)},'127.0.0.1',()=>{console.log('boot-'+String(count));});`,
    ].join('');
    const contract = executionContract(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      port,
    );

    const started = await requireApp().inject({
      method: 'POST',
      url: '/dev-server/start',
      headers: authorization(),
      payload: { contract },
    });
    expect(started.statusCode).toBe(200);

    const deadline = Date.now() + 8_000;
    let state = '';
    let failureId: string | null = null;
    while (Date.now() < deadline) {
      const logs = await requireApp().inject({
        method: 'GET',
        url: '/dev-server/logs?after=0&limit=100',
        headers: authorization(),
      });
      if (logs.statusCode === 200) {
        const body = logs.json<{ state: string; failureId: string | null }>();
        state = body.state;
        failureId = body.failureId;
        if (state === 'failed') break;
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    }

    expect(state).toBe('failed');
    expect(failureId).toMatch(/^devfail_/u);
    const repeatedFailure = await requireApp().inject({
      method: 'GET',
      url: '/dev-server/logs?after=0&limit=100',
      headers: authorization(),
    });
    expect(repeatedFailure.json<{ failureId: string | null }>().failureId).toBe(failureId);
    await expect(readFile(countPath, 'utf8')).resolves.toBe('4');
    const health = await requireApp().inject({
      method: 'GET',
      url: '/healthz',
      headers: authorization(),
    });
    expect(health.json()).toMatchObject({
      ok: false,
      details: 'workspace-agent ready; dev server failed',
      devServer: null,
    });
  }, 12_000);

  test('WS-13 observes a child exit on the readiness response boundary', async () => {
    const port = await availablePort();
    const countPath = join(workspaceRoot, 'ws13-readiness-exit-count');
    const script = [
      "const fs=require('node:fs');",
      `const path=${JSON.stringify(countPath)};`,
      "const count=Number(fs.existsSync(path)?fs.readFileSync(path,'utf8'):'0')+1;",
      'fs.writeFileSync(path,String(count));',
      `const server=require('node:http').createServer((_request,response)=>{response.end('ready');if(count===1){server.close(()=>process.exit(1));}});`,
      `server.listen(${String(port)},'127.0.0.1');`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const response = await requireApp().inject({
      method: 'POST',
      url: '/dev-server/start',
      headers: authorization(),
      payload: {
        contract: executionContract(
          `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          port,
        ),
      },
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(
      async () => {
        await expect(readFile(countPath, 'utf8')).resolves.toBe('2');
      },
      { timeout: 5_000, interval: 25 },
    );
    await vi.waitFor(
      async () => {
        const health = await requireApp().inject({
          method: 'GET',
          url: '/healthz',
          headers: authorization(),
        });
        expect(health.json()).toMatchObject({
          ok: true,
          devServer: { owned: true, httpReady: true },
        });
      },
      { timeout: 5_000, interval: 25 },
    );
  }, 12_000);

  test('rejects an unrelated ready listener as managed dev-server readiness', async () => {
    const unrelated = createHttpServer((_request, response) => response.end('unrelated'));
    const port = await listen(unrelated);
    const contract = executionContract(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1000);')}`,
      port,
    );
    try {
      const response = await requireApp().inject({
        method: 'POST',
        url: '/dev-server/start',
        headers: authorization(),
        payload: { contract },
      });
      expect(response.statusCode).toBe(500);
      const health = await requireApp().inject({
        method: 'GET',
        url: '/healthz',
        headers: authorization(),
      });
      expect(health.json()).toMatchObject({ ok: true, devServer: null });
    } finally {
      await closeServer(unrelated);
    }
  }, 8_000);

  test('pins advanced filesystem operations across a parent swap', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'zapp-workspace-agent-advanced-outside-'));
    const cases = [
      { action: 'atomic', initial: 'atomic-before', after: 'atomic-after' },
      { action: 'delete', initial: 'delete-before', after: undefined },
      { action: 'rename', initial: 'rename-before', after: 'rename-before' },
      { action: 'search', initial: 'pinned-search-marker', after: 'pinned-search-marker' },
    ] as const;

    try {
      for (const operation of cases) {
        const parent = join(workspaceRoot, `advanced-${operation.action}`);
        const pinnedParent = `${parent}-pinned`;
        const readyPath = join(workspaceRoot, `${operation.action}-ready`);
        const continuePath = join(workspaceRoot, `${operation.action}-continue`);
        await mkdir(parent);
        await writeFile(join(parent, 'target.txt'), operation.initial);
        await mkdir(join(outsideRoot, operation.action));
        await writeFile(join(outsideRoot, operation.action, 'target.txt'), 'outside-marker');
        if (operation.action === 'rename') {
          await writeFile(join(parent, 'destination.txt'), 'destination-before');
          await writeFile(
            join(outsideRoot, operation.action, 'destination.txt'),
            'outside-destination',
          );
        }
        const restorePause = configureNativePause(readyPath, continuePath);
        try {
          const request =
            operation.action === 'atomic'
              ? requireApp().inject({
                  method: 'POST',
                  url: '/files/atomic-write',
                  headers: authorization(),
                  payload: {
                    files: [
                      {
                        path: `advanced-${operation.action}/target.txt`,
                        dataBase64: Buffer.from(operation.after).toString('base64'),
                      },
                    ],
                  },
                })
              : operation.action === 'delete'
                ? requireApp().inject({
                    method: 'DELETE',
                    url: `/files?path=advanced-${operation.action}%2Ftarget.txt`,
                    headers: authorization(),
                  })
                : operation.action === 'rename'
                  ? requireApp().inject({
                      method: 'POST',
                      url: '/files/rename',
                      headers: authorization(),
                      payload: {
                        source: `advanced-${operation.action}/target.txt`,
                        destination: `advanced-${operation.action}/destination.txt`,
                        overwrite: 'replace',
                      },
                    })
                  : requireApp().inject({
                      method: 'POST',
                      url: '/search',
                      headers: authorization(),
                      payload: {
                        pattern: 'pinned-search-marker',
                        path: `advanced-${operation.action}/target.txt`,
                        fixedStrings: true,
                      },
                    });
          await requireNativePause(request, readyPath);
          await rename(parent, pinnedParent);
          await symlink(join(outsideRoot, operation.action), parent, 'dir');
          await writeFile(continuePath, 'continue');

          const response = await request;
          expect(response.statusCode, operation.action).toBe(200);
          if (operation.action === 'delete') {
            await expect(access(join(pinnedParent, 'target.txt'))).rejects.toMatchObject({
              code: 'ENOENT',
            });
          } else if (operation.action === 'rename') {
            await expect(readFile(join(pinnedParent, 'destination.txt'), 'utf8')).resolves.toBe(
              operation.after,
            );
          } else if (operation.action === 'search') {
            expect(response.json<{ stdout: string }>().stdout).toContain('pinned-search-marker');
          } else {
            await expect(readFile(join(pinnedParent, 'target.txt'), 'utf8')).resolves.toBe(
              operation.after,
            );
          }
          await expect(
            readFile(
              join(
                outsideRoot,
                operation.action,
                operation.action === 'rename' ? 'destination.txt' : 'target.txt',
              ),
              'utf8',
            ),
          ).resolves.toMatch(/^outside/u);
        } finally {
          restorePause();
        }
      }
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test('serializes concurrent dev-server starts so every spawned process remains owned', async () => {
    const ports = await Promise.all([availablePort(), availablePort()]);
    const contracts = ports.map((port) => {
      const script = `require('node:http').createServer((_request, response) => response.end('ready')).listen(${String(port)}, '127.0.0.1'); setInterval(() => {}, 1000);`;
      return executionContract(
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        port,
      );
    });
    const responses = await Promise.all(
      contracts.map((contract, index) =>
        requireApp().inject({
          method: 'POST',
          url: '/dev-server/start',
          headers: authorization(token, `concurrent-start-${String(index)}`),
          payload: { contract },
        }),
      ),
    );
    const started = responses.filter((response) => response.statusCode === 200);
    const rejected = responses.filter((response) => response.statusCode !== 200);
    expect(started).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const pid = started[0]?.json<{ pid: number }>().pid;
    expect(pid).toBeGreaterThan(0);
    await requireApp().close();
    app = undefined;
    if (pid !== undefined) await waitForProcessExit(pid);
  });

  test('streams a real PID, ordered output, and one exit record as validated NDJSON', async () => {
    const response = await requireApp().inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers: authorization(),
      payload: {
        cmd: process.execPath,
        args: ['-e', 'process.stdout.write("hi\\n")'],
        timeoutMs: 2_000,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    const records = parseNdjson(response.body);
    expect(records[0]?.type).toBe('started');
    expect(typeof records[0]?.pid).toBe('number');
    expect(records[0]?.executionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(records.some((record) => record.type === 'stdout' && record.data === 'hi\n')).toBe(true);
    expect(records.at(-1)).toMatchObject({ type: 'exit', exitCode: 0, truncated: false });
    expect(records.filter((record) => record.type === 'exit')).toHaveLength(1);
    expect(records.every((record) => Number.isFinite(Date.parse(record.at)))).toBe(true);
  });

  test('fails closed with a stable response when production cgroup containment is unavailable', async () => {
    await requireApp().close();
    app = await buildWorkspaceAgent({
      workspaceRoot,
      token,
      containment: new CgroupV2Containment(join(workspaceRoot, 'missing-cgroup-root')),
    });

    const response = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: authorization(),
      payload: { cmd: 'true', args: [], timeoutMs: 2_000 },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'containment_unavailable' });
  });

  test('stops pulling output while an NDJSON client is backpressured', async () => {
    class SlowWriter extends EventEmitter {
      readonly writes: string[] = [];
      private firstWrite = true;

      write(value: string): boolean {
        this.writes.push(value);
        if (this.firstWrite) {
          this.firstWrite = false;
          return false;
        }
        return true;
      }
    }

    let pulls = 0;
    const chunks: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next(): Promise<IteratorResult<Buffer>> {
            pulls += 1;
            if (index < 2) {
              index += 1;
              return Promise.resolve({ done: false, value: Buffer.from(String(index)) });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
    const writer = new SlowWriter();
    const production = consumeOutputChunks(chunks, async (chunk) => {
      await writeNdjsonRecord(writer, {
        type: 'stdout',
        data: chunk.toString(),
        at: new Date().toISOString(),
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(pulls).toBe(1);
    expect(writer.writes).toHaveLength(1);
    writer.emit('drain');
    await production;
    expect(pulls).toBe(3);
    expect(writer.writes).toHaveLength(2);
  });

  test('removes NDJSON wait listeners when a backpressured client closes', async () => {
    class ClosingWriter extends EventEmitter {
      write(): boolean {
        return false;
      }
    }
    const writer = new ClosingWriter();
    const writing = writeNdjsonRecord(writer, {
      type: 'stdout',
      data: 'blocked',
      at: new Date().toISOString(),
    });
    expect(writer.listenerCount('drain')).toBe(1);
    expect(writer.listenerCount('close')).toBe(1);
    expect(writer.listenerCount('error')).toBe(1);

    writer.emit('close');

    await expect(writing).rejects.toThrow('Streaming client closed');
    expect(writer.listenerCount('drain')).toBe(0);
    expect(writer.listenerCount('close')).toBe(0);
    expect(writer.listenerCount('error')).toBe(0);
  });

  test.each([
    { name: 'escaped cwd', cwd: '../outside', cmd: process.execPath },
    { name: 'missing executable', cwd: '.', cmd: '/definitely/missing/zapp-command' },
  ])('rejects $name before hijacking a streaming response', async ({ cwd, cmd }) => {
    const response = await requireApp().inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers: authorization(),
      payload: { cmd, args: [], cwd, timeoutMs: 2_000 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'bad_request' });
  });

  test('allocates a real terminal for pty execution', async () => {
    const response = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: authorization(),
      payload: { cmd: '/bin/sh', args: ['-c', 'test -t 1'], timeoutMs: 2_000, pty: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ exitCode: 0, truncated: false });
  });

  test('installs the pinned node-pty macOS spawn helper with executable mode', async () => {
    if (process.platform !== 'darwin') return;
    const nodePtyRoot = resolve(dirname(require.resolve('node-pty')), '..');
    const helper = join(
      nodePtyRoot,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    );

    expect((await stat(helper)).mode & 0o111).not.toBe(0);
  });

  test.each([false, true])(
    'isolates reserved daemon env while allowing application credentials when pty=%s',
    async (pty) => {
      const previousAgentToken = process.env.ZAPP_AGENT_TOKEN;
      const previousWorkspaceRoot = process.env.ZAPP_WORKSPACE_ROOT;
      const previousDevServerPort = process.env.ZAPP_DEV_SERVER_PORT;
      process.env.ZAPP_AGENT_TOKEN = token;
      process.env.ZAPP_WORKSPACE_ROOT = workspaceRoot;
      process.env.ZAPP_DEV_SERVER_PORT = '8877';

      try {
        const response = await requireApp().inject({
          method: 'POST',
          url: '/exec',
          headers: authorization(),
          payload: {
            cmd: process.execPath,
            args: [
              '-e',
              "process.stdout.write([process.env.ZAPP_AGENT_TOKEN ?? 'absent', process.env.ZAPP_WORKSPACE_ROOT ?? 'absent', process.env.ZAPP_DEV_SERVER_PORT ?? 'absent', process.env.PATH ? 'path' : 'no-path', process.env.CUSTOM_API_KEY, process.env.STRIPE_SECRET_KEY, process.env.APP_PASSWORD, process.env.DATABASE_URL].join('|'))",
            ],
            env: {
              CUSTOM_API_KEY: 'custom-value',
              STRIPE_SECRET_KEY: 'stripe-value',
              APP_PASSWORD: 'password-value',
              DATABASE_URL: 'postgres://application/database',
            },
            timeoutMs: 2_000,
            pty,
          },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json<{ stdout: string }>().stdout).toContain(
          'absent|absent|absent|path|custom-value|stripe-value|password-value|postgres://application/database',
        );
      } finally {
        if (previousAgentToken === undefined) delete process.env.ZAPP_AGENT_TOKEN;
        else process.env.ZAPP_AGENT_TOKEN = previousAgentToken;
        if (previousWorkspaceRoot === undefined) delete process.env.ZAPP_WORKSPACE_ROOT;
        else process.env.ZAPP_WORKSPACE_ROOT = previousWorkspaceRoot;
        if (previousDevServerPort === undefined) delete process.env.ZAPP_DEV_SERVER_PORT;
        else process.env.ZAPP_DEV_SERVER_PORT = previousDevServerPort;
      }
    },
  );

  test.each([false, true])(
    'rejects reserved request env before spawning when pty=%s',
    async (pty) => {
      const marker = join(workspaceRoot, `protected-env-${String(pty)}`);
      const response = await requireApp().inject({
        method: 'POST',
        url: '/exec',
        headers: authorization(),
        payload: {
          cmd: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
          env: {
            ZAPP_AGENT_TOKEN: 'request-token',
            ZAPP_WORKSPACE_ROOT: '/request/root',
            ZAPP_DEV_SERVER_PORT: '9999',
          },
          timeoutMs: 2_000,
          pty,
        },
      });

      expect(response.statusCode).toBe(400);
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  test.each([false, true])(
    'rejects non-POSIX env names and NUL values before spawning when pty=%s',
    async (pty) => {
      const marker = join(workspaceRoot, `invalid-env-${String(pty)}`);
      const command = {
        cmd: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        timeoutMs: 2_000,
        pty,
      };
      const invalidName = await requireApp().inject({
        method: 'POST',
        url: '/exec',
        headers: authorization(),
        payload: { ...command, env: { 'INVALID-NAME': 'value' } },
      });
      const nulValue = await requireApp().inject({
        method: 'POST',
        url: '/exec',
        headers: authorization(),
        payload: { ...command, env: { VALID_NAME: 'before\0after' } },
      });

      expect(invalidName.statusCode).toBe(400);
      expect(nulValue.statusCode).toBe(400);
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  test('requires a valid Idempotency-Key on every mutating route', async () => {
    const authorizationHeader = { authorization: `Bearer ${token}` };
    const requests = [
      {
        method: 'POST' as const,
        url: '/exec',
        payload: { cmd: 'true', args: [], timeoutMs: 1_000 },
      },
      {
        method: 'POST' as const,
        url: '/exec?stream=1',
        payload: { cmd: 'true', args: [], timeoutMs: 1_000 },
      },
      { method: 'POST' as const, url: '/exec/999999/kill' },
      {
        method: 'PUT' as const,
        url: '/files?path=idempotency-required.txt',
        payload: Buffer.from('must-not-write'),
      },
      {
        method: 'POST' as const,
        url: '/git',
        payload: { operation: 'status', args: ['--short'] },
      },
      {
        method: 'POST' as const,
        url: '/files/atomic-write',
        payload: { files: [{ path: 'idempotency.txt', dataBase64: '' }] },
      },
      { method: 'DELETE' as const, url: '/files?path=idempotency.txt' },
      {
        method: 'POST' as const,
        url: '/files/rename',
        payload: { source: 'a', destination: 'b', overwrite: 'replace' },
      },
      {
        method: 'POST' as const,
        url: '/dev-server/start',
        payload: { contract: executionContract('true', 4173) },
      },
      {
        method: 'POST' as const,
        url: '/dev-server/restart',
        payload: { contract: executionContract('true', 4173) },
      },
    ];

    for (const request of requests) {
      const missing = await requireApp().inject({
        ...request,
        headers: authorizationHeader,
      });
      const invalid = await requireApp().inject({
        ...request,
        headers: { ...authorizationHeader, 'idempotency-key': 'contains spaces' },
      });
      expect(missing.statusCode, request.url).toBe(400);
      expect(missing.json(), request.url).toEqual({ error: 'bad_request' });
      expect(invalid.statusCode, request.url).toBe(400);
      expect(invalid.json(), request.url).toEqual({ error: 'bad_request' });
    }
    await expect(access(join(workspaceRoot, 'idempotency-required.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('GET /files authenticates without validating Idempotency-Key', async () => {
    await writeFile(join(workspaceRoot, 'bearer-only.txt'), 'bearer-only');
    const bearerOnly = { authorization: `Bearer ${token}` };

    const withoutKey = await requireApp().inject({
      method: 'GET',
      url: '/files?path=bearer-only.txt',
      headers: bearerOnly,
    });
    const withInvalidKey = await requireApp().inject({
      method: 'GET',
      url: '/files?path=bearer-only.txt',
      headers: { ...bearerOnly, 'idempotency-key': 'invalid key' },
    });

    expect(withoutKey.statusCode).toBe(200);
    expect(withoutKey.body).toBe('bearer-only');
    expect(withInvalidKey.statusCode).toBe(200);
    expect(withInvalidKey.body).toBe('bearer-only');
  });

  test('replays buffered and streamed exec responses without repeating side effects', async () => {
    const bufferedMarker = join(workspaceRoot, 'buffered-replay-count');
    const bufferedPayload = {
      cmd: process.execPath,
      args: [
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(bufferedMarker)}, 'x'); process.stdout.write('buffered')`,
      ],
      timeoutMs: 2_000,
    };
    const bufferedHeaders = authorization(token, 'buffered-exec-replay');
    const firstBuffered = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: bufferedHeaders,
      payload: bufferedPayload,
    });
    const replayedBuffered = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: bufferedHeaders,
      payload: bufferedPayload,
    });

    const streamedMarker = join(workspaceRoot, 'streamed-replay-count');
    const streamedPayload = {
      cmd: process.execPath,
      args: [
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(streamedMarker)}, 'x'); process.stdout.write('streamed')`,
      ],
      timeoutMs: 2_000,
    };
    const streamedHeaders = authorization(token, 'streamed-exec-replay');
    const firstStreamed = await requireApp().inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers: streamedHeaders,
      payload: streamedPayload,
    });
    const replayedStreamed = await requireApp().inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers: streamedHeaders,
      payload: streamedPayload,
    });

    expect(replayedBuffered.statusCode).toBe(firstBuffered.statusCode);
    expect(replayedBuffered.body).toBe(firstBuffered.body);
    expect(await readFile(bufferedMarker, 'utf8')).toBe('x');
    expect(replayedStreamed.statusCode).toBe(firstStreamed.statusCode);
    expect(replayedStreamed.headers['content-type']).toBe(firstStreamed.headers['content-type']);
    expect(replayedStreamed.body).toBe(firstStreamed.body);
    expect(parseNdjson(replayedStreamed.body).at(-1)?.type).toBe('exit');
    expect(await readFile(streamedMarker, 'utf8')).toBe('x');
  });

  test('coalesces thousands of tiny output chunks into bounded replay framing', async () => {
    const marker = join(workspaceRoot, 'tiny-stream-replay-count');
    const payload = {
      cmd: process.execPath,
      args: [
        '-e',
        `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'x');let count=0;const write=()=>{if(count===10000)return;count+=1;process.stdout.write('x');setImmediate(write)};write();`,
      ],
      timeoutMs: 10_000,
    };
    const headers = authorization(token, 'tiny-stream-replay');

    const first = await requireApp().inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers,
      payload,
    });
    const replayed = await requireApp().inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers,
      payload,
    });
    const stdoutRecords = parseNdjson(first.body).filter((record) => record.type === 'stdout');

    expect(first.statusCode).toBe(200);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.body).toBe(first.body);
    expect(stdoutRecords.map((record) => record.data ?? '').join('')).toBe('x'.repeat(10_000));
    // The retained-response byte ceiling is the structural bound. A fixed
    // record count is scheduler-dependent because the 25 ms latency flush can
    // fire while a contended runner is still producing setImmediate chunks.
    expect(Buffer.byteLength(first.body)).toBeLessThan(64 * 1_024);
    expect(await readFile(marker, 'utf8')).toBe('x');
  });

  test('tombstones an oversized response without rerunning its side effect', async () => {
    const marker = join(workspaceRoot, 'oversized-replay-count');
    const payload = {
      cmd: process.execPath,
      args: [
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'x');process.stdout.write('x'.repeat(80*1024));`,
      ],
      timeoutMs: 5_000,
    };
    const headers = authorization(token, 'oversized-replay');

    const first = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers,
      payload,
    });
    const replayed = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers,
      payload,
    });
    const conflict = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers,
      payload: { ...payload, args: ['-e', 'process.stdout.write("different")'] },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json<{ stdout: string }>().stdout).toBe('x'.repeat(80 * 1_024));
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json()).toEqual({ error: 'idempotency_response_not_retained' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'idempotency_conflict' });
    expect(await readFile(marker, 'utf8')).toBe('x');
  });

  test('bounds total replay bytes across 256 entries without rerunning evicted responses', async () => {
    const firstMarker = join(workspaceRoot, 'total-replay-first');
    const lastMarker = join(workspaceRoot, 'total-replay-last');
    const body = 'x'.repeat(1_024);
    const command = '[ -z "$MARKER" ] || printf x >> "$MARKER"; printf %s "$BODY"';
    let firstPayload: Record<string, unknown> | undefined;
    let firstHeaders: ReturnType<typeof authorization> | undefined;
    let lastPayload: Record<string, unknown> | undefined;
    let lastHeaders: ReturnType<typeof authorization> | undefined;
    let lastResponseBody = '';

    for (let index = 0; index < 256; index += 1) {
      const marker = index === 0 ? firstMarker : index === 255 ? lastMarker : '';
      const payload = {
        cmd: '/bin/sh',
        args: ['-c', command],
        env: { BODY: body, MARKER: marker },
        timeoutMs: 2_000,
      };
      const headers = authorization(token, `total-replay-${String(index)}`);
      const response = await requireApp().inject({
        method: 'POST',
        url: '/exec',
        headers,
        payload,
      });
      expect(response.statusCode, String(index)).toBe(200);
      if (index === 0) {
        firstPayload = payload;
        firstHeaders = headers;
      } else if (index === 255) {
        lastPayload = payload;
        lastHeaders = headers;
        lastResponseBody = response.body;
      }
    }
    if (
      firstPayload === undefined ||
      firstHeaders === undefined ||
      lastPayload === undefined ||
      lastHeaders === undefined
    ) {
      throw new Error('Replay pressure fixtures were not initialized');
    }

    const replayedLast = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: lastHeaders,
      payload: lastPayload,
    });
    const tombstonedFirst = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: firstHeaders,
      payload: firstPayload,
    });

    expect(replayedLast.statusCode).toBe(200);
    expect(replayedLast.body).toBe(lastResponseBody);
    expect(await readFile(lastMarker, 'utf8')).toBe('x');
    expect(tombstonedFirst.statusCode).toBe(409);
    expect(tombstonedFirst.json()).toEqual({ error: 'idempotency_response_not_retained' });
    expect(await readFile(firstMarker, 'utf8')).toBe('x');
  }, 30_000);

  test('coalesces concurrent duplicate exec requests into one execution', async () => {
    const marker = join(workspaceRoot, 'concurrent-idempotency-count');
    const request = {
      method: 'POST' as const,
      url: '/exec',
      headers: authorization(token, 'concurrent-exec-replay'),
      payload: {
        cmd: process.execPath,
        args: [
          '-e',
          `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); setTimeout(() => process.stdout.write('once'), 100)`,
        ],
        timeoutMs: 2_000,
      },
    };

    const [first, duplicate] = await Promise.all([
      requireApp().inject(request),
      requireApp().inject(request),
    ]);

    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.body).toBe(first.body);
    expect(await readFile(marker, 'utf8')).toBe('x');
  });

  test('replays kill, file-write, and git responses without repeating side effects', async () => {
    const pidFile = join(workspaceRoot, 'idempotent-kill.pid');
    const activeStream = await startLiveExecStream(
      requireApp(),
      token,
      'active-for-idempotent-kill',
      {
        cmd: process.execPath,
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
        ],
        timeoutMs: 10_000,
      },
    );
    const pid = Number(await waitForFile(pidFile));
    expect(activeStream.started.pid).toBe(pid);
    const killHeaders = authorization(token, 'kill-replay');
    const killPayload = { executionId: activeStream.started.executionId };
    const firstKill = await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(pid)}/kill`,
      headers: killHeaders,
      payload: killPayload,
    });
    await activeStream.finish();
    const replayedKill = await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(pid)}/kill`,
      headers: killHeaders,
      payload: killPayload,
    });

    const fileHeaders = {
      ...authorization(token, 'file-write-replay'),
      'content-type': 'application/octet-stream',
    };
    const firstWrite = await requireApp().inject({
      method: 'PUT',
      url: '/files?path=idempotent.txt',
      headers: fileHeaders,
      payload: Buffer.from('original'),
    });
    await writeFile(join(workspaceRoot, 'idempotent.txt'), 'changed-after-first-write');
    const replayedWrite = await requireApp().inject({
      method: 'PUT',
      url: '/files?path=idempotent.txt',
      headers: fileHeaders,
      payload: Buffer.from('original'),
    });

    await execFileAsync('git', ['init'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'workspace-agent@example.invalid'], {
      cwd: workspaceRoot,
    });
    await execFileAsync('git', ['config', 'user.name', 'Workspace Agent Test'], {
      cwd: workspaceRoot,
    });
    await writeFile(join(workspaceRoot, 'idempotent-git.txt'), 'content');
    const gitHeaders = authorization(token, 'git-replay');
    const gitPayload = {
      operation: 'add_commit' as const,
      paths: ['idempotent-git.txt'],
      message: 'idempotent commit',
    };
    const firstGit = await requireApp().inject({
      method: 'POST',
      url: '/git',
      headers: gitHeaders,
      payload: gitPayload,
    });
    const replayedGit = await requireApp().inject({
      method: 'POST',
      url: '/git',
      headers: gitHeaders,
      payload: gitPayload,
    });
    const { stdout: commitCount } = await execFileAsync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: workspaceRoot,
    });

    expect(firstKill.json()).toEqual({ killed: true });
    expect(replayedKill.body).toBe(firstKill.body);
    expect(firstWrite.statusCode).toBe(204);
    expect(replayedWrite.statusCode).toBe(204);
    expect(await readFile(join(workspaceRoot, 'idempotent.txt'), 'utf8')).toBe(
      'changed-after-first-write',
    );
    expect(replayedGit.body).toBe(firstGit.body);
    expect(commitCount.trim()).toBe('1');
  });

  test('returns 409 when an Idempotency-Key is reused for another payload or route', async () => {
    const headers = {
      ...authorization(token, 'idempotency-conflict'),
      'content-type': 'application/octet-stream',
    };
    const first = await requireApp().inject({
      method: 'PUT',
      url: '/files?path=conflict.txt',
      headers,
      payload: Buffer.from('first'),
    });
    const payloadConflict = await requireApp().inject({
      method: 'PUT',
      url: '/files?path=conflict.txt',
      headers,
      payload: Buffer.from('second'),
    });
    const routeConflict = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: authorization(token, 'idempotency-conflict'),
      payload: { cmd: 'true', args: [], timeoutMs: 1_000 },
    });

    expect(first.statusCode).toBe(204);
    expect(payloadConflict.statusCode).toBe(409);
    expect(payloadConflict.json()).toEqual({ error: 'idempotency_conflict' });
    expect(routeConflict.statusCode).toBe(409);
    expect(routeConflict.json()).toEqual({ error: 'idempotency_conflict' });
    expect(await readFile(join(workspaceRoot, 'conflict.txt'), 'utf8')).toBe('first');
  });

  test('does not rerun a started streamed side effect after a backpressured disconnect', async () => {
    const activeApp = requireApp();
    const address = await activeApp.listen({ host: '127.0.0.1', port: 0 });
    const marker = join(workspaceRoot, 'ambiguous-stream-count');
    const pidFile = join(workspaceRoot, 'ambiguous-stream.pid');
    const headers = authorization(token, 'ambiguous-stream-retry');
    const payload = {
      cmd: process.execPath,
      args: [
        '-e',
        `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'x');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write(Buffer.alloc(${String(OUTPUT_LIMIT)},120));`,
      ],
      timeoutMs: 10_000,
    };
    const serverSocketPromise = new Promise<Socket>((resolveSocket) => {
      activeApp.server.once('connection', (socket) => {
        socket.cork();
        resolveSocket(socket);
      });
    });
    const body = JSON.stringify(payload);
    const url = new URL(address);
    const client = createConnection({ host: url.hostname, port: Number(url.port) });
    client.on('error', () => undefined);
    await onceEvent(client, 'connect');
    client.write(
      [
        'POST /exec?stream=1 HTTP/1.1',
        `Host: ${url.host}`,
        `Authorization: ${headers.authorization}`,
        `Idempotency-Key: ${headers['idempotency-key']}`,
        'Content-Type: application/json',
        `Content-Length: ${String(Buffer.byteLength(body))}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'),
    );
    const serverSocket = await serverSocketPromise;
    const pid = Number(await waitForFile(pidFile));
    expect(await readFile(marker, 'utf8')).toBe('x');
    const backpressureDeadline = Date.now() + 3_000;
    while (!serverSocket.writableNeedDrain) {
      if (Date.now() >= backpressureDeadline) throw new Error('Stream never backpressured');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }

    const serverClosed = onceEvent(serverSocket, 'close');
    client.destroy();
    await settleWithin(
      serverClosed.then(() => undefined),
      1_000,
    );
    await waitForProcessExit(pid);
    const inactiveDeadline = Date.now() + 3_000;
    for (;;) {
      const metrics = await activeApp.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${token}` },
      });
      if (metrics.json<{ activeChildren: number }>().activeChildren === 0) break;
      if (Date.now() >= inactiveDeadline) throw new Error('Streamed command stayed active');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }

    const retry = await activeApp.inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers,
      payload,
    });
    const conflict = await activeApp.inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers,
      payload: { ...payload, args: ['-e', 'process.stdout.write("different")'] },
    });

    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toEqual({ error: 'idempotency_ambiguous' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'idempotency_conflict' });
    expect(await readFile(marker, 'utf8')).toBe('x');

    for (let index = 0; index < 256; index += 1) {
      const pressure = await activeApp.inject({
        method: 'POST',
        url: '/exec/999999/kill',
        headers: authorization(token, `ambiguity-pressure-${String(index)}`),
        payload: { executionId: randomUUID() },
      });
      expect(pressure.statusCode).toBe(200);
    }
    const retryAfterPressure = await activeApp.inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers,
      payload,
    });

    expect(retryAfterPressure.statusCode).toBe(409);
    expect(retryAfterPressure.json()).toEqual({ error: 'idempotency_ambiguous' });
    expect(await readFile(marker, 'utf8')).toBe('x');
  });

  test('times out the whole process group without leaving a descendant', async () => {
    const orphanMarker = join(workspaceRoot, 'orphan-marker');
    const script = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(orphanMarker)}, 'orphan'), 400)`,
      )}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1000);',
    ].join('');

    const response = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: authorization(),
      payload: { cmd: process.execPath, args: ['-e', script], timeoutMs: 75 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ exitCode: 124 });
    await new Promise((resolve) => setTimeout(resolve, 550));
    await expect(access(orphanMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('requires authentication to acknowledge authoritative cleanup for an exact execution', async () => {
    const cleanupId = randomUUID();
    const execution = await requireApp().inject({
      method: 'POST',
      url: `/exec?cleanupId=${cleanupId}`,
      headers: authorization(),
      payload: { cmd: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 2_000 },
    });

    expect(execution.statusCode).toBe(200);
    const unauthorized = await requireApp().inject({
      method: 'GET',
      url: `/exec/cleanup/${cleanupId}`,
      headers: authorization('wrong-token'),
    });
    const acknowledged = await requireApp().inject({
      method: 'GET',
      url: `/exec/cleanup/${cleanupId}`,
      headers: authorization(),
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json()).toEqual({ cleaned: true });
  });

  test.each(['kill', 'populated_wait', 'remove'] as const)(
    'returns the closed %s diagnostic stage for authenticated cleanup failure',
    async (stage) => {
      const failureRoot = await mkdtemp(join(tmpdir(), 'zapp-cleanup-stage-route-'));
      const failureApp = await buildWorkspaceAgent({
        workspaceRoot,
        token,
        containment: new CleanupStageFailureContainment(failureRoot, stage),
      });
      const cleanupId = randomUUID();

      try {
        const execution = await failureApp.inject({
          method: 'POST',
          url: `/exec?cleanupId=${cleanupId}`,
          headers: authorization(),
          payload: { cmd: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 2_000 },
        });
        const acknowledgement = await failureApp.inject({
          method: 'GET',
          url: `/exec/cleanup/${cleanupId}`,
          headers: authorization(),
        });

        expect(execution.statusCode).toBe(200);
        expect(acknowledgement.statusCode).toBe(503);
        expect(acknowledgement.json()).toEqual({
          error: 'containment_cleanup_failed',
          stage,
        });
      } finally {
        await failureApp.close().catch(() => undefined);
        await rm(failureRoot, { recursive: true, force: true });
      }
    },
  );

  test('requests containment kill for a detached setsid descendant on buffered timeout', async () => {
    const fixture = createDetachedSetsidFixture(workspaceRoot, 'timeout-setsid');
    containment.setKillMarker(fixture.killMarker);
    const response = requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: authorization(),
      payload: { cmd: process.execPath, args: ['-e', fixture.script], timeoutMs: 1_000 },
    });

    try {
      await waitForFile(fixture.childPidPath);
      expect((await response).json()).toMatchObject({ exitCode: 124 });
      await expectDetachedSetsidContainment(fixture);
    } finally {
      await releaseDetachedSetsidFixture(fixture);
    }
  });

  test('requests containment kill for a detached setsid descendant on explicit kill', async () => {
    const fixture = createDetachedSetsidFixture(workspaceRoot, 'explicit-setsid');
    containment.setKillMarker(fixture.killMarker);
    const stream = await startLiveExecStream(requireApp(), token, 'explicit-setsid-stream', {
      cmd: process.execPath,
      args: ['-e', fixture.script],
      timeoutMs: 10_000,
    });

    try {
      await waitForFile(fixture.childPidPath);
      const parentPid = Number(await readFile(fixture.parentPidPath, 'utf8'));
      const killed = await requireApp().inject({
        method: 'POST',
        url: `/exec/${String(parentPid)}/kill`,
        headers: authorization(),
        payload: { executionId: stream.started.executionId },
      });
      expect(killed.json()).toEqual({ killed: true });
      await stream.finish();
      await expectDetachedSetsidContainment(fixture);
    } finally {
      await releaseDetachedSetsidFixture(fixture);
    }
  });

  test('requests containment kill for a detached setsid descendant on client disconnect', async () => {
    const fixture = createDetachedSetsidFixture(workspaceRoot, 'disconnect-setsid');
    containment.setKillMarker(fixture.killMarker);
    const activeApp = requireApp();
    const address = await activeApp.listen({ host: '127.0.0.1', port: 0 });

    try {
      const response = await fetch(`${address}/exec?stream=1`, {
        method: 'POST',
        headers: { ...authorization(), 'content-type': 'application/json' },
        body: JSON.stringify({
          cmd: process.execPath,
          args: ['-e', fixture.script],
          timeoutMs: 10_000,
        }),
      });
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error('Expected a streaming response body');
      }
      await waitForFile(fixture.childPidPath);
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
      await expectDetachedSetsidContainment(fixture);
    } finally {
      await releaseDetachedSetsidFixture(fixture);
      await activeApp.close();
      app = undefined;
    }
  });

  test('requests containment kill for a detached setsid descendant on agent shutdown', async () => {
    const fixture = createDetachedSetsidFixture(workspaceRoot, 'shutdown-setsid');
    containment.setKillMarker(fixture.killMarker);
    const activeApp = requireApp();
    const request = activeApp.inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers: authorization(),
      payload: { cmd: process.execPath, args: ['-e', fixture.script], timeoutMs: 10_000 },
    });
    const requestOutcome = request.catch(() => undefined);

    try {
      await waitForFile(fixture.childPidPath);
      await activeApp.close();
      app = undefined;
      await requestOutcome;
      await expectDetachedSetsidContainment(fixture);
    } finally {
      await releaseDetachedSetsidFixture(fixture);
      if (app !== undefined) {
        await app.close();
        app = undefined;
      }
    }
  });

  test('kills an active streamed command by its real PID and reaps it', async () => {
    const pidFile = join(workspaceRoot, 'active.pid');
    const stream = await startLiveExecStream(requireApp(), token, 'active-stream-kill', {
      cmd: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      timeoutMs: 10_000,
    });
    const pid = Number(await waitForFile(pidFile));
    expect(stream.started.pid).toBe(pid);

    const killed = await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(pid)}/kill`,
      headers: authorization(),
      payload: { executionId: stream.started.executionId },
    });
    const streamed = await stream.finish();

    expect(killed.statusCode).toBe(200);
    expect(killed.json()).toEqual({ killed: true });
    expect(streamed.at(-1)).toMatchObject({ type: 'exit' });
    await waitForProcessExit(pid);
  });

  test('kills and reaps a streamed command when the client disconnects', async () => {
    const activeApp = requireApp();
    const address = await activeApp.listen({ host: '127.0.0.1', port: 0 });
    const pidFile = join(workspaceRoot, 'disconnected.pid');
    const response = await fetch(`${address}/exec?stream=1`, {
      method: 'POST',
      headers: { ...authorization(), 'content-type': 'application/json' },
      body: JSON.stringify({
        cmd: process.execPath,
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`,
        ],
        timeoutMs: 10_000,
      }),
    });
    const pid = Number(await waitForFile(pidFile));
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error('Expected a streaming response body');
    }
    expect((await reader.read()).done).toBe(false);

    await reader.cancel();

    await waitForProcessExit(pid);
    app = undefined;
    const closePromise = activeApp.close();
    try {
      await settleWithin(closePromise, 1_000);
      await waitForNoServerConnections(activeApp.server);
      expect(activeApp.server.listening).toBe(false);
      expect(await serverConnectionCount(activeApp.server)).toBe(0);
    } finally {
      activeApp.server.closeAllConnections();
      await closePromise;
    }
  });

  test('closes a backpressured raw stream before waiting for child shutdown', async () => {
    const activeApp = requireApp();
    const address = await activeApp.listen({ host: '127.0.0.1', port: 0 });
    const pidFile = join(workspaceRoot, 'shutdown-backpressure.pid');
    const headers = authorization(token, 'shutdown-backpressure');
    const payload = {
      cmd: process.execPath,
      args: [
        '-e',
        `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write(Buffer.alloc(${String(OUTPUT_LIMIT)},120));setInterval(()=>{},1000);`,
      ],
      timeoutMs: 10_000,
    };
    const serverSocketPromise = new Promise<Socket>((resolveSocket) => {
      activeApp.server.once('connection', (socket) => {
        socket.cork();
        resolveSocket(socket);
      });
    });
    const body = JSON.stringify(payload);
    const url = new URL(address);
    const client = createConnection({ host: url.hostname, port: Number(url.port) });
    client.on('error', () => undefined);
    await onceEvent(client, 'connect');
    client.write(
      [
        'POST /exec?stream=1 HTTP/1.1',
        `Host: ${url.host}`,
        `Authorization: ${headers.authorization}`,
        `Idempotency-Key: ${headers['idempotency-key']}`,
        'Content-Type: application/json',
        `Content-Length: ${String(Buffer.byteLength(body))}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'),
    );
    const serverSocket = await serverSocketPromise;
    const pid = Number(await waitForFile(pidFile));
    const backpressureDeadline = Date.now() + 3_000;
    while (!serverSocket.writableNeedDrain) {
      if (Date.now() >= backpressureDeadline) throw new Error('Stream never backpressured');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }

    const clientClosed = onceEvent(client, 'close');
    const closePromise = activeApp.close();
    app = undefined;
    try {
      await settleWithin(closePromise, 1_000);
      await settleWithin(
        clientClosed.then(() => undefined),
        1_000,
      );
      await waitForProcessExit(pid);
      await waitForNoServerConnections(activeApp.server);
      expect(serverSocket.destroyed).toBe(true);
      expect(activeApp.server.listening).toBe(false);
    } finally {
      serverSocket.destroy();
      client.destroy();
      await closePromise;
    }
  });

  test('reports a non-zero exit when the kill route terminates a PTY command', async () => {
    const pidFile = join(workspaceRoot, 'active-pty.pid');
    const stream = await startLiveExecStream(requireApp(), token, 'active-pty-kill', {
      cmd: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      timeoutMs: 10_000,
      pty: true,
    });
    const pid = Number(await waitForFile(pidFile));
    expect(stream.started.pid).toBe(pid);

    const killed = await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(pid)}/kill`,
      headers: authorization(),
      payload: { executionId: stream.started.executionId },
    });
    const exitRecord = (await stream.finish()).at(-1);

    expect(killed.json()).toEqual({ killed: true });
    expect(exitRecord?.type).toBe('exit');
    expect(exitRecord?.exitCode).not.toBe(0);
    await waitForProcessExit(pid);
  });

  test('caps combined command output and reports truncation', async () => {
    const response = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: authorization(),
      payload: {
        cmd: process.execPath,
        args: ['-e', `process.stdout.write(Buffer.alloc(${String(OUTPUT_LIMIT + 4_096)}, 120))`],
        timeoutMs: 3_000,
      },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json<{ stdout: string; stderr: string; truncated: boolean }>();
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(OUTPUT_LIMIT);
    expect(result.truncated).toBe(true);
  });

  test('preserves a UTF-8 sequence split across streamed process chunks', async () => {
    const script =
      'process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 50)';
    const buffered = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: authorization(),
      payload: { cmd: process.execPath, args: ['-e', script], timeoutMs: 2_000 },
    });
    const streamed = await requireApp().inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers: authorization(),
      payload: { cmd: process.execPath, args: ['-e', script], timeoutMs: 2_000 },
    });
    const streamedText = parseNdjson(streamed.body)
      .filter((record) => record.type === 'stdout')
      .map((record) => record.data ?? '')
      .join('');

    expect(buffered.json<{ stdout: string }>().stdout).toBe('€');
    expect(streamedText).toBe('€');
  });

  test('bounds invalid-byte replacement output to the exact largest valid UTF-8 prefix', async () => {
    const response = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: authorization(),
      payload: {
        cmd: process.execPath,
        args: ['-e', `process.stdout.write(Buffer.alloc(${String(OUTPUT_LIMIT)}, 0xff))`],
        timeoutMs: 3_000,
      },
    });

    const result = response.json<{ stdout: string; stderr: string; truncated: boolean }>();
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(1_048_575);
    expect(result.truncated).toBe(true);
  });

  test.each([false, true])(
    'discards all output after a decoded scalar cannot fit when stream=%s',
    async (stream) => {
      const script = [
        `process.stdout.write('A'.repeat(${String(OUTPUT_LIMIT - 1)}));`,
        "setTimeout(() => process.stdout.write('€'), 25);",
        "setTimeout(() => process.stdout.write('Z'), 50);",
      ].join('');
      const response = await requireApp().inject({
        method: 'POST',
        url: stream ? '/exec?stream=1' : '/exec',
        headers: authorization(),
        payload: { cmd: process.execPath, args: ['-e', script], timeoutMs: 2_000 },
      });
      const records = stream ? parseNdjson(response.body) : [];
      const stdout = stream
        ? records
            .filter((record) => record.type === 'stdout')
            .map((record) => record.data ?? '')
            .join('')
        : response.json<{ stdout: string }>().stdout;
      const truncated = stream
        ? records.at(-1)?.truncated
        : response.json<{ truncated: boolean }>().truncated;

      expect(Buffer.byteLength(stdout)).toBe(OUTPUT_LIMIT - 1);
      expect(stdout.endsWith('A')).toBe(true);
      expect(stdout.endsWith('Z')).toBe(false);
      expect(truncated).toBe(true);
    },
  );

  test('round-trips arbitrary bytes and lists files with depth and glob controls', async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 2]);
    const written = await requireApp().inject({
      method: 'PUT',
      url: '/files?path=binary.dat',
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    await mkdir(join(workspaceRoot, 'nested'));
    await writeFile(join(workspaceRoot, 'nested', 'visible.txt'), 'visible');
    await mkdir(join(workspaceRoot, 'nested', 'deeper'));
    await writeFile(join(workspaceRoot, 'nested', 'deeper', 'hidden.txt'), 'hidden');

    const read = await requireApp().inject({
      method: 'GET',
      url: '/files?path=binary.dat',
      headers: authorization(),
    });
    const listed = await requireApp().inject({
      method: 'GET',
      url: '/files/list?path=.&glob=*.txt&maxDepth=1',
      headers: authorization(),
    });

    expect(written.statusCode).toBe(204);
    expect(read.statusCode).toBe(200);
    expect(read.rawPayload).toEqual(bytes);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([{ path: 'nested/visible.txt', type: 'file' }]);
  });

  test('uses the native helper for read, write, and list across parent swaps', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'zapp-workspace-agent-native-outside-'));
    const restoreNativePause = configureNativePause(
      join(workspaceRoot, 'native-helper-ready'),
      join(workspaceRoot, 'native-helper-continue'),
    );

    try {
      const readParent = join(workspaceRoot, 'read-parent');
      const pinnedReadParent = join(workspaceRoot, 'pinned-read-parent');
      await mkdir(readParent);
      await writeFile(join(readParent, 'secret.txt'), 'inside');
      await writeFile(join(outsideRoot, 'secret.txt'), 'outside');
      const readRequest = requireApp().inject({
        method: 'GET',
        url: '/files?path=read-parent/secret.txt',
        headers: authorization(),
      });
      await requireNativePause(readRequest, join(workspaceRoot, 'native-helper-ready'));
      await rename(readParent, pinnedReadParent);
      await symlink(outsideRoot, readParent, 'dir');
      await writeFile(join(workspaceRoot, 'native-helper-continue'), 'continue');
      const readResponse = await readRequest;
      expect(readResponse.statusCode).toBe(200);
      expect(readResponse.body).toBe('inside');

      await rm(join(workspaceRoot, 'native-helper-ready'), { force: true });
      await rm(join(workspaceRoot, 'native-helper-continue'), { force: true });
      const writeParent = join(workspaceRoot, 'write-parent');
      const pinnedWriteParent = join(workspaceRoot, 'pinned-write-parent');
      await mkdir(writeParent);
      const writeRequest = requireApp().inject({
        method: 'PUT',
        url: '/files?path=write-parent/written.txt',
        headers: { ...authorization(), 'content-type': 'application/octet-stream' },
        payload: Buffer.from('inside'),
      });
      await requireNativePause(writeRequest, join(workspaceRoot, 'native-helper-ready'));
      await rename(writeParent, pinnedWriteParent);
      await symlink(outsideRoot, writeParent, 'dir');
      await writeFile(join(workspaceRoot, 'native-helper-continue'), 'continue');
      const writeResponse = await writeRequest;
      expect(writeResponse.statusCode).toBe(204);
      expect(await readFile(join(pinnedWriteParent, 'written.txt'), 'utf8')).toBe('inside');
      await expect(access(join(outsideRoot, 'written.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      await rm(join(workspaceRoot, 'native-helper-ready'), { force: true });
      await rm(join(workspaceRoot, 'native-helper-continue'), { force: true });
      const listParent = join(workspaceRoot, 'list-parent');
      const pinnedListParent = join(workspaceRoot, 'pinned-list-parent');
      await mkdir(listParent);
      await writeFile(join(listParent, 'inside.txt'), 'inside');
      await writeFile(join(outsideRoot, 'outside.txt'), 'outside');
      const listRequest = requireApp().inject({
        method: 'GET',
        url: '/files/list?path=list-parent',
        headers: authorization(),
      });
      await requireNativePause(listRequest, join(workspaceRoot, 'native-helper-ready'));
      await rename(listParent, pinnedListParent);
      await symlink(outsideRoot, listParent, 'dir');
      await writeFile(join(workspaceRoot, 'native-helper-continue'), 'continue');
      const listResponse = await listRequest;
      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toEqual([{ path: 'inside.txt', type: 'file' }]);
    } finally {
      restoreNativePause();
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test.each([false, true])(
    'uses the native launcher to pin cwd across a parent swap when pty=%s',
    async (pty) => {
      const outsideRoot = await mkdtemp(join(tmpdir(), 'zapp-workspace-agent-native-exec-'));
      const parent = join(workspaceRoot, 'exec-parent');
      const pinnedParent = join(workspaceRoot, 'pinned-exec-parent');
      const readyPath = join(workspaceRoot, `native-exec-${String(pty)}-ready`);
      const continuePath = join(workspaceRoot, `native-exec-${String(pty)}-continue`);
      await mkdir(parent);

      try {
        const request = requireApp().inject({
          method: 'POST',
          url: '/exec',
          headers: authorization(),
          payload: {
            cmd: '/bin/sh',
            args: ['-c', 'printf pinned > executed.txt'],
            cwd: 'exec-parent',
            env: {
              ZAPP_NATIVE_TEST_READY_PATH: readyPath,
              ZAPP_NATIVE_TEST_CONTINUE_PATH: continuePath,
            },
            timeoutMs: 2_000,
            pty,
          },
        });
        await requireNativePause(request, readyPath);
        await rename(parent, pinnedParent);
        await symlink(outsideRoot, parent, 'dir');
        await writeFile(continuePath, 'continue');

        const response = await request;
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ exitCode: 0 });
        expect(await readFile(join(pinnedParent, 'executed.txt'), 'utf8')).toBe('pinned');
        await expect(access(join(outsideRoot, 'executed.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await rm(outsideRoot, { recursive: true, force: true });
      }
    },
  );

  test('runs the safe git init, add_commit, and status workflow inside the workspace', async () => {
    await execFileAsync('git', ['init'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'workspace-agent@example.invalid'], {
      cwd: workspaceRoot,
    });
    await execFileAsync('git', ['config', 'user.name', 'Workspace Agent Test'], {
      cwd: workspaceRoot,
    });
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'initial');

    const commit = await requireApp().inject({
      method: 'POST',
      url: '/git',
      headers: authorization(),
      payload: { operation: 'add_commit', paths: ['tracked.txt'], message: 'initial commit' },
    });
    const clean = await requireApp().inject({
      method: 'POST',
      url: '/git',
      headers: authorization(),
      payload: { operation: 'status', args: ['--short'] },
    });
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'changed');
    const dirty = await requireApp().inject({
      method: 'POST',
      url: '/git',
      headers: authorization(),
      payload: { operation: 'status', args: ['--short'] },
    });

    expect(commit.statusCode).toBe(200);
    expect(commit.json()).toMatchObject({ exitCode: 0 });
    expect(clean.json()).toMatchObject({ exitCode: 0, stdout: '' });
    expect(dirty.json()).toMatchObject({ exitCode: 0, stdout: ' M tracked.txt\n' });
  });

  test('bounds git command output through the managed execution path', async () => {
    await execFileAsync('git', ['init'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'workspace-agent@example.invalid'], {
      cwd: workspaceRoot,
    });
    await execFileAsync('git', ['config', 'user.name', 'Workspace Agent Test'], {
      cwd: workspaceRoot,
    });
    await writeFile(join(workspaceRoot, 'large.txt'), 'a\n'.repeat(600_000));
    const commit = await requireApp().inject({
      method: 'POST',
      url: '/git',
      headers: authorization(),
      payload: { operation: 'add_commit', paths: ['large.txt'], message: 'large fixture' },
    });
    await writeFile(join(workspaceRoot, 'large.txt'), 'b\n'.repeat(600_000));

    const diff = await requireApp().inject({
      method: 'POST',
      url: '/git',
      headers: authorization(),
      payload: { operation: 'diff' },
    });

    expect(commit.json()).toMatchObject({ exitCode: 0 });
    expect(diff.statusCode).toBe(200);
    const result = diff.json<{ stdout: string; stderr: string }>();
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      OUTPUT_LIMIT,
    );
  });

  test('rejects missing and wrong bearer tokens before route side effects', async () => {
    const wrongToken = randomBytes(32).toString('hex');
    const missing = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      payload: {
        cmd: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync("unauthorized", "bad")'],
        timeoutMs: 1_000,
      },
    });
    const wrong = await requireApp().inject({
      method: 'PUT',
      url: '/files?path=unauthorized',
      headers: { ...authorization(wrongToken), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('bad'),
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    for (const request of [
      { method: 'GET' as const, url: '/files/update-snapshot?path=unauthorized' },
      {
        method: 'POST' as const,
        url: '/files/atomic-write',
        payload: { files: [{ path: 'unauthorized', dataBase64: '' }] },
      },
      { method: 'POST' as const, url: '/search', payload: { pattern: 'x', path: '.' } },
      { method: 'DELETE' as const, url: '/files?path=unauthorized' },
      {
        method: 'POST' as const,
        url: '/files/rename',
        payload: { source: 'a', destination: 'b', overwrite: 'replace' },
      },
      {
        method: 'POST' as const,
        url: '/dev-server/start',
        payload: { contract: executionContract('true', 4173) },
      },
      {
        method: 'POST' as const,
        url: '/dev-server/restart',
        payload: { contract: executionContract('true', 4173) },
      },
    ]) {
      const response = await requireApp().inject({
        ...request,
        headers: { authorization: `Bearer ${wrongToken}`, 'idempotency-key': 'wrong-token' },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
    }
    await expect(access(join(workspaceRoot, 'unauthorized'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('rejects lexical, absolute, encoded, and symlink path escapes before access or spawn', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'zapp-workspace-agent-outside-'));
    await writeFile(join(outsideRoot, 'secret'), 'outside');
    await symlink(outsideRoot, join(workspaceRoot, 'escape-link'));
    const paths = [
      '../outside',
      join(outsideRoot, 'secret'),
      '%2e%2e%2foutside',
      'escape-link/secret',
    ];

    try {
      for (const path of paths) {
        const response = await requireApp().inject({
          method: 'GET',
          url: `/files?path=${path}`,
          headers: authorization(),
        });
        expect(response.statusCode, path).toBe(400);
        if (path !== '%2e%2e%2foutside') {
          const directEdit = await requireApp().inject({
            method: 'POST',
            url: '/files/direct-edit',
            headers: authorization(token, `direct-edit-escape-${String(paths.indexOf(path))}`),
            payload: {
              path,
              dataBase64: Buffer.from('bad').toString('base64'),
              compareToken: `sha256:${'a'.repeat(64)}`,
            },
          });
          expect(directEdit.statusCode, path).toBe(400);
        }
      }

      const spawnMarker = join(workspaceRoot, 'must-not-spawn');
      const escapedCwd = await requireApp().inject({
        method: 'POST',
        url: '/exec',
        headers: authorization(),
        payload: {
          cmd: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(spawnMarker)}, 'bad')`],
          cwd: 'escape-link',
          timeoutMs: 1_000,
        },
      });
      expect(escapedCwd.statusCode).toBe(400);
      await expect(access(spawnMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test('rejects unknown request and query fields and unsafe git arguments', async () => {
    const unknownBody = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: authorization(),
      payload: { cmd: 'true', args: [], timeoutMs: 1_000, unexpected: true },
    });
    const unknownQuery = await requireApp().inject({
      method: 'GET',
      url: '/files/list?path=.&unexpected=true',
      headers: authorization(),
    });
    const unsafeFlag = await requireApp().inject({
      method: 'POST',
      url: '/git',
      headers: authorization(),
      payload: { operation: 'status', args: ['--exec-path=/tmp'] },
    });
    const unsafePath = await requireApp().inject({
      method: 'POST',
      url: '/git',
      headers: authorization(),
      payload: { operation: 'add_commit', paths: ['--all'], message: 'unsafe' },
    });
    const unknownKillBody = await requireApp().inject({
      method: 'POST',
      url: '/exec/999999/kill',
      headers: authorization(),
      payload: { unexpected: true },
    });

    expect(unknownBody.statusCode).toBe(400);
    expect(unknownQuery.statusCode).toBe(400);
    expect(unsafeFlag.statusCode).toBe(400);
    expect(unsafePath.statusCode).toBe(400);
    expect(unknownKillBody.statusCode).toBe(400);
    for (const request of [
      {
        method: 'GET' as const,
        url: '/files/update-snapshot?path=file&unexpected=true',
      },
      {
        method: 'POST' as const,
        url: '/files/atomic-write',
        payload: { files: [{ path: 'file', dataBase64: '', unexpected: true }] },
      },
      {
        method: 'POST' as const,
        url: '/search',
        payload: { pattern: 'x', path: '.', unexpected: true },
      },
      { method: 'DELETE' as const, url: '/files?path=file&unexpected=true' },
      {
        method: 'POST' as const,
        url: '/files/rename',
        payload: { source: 'a', destination: 'b', overwrite: 'replace', unexpected: true },
      },
      {
        method: 'POST' as const,
        url: '/dev-server/start',
        payload: { contract: executionContract('true', 4173), unexpected: true },
      },
      {
        method: 'POST' as const,
        url: '/dev-server/restart',
        payload: { contract: executionContract('true', 4173), unexpected: true },
      },
    ]) {
      const response = await requireApp().inject({ ...request, headers: authorization() });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(400);
    }
  });

  test('rejects NUL in every OS and path boundary with 400', async () => {
    const requests = [
      {
        method: 'GET' as const,
        url: '/files?path=%00',
        headers: authorization(),
      },
      {
        method: 'PUT' as const,
        url: '/files?path=%00',
        headers: { ...authorization(), 'content-type': 'application/octet-stream' },
        payload: Buffer.from('blocked'),
      },
      {
        method: 'GET' as const,
        url: '/files/list?path=%00',
        headers: authorization(),
      },
      {
        method: 'GET' as const,
        url: '/files/list?path=.&glob=%00',
        headers: authorization(),
      },
      ...[
        { cmd: 'bad\0command', args: [], timeoutMs: 1_000 },
        { cmd: process.execPath, args: ['bad\0argument'], timeoutMs: 1_000 },
        { cmd: process.execPath, args: [], cwd: 'bad\0cwd', timeoutMs: 1_000 },
      ].map((payload) => ({
        method: 'POST' as const,
        url: '/exec',
        headers: authorization(),
        payload,
      })),
      {
        method: 'POST' as const,
        url: '/git',
        headers: authorization(),
        payload: { operation: 'status', args: ['bad\0argument'] },
      },
      {
        method: 'POST' as const,
        url: '/git',
        headers: authorization(),
        payload: { operation: 'add_commit', paths: ['bad\0path'], message: 'message' },
      },
      {
        method: 'POST' as const,
        url: '/git',
        headers: authorization(),
        payload: { operation: 'add_commit', paths: ['path'], message: 'bad\0message' },
      },
    ];

    for (const request of requests) {
      const response = await requireApp().inject(request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(400);
      expect(response.json(), `${request.method} ${request.url}`).toEqual({
        error: 'bad_request',
      });
    }
  });

  test('preserves legitimate Unicode across exec, file, and git boundaries', async () => {
    const path = '雪-😀.txt';
    const message = '提交 雪 😀';
    const written = await requireApp().inject({
      method: 'PUT',
      url: `/files?path=${encodeURIComponent(path)}`,
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('unicode'),
    });
    const executed = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: authorization(),
      payload: {
        cmd: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', message],
        cwd: '.',
        timeoutMs: 2_000,
      },
    });
    await execFileAsync('git', ['init'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'workspace-agent@example.invalid'], {
      cwd: workspaceRoot,
    });
    await execFileAsync('git', ['config', 'user.name', 'Workspace Agent Test'], {
      cwd: workspaceRoot,
    });
    const committed = await requireApp().inject({
      method: 'POST',
      url: '/git',
      headers: authorization(),
      payload: { operation: 'add_commit', paths: [path], message },
    });
    const { stdout: committedMessage } = await execFileAsync('git', ['log', '-1', '--pretty=%s'], {
      cwd: workspaceRoot,
    });

    expect(written.statusCode).toBe(204);
    expect(executed.statusCode).toBe(200);
    expect(executed.json<{ stdout: string }>().stdout).toBe(message);
    expect(committed.json()).toMatchObject({ exitCode: 0 });
    expect(committedMessage.trim()).toBe(message);
  });

  test.each([
    '/files?path=missing',
    '/files/list?path=.',
    '/files/update-snapshot?path=missing',
    '/healthz',
    '/metrics',
  ])('rejects a request body on GET %s', async (url) => {
    const response = await requireApp().inject({
      method: 'GET',
      url,
      headers: authorization(),
      payload: { unexpected: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'bad_request' });
  });

  test('reports configured dev-server readiness and finite non-negative metrics', async () => {
    await requireApp().close();
    app = undefined;
    const devServer = createServer();
    const port = await listen(devServer);
    app = await buildWorkspaceAgent({ workspaceRoot, token, devServerPort: port, containment });

    const ready = await app.inject({ method: 'GET', url: '/healthz', headers: authorization() });
    const metrics = await app.inject({ method: 'GET', url: '/metrics', headers: authorization() });
    await closeServer(devServer);
    const notReady = await app.inject({ method: 'GET', url: '/healthz', headers: authorization() });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      ok: true,
      details: 'workspace-agent ready',
      devServer: { port, ready: true },
    });
    expect(notReady.json()).toEqual({
      ok: false,
      details: 'workspace-agent ready; dev server not ready',
      devServer: { port, ready: false },
    });
    const snapshot = metrics.json<Record<string, unknown>>();
    expect(Number.isFinite(Date.parse(snapshot.at as string))).toBe(true);
    const values = [
      ...Object.values(snapshot.cpu as Record<string, number>),
      ...Object.values(snapshot.memory as Record<string, number>),
    ];
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
  });

  test('includes active workspace child usage through the portable metrics seam', async () => {
    await requireApp().close();
    app = undefined;
    const options = {
      workspaceRoot,
      token,
      containment,
      metricsSource: {
        sample: (activePids: readonly number[]) =>
          Promise.resolve({
            cpu: { userMicros: activePids.length === 1 ? 111 : 0, systemMicros: 222 },
            memory: {
              rssBytes: activePids.length === 1 ? 333 : 0,
              heapTotalBytes: 444,
              heapUsedBytes: 555,
              externalBytes: 666,
              arrayBuffersBytes: 777,
            },
          }),
      },
    };
    app = await buildWorkspaceAgent(options);
    const pidFile = join(workspaceRoot, 'metrics.pid');
    const stream = await startLiveExecStream(requireApp(), token, 'metrics-active-stream', {
      cmd: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      timeoutMs: 10_000,
    });
    const pid = Number(await waitForFile(pidFile));
    expect(stream.started.pid).toBe(pid);

    const metrics = await requireApp().inject({
      method: 'GET',
      url: '/metrics',
      headers: authorization(),
    });
    const killed = await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(pid)}/kill`,
      headers: authorization(),
      payload: { executionId: stream.started.executionId },
    });
    await stream.finish();

    expect(killed.json()).toEqual({ killed: true });
    expect(metrics.json()).toMatchObject({
      activeChildren: 1,
      cpu: { userMicros: 111, systemMicros: 222 },
      memory: {
        rssBytes: 333,
        heapTotalBytes: 444,
        heapUsedBytes: 555,
        externalBytes: 666,
        arrayBuffersBytes: 777,
      },
    });
  });

  test('portable metrics include process-group descendants with separate user and system CPU', async () => {
    await requireApp().close();
    app = await buildWorkspaceAgent({
      workspaceRoot,
      token,
      containment,
      metricsSource: portableMetricsSource,
    });
    const rootPidFile = join(workspaceRoot, 'metrics-root.pid');
    const childPidFile = join(workspaceRoot, 'metrics-child.pid');
    const childScript = [
      "const fs = require('node:fs');",
      'const memory = Buffer.allocUnsafe(96 * 1024 * 1024);',
      "require('node:crypto').randomFillSync(memory);",
      "const fd = fs.openSync('/dev/null', 'w');",
      'const block = Buffer.alloc(4096, 1);',
      'const deadline = Date.now() + 750;',
      'let value = 1;',
      'while (Date.now() < deadline) { fs.writeSync(fd, block); value += Math.sqrt(value); }',
      `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
      'setInterval(() => { value += memory[0]; }, 1000);',
    ].join('');
    const daemonCpu = process.cpuUsage();
    const activeStream = await startLiveExecStream(
      requireApp(),
      token,
      'portable-metrics-active-stream',
      {
        cmd: '/bin/sh',
        args: ['-c', 'echo $$ > "$ROOT_PID_FILE"; "$NODE_BIN" -e "$CHILD_SCRIPT" & wait'],
        env: {
          ROOT_PID_FILE: rootPidFile,
          NODE_BIN: process.execPath,
          CHILD_SCRIPT: childScript,
        },
        timeoutMs: 10_000,
      },
    );
    const rootPid = Number(await waitForFile(rootPidFile));
    const childPid = Number(await waitForFile(childPidFile));
    expect(activeStream.started.pid).toBe(rootPid);

    const daemonMemory = process.memoryUsage();
    const activeResponse = await requireApp().inject({
      method: 'GET',
      url: '/metrics',
      headers: authorization(),
    });
    const active = activeResponse.json<{
      cpu: { userMicros: number; systemMicros: number };
      memory: { rssBytes: number };
    }>();
    const childUsage = await execFileAsync('ps', ['-o', 'rss=', '-p', String(childPid)]);
    const childRssBytes = Number(childUsage.stdout.trim()) * 1_024;
    await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(rootPid)}/kill`,
      headers: authorization(),
      payload: { executionId: activeStream.started.executionId },
    });
    await activeStream.finish();

    expect(childRssBytes).toBeGreaterThan(32 * 1024 * 1024);
    expect(active.memory.rssBytes - daemonMemory.rss).toBeGreaterThanOrEqual(
      childRssBytes - 8 * 1024 * 1024,
    );
    expect(active.cpu.userMicros).toBeGreaterThanOrEqual(daemonCpu.user);
    expect(active.cpu.systemMicros).toBeGreaterThanOrEqual(daemonCpu.system);
  });

  test('portable metrics retain an owned containment after its leader exits', async () => {
    await requireApp().close();
    app = await buildWorkspaceAgent({
      workspaceRoot,
      token,
      containment,
      metricsSource: portableMetricsSource,
    });
    const activeApp = requireApp();
    const leaderPidFile = join(workspaceRoot, 'exited-metrics-leader.pid');
    const childPidFile = join(workspaceRoot, 'exited-metrics-child.pid');
    const childScript = [
      "const fs = require('node:fs');",
      'const memory = Buffer.allocUnsafe(96 * 1024 * 1024);',
      "require('node:crypto').randomFillSync(memory);",
      "const fd = fs.openSync('/dev/null', 'w');",
      'const block = Buffer.alloc(4096, 1);',
      'const deadline = Date.now() + 750;',
      'let value = 1;',
      'while (Date.now() < deadline) { fs.writeSync(fd, block); value += Math.sqrt(value); }',
      `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
      'setInterval(() => { value += memory[0]; }, 1000);',
    ].join('');
    const daemonCpu = process.cpuUsage();
    const activeRequest = activeApp.inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers: authorization(),
      payload: {
        cmd: '/bin/sh',
        args: ['-c', 'echo $$ > "$LEADER_PID_FILE"; "$NODE_BIN" -e "$CHILD_SCRIPT" & exit 0'],
        env: {
          LEADER_PID_FILE: leaderPidFile,
          NODE_BIN: process.execPath,
          CHILD_SCRIPT: childScript,
        },
        timeoutMs: 10_000,
      },
    });
    const requestOutcome = activeRequest.catch(() => undefined);
    let childPid: number | undefined;

    try {
      const leaderPid = Number(await waitForFile(leaderPidFile));
      childPid = Number(await waitForFile(childPidFile));
      await waitForProcessExit(leaderPid);

      const daemonMemory = process.memoryUsage();
      const activeResponse = await activeApp.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${token}` },
      });
      const active = activeResponse.json<{
        activeChildren: number;
        cpu: { userMicros: number; systemMicros: number };
        memory: { rssBytes: number };
      }>();
      const staleKill = await activeApp.inject({
        method: 'POST',
        url: `/exec/${String(leaderPid)}/kill`,
        headers: authorization(),
        payload: { executionId: randomUUID() },
      });

      expect(staleKill.json()).toEqual({ killed: false });
      expect(active.activeChildren).toBe(1);
      expect(active.memory.rssBytes - daemonMemory.rss).toBeGreaterThan(32 * 1024 * 1024);
      expect(active.cpu.userMicros).toBeGreaterThanOrEqual(daemonCpu.user);
      expect(active.cpu.systemMicros).toBeGreaterThanOrEqual(daemonCpu.system);

      await activeApp.close();
      app = undefined;
      await requestOutcome;
      await waitForProcessExit(childPid);
    } finally {
      if (app !== undefined) {
        await app.close();
        app = undefined;
      }
      if (childPid !== undefined) {
        try {
          await waitForProcessExit(childPid);
        } catch {
          // Test-only recovery: never leave a failed fixture process behind.
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            // The fixture can already have exited.
          }
        }
      }
    }
  });

  test('closing the agent reaps every active child', async () => {
    const pidFile = join(workspaceRoot, 'close.pid');
    const request = requireApp().inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers: authorization(),
      payload: {
        cmd: process.execPath,
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
        ],
        timeoutMs: 10_000,
      },
    });
    const requestOutcome = request.then(
      () => 'fulfilled' as const,
      (error: unknown) => {
        expect(error).toMatchObject({ code: 'LIGHT_ECONNRESET' });
        return 'rejected' as const;
      },
    );
    const pid = Number(await waitForFile(pidFile));

    await requireApp().close();
    app = undefined;
    expect(await requestOutcome).toBe('rejected');

    await waitForProcessExit(pid);
  });

  test('signal shutdown exits 0 on close success and exits 1 safely on rejection', async () => {
    const successExitCodes: number[] = [];
    const successDiagnostics: string[] = [];
    await closeWorkspaceAgentForSignal(
      { close: () => Promise.resolve() },
      (code) => successExitCodes.push(code),
      (message) => successDiagnostics.push(message),
    );

    const failureExitCodes: number[] = [];
    const failureDiagnostics: string[] = [];
    await closeWorkspaceAgentForSignal(
      { close: () => Promise.reject(new Error('private close failure detail')) },
      (code) => failureExitCodes.push(code),
      (message) => failureDiagnostics.push(message),
    );

    expect(successExitCodes).toEqual([0]);
    expect(successDiagnostics).toEqual([]);
    expect(failureExitCodes).toEqual([1]);
    expect(failureDiagnostics).toEqual(['workspace-agent failed to shut down\n']);
    expect(failureDiagnostics.join('')).not.toContain('private close failure detail');
  });
});
