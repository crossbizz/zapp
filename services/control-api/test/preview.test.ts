import type { AddressInfo } from 'node:net';

import { newId } from '@zapp/contracts';
import type { PreviewShareRow, Project, Workspace } from '@zapp/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import type { AuthIdentity } from '../src/auth/port.js';
import {
  createSandboxPreviewProxy,
  createInMemoryPreviewSessionStore,
  createInMemoryPreviewShareStore,
  rewritePreviewOriginUrl,
  type PreviewProxyPort,
} from '../src/routes/preview.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness } from './support/harness.js';
import { EMPTY_WORKSPACE_USAGE, InMemoryTenantData } from './support/tenant-db.js';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (harness) => harness.app.close()));
});

const OWNER: AuthIdentity = {
  externalId: 'preview-owner',
  email: 'preview-owner@zapp.test',
  displayName: 'Preview Owner',
};

describe('WS-12 public preview shares', () => {
  it('recognizes a local preview host when the configured domain includes its port', () => {
    expect(
      rewritePreviewOriginUrl(
        '/dashboard',
        '01j00000000000000000000000-01h00000000000000000000000.preview.localhost:4000',
        'preview.localhost:4000',
      ),
    ).toBe('/__zapp_preview_data/dashboard');
  });

  it('creates and replays a secret-free share, exchanges and redeems it, proxies, then revokes', async () => {
    const data = new InMemoryTenantData();
    const shares = createInMemoryPreviewShareStore();
    const memorySessions = createInMemoryPreviewSessionStore();
    let publishRevocation:
      | ((record: { readonly organizationId: string; readonly shareId: string }) => void)
      | undefined;
    const sessions = {
      ...memorySessions,
      async revoke(organizationId: string, shareId: string) {
        await memorySessions.revoke(organizationId, shareId);
        publishRevocation?.({ organizationId, shareId });
      },
    };
    const proxiedBodies: Buffer[] = [];
    const request = vi.fn<PreviewProxyPort['request']>(async (input) => {
      for await (const chunk of input.body ?? []) proxiedBodies.push(Buffer.from(chunk));
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: (async function* () {
          await Promise.resolve();
          yield Buffer.from('preview-body');
        })(),
      };
    });
    const openWebSocket = vi.fn<PreviewProxyPort['openWebSocket']>((_input, socket) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          socket.send('hmr-ready');
        }, 10);
        socket.onClose(resolve);
      }),
    );
    const built = buildHarness({
      tenantDb: data.factory,
      preview: {
        shares,
        sessions,
        proxy: { request, openWebSocket },
        signingKey: Buffer.alloc(32, 0x31),
        keyVersion: 1,
        appBaseUrl: new URL('https://app.zapp.test'),
        previewBaseDomain: 'preview.zapp.test',
        recheckIntervalMs: 60_000,
        revocations: {
          subscribe(listener) {
            publishRevocation = listener;
            return () => {
              publishRevocation = undefined;
            };
          },
        },
      },
    });
    harnesses.push(built);
    const owner = await signIn(built, OWNER);
    const organization = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Preview Org' },
    });
    const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
    const project: Project = {
      id: newId('proj'),
      organizationId,
      name: 'Preview App',
      slug: 'preview-app',
      description: null,
      sourceType: 'prompt',
      supportLevel: 'compatible',
      createdBy: owner.userId,
      createdAt: built.now(),
      archivedAt: null,
    };
    const workspace: Workspace = {
      id: newId('ws'),
      organizationId,
      projectId: project.id,
      branchId: null,
      provider: 'modal',
      providerWorkspaceId: 'sb-private',
      status: 'ready',
      resourceProfile: 'standard',
      runId: null,
      taskId: null,
      purpose: null,
      environment: null,
      imageTag: null,
      previewMonitorEnabled: false,
      previewMonitorOwnerId: null,
      previewMonitorLeaseExpiresAt: null,
      snapshotRef: null,
      ...EMPTY_WORKSPACE_USAGE,
      createdAt: built.now(),
      lastActiveAt: built.now(),
      terminatedAt: null,
    };
    data.projects.push(project);
    data.workspaces.push(workspace);
    const otherWorkspace = { ...workspace, id: newId('ws') };
    data.workspaces.push(otherWorkspace);
    const headers = {
      ...owner.headers,
      [ORGANIZATION_HEADER]: organizationId,
      'idempotency-key': 'preview-share-create-01',
    };

    const created = await built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/preview/shares`,
      headers,
      payload: { policy: 'org', expiresInSeconds: 3_600 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const first = created.json<{
      share: { id: string; url: string; expiresAt: string; policy: string };
    }>().share;
    expect(first.url).toContain('#token=psb_');
    expect(first.url).not.toContain('modal');

    const replay = await built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/preview/shares`,
      headers,
      payload: { policy: 'org', expiresInSeconds: 3_600 },
    });
    expect(replay.json()).toEqual(created.json());
    expect(shares.rows).toHaveLength(1);
    expect((shares.rows[0] as PreviewShareRow).tokenHash).toMatch(/^\$argon2id\$/u);
    expect(JSON.stringify(shares.rows)).not.toContain('psb_');

    const conflictingReplay = await built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/preview/shares`,
      headers,
      payload: { policy: 'anyone_with_link', expiresInSeconds: 3_600 },
    });
    expect(conflictingReplay.statusCode, conflictingReplay.body).toBe(422);

    const crossWorkspaceReplay = await built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${otherWorkspace.id}/preview/shares`,
      headers,
      payload: { policy: 'org', expiresInSeconds: 3_600 },
    });
    expect(crossWorkspaceReplay.statusCode, crossWorkspaceReplay.body).toBe(422);

    const listed = await built.app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/preview/shares`,
      headers: { ...owner.headers, [ORGANIZATION_HEADER]: organizationId },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).not.toContain('token');
    expect(listed.body).not.toContain('argon');

    const bearer = new URL(first.url).hash.slice('#token='.length);
    const exchanged = await built.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/preview-shares/${first.id}/sessions`,
      headers: { ...owner.headers, 'idempotency-key': 'preview-exchange-01' },
      payload: { bearer },
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const exchange = exchanged.json<{ previewOrigin: string; grant: string; expiresAt: string }>();
    expect(exchange.previewOrigin).toMatch(/^https:\/\/[0-9a-z-]+\.preview\.zapp\.test$/u);
    expect(exchange.grant).toMatch(/^pbg_/u);

    const preflight = await built.app.inject({
      method: 'OPTIONS',
      url: '/v1/preview/session',
      headers: {
        host: new URL(exchange.previewOrigin).host,
        origin: 'https://app.zapp.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,idempotency-key',
      },
    });
    expect(preflight.statusCode, preflight.body).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://app.zapp.test');
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
    expect(preflight.headers['access-control-allow-headers']).toContain('idempotency-key');

    const exchangeReplay = await built.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/preview-shares/${first.id}/sessions`,
      headers: { ...owner.headers, 'idempotency-key': 'preview-exchange-01' },
      payload: { bearer },
    });
    expect(exchangeReplay.json()).toEqual(exchanged.json());

    const wrongOrigin = await built.app.inject({
      method: 'POST',
      url: '/v1/preview/session',
      headers: {
        host: new URL(exchange.previewOrigin).host,
        origin: 'https://attacker.invalid',
        'idempotency-key': 'preview-redeem-wrong-origin',
      },
      payload: { organizationId, shareId: first.id, grant: exchange.grant },
    });
    expect(wrongOrigin.statusCode, wrongOrigin.body).toBe(401);

    const redeemed = await built.app.inject({
      method: 'POST',
      url: '/v1/preview/session',
      headers: {
        host: new URL(exchange.previewOrigin).host,
        origin: 'https://app.zapp.test',
        'idempotency-key': 'preview-redeem-01',
      },
      payload: { organizationId, shareId: first.id, grant: exchange.grant },
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    expect(redeemed.headers['set-cookie']).toContain('__Host-zapp_preview=');
    expect(redeemed.headers['set-cookie']).toContain('SameSite=None');
    expect(redeemed.headers['set-cookie']).toContain('Partitioned');
    expect(redeemed.headers['set-cookie']).not.toContain('SameSite=Lax');
    expect(redeemed.headers['cache-control']).toBe('no-store');
    expect(redeemed.headers['access-control-allow-origin']).toBe('https://app.zapp.test');
    expect(redeemed.headers['access-control-allow-credentials']).toBe('true');

    const redeemedReplay = await built.app.inject({
      method: 'POST',
      url: '/v1/preview/session',
      headers: {
        host: new URL(exchange.previewOrigin).host,
        origin: 'https://app.zapp.test',
        'idempotency-key': 'preview-redeem-01',
      },
      payload: { organizationId, shareId: first.id, grant: exchange.grant },
    });
    expect(redeemedReplay.statusCode, redeemedReplay.body).toBe(200);
    expect(redeemedReplay.headers['set-cookie']).toBe(redeemed.headers['set-cookie']);

    const grantReuse = await built.app.inject({
      method: 'POST',
      url: '/v1/preview/session',
      headers: {
        host: new URL(exchange.previewOrigin).host,
        origin: 'https://app.zapp.test',
        'idempotency-key': 'preview-redeem-different-operation',
      },
      payload: { organizationId, shareId: first.id, grant: exchange.grant },
    });
    expect(grantReuse.statusCode, grantReuse.body).toBe(401);

    const cookie = String(redeemed.headers['set-cookie']).split(';', 1)[0];
    const proxied = await built.app.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { host: new URL(exchange.previewOrigin).host, cookie },
    });
    expect(proxied.statusCode, proxied.body).toBe(200);
    expect(proxied.body).toBe('preview-body');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, projectId: project.id, workspaceId: workspace.id }),
    );

    const collidingApplicationPath = await built.app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}`,
      headers: { host: new URL(exchange.previewOrigin).host, cookie },
    });
    expect(collidingApplicationPath.statusCode, collidingApplicationPath.body).toBe(200);
    expect(collidingApplicationPath.body).toBe('preview-body');
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: `/v1/projects/${project.id}` }),
    );

    const proxiedUpload = await built.app.inject({
      method: 'POST',
      url: '/upload',
      headers: {
        host: new URL(exchange.previewOrigin).host,
        cookie,
        authorization: 'Bearer application-token',
        origin: 'https://application.preview.test',
        range: 'bytes=0-9',
        'content-type': 'application/x-zapp-stream',
        'x-application-header': 'kept',
      },
      payload: Buffer.from('streamed-body'),
    });
    expect(proxiedUpload.statusCode, proxiedUpload.body).toBe(200);
    expect(Buffer.concat(proxiedBodies).toString('utf8')).toBe('streamed-body');
    const uploadCall = request.mock.calls.at(-1)?.[0];
    expect(uploadCall?.path).toBe('/upload');
    expect(uploadCall?.headers).toMatchObject({
      authorization: 'Bearer application-token',
      origin: 'https://application.preview.test',
      range: 'bytes=0-9',
      'x-application-header': 'kept',
    });

    const webSocket = await built.app.injectWS('/hmr', {
      headers: { host: new URL(exchange.previewOrigin).host, cookie },
    });
    await expect(
      new Promise<string>((resolve) => {
        webSocket.once('message', (data) => {
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : data;
          resolve(bytes.toString('utf8'));
        });
      }),
    ).resolves.toBe('hmr-ready');

    const revoked = await built.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspace.id}/preview/shares/${first.id}`,
      headers: {
        ...owner.headers,
        [ORGANIZATION_HEADER]: organizationId,
        'idempotency-key': 'preview-revoke-01',
      },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    await expect(
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('preview WebSocket stayed open'));
        }, 250);
        webSocket.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      }),
    ).resolves.toBeUndefined();
    expect(
      (
        await built.app.inject({
          method: 'GET',
          url: '/dashboard',
          headers: { host: new URL(exchange.previewOrigin).host, cookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('forwards application headers through the service bridge without forwarding zapp credentials', async () => {
    const bridgeOrganizationId = 'org_00000000000000000000000000';
    const bridgeProjectId = 'proj_00000000000000000000000000';
    const bridgeWorkspaceId = 'ws_00000000000000000000000000';
    const doFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const proxy = createSandboxPreviewProxy({
      baseUrl: 'https://sandbox.internal',
      serviceTokens: { secret: 's'.repeat(32) },
      fetch: doFetch,
    });
    await proxy.request({
      organizationId: bridgeOrganizationId,
      projectId: bridgeProjectId,
      workspaceId: bridgeWorkspaceId,
      method: 'GET',
      path: '/asset',
      publicOrigin: new URL('https://share.preview.zapp.test'),
      headers: {
        authorization: 'Bearer app-token',
        cookie: '__Host-zapp_preview=internal; app_session=kept',
        origin: 'https://app-origin.test',
        range: 'bytes=0-9',
        'sec-websocket-protocol': 'vite-hmr',
        'x-application-header': 'kept',
        'x-zapp-service-token': 'must-not-pass',
      },
      body: undefined,
      signal: new AbortController().signal,
    });

    expect(doFetch.mock.calls[0]?.[0]).toBe(
      'https://sandbox.internal/internal/workspaces/ws_00000000000000000000000000/preview/asset',
    );
    const headers = doFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).toMatchObject({
      authorization: 'Bearer app-token',
      origin: 'https://app-origin.test',
      range: 'bytes=0-9',
      'sec-websocket-protocol': 'vite-hmr',
      'x-application-header': 'kept',
      'x-zapp-preview-app-cookie': 'app_session=kept',
      'x-zapp-preview-public-origin': 'https://share.preview.zapp.test',
    });
    expect(headers['x-zapp-service-token']).not.toBe('must-not-pass');
  });

  it('negotiates the Vite HMR subprotocol through the sandbox WebSocket bridge', async () => {
    const negotiatedProtocols: string[][] = [];
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      handleProtocols(protocols) {
        negotiatedProtocols.push([...protocols]);
        return protocols.has('vite-hmr') ? 'vite-hmr' : false;
      },
    });
    await new Promise<void>((resolve) => {
      server.once('listening', resolve);
    });
    const address = server.address() as AddressInfo;
    server.once('connection', (socket) => {
      socket.send('hmr-ready');
      socket.close();
    });

    const messages: string[] = [];
    const proxy = createSandboxPreviewProxy({
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      serviceTokens: { secret: 's'.repeat(32) },
    });

    try {
      await expect(
        proxy.openWebSocket(
          {
            organizationId: 'org_00000000000000000000000000',
            projectId: 'proj_00000000000000000000000000',
            workspaceId: 'ws_00000000000000000000000000',
            path: '/',
            publicOrigin: new URL('https://share.preview.zapp.test'),
            headers: { 'sec-websocket-protocol': 'vite-hmr' },
            signal: new AbortController().signal,
          },
          {
            send(data) {
              messages.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
            },
            close() {},
            onMessage() {},
            onClose() {},
            onError() {},
          },
        ),
      ).resolves.toBeUndefined();
      expect(negotiatedProtocols).toEqual([['vite-hmr']]);
      expect(messages).toEqual(['hmr-ready']);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });
});
