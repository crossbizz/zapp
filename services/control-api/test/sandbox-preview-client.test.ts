import { newId } from '@zapp/contracts';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import {
  createS3BuilderPreviewScreenshotStore,
  type BuilderPreviewS3Command,
  type BuilderPreviewS3CommandSender,
} from '../src/routes/builder-preview.js';
import {
  createBuilderPreviewSandboxClient,
  createSandboxServiceClient,
  createSandboxStorageMeasurementClient,
  createSupportSandboxClient,
} from '../src/sandbox/client.js';
import type { SandboxWorkspace } from '../src/sandbox/port.js';
import { TEST_SERVICE_TOKEN_SECRET } from './support/service-tokens.js';

const workspace: SandboxWorkspace = {
  id: newId('ws'),
  organizationId: newId('org'),
  projectId: newId('proj'),
  branchId: newId('br'),
  provider: 'modal',
  providerWorkspaceId: 'provider-preview',
  status: 'active',
  resourceProfile: 'standard',
  runId: newId('run'),
  snapshotRef: null,
  createdAt: new Date('2026-08-10T19:00:00.000Z'),
  lastActiveAt: new Date('2026-08-10T20:00:00.000Z'),
  terminatedAt: null,
};

interface StoredS3Object {
  readonly body: Buffer;
  readonly contentType: string;
  readonly metadata?: Record<string, string>;
  readonly chunks?: readonly Buffer[];
}

class RecordingS3Sender implements BuilderPreviewS3CommandSender {
  readonly commands: BuilderPreviewS3Command[] = [];
  readonly objects = new Map<string, StoredS3Object>();

  send(command: BuilderPreviewS3Command): Promise<unknown> {
    this.commands.push(command);
    if (command instanceof PutObjectCommand) {
      const key = String(command.input.Key);
      if (command.input.IfNoneMatch === '*' && this.objects.has(key)) {
        return Promise.reject(
          Object.assign(new Error('precondition failed'), {
            $metadata: { httpStatusCode: 412 },
          }),
        );
      }
      const rawBody = command.input.Body;
      if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
        return Promise.reject(new Error('test sender accepts only string or Buffer bodies'));
      }
      const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
      this.objects.set(key, {
        body,
        contentType: command.input.ContentType ?? '',
        ...(command.input.Metadata === undefined ? {} : { metadata: command.input.Metadata }),
      });
      return Promise.resolve({});
    }
    if (command instanceof GetObjectCommand) {
      const stored = this.objects.get(String(command.input.Key));
      if (stored === undefined) {
        return Promise.reject(
          Object.assign(new Error('object not found'), { $metadata: { httpStatusCode: 404 } }),
        );
      }
      return Promise.resolve({
        Body: byteStream(stored.chunks ?? [stored.body]),
        ContentType: stored.contentType,
        Metadata: stored.metadata,
      });
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(String(command.input.Key));
      return Promise.resolve({});
    }
    return Promise.reject(new Error('unexpected S3 command'));
  }
}

