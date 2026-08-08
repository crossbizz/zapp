import { readFile } from 'node:fs/promises';

import type {
  CreateWorkspaceInput,
  ExecutionContract,
  WorkspaceHandle,
  WorkspaceStatus,
} from '@zapp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import {
  createModalSandboxProvider,
  type ModalWorkspaceCreateOptions,
  type ModalWorkspaceSandbox,
  type ModalWorkspaceSdkPort,
} from '../../src/provider/modal.js';
import type {
  WorkspaceLifecycleRow,
  WorkspaceRowBoundary,
  WorkspaceRowClaim,
  WorkspaceRowIdempotencyKey,
} from '../../src/routes/workspaces.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const OPERATION_KEY = `op_${'a'.repeat(64)}`;
const SERVICE_TOKEN = 'valid-control-api-service-token';
const AGENT_TOKEN = 'agent-test-token';
const IDS = {
  organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
  branchId: 'br_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
  runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
  taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NE',
  workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NF',
} as const;

const IMAGE_LOCK = {
  version: 1,
  environments: {
    dev: {
      modalEnvironment: 'zapp-dev',
      sourceRevision: 'c58a416cba65f57ea64ba3e3e90f3646efca9b62',
      tag: '2026-08-08-c58a416',
      images: {
        'forge-node-base': {
          appName: 'zapp-workspaces',
          digest: 'im-9NCxx8merCgh67jj0YLM84',
          publishedName: 'forge-node-base:2026-08-08-c58a416',
        },
        'forge-web-test': {
          appName: 'zapp-browser-verify',
          digest: 'im-eVxjg43Gv7bQrkH0CbwrrX',
          publishedName: 'forge-web-test:2026-08-08-c58a416',
        },
      },
    },
  },
} as const;

const EXECUTION_CONTRACT: ExecutionContract = {
  version: 1,
  package_manager: 'pnpm',
  workspace_root: '.',
  install: { command: 'pnpm install' },
  develop: { command: 'pnpm dev', port: 4173 },
};

function createInput(): CreateWorkspaceInput {
  return {
    organizationId: IDS.organizationId,
    projectId: IDS.projectId,
    branchId: IDS.branchId,
    runId: IDS.runId,
    taskId: IDS.taskId,
    purpose: 'builder',
    resourceProfile: 'small',
    imageTag: IMAGE_LOCK.environments.dev.images['forge-node-base'].publishedName,
    env: { PNPM_STORE_DIR: '/cache/pnpm' },
    networkProfile: 'dependency_install',
  };
}

class FakeModalWorkspaceSandbox implements ModalWorkspaceSandbox {
  readonly providerWorkspaceId = 'sb-modal-4a';
  readonly readinessTimeouts: number[] = [];
  readonly healthTokens: string[] = [];
  terminateCalls = 0;
  private healthResults = [false, true];
  readonly agentRequests: AgentRequest[] = [];
  agentResponder: (request: AgentRequest) => AgentResponse = strictAgentResponse;
  private devServerEvidence:
    | { port: number; pid: number; supervisorId: string; owned: true; httpReady: true }
    | undefined;
  streamCancelCalls = 0;

  constructor(private readonly owner: FakeModalWorkspaceSdk) {}

  waitUntilReady(timeoutMs: number): Promise<void> {
    this.readinessTimeouts.push(timeoutMs);
    return Promise.resolve();
  }

  agentHealth(token: string): Promise<unknown> {
    this.healthTokens.push(token);
    return Promise.resolve({
      ok: this.healthResults.shift() ?? true,
      details: 'workspace agent ready',
    });
  }

  terminate(): Promise<void> {
    this.terminateCalls += 1;
    this.owner.present = false;
    return Promise.resolve();
  }

  agentRequest(request: AgentRequest): Promise<AgentResponse> {
    this.agentRequests.push(request);
    if (request.method === 'GET' && request.path === '/healthz' && this.devServerEvidence !== undefined) {
      return Promise.resolve(
        jsonResponse({
          ok: true,
          details: 'workspace-agent ready',
          devServer: this.devServerEvidence,
        }),
      );
    }
    const response = this.agentResponder(request);
    if (
      request.method === 'POST' &&
      ['/dev-server/start', '/dev-server/restart'].includes(request.path) &&
      response.statusCode === 200
    ) {
      const parsed = JSON.parse(Buffer.from(response.body).toString('utf8')) as {
        port: number;
        pid: number;
        supervisorId: string;
      };
      this.devServerEvidence = {
        port: parsed.port,
        pid: parsed.pid,
        supervisorId: parsed.supervisorId,
        owned: true,
        httpReady: true,
      };
    }
    return Promise.resolve(response);
  }

