import { request as httpRequest } from 'node:http';

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { describe, expect, it, vi } from 'vitest';

import {
  bridgePreviewWebSockets,
  createFetchPreviewTransport,
  createPreviewTransport,
  sanitizePreviewRequestHeaders,
  sanitizePreviewResponseHeaders,
  type PreviewSocket,
} from '../src/preview/transport.js';
import {
  createPreviewSecret,
  previewShareLocator,
  verifyPreviewSecret,
} from '../src/preview/tokens.js';
import { registerPreviewRoutes } from '../src/routes/preview.js';

const workspaceId = 'ws_00000000000000000000000000';
const organizationId = 'org_00000000000000000000000000';
const projectId = 'proj_00000000000000000000000000';

function previewRow() {
  return {
    id: workspaceId,
    organizationId,
    projectId,
    branchId: 'br_00000000000000000000000000',
    provider: 'modal' as const,
    providerWorkspaceId: 'sb-provider-private',
    status: 'ready' as const,
    resourceProfile: 'standard' as const,
    snapshotRef: null,
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
    lastActiveAt: null,
    terminatedAt: null,
  };
}

class FakePreviewSocket implements PreviewSocket {
  readonly sent: Array<string | Uint8Array> = [];
  closeCalls = 0;
  private messageHandlers: Array<(data: string | Uint8Array) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private errorHandlers: Array<() => void> = [];

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  onMessage(handler: (data: string | Uint8Array) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  onError(handler: () => void): void {
    this.errorHandlers.push(handler);
  }

  emitMessage(data: string | Uint8Array): void {
    for (const handler of this.messageHandlers) handler(data);
  }

  emitClose(): void {
    for (const handler of this.closeHandlers) handler();
  }

  emitError(): void {
    for (const handler of this.errorHandlers) handler();
  }
}

describe('WS-12 authenticated preview transport', () => {
  it('derives stable tenant-scoped locators and deterministic bearers while storing only Argon2id hashes', async () => {
    const signingKey = Buffer.alloc(32, 0x42);
    const operationKey = `op_${'a'.repeat(64)}`;
    const firstLocator = previewShareLocator({
      organizationId,
      workspaceId,
      operationKey,
      signingKey,
    });
    const replayLocator = previewShareLocator({
      organizationId,
      workspaceId,
      operationKey,
      signingKey,
    });
    const otherTenantLocator = previewShareLocator({
      organizationId: 'org_01H00000000000000000000001',
      workspaceId,
      operationKey,
      signingKey,
    });

    expect(firstLocator).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/u);
    expect(replayLocator).toBe(firstLocator);
    expect(otherTenantLocator).not.toBe(firstLocator);

    const secret = await createPreviewSecret({
      organizationId,
      shareLocator: firstLocator,
      keyVersion: 3,
      signingKey,
    });
    const replay = await createPreviewSecret({
      organizationId,
      shareLocator: firstLocator,
      keyVersion: 3,
      signingKey,
    });
    expect(secret.bearer).toBe(replay.bearer);
    expect(secret.hash).toMatch(/^\$argon2id\$/u);
    expect(secret.hash).not.toContain(secret.bearer);
    await expect(verifyPreviewSecret(secret.bearer, secret.hash)).resolves.toBe(true);
    await expect(verifyPreviewSecret(`${secret.bearer}x`, secret.hash)).resolves.toBe(false);
  });

  it('strips infrastructure credentials while preserving application headers and cookies', () => {
    expect(
      sanitizePreviewRequestHeaders(
        {
          authorization: 'Bearer application-token',
          connection: 'keep-alive',
          cookie: '__Host-zapp_session=browser-session',
          host: 'control.local',
          'x-zapp-organization-id': 'org_00000000000000000000000000',
          'x-zapp-preview-app-cookie': 'theme=dark; app_session=allowed',
          'x-zapp-service-token': 'service-token',
          accept: 'text/html',
          'x-application-header': 'allowed',
        },
        'theme=dark; app_session=allowed',
        new URL('https://share.preview.zapp.test'),
      ),
    ).toEqual({
      accept: 'text/html',
      authorization: 'Bearer application-token',
      cookie: 'theme=dark; app_session=allowed',
      'x-forwarded-host': 'share.preview.zapp.test',
      'x-forwarded-proto': 'https',
      'x-application-header': 'allowed',
    });

    expect(
      sanitizePreviewResponseHeaders(
        {
          connection: 'close',
          location: 'https://provider.invalid/next',
          'set-cookie': 'app_session=new; HttpOnly',
          'x-zapp-provider-url': 'https://provider.invalid',
          'content-type': 'text/plain',
        },
        new URL('https://provider.invalid'),
        new URL('https://share.preview.zapp.test'),
      ),
    ).toEqual({
      'content-type': 'text/plain',
      location: 'https://share.preview.zapp.test/next',
      'set-cookie': 'app_session=new; HttpOnly',
    });
  });

  it('allows an HTTP forwarded origin only for loopback development previews', () => {
    expect(
      sanitizePreviewRequestHeaders(
        { accept: 'text/html' },
        undefined,
        new URL('http://share.preview.localhost:4000'),
      ),
    ).toEqual({
      accept: 'text/html',
      'x-forwarded-host': 'share.preview.localhost:4000',
      'x-forwarded-proto': 'http',
    });
    expect(() =>
      sanitizePreviewRequestHeaders(
        { accept: 'text/html' },
        undefined,
        new URL('http://preview.example.com'),
      ),
    ).toThrow('Preview public origin must use HTTPS outside loopback development hosts');
  });

  it('streams the fixed tunnel response, never accepts an upstream, and cancels on abort', async () => {
    const cancel = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const request = vi.fn(() =>
      Promise.resolve({
        statusCode: 206,
        headers: { 'content-type': 'text/plain', 'x-zapp-secret': 'drop-me' },
        body: (async function* () {
          await Promise.resolve();
          yield Buffer.from('first-');
          yield Buffer.from('second');
        })(),
        cancel,
      }),
    );
    const resolve = vi.fn(() =>
      Promise.resolve({
        origin: new URL('https://modal-provider.invalid/'),
        request,
      }),
    );
    const transport = createPreviewTransport({ resolve });
    const abort = new AbortController();

    const response = await transport.request({
      providerWorkspaceId: 'sb-opaque',
      method: 'POST',
      path: '/nested/path?query=1',
      headers: {
        authorization: 'Bearer application-token',
        'x-zapp-service-token': 'internal',
        'x-app': 'preserved',
      },
      publicOrigin: new URL('https://share.preview.zapp.test'),
      applicationCookie: 'app_session=value',
      body: (async function* () {
        await Promise.resolve();
        yield Buffer.from('request-body');
      })(),
      signal: abort.signal,
    });

    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toBe('first-second');
    expect(response).not.toHaveProperty('origin');
    expect(response.headers).toEqual({ 'content-type': 'text/plain' });
    expect(resolve).toHaveBeenCalledWith('sb-opaque');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/nested/path?query=1',
        headers: {
          authorization: 'Bearer application-token',
          cookie: 'app_session=value',
          'x-app': 'preserved',
          'x-forwarded-host': 'share.preview.zapp.test',
          'x-forwarded-proto': 'https',
        },
      }),
    );

