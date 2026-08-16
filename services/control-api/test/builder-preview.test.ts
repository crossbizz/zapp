import { afterEach, describe, expect, it } from 'vitest';

import { newId } from '@zapp/contracts';
import type { AgentRun, Project, Workspace } from '@zapp/db';

import type { AuthIdentity } from '../src/auth/port.js';
import type { AuditExecutor, InMemoryAuditSink } from '../src/plugins/audit.js';
import type { AuditRecord } from '@zapp/contracts';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import type { BuilderPreviewSandboxPort } from '../src/sandbox/port.js';
import type { BuilderArtifactPort } from '../src/routes/builder-artifacts.js';
import type { BuilderPreviewScreenshotStore } from '../src/routes/builder-preview.js';
import type { PreviewProxyPort, PreviewProxyResponse } from '../src/routes/preview.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';
import { EMPTY_WORKSPACE_USAGE, InMemoryTenantData } from './support/tenant-db.js';

const OWNER: AuthIdentity = {
  externalId: 'builder-preview-owner',
  email: 'owner@builder-preview.test',
  displayName: 'Pria Preview',
};

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async (harness) => {
      await harness.app.close();
    }),
  );
});

class PreviewSandbox implements BuilderPreviewSandboxPort {
  readonly logReads: Parameters<BuilderPreviewSandboxPort['readDevServerLogs']>[0][] = [];
  readonly restarts: Parameters<BuilderPreviewSandboxPort['restartDevServer']>[0][] = [];

  readDevServerLogs(input: Parameters<BuilderPreviewSandboxPort['readDevServerLogs']>[0]) {
    this.logReads.push(input);
    return Promise.resolve({
      entries: [
        {
          cursor: 8,
          at: '2026-08-10T20:00:00.000Z',
          stream: 'stderr' as const,
          message: 'ready on port 3000',
        },
      ],
      nextCursor: 8,
      truncated: false,
      state: 'ready' as const,
      failureId: null,
    });
  }

  restartDevServer(input: Parameters<BuilderPreviewSandboxPort['restartDevServer']>[0]) {
    this.restarts.push(input);
    return Promise.resolve({
      port: 3000,
      pid: 42,
      supervisorId: 'supervisor-preview',
      ownership: 'process_group' as const,
    });
  }
}