  agentStream(request: AgentRequest): Promise<{
    statusCode: number;
    contentType?: string;
    body: AsyncIterable<Uint8Array>;
    cancel(): Promise<void>;
  }> {
    this.agentRequests.push(request);
    const response = this.agentResponder(request);
    const midpoint = Math.ceil(response.body.byteLength / 2);
    const chunks = [response.body.subarray(0, midpoint), response.body.subarray(midpoint)];
    return Promise.resolve({
      statusCode: response.statusCode,
      ...(response.contentType === undefined ? {} : { contentType: response.contentType }),
      body: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          for (const chunk of chunks) yield chunk;
        },
      },
      cancel: () => {
        this.streamCancelCalls += 1;
        return Promise.resolve();
      },
    });
  }
}

interface AgentRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

interface AgentResponse {
  readonly statusCode: number;
  readonly contentType?: string;
  readonly body: Uint8Array;
}

function jsonResponse(body: unknown, statusCode = 200): AgentResponse {
  return {
    statusCode,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify(body)),
  };
}

function strictAgentResponse(request: AgentRequest): AgentResponse {
  const key = `${request.method} ${request.path}`;
  if (key === 'POST /exec') {
    if (request.query?.stream === '1') {
      const records = [
        { type: 'started', pid: 41, executionId: '123e4567-e89b-42d3-a456-426614174000', at: NOW.toISOString() },
        { type: 'stdout', data: 'hello', at: NOW.toISOString() },
        { type: 'exit', exitCode: 0, durationMs: 1, truncated: false, at: NOW.toISOString() },
      ];
      return {
        statusCode: 200,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n'),
      };
    }
    return jsonResponse({ exitCode: 0, stdout: 'hello', stderr: '', durationMs: 1, truncated: false });
  }
  if (key === 'POST /exec/41/kill') return jsonResponse({ killed: true });
  if (key === 'GET /files') {
    return { statusCode: 200, contentType: 'application/octet-stream', body: Buffer.from('file bytes') };
  }
  if (key === 'PUT /files') return { statusCode: 204, body: Buffer.alloc(0) };
  if (key === 'GET /files/list') {
    return jsonResponse([{ path: 'src/index.ts', type: 'file' }]);
  }
  if (key === 'POST /git') {
    return jsonResponse({ exitCode: 0, stdout: 'clean', stderr: '' });
  }
  if (key === 'GET /healthz') {
    return jsonResponse({ ok: true, details: 'workspace-agent ready', devServer: null });
  }
  if (key === 'GET /metrics') {
    return jsonResponse({
      at: NOW.toISOString(),
      activeChildren: 0,
      cpu: { userMicros: 1, systemMicros: 2 },
      memory: {
        rssBytes: 3,
        heapTotalBytes: 4,
        heapUsedBytes: 5,
        externalBytes: 6,
        arrayBuffersBytes: 7,
      },
    });
  }
  if (key === 'GET /files/update-snapshot') {
    return jsonResponse({ dataBase64: Buffer.from('before').toString('base64'), revision: 'rev-1' });
  }
  if (key === 'POST /files/atomic-write') {
    const body = JSON.parse(Buffer.from(request.body ?? []).toString('utf8')) as {
      files: Array<{ expectedRevision?: string }>;
    };
    return body.files.some((file) => file.expectedRevision !== undefined)
      ? jsonResponse({ error: 'atomic_write_conflict' }, 409)
      : jsonResponse({ ok: true });
  }
  if (key === 'POST /search') {
    return jsonResponse({ exitCode: 0, stdout: 'src/index.ts:1:needle\n', stderr: '', durationMs: 2, truncated: false });
  }
  if (key === 'DELETE /files') return jsonResponse({ ok: true, alreadyAbsent: false });
  if (key === 'POST /files/rename') return jsonResponse({ ok: true });
  if (key === 'POST /dev-server/start') {
    return jsonResponse({ port: 4173, pid: 71, supervisorId: 'supervisor-start', ownership: 'process_group' });
  }
  if (key === 'POST /dev-server/restart') {
    return jsonResponse({ port: 4173, pid: 72, supervisorId: 'supervisor-restart', ownership: 'process_group' });
  }
  throw new Error(`unexpected fake-agent request: ${key}`);
}

class FakeModalWorkspaceSdk implements ModalWorkspaceSdkPort {
  readonly sandbox = new FakeModalWorkspaceSandbox(this);
  readonly creates: ModalWorkspaceCreateOptions[] = [];
  closeCalls = 0;
  present = false;
  private createBarrier: Promise<void> = Promise.resolve();