    abort.abort();
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledOnce();
    });
  });

  it('allows an HTTP tunnel only on loopback for local Docker previews', async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: (async function* () {
          await Promise.resolve();
          yield Buffer.from('local-preview');
        })(),
        cancel: () => Promise.resolve(),
      }),
    );
    const localTransport = createPreviewTransport({
      resolve: () => Promise.resolve({ origin: new URL('http://127.0.0.1:32777'), request }),
    });

    const localResponse = await localTransport.request({
      providerWorkspaceId: 'sb-local',
      method: 'GET',
      path: '/',
      publicOrigin: new URL('http://127.0.0.1:3000'),
      headers: {},
    });
    const chunks: Buffer[] = [];
    for await (const chunk of localResponse.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toBe('local-preview');

    const remoteTransport = createPreviewTransport({
      resolve: () =>
        Promise.resolve({ origin: new URL('http://preview.example.com'), request }),
    });
    await expect(
      remoteTransport.request({
        providerWorkspaceId: 'sb-remote',
        method: 'GET',
        path: '/',
        publicOrigin: new URL('https://share.preview.zapp.test'),
        headers: {},
      }),
    ).rejects.toThrow('Preview tunnel must use encrypted transport outside loopback development');
  });

  it('rejects protocol-relative paths before resolving a tunnel', async () => {
    const resolve = vi.fn();
    const transport = createPreviewTransport({ resolve });

    await expect(
      transport.request({
        providerWorkspaceId: 'sb-opaque',
        method: 'GET',
        path: '//attacker.invalid/',
        publicOrigin: new URL('https://share.preview.zapp.test'),
        headers: {},
      }),
    ).rejects.toThrow('Preview path must be origin-relative');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves the workspace in tenant scope and streams without exposing provider identity', async () => {
    const get = vi.fn(() => Promise.resolve(previewRow()));
    const request = vi.fn(() =>
      Promise.resolve({
        statusCode: 201,
        headers: { 'content-type': 'text/plain', 'set-cookie': 'app=value; HttpOnly' },
        body: (async function* () {
          await Promise.resolve();
          yield Buffer.from('stream-');
          yield Buffer.from('body');
        })(),
        cancel: () => Promise.resolve(),
      }),
    );
    const app = Fastify({ logger: false });
    app.decorate('requireService', () => Promise.resolve());
    registerPreviewRoutes(app, {
      rows: { get },
      transport: { request, openWebSocket: vi.fn() },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/internal/workspaces/${workspaceId}/preview/assets/app.js?version=1`,
      headers: {
        'x-zapp-service-token': 'internal',
        'x-zapp-organization-id': organizationId,
        'x-zapp-project-id': projectId,
        'x-zapp-preview-public-origin': 'https://share.preview.zapp.test',
        'x-zapp-preview-app-cookie': 'app=value',
        'x-app': 'kept',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toBe('stream-body');
    expect(response.headers['set-cookie']).toBe('app=value; HttpOnly');
    expect(response.body).not.toContain('sb-provider-private');
    expect(get).toHaveBeenCalledWith(workspaceId, organizationId, projectId);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        providerWorkspaceId: 'sb-provider-private',
        path: '/assets/app.js?version=1',
        applicationCookie: 'app=value',
      }),
    );

    const localResponse = await app.inject({
      method: 'GET',
      url: `/internal/workspaces/${workspaceId}/preview/`,
      headers: {
        'x-zapp-service-token': 'internal',
        'x-zapp-organization-id': organizationId,
        'x-zapp-project-id': projectId,
        'x-zapp-preview-public-origin': 'http://share.preview.localhost:4000',
      },
    });
    expect(localResponse.statusCode, localResponse.body).toBe(201);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        publicOrigin: new URL('http://share.preview.localhost:4000'),
      }),
    );
    await app.close();
  });

  it('forwards an unknown-content-type request before the client finishes streaming it', async () => {
    let observedFirstChunk!: () => void;
    const firstChunkObserved = new Promise<void>((resolve) => {
      observedFirstChunk = resolve;
    });
    const request = vi.fn(async (input: { readonly body?: AsyncIterable<Uint8Array> }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body ?? []) {
        chunks.push(Buffer.from(chunk));
        if (chunks.length === 1) observedFirstChunk();
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: (async function* () {
          await Promise.resolve();
          yield Buffer.from(Buffer.concat(chunks).toString('utf8'));
        })(),
        cancel: () => Promise.resolve(),
      };
    });
    const app = Fastify({ logger: false });
    app.decorate('requireService', () => Promise.resolve());
    registerPreviewRoutes(app, {
      rows: { get: () => Promise.resolve(previewRow()) },
      transport: { request, openWebSocket: vi.fn() },
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const responseBody = new Promise<string>((resolve, reject) => {
      const outgoing = httpRequest(
        `${address}/internal/workspaces/${workspaceId}/preview/upload`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-zapp-stream',
            'x-zapp-organization-id': organizationId,
            'x-zapp-project-id': projectId,
            'x-zapp-preview-public-origin': 'https://share.preview.zapp.test',
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.write('first-');
      void Promise.race([
        firstChunkObserved,
        new Promise<never>((_resolve, rejectTimeout) => {
          setTimeout(() => {
            rejectTimeout(new Error('request body was buffered'));
          }, 250);
        }),
      ])
        .then(() => {
          outgoing.end('second');
        })
        .catch(reject);
    });

    await expect(responseBody).resolves.toBe('first-second');
    expect(request).toHaveBeenCalledOnce();
    await app.close();
  });

  it('keeps downstream abort propagation installed until the response stream finishes', async () => {
    let observedAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      observedAbort = resolve;
    });
    const request = vi.fn((input: { readonly signal?: AbortSignal }) => {
      input.signal?.addEventListener('abort', observedAbort, { once: true });
      return Promise.resolve({
        statusCode: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: (async function* () {
          yield Buffer.from('first');
          await aborted;
        })(),
        cancel: () => Promise.resolve(),
      });
    });
    const app = Fastify({ logger: false });
    app.decorate('requireService', () => Promise.resolve());
    registerPreviewRoutes(app, {
      rows: { get: () => Promise.resolve(previewRow()) },
      transport: { request, openWebSocket: vi.fn() },
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(
        `${address}/internal/workspaces/${workspaceId}/preview/large.bin`,
        {
          headers: {
            'x-zapp-organization-id': organizationId,
            'x-zapp-project-id': projectId,
            'x-zapp-preview-public-origin': 'https://share.preview.zapp.test',
          },
        },
        (response) => {
          response.once('data', () => {
            response.destroy();
          });
          response.once('close', resolve);
        },
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
    await aborted;
    await app.close();
  });

  it('keeps serving previews after a client disconnect aborts an active fetch stream', async () => {
    let observedAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      observedAbort = resolve;
    });
    let fetchCount = 0;
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      if (fetchCount > 1) {
        return Promise.resolve(new Response('service-alive', { status: 200 }));
      }
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('first'));
          signal?.addEventListener(
            'abort',
            () => {
              observedAbort();
              controller.error(signal.reason);
            },
            { once: true },
          );
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const transport = createFetchPreviewTransport(
      { resolvePreviewTunnel: () => Promise.resolve(new URL('https://provider.invalid')) },
      fetchImplementation,
    );
    const app = Fastify({ logger: false });
    app.decorate('requireService', () => Promise.resolve());
    registerPreviewRoutes(app, {
      rows: { get: () => Promise.resolve(previewRow()) },
      transport,
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(
        `${address}/internal/workspaces/${workspaceId}/preview/stream`,
        {
          headers: {
            'x-zapp-organization-id': organizationId,
            'x-zapp-project-id': projectId,
            'x-zapp-preview-public-origin': 'https://share.preview.zapp.test',
          },
        },
        (response) => {
          response.once('data', () => response.destroy());
          response.once('close', resolve);
        },
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
    await aborted;

    const nextResponse = await app.inject({
      method: 'GET',
      url: `/internal/workspaces/${workspaceId}/preview/health`,
      headers: {
        'x-zapp-organization-id': organizationId,
        'x-zapp-project-id': projectId,
        'x-zapp-preview-public-origin': 'https://share.preview.zapp.test',
      },
    });
    expect(nextResponse.statusCode).toBe(200);
    expect(nextResponse.body).toBe('service-alive');
    await app.close();
  });

  it('returns the same 404 for a cross-tenant or terminated workspace before transport access', async () => {
    const request = vi.fn();
    const rows = [undefined, { ...previewRow(), status: 'terminated' as const }];
    const app = Fastify({ logger: false });
    app.decorate('requireService', () => Promise.resolve());
    registerPreviewRoutes(app, {
      rows: { get: vi.fn(() => Promise.resolve(rows.shift())) },
      transport: { request, openWebSocket: vi.fn() },
    });

    for (const currentOrganizationId of [
      'org_11111111111111111111111111',
      organizationId,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `/internal/workspaces/${workspaceId}/preview/`,
        headers: {
          'x-zapp-organization-id': currentOrganizationId,
          'x-zapp-project-id': projectId,
          'x-zapp-preview-public-origin': 'https://share.preview.zapp.test',
        },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: 'workspace_not_found',
        message: 'Workspace was not found.',
      });
    }
    expect(request).not.toHaveBeenCalled();
    await app.close();
  });

  it('bridges WebSocket frames and closes both sides on either terminal signal', () => {
    const downstream = new FakePreviewSocket();
    const upstream = new FakePreviewSocket();

    bridgePreviewWebSockets(downstream, upstream);
    downstream.emitMessage('browser-to-app');
    upstream.emitMessage(Buffer.from('app-to-browser'));
    expect(upstream.sent).toEqual(['browser-to-app']);
    expect(downstream.sent).toEqual([Buffer.from('app-to-browser')]);

    upstream.emitError();
    expect(upstream.closeCalls).toBe(1);
    expect(downstream.closeCalls).toBe(1);
    downstream.emitClose();
    expect(upstream.closeCalls).toBe(1);
    expect(downstream.closeCalls).toBe(1);
  });

  it('upgrades only after tenant resolution and never sends a provider origin', async () => {
    const openWebSocket = vi.fn((_input, downstream: PreviewSocket) => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          downstream.send('preview-ready');
          resolve();
        }, 10);
      });
    });
    const app = Fastify({ logger: false });
    app.decorate('requireService', () => Promise.resolve());
    void app.register(websocket);
    void app.register((previewApp, _options, done) => {
      registerPreviewRoutes(previewApp, {
        rows: { get: () => Promise.resolve(previewRow()) },
        transport: { request: vi.fn(), openWebSocket },
      });
      done();
    });
    await app.ready();

    const client = await app.injectWS(
      `/internal/workspaces/${workspaceId}/preview/socket?channel=hmr`,
      {
        headers: {
          'x-zapp-organization-id': organizationId,
          'x-zapp-project-id': projectId,
          'x-zapp-preview-public-origin': 'https://share.preview.zapp.test',
        },
      },
    );
    const message = await new Promise<string>((resolve) => {
      client.once('message', (data) => {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        resolve(bytes.toString('utf8'));
      });
    });
    expect(message).toBe('preview-ready');
    expect(openWebSocket).toHaveBeenCalledWith(
      expect.objectContaining({
        providerWorkspaceId: 'sb-provider-private',
        path: '/socket?channel=hmr',
      }),
      expect.anything(),
    );
    expect(JSON.stringify(openWebSocket.mock.calls)).not.toContain('preview.modal');
    client.close();
    await app.close();
  });
});
