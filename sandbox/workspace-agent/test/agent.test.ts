import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { consumeOutputChunks } from '../src/exec.js';
import { buildWorkspaceAgent, writeNdjsonRecord } from '../src/main.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
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

  test('installs the pinned node-pty POSIX spawn helper with executable mode', async () => {
    if (process.platform === 'win32') {
      expect(process.platform).toBe('win32');
      return;
    }
    const nodePtyRoot = resolve(dirname(require.resolve('node-pty')), '..');
    const helper = join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');

    expect((await stat(helper)).mode & 0o111).not.toBe(0);
  });

  test.each([false, true])(
    'isolates daemon credentials while preserving PATH and request env when pty=%s',
    async (pty) => {
      const previousAgentToken = process.env.ZAPP_AGENT_TOKEN;
      const previousServiceToken = process.env.ZAPP_SERVICE_TOKEN_SECRET;
      const previousPlatformToken = process.env.SERVICE_TOKEN_SECRET;
      process.env.ZAPP_AGENT_TOKEN = token;
      process.env.ZAPP_SERVICE_TOKEN_SECRET = 'service-token-sentinel';
      process.env.SERVICE_TOKEN_SECRET = 'platform-token-sentinel';

      try {
        const response = await requireApp().inject({
          method: 'POST',
          url: '/exec',
          headers: authorization(),
          payload: {
            cmd: process.execPath,
            args: [
              '-e',
              "process.stdout.write([process.env.ZAPP_AGENT_TOKEN ?? 'absent', process.env.ZAPP_SERVICE_TOKEN_SECRET ?? 'absent', process.env.SERVICE_TOKEN_SECRET ?? 'absent', process.env.PATH ? 'path' : 'no-path', process.env.ALLOWED_VALUE ?? 'missing'].join('|'))",
            ],
            env: { ALLOWED_VALUE: 'allowed' },
            timeoutMs: 2_000,
            pty,
          },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json<{ stdout: string }>().stdout).toContain(
          'absent|absent|absent|path|allowed',
        );
      } finally {
        if (previousAgentToken === undefined) delete process.env.ZAPP_AGENT_TOKEN;
        else process.env.ZAPP_AGENT_TOKEN = previousAgentToken;
        if (previousServiceToken === undefined) delete process.env.ZAPP_SERVICE_TOKEN_SECRET;
        else process.env.ZAPP_SERVICE_TOKEN_SECRET = previousServiceToken;
        if (previousPlatformToken === undefined) delete process.env.SERVICE_TOKEN_SECRET;
        else process.env.SERVICE_TOKEN_SECRET = previousPlatformToken;
      }
    },
  );

  test.each([false, true])('rejects protected request env before spawning when pty=%s', async (pty) => {
    const marker = join(workspaceRoot, `protected-env-${String(pty)}`);
    const response = await requireApp().inject({
      method: 'POST',
      url: '/exec',
      headers: authorization(),
      payload: {
        cmd: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        env: { ZAPP_SERVICE_TOKEN_SECRET: 'request-sentinel' },
        timeoutMs: 2_000,
        pty,
      },
    });

    expect(response.statusCode).toBe(400);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
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

  test('kills and reaps a streamed command when the client disconnects', async () => {
    const address = await requireApp().listen({ host: '127.0.0.1', port: 0 });
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
  });

  test('reports a non-zero exit when the kill route terminates a PTY command', async () => {
    const pidFile = join(workspaceRoot, 'active-pty.pid');
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
        pty: true,
      },
    });
    const pid = Number(await waitForFile(pidFile));

    const killed = await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(pid)}/kill`,
      headers: authorization(),
    });
    const streamed = await request;
    const exitRecord = parseNdjson(streamed.body).at(-1);

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
      "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 50)";
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

  test.each(['/files?path=missing', '/files/list?path=.', '/healthz', '/metrics'])(
    'rejects a request body on GET %s',
    async (url) => {
      const response = await requireApp().inject({
        method: 'GET',
        url,
        headers: authorization(),
        payload: { unexpected: true },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'bad_request' });
    },
  );

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

  test('includes active workspace child usage through the portable metrics seam', async () => {
    await requireApp().close();
    app = undefined;
    const options = {
      workspaceRoot,
      token,
      metricsSource: {
        sample: (activePids: readonly number[]) => Promise.resolve({
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

    const metrics = await requireApp().inject({
      method: 'GET',
      url: '/metrics',
      headers: authorization(),
    });
    const killed = await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(pid)}/kill`,
      headers: authorization(),
    });
    await request;

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