  holdCreation(): () => void {
    let release = (): void => undefined;
    this.createBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  createWorkspace(input: ModalWorkspaceCreateOptions): Promise<ModalWorkspaceSandbox> {
    this.creates.push(input);
    return this.createBarrier.then(() => {
      this.present = true;
      return this.sandbox;
    });
  }

  getWorkspace(providerWorkspaceId: string): Promise<ModalWorkspaceSandbox | undefined> {
    expect(providerWorkspaceId).toBe(this.sandbox.providerWorkspaceId);
    return Promise.resolve(this.present ? this.sandbox : undefined);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

function requestedRow(id = IDS.workspaceId): WorkspaceLifecycleRow {
  return {
    id,
    organizationId: IDS.organizationId,
    projectId: IDS.projectId,
    branchId: IDS.branchId,
    provider: 'modal',
    providerWorkspaceId: null,
    status: 'requested',
    resourceProfile: 'small',
    snapshotRef: null,
    createdAt: NOW,
    lastActiveAt: null,
    terminatedAt: null,
  };
}

class MemoryWorkspaceRows implements WorkspaceRowBoundary {
  readonly transitions: Array<{ status: WorkspaceStatus; providerWorkspaceId: string | null }> = [];
  private readonly rows = new Map<string, WorkspaceLifecycleRow>();
  private readonly idempotency = new Map<string, string>();
  private readonly createWaiters = new Map<string, Array<(row: WorkspaceLifecycleRow) => void>>();
  failTransitionStatus: WorkspaceStatus | undefined;

  claimCreate(
    row: WorkspaceLifecycleRow,
    key: WorkspaceRowIdempotencyKey,
  ): Promise<WorkspaceRowClaim> {
    const serialized = `${key.runId}:${key.taskId}:${key.purpose}`;
    const existingId = this.idempotency.get(serialized);
    if (existingId !== undefined) {
      const existing = this.rows.get(existingId);
      if (existing === undefined) throw new Error('idempotency row missing');
      if (existing.providerWorkspaceId === null) {
        return new Promise((resolve) => {
          const waiters = this.createWaiters.get(existingId) ?? [];
          waiters.push((row) => {
            resolve({ created: false, row });
          });
          this.createWaiters.set(existingId, waiters);
        });
      }
      return Promise.resolve({ created: false, row: existing });
    }
    this.rows.set(row.id, row);
    this.idempotency.set(serialized, row.id);
    this.transitions.push({ status: row.status, providerWorkspaceId: row.providerWorkspaceId });
    return Promise.resolve({ created: true, row });
  }

  get(workspaceId: string, organizationId?: string): Promise<WorkspaceLifecycleRow | undefined> {
    const row = this.rows.get(workspaceId);
    return Promise.resolve(
      row === undefined || (organizationId !== undefined && row.organizationId !== organizationId)
        ? undefined
        : row,
    );
  }

  transition(
    workspaceId: string,
    status: WorkspaceStatus,
    patch: { providerWorkspaceId?: string; terminatedAt?: Date } = {},
  ): Promise<WorkspaceLifecycleRow> {
    if (this.failTransitionStatus === status) {
      this.failTransitionStatus = undefined;
      return Promise.reject(new Error(`injected ${status} persistence failure`));
    }
    const row = this.rows.get(workspaceId);
    if (row === undefined) throw new Error('workspace missing');
    const next = {
      ...row,
      status,
      ...(patch.providerWorkspaceId === undefined
        ? {}
        : { providerWorkspaceId: patch.providerWorkspaceId }),
      ...(patch.terminatedAt === undefined ? {} : { terminatedAt: patch.terminatedAt }),
    };
    this.rows.set(workspaceId, next);
    this.transitions.push({ status, providerWorkspaceId: next.providerWorkspaceId });
    if (next.providerWorkspaceId !== null) {
      for (const resolve of this.createWaiters.get(workspaceId) ?? []) resolve(next);
      this.createWaiters.delete(workspaceId);
    }
    return Promise.resolve(next);
  }
}

const serviceTokens = {
  verifyServiceToken(token: string) {
    return Promise.resolve(
      token === SERVICE_TOKEN
        ? {
            ok: true as const,
            claims: {
              service: 'control-api' as const,
              audience: 'sandbox-service' as const,
              jti: 'svc:test',
              issuedAt: NOW,
              expiresAt: new Date(NOW.getTime() + 60_000),
            },
          }
        : { ok: false as const, reason: 'signature' as const },
    );
  },
};

describe('create status terminate and idempotency', () => {
  const apps: Array<{ close(): Promise<unknown> }> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('uses the locked image, exact tags, profile limits, allowlisted env, boot command, and agent readiness', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: 'agent-test-token',
      sdkFactory: () => sdk,
      now: () => NOW,
      clockMs: () => 0,
      sleep: () => Promise.resolve(),
    });

    const handle = await provider.createWorkspace(createInput());

    expect(handle).toMatchObject({
      providerWorkspaceId: 'sb-modal-4a',
      status: 'ready',
      resourceProfile: 'small',
      imageTag: 'forge-node-base:2026-08-08-c58a416',
      createdAt: NOW.toISOString(),
    });
    expect(sdk.creates).toEqual([
      {
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        digest: 'im-9NCxx8merCgh67jj0YLM84',
        publishedName: 'forge-node-base:2026-08-08-c58a416',
        tags: {
          org_id: IDS.organizationId,
          project_id: IDS.projectId,
          branch_id: IDS.branchId,
          run_id: IDS.runId,
          task_id: IDS.taskId,
          purpose: 'builder',
          environment: 'zapp-dev',
        },
        resources: {
          cpuRequest: 0.5,
          cpuLimit: 2,
          memRequestMiB: 1024,
          memLimitMiB: 4096,
        },
        environmentVariables: {
          ZAPP_AGENT_TOKEN: 'agent-test-token',
          ZAPP_WORKSPACE_ROOT: '/workspace',
          PNPM_STORE_DIR: '/cache/pnpm',
        },
        command: ['/usr/bin/dumb-init', '--', '/opt/zapp/boot.sh'],
        encryptedPorts: [8877],
        readinessProbe: { kind: 'tcp', port: 8877, intervalMs: 250 },
        timeoutMs: 14_400_000,
      },
    ]);
    expect(sdk.sandbox.readinessTimeouts).toEqual([30_000]);
    expect(sdk.sandbox.healthTokens).toEqual(['agent-test-token', 'agent-test-token']);
    expect(await provider.getStatus(handle.providerWorkspaceId)).toBe('ready');

    await provider.terminateWorkspace(handle.providerWorkspaceId);
    await provider.terminateWorkspace(handle.providerWorkspaceId);
    expect(sdk.sandbox.terminateCalls).toBe(1);
    expect(await provider.getStatus(handle.providerWorkspaceId)).toBe('terminated');
  });

  it('rejects an unlocked image and non-allowlisted environment before mutating Modal', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: 'agent-test-token',
      sdkFactory: () => sdk,
    });