async function* byteStream(chunks: readonly Buffer[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

describe('builder preview sandbox client', () => {
  it('creates a branch-backed workspace through the authenticated sandbox boundary', async () => {
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const client = createSandboxServiceClient({
      baseUrl: 'http://sandbox.internal/',
      serviceTokens: { secret: TEST_SERVICE_TOKEN_SECRET },
      fetch: (input, init) => {
        requests.push({ input, init });
        return Promise.resolve(
          Response.json(
            {
              workspace: {
                ...workspace,
                providerWorkspaceId: 'provider-created',
                status: 'ready',
              },
            },
            { status: 201 },
          ),
        );
      },
    });
    const operationKey = `op_${'d'.repeat(64)}`;

    await expect(
      client.createWorkspace({ workspace, branchName: 'main', operationKey }),
    ).resolves.toEqual({ providerWorkspaceId: 'provider-created', status: 'ready' });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe('http://sandbox.internal/internal/workspaces');
    expect(requests[0]?.init.method).toBe('POST');
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get('x-zapp-service-token')).toMatch(/^ey/u);
    expect(headers.get('x-zapp-organization-id')).toBe(workspace.organizationId);
    expect(headers.get('x-zapp-project-id')).toBe(workspace.projectId);
    expect(headers.get('idempotency-key')).toBe(operationKey);
    const requestBody = requests[0]?.init.body;
    expect(typeof requestBody).toBe('string');
    if (typeof requestBody !== 'string') throw new Error('Expected a serialized workspace body.');
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    expect(body).toMatchObject({
      workspace: { id: workspace.id, branchId: workspace.branchId },
      branchName: 'main',
      purpose: 'builder',
      networkProfile: 'dependency_install',
      operationKey,
    });
    expect(body['runId']).toMatch(/^run_/u);
    expect(body['taskId']).toMatch(/^task_/u);
  });

  it('reads project storage through the authenticated sandbox-service boundary', async () => {
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const client = createSandboxStorageMeasurementClient({
      baseUrl: 'http://sandbox.internal/',
      serviceTokens: { secret: TEST_SERVICE_TOKEN_SECRET },
      fetch: (input, init) => {
        requests.push({ input, init });
        return Promise.resolve(Response.json({ snapshotBytes: '13', volumeBytes: '17' }));
      },
    });

    await expect(
      client.measureProjectBytes({
        organizationId: workspace.organizationId,
        projectId: workspace.projectId,
      }),
    ).resolves.toEqual({ snapshotBytes: '13', volumeBytes: '17' });
    expect(requests[0]?.input).toBe(
      `http://sandbox.internal/internal/projects/${workspace.projectId}/storage-measurement`,
    );
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get('x-zapp-service-token')).toMatch(/^ey/u);
    expect(headers.get('x-zapp-organization-id')).toBe(workspace.organizationId);
    expect(headers.get('x-zapp-project-id')).toBe(workspace.projectId);
  });

  it('authenticates and scopes the bounded log request', async () => {
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const client = createBuilderPreviewSandboxClient({
      baseUrl: 'http://sandbox.internal/',
      serviceTokens: { secret: TEST_SERVICE_TOKEN_SECRET },
      fetch: (input, init) => {
        requests.push({ input, init });
        return Promise.resolve(
          Response.json({
            entries: [],
            nextCursor: 7,
            truncated: false,
            state: 'ready',
            failureId: null,
          }),
        );
      },
    });

    const result = await client.readDevServerLogs({ workspace, after: 7, limit: 25 });

    expect(result).toEqual({
      entries: [],
      nextCursor: 7,
      truncated: false,
      state: 'ready',
      failureId: null,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe(
      `http://sandbox.internal/internal/workspaces/${workspace.id}/dev-server/logs?after=7&limit=25`,
    );
    expect(requests[0]?.init.method).toBe('GET');
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get('x-zapp-service-token')).toMatch(/^ey/u);
    expect(headers.get('x-zapp-organization-id')).toBe(workspace.organizationId);
    expect(headers.get('x-zapp-project-id')).toBe(workspace.projectId);
  });

  it('sends only the stored contract and internal idempotency key on restart', async () => {
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const client = createBuilderPreviewSandboxClient({
      baseUrl: 'http://sandbox.internal',
      serviceTokens: { secret: TEST_SERVICE_TOKEN_SECRET },
      fetch: (input, init) => {
        requests.push({ input, init });
        return Promise.resolve(
          Response.json({
            port: 3000,
            pid: 42,
            supervisorId: 'preview-supervisor',
            ownership: 'process_group',
          }),
        );
      },
    });
    const operationKey = `op_${'a'.repeat(64)}`;
    const contract = {
      version: 1 as const,
      package_manager: 'pnpm' as const,
      workspace_root: '.',
      install: { command: 'pnpm install --frozen-lockfile' },
      develop: { command: 'pnpm run dev', port: 3000 },
    };

    await client.restartDevServer({ workspace, contract, operationKey });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe(
      `http://sandbox.internal/internal/workspaces/${workspace.id}/dev-server/restart`,
    );
    expect(requests[0]?.init.method).toBe('POST');
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get('idempotency-key')).toBe(operationKey);
    expect(headers.get('x-zapp-service-token')).toMatch(/^ey/u);
    expect(headers.get('x-zapp-organization-id')).toBe(workspace.organizationId);
    expect(headers.get('x-zapp-project-id')).toBe(workspace.projectId);
    expect(headers.get('x-zapp-run-id')).toBe(workspace.runId);
    const requestBody = requests[0]?.init.body;
    expect(typeof requestBody).toBe('string');
    if (typeof requestBody !== 'string') throw new Error('restart request body must be JSON');
    expect(JSON.parse(requestBody)).toEqual({ contract });
  });

  it('binds staff termination to the service-authenticated WS-15 kill boundaries', async () => {
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const client = createSupportSandboxClient({
      baseUrl: 'http://sandbox.internal/',
      serviceTokens: { secret: TEST_SERVICE_TOKEN_SECRET },
      fetch: (input, init) => {
        requests.push({ input, init });
        return Promise.resolve(
          input.endsWith('/terminate-all')
            ? Response.json({ terminated: 3 })
            : Response.json({
                workspace: {
                  status: 'terminated',
                  terminatedAt: '2026-08-12T08:15:00.000Z',
                },
              }),
        );
      },
    });
    const workspaceOperationKey = `op_${'b'.repeat(64)}`;
    const organizationOperationKey = `op_${'c'.repeat(64)}`;
    const actorUserId = newId('user');

    await expect(
      client.terminateWorkspace({ workspace, operationKey: workspaceOperationKey }),
    ).resolves.toEqual({
      status: 'terminated',
      terminatedAt: new Date('2026-08-12T08:15:00.000Z'),
    });
    await expect(
      client.terminateOrganization({
        organizationId: workspace.organizationId,
        actorUserId,
        reason: 'Customer requested an emergency sandbox shutdown',
        operationKey: organizationOperationKey,
      }),
    ).resolves.toEqual({ terminated: 3 });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.input).toBe(
      `http://sandbox.internal/internal/workspaces/${workspace.id}/terminate`,
    );
    expect(requests[1]?.input).toBe(
      `http://sandbox.internal/internal/orgs/${workspace.organizationId}/terminate-all`,
    );
    const workspaceHeaders = new Headers(requests[0]?.init.headers);
    expect(workspaceHeaders.get('x-zapp-service-token')).toMatch(/^ey/u);
    expect(workspaceHeaders.get('x-zapp-organization-id')).toBe(workspace.organizationId);
    expect(workspaceHeaders.get('x-zapp-project-id')).toBe(workspace.projectId);
    expect(workspaceHeaders.get('idempotency-key')).toBe(workspaceOperationKey);
    const organizationHeaders = new Headers(requests[1]?.init.headers);
    expect(organizationHeaders.get('x-zapp-service-token')).toMatch(/^ey/u);
    expect(organizationHeaders.get('idempotency-key')).toBe(organizationOperationKey);

    const organizationBody = requests[1]?.init.body;
    expect(typeof organizationBody).toBe('string');
    if (typeof organizationBody !== 'string') throw new Error('terminate-all body must be JSON');
    expect(JSON.parse(organizationBody)).toEqual({
      actorUserId,
      reason: 'Customer requested an emergency sandbox shutdown',
      operationKey: organizationOperationKey,
    });
  });
});

