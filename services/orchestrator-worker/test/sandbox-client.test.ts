import { createServiceTokenSigner } from '@zapp/config';
import { newId } from '@zapp/contracts';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  SandboxWorkspaceRequestError,
  createSandboxWorkspaceRuntime,
} from '../src/runtime/sandbox-client.js';

const serviceTokens = { secret: 's'.repeat(32) };
const organizationId = newId('org');
const projectId = newId('proj');
const workspaceId = newId('ws');
const runId = newId('run');
const operationKey = `op_${'a'.repeat(64)}`;
const execution = {
  exitCode: 0,
  stdout: 'ok\n',
  stderr: '',
  durationMs: 2,
  truncated: false,
};
const workspace = {
  id: workspaceId,
  organizationId,
  projectId,
  branchId: newId('br'),
  provider: 'docker',
  status: 'ready',
  resourceProfile: 'standard',
  snapshotRef: null,
  createdAt: '2026-08-12T00:00:00.000Z',
  lastActiveAt: '2026-08-12T00:00:01.000Z',
  terminatedAt: null,
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function fixture() {
  const requests: Request[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    await Promise.resolve();
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route.endsWith('/exec') && url.searchParams.get('stream') === '1') {
      return new Response(
        [
          { type: 'started', pid: 9, executionId: randomUUID(), at: '2026-08-12T00:00:00.000Z' },
          { type: 'stdout', data: 'streamed', at: '2026-08-12T00:00:01.000Z' },
          { type: 'exit', exitCode: 0, durationMs: 2, truncated: false, at: '2026-08-12T00:00:02.000Z' },
        ].map((record) => `${JSON.stringify(record)}\n`).join(''),
        { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } },
      );
    }
    if (route.endsWith('/exec')) return json(execution);
    if (route.endsWith('/files/update-snapshot')) {
      return json({ dataBase64: Buffer.from('before').toString('base64'), revision: 'rev-1' });
    }
    if (route.endsWith('/files/list')) return json([{ path: 'app.ts', type: 'file' }]);
    if (route.endsWith('/files/stat')) {
      return json({ path: 'app.ts', type: 'file', size: 6, mtimeMs: 1_786_564_800_000 });
    }
    if (route.endsWith('/files') && request.method === 'GET') {
      return new Response('source', { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (route.endsWith('/files') && request.method === 'PUT') return new Response(null, { status: 204 });
    if (route.endsWith('/files/atomic-write')) return json({ ok: true });
    if (route.endsWith('/search')) return json(execution);
    if (route.endsWith('/files') && request.method === 'DELETE') {
      return json({ ok: true, alreadyAbsent: false });
    }
    if (route.endsWith('/files/rename')) return json({ ok: true });
    if (route.endsWith('/git')) return json({ exitCode: 0, stdout: 'main\n', stderr: '' });
    if (route.includes('/dev-server/') && request.method === 'POST') {
      return json({ port: 4173, pid: 81, supervisorId: 'preview-1', ownership: 'process_group' });
    }
    if (route.endsWith('/dev-server/logs')) {
      return json({ entries: [], nextCursor: 0, truncated: false, state: 'ready', failureId: null });
    }
    if (route.endsWith('/healthz')) return json({ ok: true, details: 'ready', devServer: null });
    if (route.endsWith('/attach')) return json({ workspace });
    if (route.endsWith('/terminate')) return json({ workspace: { ...workspace, status: 'terminated', terminatedAt: '2026-08-12T00:01:00.000Z' } });
    throw new Error(`unexpected route ${route}`);
  });
  const runtime = createSandboxWorkspaceRuntime({
    baseUrl: 'http://sandbox.test',
    serviceTokens,
    organizationId,
    projectId,
    workspaceId,
    runId,
    fetch: fetchMock,
    operationKey: () => operationKey,
  });
  return { runtime, requests, fetchMock };
}

describe('sandbox-backed WorkspaceRuntime', () => {
  it('maps the full workspace contract to tenant-scoped authenticated routes', async () => {
    const { runtime, requests } = fixture();

    await expect(runtime.exec({ cmd: 'node', args: ['app.js'], timeoutMs: 5_000 })).resolves.toEqual(execution);
    const chunks = [];
    for await (const chunk of runtime.execStream({
      providerWorkspaceId: workspaceId,
      command: 'node',
      args: ['app.js'],
      timeoutMs: 5_000,
    })) chunks.push(chunk);
    await expect(runtime.readFile('app.ts')).resolves.toEqual(new TextEncoder().encode('source'));
    await expect(runtime.readFileForUpdate('app.ts')).resolves.toEqual({
      data: new TextEncoder().encode('before'),
      revision: 'rev-1',
    });
    await runtime.writeFile('app.ts', new TextEncoder().encode('next'));
    await runtime.writeFilesAtomically([{ path: 'app.ts', data: new TextEncoder().encode('batch') }]);
    await expect(runtime.search({ pattern: 'app', path: '.' })).resolves.toEqual(execution);
    await expect(runtime.listFiles('.', { maxDepth: 2 })).resolves.toEqual([{ path: 'app.ts', type: 'file' }]);
    await expect(runtime.stat('app.ts')).resolves.toMatchObject({ path: 'app.ts', type: 'file', size: 6 });
    await runtime.delete('app.ts');
    await runtime.deleteFile('app.ts');
    await runtime.renameFile({ source: 'old.ts', destination: 'new.ts', overwrite: 'replace' });
    await expect(runtime.git({ operation: 'branch', args: ['--show-current'] })).resolves.toEqual({
      exitCode: 0,
      stdout: 'main\n',
      stderr: '',
    });
    const contract = {
      version: 1 as const,
      package_manager: 'pnpm' as const,
      workspace_root: '.',
      install: { command: 'pnpm install' },
      develop: { command: 'pnpm dev', port: 4173 },
    };
    await expect(runtime.startDevServer(contract)).resolves.toEqual({ port: 4173, pid: 81 });
    await expect(runtime.restartDevServer(contract)).resolves.toEqual({ port: 4173, pid: 81 });
    await expect(runtime.health()).resolves.toEqual({ ok: true, details: 'ready' });
    await expect(runtime.readDevServerLogs({ after: 0, limit: 10 })).resolves.toMatchObject({ state: 'ready' });
    await expect(runtime.attach()).resolves.toMatchObject({ id: workspaceId, status: 'ready' });
    await expect(runtime.terminate()).resolves.toMatchObject({ id: workspaceId, status: 'terminated' });

    expect(chunks).toEqual([{ stream: 'stdout', data: 'streamed', at: '2026-08-12T00:00:01.000Z' }]);
    const verifier = createServiceTokenSigner(serviceTokens);
    for (const request of requests) {
      expect(request.headers.get('x-zapp-organization-id')).toBe(organizationId);
      expect(request.headers.get('x-zapp-project-id')).toBe(projectId);
      expect(request.headers.get('x-zapp-run-id')).toBe(runId);
      expect(request.headers.get('x-zapp-task-id')).toBeNull();
      const token = request.headers.get('x-zapp-service-token');
      expect(token).not.toBeNull();
      const verdict = await verifier.verifyServiceToken(token ?? '', 'sandbox-service');
      expect(verdict).toMatchObject({
        ok: true,
        claims: { service: 'orchestrator-worker', audience: 'sandbox-service' },
      });
      expect(request.signal).toBeInstanceOf(AbortSignal);
    }
    const mutations = requests.filter((request) => !['GET', 'HEAD'].includes(request.method));
    expect(mutations.every((request) => request.headers.get('idempotency-key') === operationKey)).toBe(true);
  });

  it('rejects malformed success bodies and hides upstream response bodies', async () => {
    const malformed = createSandboxWorkspaceRuntime({
      baseUrl: 'http://sandbox.test', serviceTokens, organizationId, projectId, workspaceId,
      runId,
      fetch: () => Promise.resolve(json({ exitCode: 'zero' })),
    });
    await expect(malformed.exec({ cmd: 'true', args: [], timeoutMs: 1_000 })).rejects.toThrow();

    const failed = createSandboxWorkspaceRuntime({
      baseUrl: 'http://sandbox.test', serviceTokens, organizationId, projectId, workspaceId,
      runId,
      fetch: () => Promise.resolve(new Response('provider token=secret-value', { status: 502 })),
    });
    await expect(failed.health()).rejects.toEqual(
      new SandboxWorkspaceRequestError(502, 'Sandbox workspace request failed.'),
    );
    await expect(failed.health()).rejects.not.toThrow(/secret-value/u);
  });
});
