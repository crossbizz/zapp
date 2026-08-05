import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter, once as onceEvent } from 'node:events';
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
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { consumeOutputChunks } from '../src/exec.js';
import { portableMetricsSource } from '../src/health.js';
import {
  buildWorkspaceAgent,
  closeWorkspaceAgentForSignal,
  writeNdjsonRecord,
} from '../src/main.js';

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

describe('workspace-agent RPC daemon', () => {
  let workspaceRoot: string;
  let token: string;
  let app: FastifyInstance | undefined;
  let idempotencySequence: number;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'zapp-workspace-agent-'));
    token = randomBytes(32).toString('hex');
    idempotencySequence = 0;
    app = await buildWorkspaceAgent({ workspaceRoot, token });
  });

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
    }
    await rm(workspaceRoot, { recursive: true, force: true });
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

  test.each([false, true])('rejects reserved request env before spawning when pty=%s', async (pty) => {
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
  });

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
    const activeRequest = requireApp().inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers: authorization(token, 'active-for-idempotent-kill'),
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
    const killHeaders = authorization(token, 'kill-replay');
    const firstKill = await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(pid)}/kill`,
      headers: killHeaders,
    });
    await activeRequest;
    const replayedKill = await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(pid)}/kill`,
      headers: killHeaders,
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
    await settleWithin(serverClosed.then(() => undefined), 1_000);
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
      await settleWithin(clientClosed.then(() => undefined), 1_000);
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

  test('portable metrics include process-group descendants with separate user and system CPU', async () => {
    await requireApp().close();
    app = await buildWorkspaceAgent({ workspaceRoot, token, metricsSource: portableMetricsSource });
    const rootPidFile = join(workspaceRoot, 'metrics-root.pid');
    const childPidFile = join(workspaceRoot, 'metrics-child.pid');
    const childScript = [
      "const fs = require('node:fs');",
      "const memory = Buffer.allocUnsafe(96 * 1024 * 1024);",
      "require('node:crypto').randomFillSync(memory);",
      "const fd = fs.openSync('/dev/null', 'w');",
      "const block = Buffer.alloc(4096, 1);",
      'const deadline = Date.now() + 750;',
      'let value = 1;',
      'while (Date.now() < deadline) { fs.writeSync(fd, block); value += Math.sqrt(value); }',
      `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
      'setInterval(() => { value += memory[0]; }, 1000);',
    ].join('');
    const activeRequest = requireApp().inject({
      method: 'POST',
      url: '/exec?stream=1',
      headers: authorization(),
      payload: {
        cmd: '/bin/sh',
        args: [
          '-c',
          'echo $$ > "$ROOT_PID_FILE"; "$NODE_BIN" -e "$CHILD_SCRIPT" & wait',
        ],
        env: {
          ROOT_PID_FILE: rootPidFile,
          NODE_BIN: process.execPath,
          CHILD_SCRIPT: childScript,
        },
        timeoutMs: 10_000,
      },
    });
    const rootPid = Number(await waitForFile(rootPidFile));
    const childPid = Number(await waitForFile(childPidFile));

    const activeResponse = await requireApp().inject({
      method: 'GET',
      url: '/metrics',
      headers: authorization(),
    });
    const active = activeResponse.json<{
      cpu: { userMicros: number; systemMicros: number };
      memory: { rssBytes: number };
    }>();
    const daemonCpu = process.cpuUsage();
    const daemonMemory = process.memoryUsage();
    const childUsage = await execFileAsync('ps', ['-o', 'rss=', '-p', String(childPid)]);
    const childRssBytes = Number(childUsage.stdout.trim()) * 1_024;
    await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(rootPid)}/kill`,
      headers: authorization(),
    });
    await activeRequest;

    expect(childRssBytes).toBeGreaterThan(32 * 1024 * 1024);
    expect(active.memory.rssBytes - daemonMemory.rss).toBeGreaterThanOrEqual(
      childRssBytes - 8 * 1024 * 1024,
    );
    expect(active.cpu.userMicros - daemonCpu.user).toBeGreaterThan(50_000);
    expect(active.cpu.systemMicros - daemonCpu.system).toBeGreaterThan(50_000);
  });

  test('portable metrics retain an owned process group after its leader exits', async () => {
    await requireApp().close();
    app = await buildWorkspaceAgent({ workspaceRoot, token, metricsSource: portableMetricsSource });
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
    const activeRequest = requireApp().inject({
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
    const leaderPid = Number(await waitForFile(leaderPidFile));
    const childPid = Number(await waitForFile(childPidFile));
    await waitForProcessExit(leaderPid);

    const activeResponse = await requireApp().inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${token}` },
    });
    const active = activeResponse.json<{
      activeChildren: number;
      cpu: { userMicros: number; systemMicros: number };
      memory: { rssBytes: number };
    }>();
    const daemonCpu = process.cpuUsage();
    const daemonMemory = process.memoryUsage();
    const childUsage = await execFileAsync('ps', ['-o', 'rss=', '-p', String(childPid)]);
    const childRssBytes = Number(childUsage.stdout.trim()) * 1_024;
    await requireApp().inject({
      method: 'POST',
      url: `/exec/${String(leaderPid)}/kill`,
      headers: authorization(),
    });
    await activeRequest;
    const afterResponse = await requireApp().inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(active.activeChildren).toBe(1);
    expect(childRssBytes).toBeGreaterThan(32 * 1024 * 1024);
    expect(active.memory.rssBytes - daemonMemory.rss).toBeGreaterThanOrEqual(
      childRssBytes - 8 * 1024 * 1024,
    );
    expect(active.cpu.userMicros - daemonCpu.user).toBeGreaterThan(50_000);
    expect(active.cpu.systemMicros - daemonCpu.system).toBeGreaterThan(50_000);
    expect(afterResponse.json<{ activeChildren: number }>().activeChildren).toBe(0);
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