    await expect(
      provider.createWorkspace({ ...createInput(), imageTag: 'forge-node-base:latest' }),
    ).rejects.toThrow();
    await expect(
      provider.createWorkspace({ ...createInput(), env: { DATABASE_URL: 'not-allowed' } }),
    ).rejects.toThrow('environment variable is not allowlisted');
    const inputWithExtra = { ...createInput(), extraBoundaryField: true };
    await expect(provider.createWorkspace(inputWithExtra)).rejects.toThrow();
    expect(sdk.creates).toHaveLength(0);
  });

  it('rejects readiness at the deadline and terminates the allocated sandbox', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    let clockReads = 0;
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: 'agent-test-token',
      sdkFactory: () => sdk,
      clockMs: () => (clockReads++ === 0 ? 0 : 30_000),
      sleep: () => Promise.resolve(),
    });

    await expect(provider.createWorkspace(createInput())).rejects.toThrow(
      'workspace agent readiness timed out',
    );
    expect(sdk.sandbox.healthTokens).toHaveLength(0);
    expect(sdk.sandbox.terminateCalls).toBe(1);
  });

  it('persists requested -> provisioning -> started -> ready once and terminates only after provider absence', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: 'agent-test-token',
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    const rows = new MemoryWorkspaceRows();
    const app = buildApp({ provider, rows, serviceTokens, now: () => NOW });
    apps.push(app);
    await app.ready();
    const body = {
      workspace: requestedRow(),
      runId: IDS.runId,
      taskId: IDS.taskId,
      purpose: 'builder',
      env: { PNPM_STORE_DIR: '/cache/pnpm' },
      networkProfile: 'dependency_install',
      operationKey: OPERATION_KEY,
    };
    const headers = {
      'x-zapp-service-token': SERVICE_TOKEN,
      'x-zapp-organization-id': IDS.organizationId,
      'idempotency-key': OPERATION_KEY,
    };

    const created = await app.inject({
      method: 'POST',
      url: '/internal/workspaces',
      headers,
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ workspace: WorkspaceLifecycleRow }>().workspace).toMatchObject({
      id: IDS.workspaceId,
      providerWorkspaceId: 'sb-modal-4a',
      status: 'ready',
    });
    expect(rows.transitions.map(({ status }) => status)).toEqual([
      'requested',
      'provisioning',
      'started',
      'ready',
    ]);

    const replay = await app.inject({
      method: 'POST',
      url: '/internal/workspaces',
      headers,
      payload: body,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ workspace: WorkspaceLifecycleRow }>().workspace.id).toBe(IDS.workspaceId);
    expect(sdk.creates).toHaveLength(1);

    const status = await app.inject({
      method: 'GET',
      url: `/internal/workspaces/${IDS.workspaceId}`,
      headers: { 'x-zapp-service-token': SERVICE_TOKEN },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json<{ providerStatus: WorkspaceStatus }>().providerStatus).toBe('ready');

    const terminated = await app.inject({
      method: 'POST',
      url: `/internal/workspaces/${IDS.workspaceId}/terminate`,
      headers,
      payload: { operationKey: OPERATION_KEY },
    });
    expect(terminated.statusCode).toBe(200);
    expect(terminated.json<{ workspace: WorkspaceLifecycleRow }>().workspace).toMatchObject({
      status: 'terminated',
      terminatedAt: NOW.toISOString(),
    });
    expect(await provider.getStatus('sb-modal-4a')).toBe('terminated');
    expect(rows.transitions.at(-1)?.status).toBe('terminated');
  });

  it('waits a concurrent duplicate for the first provider identity without creating twice', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    const releaseCreation = sdk.holdCreation();
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: 'agent-test-token',
      sdkFactory: () => sdk,
      now: () => NOW,
      clockMs: () => 0,
      sleep: () => Promise.resolve(),
    });
    const rows = new MemoryWorkspaceRows();
    const app = buildApp({ provider, rows, serviceTokens, now: () => NOW });
    apps.push(app);
    await app.ready();
    const headers = {
      'x-zapp-service-token': SERVICE_TOKEN,
      'x-zapp-organization-id': IDS.organizationId,
      'idempotency-key': OPERATION_KEY,
    };
    const payload = {
      workspace: requestedRow(),
      runId: IDS.runId,
      taskId: IDS.taskId,
      purpose: 'builder',
      env: {},
      networkProfile: 'dependency_install',
      operationKey: OPERATION_KEY,
    };

    const first = app.inject({ method: 'POST', url: '/internal/workspaces', headers, payload });
    await vi.waitFor(() => {
      expect(sdk.creates).toHaveLength(1);
    });
    const duplicate = app.inject({ method: 'POST', url: '/internal/workspaces', headers, payload });
    releaseCreation();
    const [firstResponse, duplicateResponse] = await Promise.all([first, duplicate]);

    expect([firstResponse.statusCode, duplicateResponse.statusCode].sort()).toEqual([200, 201]);
    expect(
      [firstResponse, duplicateResponse].map(
        (response) =>
          response.json<{ workspace: WorkspaceLifecycleRow }>().workspace.providerWorkspaceId,
      ),
    ).toEqual(['sb-modal-4a', 'sb-modal-4a']);
    expect(sdk.creates).toHaveLength(1);
  });

  it('terminates and records terminated when post-create persistence fails', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: 'agent-test-token',
      sdkFactory: () => sdk,
      now: () => NOW,
      clockMs: () => 0,
      sleep: () => Promise.resolve(),
    });
    const rows = new MemoryWorkspaceRows();
    rows.failTransitionStatus = 'ready';
    const app = buildApp({ provider, rows, serviceTokens, now: () => NOW });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/internal/workspaces',
      headers: {
        'x-zapp-service-token': SERVICE_TOKEN,
        'idempotency-key': OPERATION_KEY,
      },
      payload: {
        workspace: requestedRow(),
        runId: IDS.runId,
        taskId: IDS.taskId,
        purpose: 'builder',
        env: {},
        networkProfile: 'dependency_install',
        operationKey: OPERATION_KEY,
      },
    });

    expect(response.statusCode).toBe(502);
    expect(sdk.sandbox.terminateCalls).toBe(1);
    expect(rows.transitions.at(-1)).toEqual({
      status: 'terminated',
      providerWorkspaceId: 'sb-modal-4a',
    });
  });

  it('requires service authentication and rejects missing idempotency or extra boundary fields', async () => {
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: 'agent-test-token',
      sdkFactory: () => new FakeModalWorkspaceSdk(),
    });
    const rows = new MemoryWorkspaceRows();
    const app = buildApp({ provider, rows, serviceTokens, now: () => NOW });
    apps.push(app);
    await app.ready();
    const validBody = {
      workspace: requestedRow(),
      runId: IDS.runId,
      taskId: IDS.taskId,
      purpose: 'builder',
      env: {},
      networkProfile: 'dependency_install',
      operationKey: OPERATION_KEY,
    };

    expect(
      (await app.inject({ method: 'POST', url: '/internal/workspaces', payload: validBody }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/workspaces',
          headers: { 'x-zapp-service-token': SERVICE_TOKEN },
          payload: validBody,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/workspaces',
          headers: { 'x-zapp-service-token': SERVICE_TOKEN, 'idempotency-key': OPERATION_KEY },
          payload: { ...validBody, providerWorkspaceId: 'attacker-chosen' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/workspaces',
          headers: {
            'x-zapp-service-token': SERVICE_TOKEN,
            'idempotency-key': OPERATION_KEY,
          },
          payload: {
            ...validBody,
            workspace: {
              ...validBody.workspace,
              status: 'ready',
              providerWorkspaceId: 'forged-provider',
            },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/internal/workspaces/${IDS.workspaceId}/terminate`,
          headers: { 'x-zapp-service-token': SERVICE_TOKEN },
          payload: { operationKey: OPERATION_KEY },
        })
      ).statusCode,
    ).toBe(400);
    expect(rows.transitions).toHaveLength(0);
  });

  const hasModalCredentials =
    typeof process.env.MODAL_TOKEN_ID === 'string' &&
    process.env.MODAL_TOKEN_ID !== '' &&
    typeof process.env.MODAL_TOKEN_SECRET === 'string' &&
    process.env.MODAL_TOKEN_SECRET !== '';

  it.skipIf(!hasModalCredentials)(
    'runs create/status/terminate against real Modal [skipped without MODAL_TOKEN_ID and MODAL_TOKEN_SECRET]',
    async () => {
      const lock = JSON.parse(
        await readFile(
          new URL('../../../../infra/modal/images.lock.json', import.meta.url),
          'utf8',
        ),
      ) as typeof IMAGE_LOCK;
      const provider = createModalSandboxProvider({
        environment: 'dev',
        imageLock: lock,
        agentToken: `ws4a-${Date.now().toString(36)}`,
      });
      let handle: WorkspaceHandle | undefined;
      try {
        handle = await provider.createWorkspace({
          ...createInput(),
          imageTag: lock.environments.dev.images['forge-node-base'].publishedName,
        });
        expect(await provider.getStatus(handle.providerWorkspaceId)).toBe('ready');
      } finally {
        if (handle !== undefined) await provider.terminateWorkspace(handle.providerWorkspaceId);
      }
      expect(await provider.getStatus(handle.providerWorkspaceId)).toBe('terminated');
    },
    120_000,
  );
});

describe('agent proxy and unguarded conformance', () => {
  it('proxies every strict agent endpoint with authentication, keys, encoding, and response validation', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: 'agent-test-token',
      sdkFactory: () => sdk,
    }) as unknown as AgentProxyProvider;
    const providerWorkspaceId = sdk.sandbox.providerWorkspaceId;

    const execInput = {
      providerWorkspaceId,
      command: 'printf',
      args: ['hello'],
      timeoutMs: 1_000,
    };
    await expect(provider.exec(execInput)).resolves.toEqual({
      exitCode: 0,
      stdout: 'hello',
      stderr: '',
      durationMs: 1,
      truncated: false,
    });
    const streamRecords: unknown[] = [];
    for await (const record of provider.execStream(execInput)) streamRecords.push(record);
    expect(streamRecords.map((record) => (record as { type: string }).type)).toEqual([
      'started',
      'stdout',
      'exit',
    ]);
    await expect(
      provider.killExec(
        providerWorkspaceId,
        41,
        '123e4567-e89b-42d3-a456-426614174000',
      ),
    ).resolves.toEqual({ killed: true });
    await expect(provider.readFile(providerWorkspaceId, 'src/space name.ts')).resolves.toEqual(
      Buffer.from('file bytes'),
    );
    await provider.writeFile(providerWorkspaceId, 'src/index.ts', Buffer.from('next'));
    await expect(
      provider.listFiles(providerWorkspaceId, '.', { glob: '*.ts', maxDepth: 2 }),
    ).resolves.toEqual([{ path: 'src/index.ts', type: 'file' }]);
    await expect(provider.git(providerWorkspaceId, { operation: 'status', args: ['--short'] })).resolves.toEqual({
      exitCode: 0,
      stdout: 'clean',
      stderr: '',
    });
    await expect(provider.health(providerWorkspaceId)).resolves.toMatchObject({ ok: true });
    await expect(provider.metrics(providerWorkspaceId)).resolves.toMatchObject({ activeChildren: 0 });
    const beforeGuardedSnapshot = sdk.sandbox.agentRequests.length;
    await expect(provider.readFileForUpdate(providerWorkspaceId, 'src/index.ts')).rejects.toMatchObject({
      name: 'AtomicWriteConflictError',
      code: 'atomic_write_conflict',
    });
    expect(sdk.sandbox.agentRequests).toHaveLength(beforeGuardedSnapshot);
    await provider.writeFilesAtomically(providerWorkspaceId, [
      { path: 'src/a.ts', data: Buffer.from('a') },
      { path: 'src/b.ts', data: Buffer.from('b') },
    ]);
    await expect(
      provider.search(providerWorkspaceId, {
        pattern: 'needle',
        path: 'src',
        glob: '*.ts',
        fixedStrings: true,
        ignoreCase: false,
      }),
    ).resolves.toMatchObject({ stdout: 'src/index.ts:1:needle\n' });
    await expect(provider.deleteFile(providerWorkspaceId, 'src/old.ts')).resolves.toEqual({
      alreadyAbsent: false,
    });
    await provider.renameFile(providerWorkspaceId, {
      source: 'src/a.ts',
      destination: 'src/b.ts',
      overwrite: 'replace',
    });
    await expect(provider.startDevServer(providerWorkspaceId, EXECUTION_CONTRACT)).resolves.toEqual({
      port: 4173,
      pid: 71,
      supervisorId: 'supervisor-start',
      ownership: 'process_group',
    });
    await expect(provider.restartDevServer(providerWorkspaceId, EXECUTION_CONTRACT)).resolves.toEqual({
      port: 4173,
      pid: 72,
      supervisorId: 'supervisor-restart',
      ownership: 'process_group',
    });
    const beforeGuardedWrite = sdk.sandbox.agentRequests.length;
    await expect(
      provider.writeFilesAtomically(providerWorkspaceId, [
        { path: 'src/a.ts', data: Buffer.from('guarded'), expectedRevision: 'rev-1' },
      ]),
    ).rejects.toMatchObject({ name: 'AtomicWriteConflictError', code: 'atomic_write_conflict' });
    expect(sdk.sandbox.agentRequests).toHaveLength(beforeGuardedWrite);

    for (const request of sdk.sandbox.agentRequests) {
      expect(request.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`);
    }
    const mutatingPaths = new Set([
      '/exec',
      '/exec/41/kill',
      '/files',
      '/git',
      '/files/atomic-write',
      '/files/rename',
      '/dev-server/start',
      '/dev-server/restart',
    ]);
    for (const request of sdk.sandbox.agentRequests) {
      if (request.method !== 'GET' && mutatingPaths.has(request.path)) {
        expect(request.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
      }
    }
    expect(
      sdk.sandbox.agentRequests.find(
        (request) => request.method === 'GET' && request.path === '/files',
      )?.query,
    ).toEqual({ path: 'src/space name.ts' });
    const atomicRequest = sdk.sandbox.agentRequests.find(
      (request) => request.method === 'POST' && request.path === '/files/atomic-write',
    );
    expect(JSON.parse(Buffer.from(atomicRequest?.body ?? []).toString('utf8'))).toEqual({
      files: [
        { path: 'src/a.ts', dataBase64: Buffer.from('a').toString('base64') },
        { path: 'src/b.ts', dataBase64: Buffer.from('b').toString('base64') },
      ],
    });
    const devRequest = sdk.sandbox.agentRequests.find(
      (request) => request.method === 'POST' && request.path === '/dev-server/start',
    );
    expect(JSON.parse(Buffer.from(devRequest?.body ?? []).toString('utf8'))).toEqual({
      contract: EXECUTION_CONTRACT,
    });
  });

  it('kills a cancelled stream and rejects malformed responses and extra inputs', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
    }) as unknown as AgentProxyProvider;
    for await (const record of provider.execStream({
      providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
      command: 'sleep',
      args: ['30'],
      timeoutMs: 1_000,
    })) {
      expect(record).toMatchObject({ type: 'started', pid: 41 });
      break;
    }
    expect(sdk.sandbox.agentRequests.map(({ path }) => path)).toEqual(['/exec', '/exec/41/kill']);

    sdk.sandbox.agentResponder = (request) =>
      request.path === '/metrics'
        ? jsonResponse({ ...JSON.parse(Buffer.from(strictAgentResponse(request).body).toString('utf8')), extra: true })
        : strictAgentResponse(request);
    await expect(provider.metrics(sdk.sandbox.providerWorkspaceId)).rejects.toThrow();
    const requestCount = sdk.sandbox.agentRequests.length;
    await expect(
      provider.search(sdk.sandbox.providerWorkspaceId, {
        pattern: 'x',
        path: '.',
        arbitraryProcess: 'sh',
      }),
    ).rejects.toThrow();
    expect(sdk.sandbox.agentRequests).toHaveLength(requestCount);
  });

  it('routes tenant-owned workspace ids internally and rejects unknown ownership and escape fields', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
    });
    const rows = new MemoryWorkspaceRows();
    await rows.claimCreate(requestedRow(), {
      runId: IDS.runId,
      taskId: IDS.taskId,
      purpose: 'builder',
    });
    await rows.transition(IDS.workspaceId, 'started', {
      providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
    });
    await rows.transition(IDS.workspaceId, 'ready');
    const app = buildApp({ provider, rows, serviceTokens, now: () => NOW });
    await app.ready();
    const headers = {
      'x-zapp-service-token': SERVICE_TOKEN,
      'x-zapp-organization-id': IDS.organizationId,
      'idempotency-key': OPERATION_KEY,
    };
    try {
      const search = await app.inject({
        method: 'POST',
        url: `/internal/workspaces/${IDS.workspaceId}/search`,
        headers,
        payload: { pattern: 'needle', path: 'src', fixedStrings: true },
      });
      expect(search.statusCode).toBe(200);
      expect(search.json()).toMatchObject({ stdout: 'src/index.ts:1:needle\n' });

      const atomic = await app.inject({
        method: 'POST',
        url: `/internal/workspaces/${IDS.workspaceId}/files/atomic-write`,
        headers,
        payload: {
          files: [{ path: 'src/index.ts', dataBase64: Buffer.from('next').toString('base64') }],
        },
      });
      expect(atomic.statusCode).toBe(200);
      expect(atomic.json()).toEqual({ ok: true });

      const guardedSnapshot = await app.inject({
        method: 'GET',
        url: `/internal/workspaces/${IDS.workspaceId}/files/update-snapshot?path=src%2Findex.ts`,
        headers: {
          'x-zapp-service-token': SERVICE_TOKEN,
          'x-zapp-organization-id': IDS.organizationId,
        },
      });
      expect(guardedSnapshot.statusCode).toBe(409);
      expect(guardedSnapshot.json()).toEqual({
        code: 'atomic_write_conflict',
        message: 'Atomic file changed before commit.',
      });

      for (const action of ['start', 'restart'] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/internal/workspaces/${IDS.workspaceId}/dev-server/${action}`,
          headers,
          payload: { contract: EXECUTION_CONTRACT },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ port: 4173, ownership: 'process_group' });
      }

      const unknown = await app.inject({
        method: 'POST',
        url: '/internal/workspaces/ws_01J8ME7YQZJ2V9Q0X3T5B6K7NZ/search',
        headers,
        payload: { pattern: 'needle', path: 'src' },
      });
      expect(unknown.statusCode).toBe(404);

      const crossTenant = await app.inject({
        method: 'POST',
        url: `/internal/workspaces/${IDS.workspaceId}/search`,
        headers: {
          ...headers,
          'x-zapp-organization-id': 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NZ',
        },
        payload: { pattern: 'needle', path: 'src' },
      });
      expect(crossTenant.statusCode).toBe(404);

      const forged = await app.inject({
        method: 'POST',
        url: `/internal/workspaces/${IDS.workspaceId}/search`,
        headers,
        payload: { pattern: 'needle', path: 'src', providerWorkspaceId: 'attacker-chosen' },
      });
      expect(forged.statusCode).toBe(400);
      expect(sdk.sandbox.agentRequests.some((request) => request.path.includes('attacker'))).toBe(false);
    } finally {
      await app.close();
    }
  });

});

interface AgentProxyProvider {
  exec(input: { providerWorkspaceId: string; command: string; args: string[]; timeoutMs: number }): Promise<unknown>;
  execStream(input: { providerWorkspaceId: string; command: string; args: string[]; timeoutMs: number }): AsyncIterable<unknown>;
  killExec(providerWorkspaceId: string, pid: number, executionId: string): Promise<unknown>;
  readFile(providerWorkspaceId: string, path: string): Promise<Uint8Array>;
  writeFile(providerWorkspaceId: string, path: string, data: Uint8Array): Promise<void>;
  listFiles(providerWorkspaceId: string, path: string, options?: { glob?: string; maxDepth?: number }): Promise<unknown>;
  git(providerWorkspaceId: string, input: unknown): Promise<unknown>;
  health(providerWorkspaceId: string): Promise<unknown>;
  metrics(providerWorkspaceId: string): Promise<unknown>;
  readFileForUpdate(providerWorkspaceId: string, path: string): Promise<unknown>;
  writeFilesAtomically(providerWorkspaceId: string, files: readonly { path: string; data: Uint8Array; expectedRevision?: string }[]): Promise<void>;
  search(providerWorkspaceId: string, input: unknown): Promise<unknown>;
  deleteFile(providerWorkspaceId: string, path: string): Promise<{ alreadyAbsent: boolean }>;
  renameFile(providerWorkspaceId: string, input: unknown): Promise<void>;
  startDevServer(providerWorkspaceId: string, contract: ExecutionContract): Promise<unknown>;
  restartDevServer(providerWorkspaceId: string, contract: ExecutionContract): Promise<unknown>;
}