describe('builder preview screenshot S3 store', () => {
  const config = {
    endpoint: 'http://artifact.invalid',
    region: 'us-east-1',
    bucket: 'zapp-artifacts',
    accessKeyId: 'test-access',
    secretAccessKey: 'test-secret',
  };

  it('atomically reserves, replays, releases, and reacquires the shipping command path', async () => {
    const sender = new RecordingS3Sender();
    const store = createS3BuilderPreviewScreenshotStore(config, sender);
    const key = 'org_test/proj_test/builder-preview-screenshots/ws_test/op_test.png';

    const reservations = await Promise.all([store.reserve(key), store.reserve(key)]);
    expect(reservations.map((entry) => entry.state).sort()).toEqual(['acquired', 'pending']);
    const conditionalWrites = sender.commands.filter(
      (command) => command instanceof PutObjectCommand && command.input.IfNoneMatch === '*',
    );
    expect(conditionalWrites).toHaveLength(2);

    const capturedAt = new Date('2026-08-10T21:00:00.000Z');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await store.complete(key, png, capturedAt);
    const completed = await store.reserve(key);
    expect(completed).toEqual({ state: 'completed', body: png, capturedAt });

    await store.release(key);
    expect(await store.reserve(key)).toEqual({ state: 'acquired' });
  });

  it('stops a corrupted completed object before buffering beyond 10 MiB', async () => {
    const sender = new RecordingS3Sender();
    const store = createS3BuilderPreviewScreenshotStore(config, sender);
    const key = 'org_test/proj_test/builder-preview-screenshots/ws_test/op_oversized.png';
    const fiveMiB = Buffer.alloc(5 * 1024 * 1024);
    sender.objects.set(key, {
      body: Buffer.alloc(0),
      chunks: [fiveMiB, fiveMiB, Buffer.from([1])],
      contentType: 'image/png',
      metadata: { 'captured-at': '2026-08-10T21:00:00.000Z' },
    });

    await expect(store.reserve(key)).rejects.toMatchObject({
      code: 'preview_proxy_failed',
      statusCode: 502,
    });
  });
});