function viteArtifacts(source: ReadonlyMap<string, string>): BuilderArtifactPort {
  return {
    listFiles: () =>
      Promise.resolve({
        entries: [...source.keys()].map((path) => ({ path, type: 'file' as const })),
        truncated: false,
      }),
    readFile: ({ path }) => {
      const body = source.get(path);
      if (body === undefined) return Promise.reject(new Error('file not found'));
      const bytes = Buffer.from(body);
      return Promise.resolve({
        path,
        dataBase64: bytes.toString('base64'),
        byteSize: bytes.length,
        compareToken: 'a'.repeat(64),
      });
    },
    editFile: () => Promise.reject(new Error('not used')),
    compareCommits: () => Promise.reject(new Error('not used')),
    listTests: () => Promise.reject(new Error('not used')),
    signEvidence: () => Promise.reject(new Error('not used')),
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

class PreviewCaptureProxy implements PreviewProxyPort {
  readonly requests: Parameters<PreviewProxyPort['request']>[0][] = [];
  holdEventsOpen = false;
  screenshotFailsAfterStart = false;
  screenshotStatus = 200;

  request(input: Parameters<PreviewProxyPort['request']>[0]): Promise<PreviewProxyResponse> {
    this.requests.push(input);
    if (input.path === '/__zapp/screenshot') {
      if (this.screenshotFailsAfterStart) {
        return Promise.reject(new Error('ambiguous screenshot transport failure'));
      }
      return Promise.resolve({
        statusCode: this.screenshotStatus,
        headers:
          this.screenshotStatus === 200
            ? {
                'content-type': 'image/png',
                'content-length': String(PNG.length),
                'x-zapp-service-token': 'must-not-leak',
              }
            : { 'x-zapp-service-token': 'must-not-leak' },
        body: bytes(this.screenshotStatus === 200 ? PNG : Buffer.alloc(0)),
      });
    }
    const capture = {
      type: 'network',
      payload: {
        durationMs: 12,
        method: 'GET',
        status: 500,
        transport: 'fetch',
        url: 'https://preview.zapp.test/api/fail',
      },
    };
    return Promise.resolve({
      statusCode: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-zapp-service-token': 'must-not-leak',
      },
      body: this.holdEventsOpen
        ? heldBytes(Buffer.from(`data: ${JSON.stringify(capture)}\n\n`), input.signal)
        : bytes(Buffer.from(`data: ${JSON.stringify(capture)}\n\n`)),
    });
  }

  openWebSocket(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
}

class MemoryScreenshotStore implements BuilderPreviewScreenshotStore {
  readonly objects = new Map<
    string,
    { state: 'pending' } | { state: 'completed'; body: Buffer; capturedAt: Date }
  >();

  reserve(key: string) {
    const existing = this.objects.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    this.objects.set(key, { state: 'pending' });
    return Promise.resolve({ state: 'acquired' as const });
  }

  complete(key: string, body: Buffer, capturedAt: Date): Promise<void> {
    this.objects.set(key, { state: 'completed', body, capturedAt });
    return Promise.resolve();
  }

  release(key: string): Promise<void> {
    if (this.objects.get(key)?.state === 'pending') this.objects.delete(key);
    return Promise.resolve();
  }
}

class FailFirstScreenshotCompletionAudit implements InMemoryAuditSink {
  readonly events: AuditRecord[] = [];
  private failCompletion = true;
  private readonly detachedKeys = new Set<string>();

  record(_tx: AuditExecutor, event: AuditRecord): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  recordDetached(event: AuditRecord): Promise<void> {
    if (
      this.failCompletion &&
      event.action === 'workspace.previewed' &&
      event.metadata.operation === 'screenshot'
    ) {
      this.failCompletion = false;
      return Promise.reject(new Error('transient completion audit failure'));
    }
    this.events.push(event);
    return Promise.resolve();
  }

  async recordDetachedOnce(key: string, event: AuditRecord): Promise<void> {
    if (this.detachedKeys.has(key)) return;
    await this.recordDetached(event);
    this.detachedKeys.add(key);
  }
}

async function* bytes(body: Buffer): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  if (body.length > 0) yield body;
}

async function* heldBytes(body: Buffer, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  yield body;
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

interface Wired {
  readonly asOwner: Record<string, string>;
  readonly data: InMemoryTenantData;
  readonly harness: Harness;
  readonly owner: TestSession;
  readonly proxy: PreviewCaptureProxy;
  readonly sandbox: PreviewSandbox;
  readonly screenshotStore: MemoryScreenshotStore;
  readonly organizationId: string;
}

async function wire(
  options: {
    readonly recheckIntervalMs?: number;
    readonly audit?: InMemoryAuditSink;
    readonly builderArtifacts?: BuilderArtifactPort;
  } = {},
): Promise<Wired> {
  const data = new InMemoryTenantData();
  const sandbox = new PreviewSandbox();
  const proxy = new PreviewCaptureProxy();
  const screenshotStore = new MemoryScreenshotStore();
  const harness = buildHarness({
    tenantDb: data.factory,
    builderPreviewSandbox: sandbox,
    builderPreviewProxy: proxy,
    builderPreviewScreenshotStore: screenshotStore,
    ...(options.builderArtifacts === undefined
      ? {}
      : { builderArtifacts: options.builderArtifacts }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.recheckIntervalMs === undefined
      ? {}
      : { builderPreviewRecheckIntervalMs: options.recheckIntervalMs }),
  });
  harnesses.push(harness);
  const owner = await signIn(harness, OWNER);
  const organization = await harness.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Preview Builders' },
  });
  expect(organization.statusCode, organization.body).toBe(201);
  const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
  return {
    asOwner: { ...owner.headers, [ORGANIZATION_HEADER]: organizationId },
    data,
    harness,
    owner,
    proxy,
    sandbox,
    screenshotStore,
    organizationId,
  };
}

