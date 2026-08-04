import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildWorkspaceAgent } from '../src/main.js';

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 1_024 * 1_024;

interface StreamRecord {
  readonly type: 'started' | 'stdout' | 'stderr' | 'exit';
  readonly pid?: number;
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

function parseNdjson(body: string): StreamRecord[] {
  return body
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as StreamRecord);
}

describe('workspace-agent RPC daemon', () => {
  let workspaceRoot: string;
  let token: string;
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-workspace-agent-'));
    token = randomBytes(32).toString('hex');
    app = await buildWorkspaceAgent({ workspaceRoot, token });
  });

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function authorization(value = token): { authorization: string } {
    return { authorization: `Bearer ${value}` };
  }

  function requireApp(): FastifyInstance {
    if (app === undefined) {
      throw new Error('Workspace agent is not available');
    }
    return app;
  }

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
    expect(records.some((record) => record.type === 'stdout' && record.data === 'hi\n')).toBe(true);
    expect(records.at(-1)).toMatchObject({ type: 'exit', exitCode: 0, truncated: false });
    expect(records.filter((record) => record.type === 'exit')).toHaveLength(1);
    expect(records.every((record) => Number.isFinite(Date.parse(record.at)))).toBe(true);
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

  test('kills an active streamed command by its real PID and reaps it', async () => {
    const pidFile = join(workspaceRoot, 'active.pid');
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
    const pid = Number(await waitForFile(pidFile));

    const killed = await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(pid)}/kill`,
      headers: authorization(),
    });
    const streamed = await request;

    expect(killed.statusCode).toBe(200);
    expect(killed.json()).toEqual({ killed: true });
    expect(parseNdjson(streamed.body).at(-1)).toMatchObject({ type: 'exit' });
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
    expect(listed.json()).toEqual([
      { path: 'nested/visible.txt', type: 'file' },
    ]);
  });

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
    await expect(access(join(workspaceRoot, 'unauthorized'))).rejects.toMatchObject({ code: 'ENOENT' });
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
  });

  test('reports configured dev-server readiness and finite non-negative metrics', async () => {
    await requireApp().close();
    app = undefined;
    const devServer = createServer();
    const port = await listen(devServer);
    app = await buildWorkspaceAgent({ workspaceRoot, token, devServerPort: port });

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
    const pid = Number(await waitForFile(pidFile));

    await requireApp().close();
    app = undefined;
    await request;

    await waitForProcessExit(pid);
  });
});