async function seedWorkspace(wired: Wired): Promise<{ project: Project; workspace: Workspace }> {
  const projectResponse = await wired.harness.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: wired.asOwner,
    payload: { name: 'Preview target' },
  });
  expect(projectResponse.statusCode, projectResponse.body).toBe(201);
  const projectId = projectResponse.json<{ project: { id: string } }>().project.id;
  const project = wired.data.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) throw new Error('seed project missing');
  const workspace: Workspace = {
    id: newId('ws'),
    organizationId: project.organizationId,
    projectId,
    branchId: wired.data.branches.find((branch) => branch.projectId === projectId)?.id ?? null,
    provider: 'modal',
    providerWorkspaceId: 'provider-preview-target',
    status: 'active',
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
    createdAt: new Date('2026-08-10T19:00:00.000Z'),
    lastActiveAt: new Date('2026-08-10T20:00:00.000Z'),
    terminatedAt: null,
  };
  wired.data.workspaces.push(workspace);
  wired.data.addContract(project, {
    contractJson: {
      version: 1,
      package_manager: 'pnpm',
      workspace_root: '.',
      install: { command: 'pnpm install --frozen-lockfile' },
      develop: { command: 'pnpm run dev', port: 3000 },
    },
  });
  return { project, workspace };
}

describe('public builder preview bridge', () => {
  it('forwards a bounded log cursor only after resolving the tenant workspace', async () => {
    const wired = await wire();
    const { workspace } = await seedWorkspace(wired);

    const response = await wired.harness.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspace.id}/dev-server/logs?after=7&limit=25`,
      headers: wired.asOwner,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      entries: [
        {
          cursor: 8,
          at: '2026-08-10T20:00:00.000Z',
          stream: 'stderr',
          message: 'ready on port 3000',
        },
      ],
      nextCursor: 8,
      truncated: false,
      state: 'ready',
      failureId: null,
    });
    expect(wired.sandbox.logReads).toHaveLength(1);
    expect(wired.sandbox.logReads[0]).toMatchObject({
      after: 7,
      limit: 25,
      workspace: { id: workspace.id },
    });

    const foreignWorkspace: Workspace = {
      ...workspace,
      id: newId('ws'),
      organizationId: newId('org'),
      projectId: newId('proj'),
      providerWorkspaceId: 'provider-foreign',
    };
    wired.data.workspaces.push(foreignWorkspace);
    const foreign = await wired.harness.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${foreignWorkspace.id}/dev-server/logs`,
      headers: wired.asOwner,
    });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(wired.sandbox.logReads).toHaveLength(1);
  });

  it('restarts with the server-stored execution contract and the request idempotency key', async () => {
    const wired = await wire();
    const { workspace } = await seedWorkspace(wired);

    const response = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/dev-server/restart`,
      headers: { ...wired.asOwner, 'idempotency-key': 'builder-preview-restart-01' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      port: 3000,
      pid: 42,
      supervisorId: 'supervisor-preview',
      ownership: 'process_group',
    });
    expect(wired.sandbox.restarts).toHaveLength(1);
    expect(wired.sandbox.restarts[0]?.operationKey).toMatch(/^op_[a-f0-9]{64}$/u);
    expect(wired.sandbox.restarts[0]?.workspace.id).toBe(workspace.id);
    expect(wired.sandbox.restarts[0]?.contract.develop).toEqual({
      command: 'pnpm run dev',
      port: 3000,
    });
    expect(
      wired.harness.audit.events
        .filter((event) => event.metadata.operation === 'restart')
        .map((event) => event.action),
    ).toEqual(['workspace.preview_requested', 'workspace.previewed']);

    const replay = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/dev-server/restart`,
      headers: { ...wired.asOwner, 'idempotency-key': 'builder-preview-restart-01' },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(wired.sandbox.restarts).toHaveLength(1);
    expect(
      wired.harness.audit.events.filter((event) => event.metadata.operation === 'restart'),
    ).toHaveLength(2);
  });

  it('refreshes a stale stored execution contract from the current workspace source', async () => {
    const source = new Map<string, string>([
      [
        'package.json',
        JSON.stringify({
          name: 'migrated-vite-app',
          private: true,
          scripts: { dev: 'vite --port 3000', build: 'vite build' },
          dependencies: { vite: '^5.4.0', typescript: '^5.6.0' },
        }),
      ],
      ['pnpm-lock.yaml', 'lockfileVersion: 9.0'],
      ['index.html', '<main id="app"></main>'],
      ['src/main.ts', "document.querySelector('#app')!.textContent = 'Migrated';"],
    ]);
    const wired = await wire({ builderArtifacts: viteArtifacts(source) });
    const { workspace } = await seedWorkspace(wired);
    Object.assign(wired.data.contracts[0]?.contractJson ?? {}, {
      package_manager: 'npm',
      install: { command: 'npm install' },
      develop: { command: 'npm run dev', port: 3000 },
    });

    const response = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/dev-server/restart`,
      headers: { ...wired.asOwner, 'idempotency-key': 'builder-preview-refresh-contract-01' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(wired.sandbox.restarts[0]?.contract).toMatchObject({
      package_manager: 'pnpm',
      install: { command: 'pnpm install --frozen-lockfile' },
      develop: { command: 'pnpm run dev', port: 3000 },
    });
  });

  it('attributes a recovered workspace restart to the latest durable project run', async () => {
    const wired = await wire();
    const { project, workspace } = await seedWorkspace(wired);
    const run: AgentRun = {
      id: newId('run'),
      organizationId: wired.organizationId,
      projectId: project.id,
      conversationId: newId('conv'),
      conversationRunNumber: 1,
      branchId: workspace.branchId,
      mode: 'build',
      appType: 'web',
      model: null,
      requestFingerprint: 'recovered-preview-run',
      status: 'completed',
      specificationId: null,
      temporalWorkflowId: 'recovered-preview-workflow',
      startedBy: wired.owner.userId,
      budgetJson: null,
      planMaxCredits: '1000.0000',
      startedAt: new Date('2026-08-10T21:00:00.000Z'),
      completedAt: new Date('2026-08-10T21:05:00.000Z'),
    };
    wired.data.runs.push(run);
    Object.assign(workspace, {
      runId: newId('run'),
      taskId: newId('task'),
      purpose: 'builder',
      environment: 'zapp-dev',
      imageTag: 'zapp-builder:test',
    });

    const response = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/dev-server/restart`,
      headers: { ...wired.asOwner, 'idempotency-key': 'builder-preview-recovered-run-01' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(wired.sandbox.restarts[0]?.workspace.runId).toBe(run.id);
  });

  it('refuses restart when no validated project contract exists', async () => {
    const wired = await wire();
    const { workspace } = await seedWorkspace(wired);
    wired.data.contracts.length = 0;

    const response = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/dev-server/restart`,
      headers: { ...wired.asOwner, 'idempotency-key': 'builder-preview-missing-contract-01' },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'project_contract_unavailable',
    );
    expect(wired.sandbox.restarts).toEqual([]);
  });

  it('derives a missing preview contract from the recovered workspace source', async () => {
    const source = new Map<string, string>([
      [
        'package.json',
        JSON.stringify({
          name: 'recovered-vite-app',
          private: true,
          scripts: { dev: 'vite --port 3000', build: 'vite build' },
          dependencies: { vite: '^5.4.0', typescript: '^5.6.0' },
        }),
      ],
      ['pnpm-lock.yaml', 'lockfileVersion: 9.0'],
      ['index.html', '<main id="app"></main>'],
      ['src/main.ts', "document.querySelector('#app')!.textContent = 'Recovered';"],
    ]);
    const wired = await wire({ builderArtifacts: viteArtifacts(source) });
    const { workspace } = await seedWorkspace(wired);
    wired.data.contracts.length = 0;

    const response = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/dev-server/restart`,
      headers: { ...wired.asOwner, 'idempotency-key': 'builder-preview-derived-contract-01' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(wired.sandbox.restarts[0]?.contract).toMatchObject({
      package_manager: 'pnpm',
      develop: { command: 'pnpm run dev', port: 3000 },
    });
  });

  it('streams validated capture records without exposing upstream credentials', async () => {
    const wired = await wire();
    const { workspace } = await seedWorkspace(wired);

    const response = await wired.harness.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspace.id}/preview/events`,
      headers: { ...wired.asOwner, accept: 'text/event-stream' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers).not.toHaveProperty('x-zapp-service-token');
    expect(response.body).toContain('"type":"network"');
    expect(response.body).not.toContain('must-not-leak');
    expect(wired.proxy.requests).toEqual([
      expect.objectContaining({
        workspaceId: workspace.id,
        organizationId: workspace.organizationId,
        projectId: workspace.projectId,
        method: 'GET',
        path: '/__zapp/events',
      }),
    ]);

    const foreign = await wired.harness.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${newId('ws')}/preview/events`,
      headers: { ...wired.asOwner, accept: 'text/event-stream' },
    });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(wired.proxy.requests).toHaveLength(1);
  });

  it('preserves screenshot bytes and the structural 501 without forwarding headers', async () => {
    const wired = await wire();
    const { workspace } = await seedWorkspace(wired);
    const headers = {
      ...wired.asOwner,
      'idempotency-key': 'builder-preview-screenshot-01',
      'x-zapp-service-token': 'browser-spoof',
    };

    const screenshot = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/preview/screenshot`,
      headers,
    });

    expect(screenshot.statusCode, screenshot.body).toBe(200);
    expect(screenshot.headers['content-type']).toBe('image/png');
    expect(screenshot.rawPayload).toEqual(PNG);
    expect(screenshot.headers).not.toHaveProperty('x-zapp-service-token');
    expect(wired.proxy.requests[0]?.method).toBe('POST');
    expect(wired.proxy.requests[0]?.path).toBe('/__zapp/screenshot');
    expect(wired.proxy.requests[0]?.headers).not.toHaveProperty('authorization');
    expect(wired.proxy.requests[0]?.headers).not.toHaveProperty('cookie');
    expect(wired.proxy.requests[0]?.headers).not.toHaveProperty('x-zapp-service-token');

    const replay = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/preview/screenshot`,
      headers,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.rawPayload).toEqual(PNG);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(
      wired.proxy.requests.filter((request) => request.path === '/__zapp/screenshot'),
    ).toHaveLength(1);
    expect(
      wired.harness.audit.events
        .filter((event) => event.metadata.operation === 'screenshot')
        .map((event) => event.action),
    ).toEqual(['workspace.preview_requested', 'workspace.previewed']);

    wired.proxy.screenshotStatus = 501;
    const unavailable = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/preview/screenshot`,
      headers: { ...wired.asOwner, 'idempotency-key': 'builder-preview-screenshot-02' },
    });
    expect(unavailable.statusCode, unavailable.body).toBe(501);
    expect(unavailable.rawPayload).toEqual(Buffer.alloc(0));
    expect(unavailable.headers).not.toHaveProperty('x-zapp-service-token');

    wired.proxy.screenshotStatus = 200;
    const afterExplicitFailure = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/preview/screenshot`,
      headers: { ...wired.asOwner, 'idempotency-key': 'builder-preview-screenshot-02' },
    });
    expect(afterExplicitFailure.statusCode, afterExplicitFailure.body).toBe(200);
    expect(afterExplicitFailure.rawPayload).toEqual(PNG);

    wired.proxy.screenshotStatus = 503;
    const failed = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/preview/screenshot`,
      headers: { ...wired.asOwner, 'idempotency-key': 'builder-preview-screenshot-03' },
    });
    expect(failed.statusCode, failed.body).toBe(503);
    expect(failed.rawPayload).toEqual(Buffer.alloc(0));
  });

  it('cancels the upstream capture stream when the browser disconnects', async () => {
    const wired = await wire();
    const { workspace } = await seedWorkspace(wired);
    wired.proxy.holdEventsOpen = true;
    const address = await wired.harness.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();

    const response = await fetch(`${address}/v1/workspaces/${workspace.id}/preview/events`, {
      headers: { ...wired.asOwner, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    controller.abort();

    await expect.poll(() => wired.proxy.requests[0]?.signal.aborted).toBe(true);
  });

  it('fails closed without recapturing an ambiguously failed screenshot operation', async () => {
    const wired = await wire();
    const { workspace } = await seedWorkspace(wired);
    wired.proxy.screenshotFailsAfterStart = true;
    const request = {
      method: 'POST' as const,
      url: `/v1/workspaces/${workspace.id}/preview/screenshot`,
      headers: { ...wired.asOwner, 'idempotency-key': 'builder-preview-ambiguous-01' },
    };

    const first = await wired.harness.app.inject(request);
    expect(first.statusCode, first.body).toBe(502);
    const retry = await wired.harness.app.inject(request);
    expect(retry.statusCode, retry.body).toBe(409);
    expect(retry.json<{ error: { code: string } }>().error.code).toBe('idempotency_in_progress');
    expect(
      wired.proxy.requests.filter((candidate) => candidate.path === '/__zapp/screenshot'),
    ).toHaveLength(1);
  });

  it('retries a failed completion audit from the durable screenshot replay without lying', async () => {
    const audit = new FailFirstScreenshotCompletionAudit();
    const wired = await wire({ audit });
    const { workspace } = await seedWorkspace(wired);
    const request = {
      method: 'POST' as const,
      url: `/v1/workspaces/${workspace.id}/preview/screenshot`,
      headers: { ...wired.asOwner, 'idempotency-key': 'builder-preview-audit-retry-01' },
    };

    const first = await wired.harness.app.inject(request);
    expect(first.statusCode, first.body).toBe(500);
    const retry = await wired.harness.app.inject(request);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.headers['x-idempotent-replay']).toBe('true');
    expect(
      wired.proxy.requests.filter((candidate) => candidate.path === '/__zapp/screenshot'),
    ).toHaveLength(1);
    expect(
      audit.events.filter(
        (event) =>
          event.action === 'workspace.previewed' && event.metadata.operation === 'screenshot',
      ),
    ).toHaveLength(1);
    expect(
      audit.events.filter(
        (event) =>
          event.action === 'workspace.preview_rejected' &&
          event.metadata.operation === 'screenshot',
      ),
    ).toHaveLength(0);
  });

  it('cancels an open capture stream when organization access is revoked', async () => {
    const wired = await wire({ recheckIntervalMs: 5 });
    const { workspace } = await seedWorkspace(wired);
    wired.proxy.holdEventsOpen = true;
    const address = await wired.harness.app.listen({ host: '127.0.0.1', port: 0 });

    const response = await fetch(`${address}/v1/workspaces/${workspace.id}/preview/events`, {
      headers: { ...wired.asOwner, accept: 'text/event-stream' },
    });
    expect(response.status).toBe(200);
    await response.body?.getReader().read();

    const membership = [...wired.harness.organizations.memberships.entries()].find(
      ([, record]) =>
        record.organizationId === wired.organizationId && record.userId === wired.owner.userId,
    );
    expect(membership).toBeDefined();
    if (membership !== undefined) {
      wired.harness.organizations.memberships.set(membership[0], {
        ...membership[1],
        status: 'removed',
      });
    }

    await expect.poll(() => wired.proxy.requests[0]?.signal.aborted).toBe(true);
  });
});
