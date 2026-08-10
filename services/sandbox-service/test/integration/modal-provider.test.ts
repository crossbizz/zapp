import { readFile } from 'node:fs/promises';

import type {
  CreateWorkspaceInput,
  ExecutionContract,
  WorkspaceHandle,
  WorkspaceStatus,
} from '@zapp/contracts';
import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp, type BuildAppOptions } from '../../src/app.js';
import type { WorkspaceGitService } from '../../src/provider/git-bootstrap.js';
import {
  createModalSandboxProvider,
  type ModalWorkspaceCreateOptions,
  type ModalWorkspaceSandbox,
  type ModalWorkspaceSdkPort,
  type WorkspaceAgentStreamRecord,
} from '../../src/provider/modal.js';
import { BranchLockedError } from '../../src/provider/volumes.js';
import { createFetchPreviewTransport } from '../../src/preview/transport.js';
import { createScopedSecretInjector } from '../../src/secrets/injector.js';
import type {
  WorkspaceLifecycleRow,
  PreviewMonitorCoordinator,
  WorkspaceRowBoundary,
  WorkspaceRowClaim,
  WorkspaceRowIdempotencyKey,
} from '../../src/routes/workspaces.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const OPERATION_KEY = `op_${'a'.repeat(64)}`;
const SERVICE_TOKEN = 'valid-control-api-service-token';
const AGENT_TOKEN = 'agent-test-token';
const WORKSPACE_GIT_FIXTURE: WorkspaceGitService = {
  bootstrap: () => Promise.resolve(),
  push: () => Promise.reject(new Error('Unexpected workspace Git push')),
};
const EMPTY_SECRET_INJECTOR = createScopedSecretInjector({
  decrypt: () => Promise.reject(new Error('Unexpected secret decrypt')),
});
const NOOP_NETWORK_POLICIES = { record: () => Promise.resolve() };
const NOOP_PREVIEW_EVENTS = { emit: () => Promise.resolve() };

function buildTestApp(
  options: Omit<
    BuildAppOptions,
    'secrets' | 'networkPolicies' | 'events' | 'previewMonitors'
  > &
    Partial<
      Pick<BuildAppOptions, 'secrets' | 'networkPolicies' | 'events' | 'previewMonitors'>
    >,
) {
  return buildApp({
    secrets: EMPTY_SECRET_INJECTOR,
    networkPolicies: NOOP_NETWORK_POLICIES,
    events: NOOP_PREVIEW_EVENTS,
    previewMonitors:
      options.previewMonitors ??
      (options.rows as WorkspaceRowBoundary & PreviewMonitorCoordinator),
    ...options,
  } as BuildAppOptions);
}
const IDS = {
  organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
  branchId: 'br_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
  runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
  taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NE',
  workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NF',
} as const;
const OTHER_ORGANIZATION_ID = 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NZ';
const OTHER_PROJECT_ID = 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NZ';

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

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function createDeferredSignal(): { readonly promise: Promise<undefined>; resolve(): void } {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<undefined>((resolve) => {
    resolvePromise = () => {
      resolve(undefined);
    };
  });
  return { promise, resolve: resolvePromise };
}

class FakeModalWorkspaceSandbox implements ModalWorkspaceSandbox {
  readonly providerWorkspaceId = 'sb-modal-4a';
  readonly readinessTimeouts: number[] = [];
  readonly healthTokens: string[] = [];
  terminateCalls = 0;
  healthResults = [false, true];
  legacyHealthPayload = false;
  readonly agentRequests: AgentRequest[] = [];
  agentResponder: (request: AgentRequest) => AgentResponse = strictAgentResponse;
  private devServerEvidence:
    { port: number; pid: number; supervisorId: string; owned: true; httpReady: true } | undefined;
  streamCancelCalls = 0;
  stallStreamAfterStarted = false;
  private stalledStream = createDeferredSignal();
  tags: Readonly<Record<string, string>> = createInputTags();
  waitUntilReadyError: Error | undefined;
  disappearAfterTags = false;
  disappearDuringTags = false;

  constructor(private readonly owner: FakeModalWorkspaceSdk) {}

  getTags(): Promise<Readonly<Record<string, string>>> {
    if (this.disappearDuringTags) {
      this.owner.present = false;
      return Promise.reject(new Error('sandbox disappeared during tag lookup'));
    }
    if (this.disappearAfterTags) this.owner.present = false;
    return Promise.resolve({ ...this.tags });
  }

  waitUntilReady(timeoutMs: number): Promise<void> {
    this.readinessTimeouts.push(timeoutMs);
    return this.waitUntilReadyError === undefined
      ? Promise.resolve()
      : Promise.reject(this.waitUntilReadyError);
  }

  agentHealth(token: string): Promise<unknown> {
    this.healthTokens.push(token);
    const ok = this.healthResults.shift() ?? true;
    return Promise.resolve(
      ok
        ? {
            ok: true,
            details: 'workspace agent ready',
            ...(this.legacyHealthPayload ? {} : { devServer: null }),
          }
        : { ok: false, details: 'workspace agent not ready' },
    );
  }

  tunnels(): Promise<Readonly<Record<number, { readonly url: string }>>> {
    return Promise.resolve({
      8877: { url: 'https://agent.modal.test/' },
      8080: { url: 'https://preview.modal.test/' },
    });
  }

  terminate(): Promise<void> {
    this.terminateCalls += 1;
    this.owner.present = false;
    return Promise.resolve();
  }

  agentRequest(request: AgentRequest): Promise<AgentResponse> {
    this.agentRequests.push(request);
    if (
      request.method === 'GET' &&
      request.path === '/healthz' &&
      this.devServerEvidence !== undefined
    ) {
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
    if (this.stallStreamAfterStarted) {
      const newline = response.body.indexOf(10);
      const firstRecord = response.body.subarray(0, newline + 1);
      const stalledStream = this.stalledStream.promise;
      return Promise.resolve({
        statusCode: response.statusCode,
        ...(response.contentType === undefined ? {} : { contentType: response.contentType }),
        body: {
          async *[Symbol.asyncIterator]() {
            yield firstRecord;
            await stalledStream;
          },
        },
        cancel: () => {
          this.streamCancelCalls += 1;
          return Promise.resolve();
        },
      });
    }
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

  releaseStalledStream(): void {
    this.stalledStream.resolve();
    this.stalledStream = createDeferredSignal();
  }
}

function createInputTags() {
  return {
    org_id: IDS.organizationId,
    project_id: IDS.projectId,
    branch_id: IDS.branchId,
    run_id: IDS.runId,
    task_id: IDS.taskId,
    purpose: 'builder',
    environment: 'zapp-dev',
  } as const;
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
        {
          type: 'started',
          pid: 41,
          executionId: '123e4567-e89b-42d3-a456-426614174000',
          at: NOW.toISOString(),
        },
        { type: 'stdout', data: 'hello', at: NOW.toISOString() },
        { type: 'exit', exitCode: 0, durationMs: 1, truncated: false, at: NOW.toISOString() },
      ];
      return {
        statusCode: 200,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n'),
      };
    }
    return jsonResponse({
      exitCode: 0,
      stdout: 'hello',
      stderr: '',
      durationMs: 1,
      truncated: false,
    });
  }
  if (key === 'POST /exec/41/kill') return jsonResponse({ killed: true });
  if (key === 'GET /files') {
    return {
      statusCode: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from('file bytes'),
    };
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
    return jsonResponse({
      dataBase64: Buffer.from('before').toString('base64'),
      revision: 'rev-1',
    });
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
    return jsonResponse({
      exitCode: 0,
      stdout: 'src/index.ts:1:needle\n',
      stderr: '',
      durationMs: 2,
      truncated: false,
    });
  }
  if (key === 'DELETE /files') return jsonResponse({ ok: true, alreadyAbsent: false });
  if (key === 'POST /files/rename') return jsonResponse({ ok: true });
  if (key === 'POST /dev-server/start') {
    return jsonResponse({
      port: 4173,
      pid: 71,
      supervisorId: 'supervisor-start',
      ownership: 'process_group',
    });
  }
  if (key === 'POST /dev-server/restart') {
    return jsonResponse({
      port: 4173,
      pid: 72,
      supervisorId: 'supervisor-restart',
      ownership: 'process_group',
    });
  }
  if (key === 'GET /dev-server/logs') {
    return jsonResponse({
      entries: [
        {
          cursor: 7,
          at: NOW.toISOString(),
          stream: 'stdout',
          message: 'ready\n',
        },
      ],
      nextCursor: 7,
      truncated: false,
      state: 'ready',
      failureId: null,
    });
  }
  throw new Error(`unexpected fake-agent request: ${key}`);
}

class FakeModalWorkspaceSdk implements ModalWorkspaceSdkPort {
  readonly sandbox = new FakeModalWorkspaceSandbox(this);
  readonly creates: ModalWorkspaceCreateOptions[] = [];
  closeCalls = 0;
  getWorkspaceCalls = 0;
  present = false;
  createError: Error | undefined;
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
      if (this.createError !== undefined) throw this.createError;
      this.present = true;
      return this.sandbox;
    });
  }

  getWorkspace(providerWorkspaceId: string): Promise<ModalWorkspaceSandbox | undefined> {
    this.getWorkspaceCalls += 1;
    return Promise.resolve(
      this.present && providerWorkspaceId === this.sandbox.providerWorkspaceId
        ? this.sandbox
        : undefined,
    );
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

class MemoryWorkspaceRows implements WorkspaceRowBoundary, PreviewMonitorCoordinator {
  readonly transitions: Array<{ status: WorkspaceStatus; providerWorkspaceId: string | null }> = [];
  replayClaims = 0;
  replayResolutions = 0;
  private readonly rows = new Map<string, WorkspaceLifecycleRow>();
  private readonly idempotency = new Map<string, string>();
  private readonly createWaiters = new Map<string, Array<(row: WorkspaceLifecycleRow) => void>>();
  private readonly attachments = new Map<string, Parameters<WorkspaceRowBoundary['claimCreate']>[2]>();
  private readonly previewMonitorOwners = new Map<string, string>();
  private readonly previewMonitorsEnabled = new Set<string>();
  private previewMonitorLeaseSequence = 0;
  failTransitionStatus: WorkspaceStatus | undefined;
  projectOwned = true;

  projectOwnedBy(projectId: string, organizationId: string): Promise<boolean> {
    return Promise.resolve(
      this.projectOwned &&
        projectId === IDS.projectId &&
        organizationId === IDS.organizationId,
    );
  }

  seed(row: WorkspaceLifecycleRow): void {
    this.rows.set(row.id, row);
    this.attachments.set(row.id, {
      resourceProfile: row.resourceProfile,
      imageTag: IMAGE_LOCK.environments.dev.images['forge-node-base'].publishedName,
      createdAt: row.createdAt,
      requiredTags: createInputTags(),
    });
    if (row.status === 'ready') this.previewMonitorsEnabled.add(row.id);
  }

  claimCreate(
    row: WorkspaceLifecycleRow,
    key: WorkspaceRowIdempotencyKey,
    attachment: Parameters<WorkspaceRowBoundary['claimCreate']>[2],
  ): Promise<WorkspaceRowClaim> {
    const serialized = `${key.runId}:${key.taskId}:${key.purpose}:${key.branchId}:${key.branchName}`;
    const existingId = this.idempotency.get(serialized);
    if (existingId !== undefined) {
      this.replayClaims += 1;
      const existing = this.rows.get(existingId);
      if (existing === undefined) throw new Error('idempotency row missing');
      if (existing.status !== 'ready' && existing.status !== 'terminated') {
        return new Promise((resolve) => {
          const waiters = this.createWaiters.get(existingId) ?? [];
          waiters.push((row) => {
            this.replayResolutions += 1;
            resolve({ created: false, row });
          });
          this.createWaiters.set(existingId, waiters);
        });
      }
      this.replayResolutions += 1;
      return Promise.resolve({ created: false, row: existing });
    }
    this.rows.set(row.id, row);
    this.attachments.set(row.id, attachment);
    this.idempotency.set(serialized, row.id);
    this.transitions.push({ status: row.status, providerWorkspaceId: row.providerWorkspaceId });
    return Promise.resolve({ created: true, row });
  }

  bindProviderWorkspaceId(
    workspaceId: string,
    providerWorkspaceId: string,
    expectedStatus: 'provisioning',
  ): Promise<WorkspaceLifecycleRow> {
    const row = this.rows.get(workspaceId);
    if (row === undefined) throw new Error('workspace missing');
    if (row.status !== expectedStatus) return Promise.resolve(row);
    const next = { ...row, providerWorkspaceId };
    this.rows.set(workspaceId, next);
    return Promise.resolve(next);
  }

  get(
    workspaceId: string,
    organizationId: string,
    projectId: string,
  ): Promise<WorkspaceLifecycleRow | undefined> {
    const row = this.rows.get(workspaceId);
    return Promise.resolve(
      row === undefined ||
        row.organizationId !== organizationId ||
        row.projectId !== projectId
        ? undefined
        : row,
    );
  }

  async getAttachment(
    workspaceId: string,
    organizationId: string,
    projectId: string,
  ) {
    const row = await this.get(workspaceId, organizationId, projectId);
    const attachment = this.attachments.get(workspaceId);
    return row === undefined || attachment === undefined
      ? undefined
      : { row, attachment };
  }

  listAttachments() {
    return Promise.resolve(
      [...this.rows.values()].flatMap((row) => {
        const attachment = this.attachments.get(row.id);
        return row.status === 'ready' &&
          row.providerWorkspaceId !== null &&
          attachment !== undefined &&
          this.previewMonitorsEnabled.has(row.id)
          ? [{ row, attachment }]
          : [];
      }),
    );
  }

  activateAndClaim(workspaceId: string, ownerId: string): Promise<string | undefined> {
    this.previewMonitorsEnabled.add(workspaceId);
    return this.claim(workspaceId, ownerId);
  }

  claim(workspaceId: string, ownerId: string): Promise<string | undefined> {
    if (!this.previewMonitorsEnabled.has(workspaceId)) return Promise.resolve(undefined);
    if (this.previewMonitorOwners.has(workspaceId)) return Promise.resolve(undefined);
    this.previewMonitorLeaseSequence += 1;
    const leaseToken = `${ownerId}:${String(this.previewMonitorLeaseSequence)}`;
    this.previewMonitorOwners.set(workspaceId, leaseToken);
    return Promise.resolve(leaseToken);
  }

  renew(workspaceId: string, leaseToken: string): Promise<boolean> {
    return Promise.resolve(
      this.previewMonitorsEnabled.has(workspaceId) &&
        this.previewMonitorOwners.get(workspaceId) === leaseToken,
    );
  }

  complete(workspaceId: string, leaseToken: string): Promise<boolean> {
    if (this.previewMonitorOwners.get(workspaceId) !== leaseToken) {
      return Promise.resolve(false);
    }
    this.previewMonitorsEnabled.delete(workspaceId);
    this.previewMonitorOwners.delete(workspaceId);
    return Promise.resolve(true);
  }

  revoke(workspaceId: string): Promise<void> {
    this.previewMonitorsEnabled.delete(workspaceId);
    this.previewMonitorOwners.delete(workspaceId);
    return Promise.resolve();
  }

  release(workspaceId: string, leaseToken: string): Promise<void> {
    if (this.previewMonitorOwners.get(workspaceId) === leaseToken) {
      this.previewMonitorOwners.delete(workspaceId);
    }
    return Promise.resolve();
  }

  isPreviewMonitorEnabled(workspaceId: string): boolean {
    return this.previewMonitorsEnabled.has(workspaceId);
  }

  transition(
    workspaceId: string,
    status: WorkspaceStatus,
    patch: { providerWorkspaceId?: string; terminatedAt?: Date } = {},
    expectedStatus?: WorkspaceStatus,
  ): Promise<WorkspaceLifecycleRow> {
    if (this.failTransitionStatus === status) {
      this.failTransitionStatus = undefined;
      return Promise.reject(new Error(`injected ${status} persistence failure`));
    }
    const row = this.rows.get(workspaceId);
    if (row === undefined) throw new Error('workspace missing');
    if (expectedStatus !== undefined && row.status !== expectedStatus) return Promise.resolve(row);
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
    if (next.status === 'ready' || next.status === 'terminated') {
      for (const resolve of this.createWaiters.get(workspaceId) ?? []) resolve(next);
      this.createWaiters.delete(workspaceId);
    }
    return Promise.resolve(next);
  }
}

describe('attach reattach recovery and ownership', () => {
  const apps: Array<{ close(): Promise<unknown> }> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('reattaches from persisted provider identity after a fresh provider instance and preserves exec/file access', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    const firstProvider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    const created = await firstProvider.createWorkspace(createInput());

    const restartedProvider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    const attached = await restartedProvider.attachWorkspace(created.providerWorkspaceId, {
      resourceProfile: 'small',
      imageTag: created.imageTag,
      createdAt: NOW,
      requiredTags: {
        org_id: IDS.organizationId,
        project_id: IDS.projectId,
        branch_id: IDS.branchId,
        run_id: IDS.runId,
        task_id: IDS.taskId,
        purpose: 'builder',
        environment: 'zapp-dev',
      },
    });

    expect(attached).toEqual(created);
    await expect(
      restartedProvider.exec({
        providerWorkspaceId: attached.providerWorkspaceId,
        command: 'printf',
        args: ['hello'],
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'hello' });
    await expect(restartedProvider.readFile(attached.providerWorkspaceId, 'src/index.ts')).resolves.toEqual(
      Buffer.from('file bytes'),
    );
    expect(sdk.creates).toHaveLength(1);
  });

  it('resolves the encrypted preview tunnel server-side without exposing agent infrastructure', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });

    await expect(provider.resolvePreviewTunnel(sdk.sandbox.providerWorkspaceId)).resolves.toEqual(
      new URL('https://preview.modal.test/'),
    );
    expect(sdk.getWorkspaceCalls).toBe(1);
    expect(sdk.closeCalls).toBe(1);
  });

  it('resolves child-only secrets and redacts buffered and split streaming output at the route boundary', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    sdk.sandbox.agentResponder = (request) => {
      if (request.method !== 'POST' || request.path !== '/exec') {
        return strictAgentResponse(request);
      }
      const body = JSON.parse(Buffer.from(request.body ?? []).toString('utf8')) as {
        env?: Record<string, string>;
      };
      expect(body.env).toEqual({
        STRIPE_KEY: 'stripe-value',
        ZAPP_SECRET_NAMES: '["STRIPE_KEY"]',
      });
      if (request.query?.stream === '1') {
        return {
          statusCode: 200,
          contentType: 'application/x-ndjson; charset=utf-8',
          body: Buffer.from(
            [
              {
                type: 'started',
                pid: 41,
                executionId: '123e4567-e89b-42d3-a456-426614174000',
                at: NOW.toISOString(),
              },
              { type: 'stdout', data: 'stripe-', at: NOW.toISOString() },
              { type: 'stdout', data: 'value', at: NOW.toISOString() },
              {
                type: 'exit',
                exitCode: 0,
                durationMs: 1,
                truncated: false,
                at: NOW.toISOString(),
              },
            ]
              .map((record) => JSON.stringify(record))
              .join('\n') + '\n',
          ),
        };
      }
      return jsonResponse({
        exitCode: 0,
        stdout: 'stripe-value',
        stderr: '',
        durationMs: 1,
        truncated: false,
      });
    };
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    const rows = new MemoryWorkspaceRows();
    rows.seed({
      ...requestedRow(),
      providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
      status: 'ready',
    });
    const decrypt = vi.fn(({ secretId }: { readonly secretId: string }) =>
      Promise.resolve({
        secret: {
          id: secretId,
          organizationId: IDS.organizationId,
          projectId: IDS.projectId,
          environmentId: 'env_01J8ME7YQZJ2V9Q0X3T5B6K7NG',
          name: 'STRIPE_KEY',
          keyVersion: 1,
        },
        value: 'stripe-value',
      }),
    );
    const options = {
      provider,
      rows,
      workspaceGit: WORKSPACE_GIT_FIXTURE,
      serviceTokens,
      secrets: createScopedSecretInjector({ decrypt }),
      networkPolicies: { record: vi.fn(() => Promise.resolve()) },
      now: () => NOW,
    };
    const app = buildTestApp(options);
    apps.push(app);
    await app.ready();
    const headers = {
      'x-zapp-service-token': SERVICE_TOKEN,
      'x-zapp-organization-id': IDS.organizationId,
      'x-zapp-project-id': IDS.projectId,
      'idempotency-key': OPERATION_KEY,
    };
    const payload = {
      command: 'node',
      args: ['-e', 'process.stdout.write(process.env.STRIPE_KEY ?? "")'],
      timeoutMs: 1_000,
      secretScope: {
        environmentId: 'env_01J8ME7YQZJ2V9Q0X3T5B6K7NG',
        secretIds: ['sec_01J8ME7YQZJ2V9Q0X3T5B6K7NH'],
      },
    };

    const buffered = await app.inject({
      method: 'POST',
      url: `/internal/workspaces/${IDS.workspaceId}/exec`,
      headers,
      payload,
    });
    expect(buffered.statusCode).toBe(200);
    expect(buffered.json()).toMatchObject({ stdout: '[secret:STRIPE_KEY]' });
    expect(buffered.body).not.toContain('stripe-value');

    const streamed = await app.inject({
      method: 'POST',
      url: `/internal/workspaces/${IDS.workspaceId}/exec?stream=1`,
      headers,
      payload,
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).toContain('[secret:STRIPE_KEY]');
    expect(streamed.body).not.toContain('stripe-value');
    expect(decrypt).toHaveBeenCalledTimes(2);

    const rawEnvironment = await app.inject({
      method: 'POST',
      url: `/internal/workspaces/${IDS.workspaceId}/exec`,
      headers,
      payload: { ...payload, env: { STRIPE_KEY: 'caller-value' } },
    });
    expect(rawEnvironment.statusCode).toBe(400);
  });

  it('rejects unknown and mismatched provider identity and keeps repeated attach read-only', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    const firstProvider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    const created = await firstProvider.createWorkspace(createInput());
    const attachment = {
      resourceProfile: 'small' as const,
      imageTag: created.imageTag,
      createdAt: NOW,
      requiredTags: createInputTags(),
    };
    const restartedProvider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });

    await expect(restartedProvider.attachWorkspace('sb-unknown', attachment)).rejects.toMatchObject({
      name: 'ModalWorkspaceNotFoundError',
    });
    sdk.sandbox.tags = { ...createInputTags(), project_id: `${IDS.projectId}-wrong` };
    await expect(
      restartedProvider.attachWorkspace(created.providerWorkspaceId, attachment),
    ).rejects.toMatchObject({ name: 'ModalWorkspaceTagMismatchError' });

    sdk.sandbox.tags = createInputTags();
    const [first, second] = await Promise.all([
      restartedProvider.attachWorkspace(created.providerWorkspaceId, attachment),
      restartedProvider.attachWorkspace(created.providerWorkspaceId, attachment),
    ]);
    expect(first).toEqual(created);
    expect(second).toEqual(created);
    expect(sdk.creates).toHaveLength(1);
    expect(sdk.sandbox.terminateCalls).toBe(0);
  });

  it('persists provider identity early but keeps duplicate create waiting through Git bootstrap', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    let releaseHealth = (): void => undefined;
    const healthBarrier = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      clockMs: () => 0,
      sleep: () => healthBarrier,
    });
    const rows = new MemoryWorkspaceRows();
    let gitBootstrapStarted = (): void => undefined;
    const bootstrapStarted = new Promise<void>((resolve) => {
      gitBootstrapStarted = resolve;
    });
    let releaseGitBootstrap = (): void => undefined;
    const gitBootstrapBarrier = new Promise<void>((resolve) => {
      releaseGitBootstrap = resolve;
    });
    const workspaceGit = {
      ...WORKSPACE_GIT_FIXTURE,
      async bootstrap(): Promise<void> {
        gitBootstrapStarted();
        await gitBootstrapBarrier;
      },
    };
    const app = buildTestApp({ provider, rows, workspaceGit, serviceTokens, now: () => NOW });
    apps.push(app);
    await app.ready();

    const creation = app.inject({
      method: 'POST',
      url: '/internal/workspaces',
      headers: {
        'x-zapp-service-token': SERVICE_TOKEN,
        'x-zapp-organization-id': IDS.organizationId,
        'x-zapp-project-id': IDS.projectId,
        'idempotency-key': OPERATION_KEY,
      },
      payload: {
        workspace: requestedRow(),
        branchName: 'main',
        runId: IDS.runId,
        taskId: IDS.taskId,
        purpose: 'builder',
        env: {},
        networkProfile: 'dependency_install',
        operationKey: OPERATION_KEY,
      },
    });
    await vi.waitFor(async () => {
      await expect(
        rows.get(IDS.workspaceId, IDS.organizationId, IDS.projectId),
      ).resolves.toMatchObject({
        status: 'provisioning',
        providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
      });
    });
    releaseHealth();
    await bootstrapStarted;
    const replay = app.inject({
      method: 'POST',
      url: '/internal/workspaces',
      headers: {
        'x-zapp-service-token': SERVICE_TOKEN,
        'x-zapp-organization-id': IDS.organizationId,
        'x-zapp-project-id': IDS.projectId,
        'idempotency-key': OPERATION_KEY,
      },
      payload: {
        workspace: requestedRow(),
        branchName: 'main',
        runId: IDS.runId,
        taskId: IDS.taskId,
        purpose: 'builder',
        env: {},
        networkProfile: 'dependency_install',
        operationKey: OPERATION_KEY,
      },
    });
    await vi.waitFor(() => {
      expect(rows.replayClaims).toBe(1);
    });
    expect(rows.replayResolutions).toBe(0);
    releaseGitBootstrap();
    const [created, replayed] = await Promise.all([creation, replay]);
    expect(created.statusCode).toBe(201);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ workspace: { status: 'ready' } });
  });

  it('reattaches a workspace from its persisted immutable image after the service lock advances', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    const nextLock = structuredClone(IMAGE_LOCK) as unknown as {
      version: 1;
      environments: Record<string, unknown>;
    };
    nextLock.environments.dev = {
      ...IMAGE_LOCK.environments.dev,
      sourceRevision: 'b'.repeat(40),
      tag: '2026-08-09-bbbbbbb',
      images: {
        ...IMAGE_LOCK.environments.dev.images,
        'forge-node-base': {
          ...IMAGE_LOCK.environments.dev.images['forge-node-base'],
          digest: 'im-next-immutable',
          publishedName: 'forge-node-base:2026-08-09-bbbbbbb',
        },
      },
    };
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: nextLock,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });

    await expect(
      provider.attachWorkspace(sdk.sandbox.providerWorkspaceId, {
        resourceProfile: 'small',
        imageTag: IMAGE_LOCK.environments.dev.images['forge-node-base'].publishedName,
        createdAt: NOW,
        requiredTags: createInputTags(),
      }),
    ).resolves.toMatchObject({
      imageTag: IMAGE_LOCK.environments.dev.images['forge-node-base'].publishedName,
      status: 'ready',
    });
  });

  it('reattaches a provisioning row server-side, enforces tenant/project ownership, and hides provider identity', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    const created = await provider.createWorkspace(createInput());
    const rows = new MemoryWorkspaceRows();
    rows.seed({
      ...requestedRow(),
      providerWorkspaceId: created.providerWorkspaceId,
      status: 'provisioning',
    });
    const app = buildTestApp({ provider, rows, workspaceGit: WORKSPACE_GIT_FIXTURE, serviceTokens, now: () => NOW });
    apps.push(app);
    await app.ready();
    const headers = {
      'x-zapp-service-token': SERVICE_TOKEN,
      'x-zapp-organization-id': IDS.organizationId,
      'x-zapp-project-id': IDS.projectId,
      'idempotency-key': OPERATION_KEY,
    };

    const crossTenant = await app.inject({
      method: 'POST',
      url: `/internal/workspaces/${IDS.workspaceId}/attach`,
      headers: { ...headers, 'x-zapp-organization-id': 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NZ' },
      payload: { operationKey: OPERATION_KEY },
    });
    expect(crossTenant.statusCode).toBe(404);
    const crossProject = await app.inject({
      method: 'POST',
      url: `/internal/workspaces/${IDS.workspaceId}/attach`,
      headers: { ...headers, 'x-zapp-project-id': 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NZ' },
      payload: { operationKey: OPERATION_KEY },
    });
    expect(crossProject.statusCode).toBe(404);

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/internal/workspaces/${IDS.workspaceId}/attach`,
        headers,
        payload: { operationKey: OPERATION_KEY },
      }),
      app.inject({
        method: 'POST',
        url: `/internal/workspaces/${IDS.workspaceId}/attach`,
        headers,
        payload: { operationKey: OPERATION_KEY },
      }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    for (const response of [first, second]) {
      const body = response.json<{ workspace: Record<string, unknown> }>();
      expect(body.workspace.status).toBe('ready');
      expect(body.workspace).not.toHaveProperty('providerWorkspaceId');
      expect(JSON.stringify(body)).not.toContain(created.providerWorkspaceId);
      expect(JSON.stringify(body)).not.toContain('127.0.0.1');
    }
    expect(rows.transitions.map(({ status }) => status)).toEqual(['started', 'ready']);
    expect(sdk.creates).toHaveLength(1);

    const exec = await app.inject({
      method: 'POST',
      url: `/internal/workspaces/${IDS.workspaceId}/exec`,
      headers,
      payload: { command: 'printf', args: ['hello'], timeoutMs: 1_000 },
    });
    expect(exec.statusCode).toBe(200);
    expect(exec.json()).toMatchObject({ exitCode: 0, stdout: 'hello' });
    const file = await app.inject({
      method: 'GET',
      url: `/internal/workspaces/${IDS.workspaceId}/files?path=src/index.ts`,
      headers,
    });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload).toEqual(Buffer.from('file bytes'));
  });

  it('reconciles unknown, terminated, unready, disappeared, and mismatched provider state without replacement', async () => {
    const cases = [
      { name: 'unknown provider', mode: 'unknown', expectedStatus: 404 },
      { name: 'required tag mismatch', mode: 'tags', expectedStatus: 404 },
      { name: 'readiness timeout', mode: 'timeout', expectedStatus: 502 },
      { name: 'provider disappearance', mode: 'disappear', expectedStatus: 404 },
      { name: 'provider disappearance during tags', mode: 'tags-disappear', expectedStatus: 404 },
      { name: 'post-attach unready provider', mode: 'started', expectedStatus: 502 },
      { name: 'terminated row disagreement', mode: 'terminated-row', expectedStatus: 404 },
    ] as const;

    for (const testCase of cases) {
      const sdk = new FakeModalWorkspaceSdk();
      sdk.present = testCase.mode !== 'unknown';
      if (testCase.mode === 'tags') {
        sdk.sandbox.tags = { ...createInputTags(), org_id: `${IDS.organizationId}-wrong` };
      }
      if (testCase.mode === 'timeout') {
        sdk.sandbox.waitUntilReadyError = new Error('readiness deadline exceeded');
      }
      if (testCase.mode === 'disappear') sdk.sandbox.disappearAfterTags = true;
      if (testCase.mode === 'tags-disappear') sdk.sandbox.disappearDuringTags = true;
      if (testCase.mode === 'started') sdk.sandbox.healthResults = [true, false];
      const provider = createModalSandboxProvider({
        environment: 'dev',
        imageLock: IMAGE_LOCK,
        agentToken: AGENT_TOKEN,
        sdkFactory: () => sdk,
        now: () => NOW,
        sleep: () => Promise.resolve(),
      });
      const rows = new MemoryWorkspaceRows();
      rows.seed({
        ...requestedRow(),
        providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
        status: testCase.mode === 'terminated-row' ? 'terminated' : 'ready',
        terminatedAt: testCase.mode === 'terminated-row' ? NOW : null,
      });
      const app = buildTestApp({ provider, rows, workspaceGit: WORKSPACE_GIT_FIXTURE, serviceTokens, now: () => NOW });
      apps.push(app);
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: `/internal/workspaces/${IDS.workspaceId}/attach`,
        headers: {
          'x-zapp-service-token': SERVICE_TOKEN,
          'x-zapp-organization-id': IDS.organizationId,
          'x-zapp-project-id': IDS.projectId,
          'idempotency-key': OPERATION_KEY,
        },
        payload: { operationKey: OPERATION_KEY },
      });

      expect(response.statusCode, testCase.name).toBe(testCase.expectedStatus);
      await expect(
        rows.get(IDS.workspaceId, IDS.organizationId, IDS.projectId),
      ).resolves.toMatchObject({
        status: 'terminated',
        terminatedAt: NOW,
      });
      expect(sdk.creates, testCase.name).toHaveLength(0);
      if (testCase.mode === 'tags') expect(sdk.sandbox.terminateCalls).toBe(0);
      if (testCase.mode === 'terminated-row') expect(sdk.sandbox.terminateCalls).toBe(1);
    }
  });

  const hasModalCredentials =
    typeof process.env.MODAL_TOKEN_ID === 'string' &&
    process.env.MODAL_TOKEN_ID !== '' &&
    typeof process.env.MODAL_TOKEN_SECRET === 'string' &&
    process.env.MODAL_TOKEN_SECRET !== '';

  it.skipIf(!hasModalCredentials)(
    'injects and redacts one app-child secret through the locked Modal image [skipped without MODAL_TOKEN_ID and MODAL_TOKEN_SECRET]',
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
        agentToken: `ws11-${Date.now().toString(36)}`,
      });
      let created: WorkspaceHandle | undefined;
      try {
        created = await provider.createWorkspace({
          ...createInput(),
          imageTag: lock.environments.dev.images['forge-node-base'].publishedName,
        });
        const rows = new MemoryWorkspaceRows();
        rows.seed({
          ...requestedRow(),
          providerWorkspaceId: created.providerWorkspaceId,
          status: 'ready',
        });
        const app = buildTestApp({
          provider,
          rows,
          workspaceGit: WORKSPACE_GIT_FIXTURE,
          serviceTokens,
          secrets: createScopedSecretInjector({
            decrypt: ({ secretId }) =>
              Promise.resolve({
                secret: {
                  id: secretId,
                  organizationId: IDS.organizationId,
                  projectId: IDS.projectId,
                  environmentId: 'env_01J8ME7YQZJ2V9Q0X3T5B6K7NG',
                  name: 'STRIPE_KEY',
                  keyVersion: 1,
                },
                value: 'ws11-redaction-sentinel',
              }),
          }),
          now: () => NOW,
        });
        apps.push(app);
        await app.ready();
        const response = await app.inject({
          method: 'POST',
          url: `/internal/workspaces/${IDS.workspaceId}/exec`,
          headers: {
            'x-zapp-service-token': SERVICE_TOKEN,
            'x-zapp-organization-id': IDS.organizationId,
            'x-zapp-project-id': IDS.projectId,
            'idempotency-key': OPERATION_KEY,
          },
          payload: {
            command: 'node',
            args: ['-e', 'process.stdout.write(process.env.STRIPE_KEY ?? "missing")'],
            timeoutMs: 10_000,
            secretScope: {
              environmentId: 'env_01J8ME7YQZJ2V9Q0X3T5B6K7NG',
              secretIds: ['sec_01J8ME7YQZJ2V9Q0X3T5B6K7NH'],
            },
          },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ stdout: '[secret:STRIPE_KEY]' });
        expect(response.body).not.toContain('ws11-redaction-sentinel');
      } finally {
        if (created !== undefined) await provider.terminateWorkspace(created.providerWorkspaceId);
      }
    },
    60_000,
  );

  it.skipIf(!hasModalCredentials)(
    'reattaches a real Modal sandbox after provider restart [skipped without MODAL_TOKEN_ID and MODAL_TOKEN_SECRET]',
    async () => {
      const lock = JSON.parse(
        await readFile(
          new URL('../../../../infra/modal/images.lock.json', import.meta.url),
          'utf8',
        ),
      ) as typeof IMAGE_LOCK;
      const agentToken = `ws4c-${Date.now().toString(36)}`;
      const firstProvider = createModalSandboxProvider({
        environment: 'dev',
        imageLock: lock,
        agentToken,
      });
      let created: WorkspaceHandle | undefined;
      try {
        created = await firstProvider.createWorkspace({
          ...createInput(),
          imageTag: lock.environments.dev.images['forge-node-base'].publishedName,
        });
        await firstProvider.writeFile(
          created.providerWorkspaceId,
          'ws4c-reattach.txt',
          Buffer.from('reattached\n'),
        );

        const restartedProvider = createModalSandboxProvider({
          environment: 'dev',
          imageLock: lock,
          agentToken,
        });
        const attached = await restartedProvider.attachWorkspace(created.providerWorkspaceId, {
          resourceProfile: 'small',
          imageTag: created.imageTag,
          createdAt: new Date(created.createdAt),
          requiredTags: createInputTags(),
        });
        expect(attached).toEqual(created);
        await expect(
          restartedProvider.exec({
            providerWorkspaceId: attached.providerWorkspaceId,
            command: 'printf',
            args: ['reattached'],
            timeoutMs: 5_000,
          }),
        ).resolves.toMatchObject({ exitCode: 0, stdout: 'reattached' });
        await expect(
          restartedProvider.readFile(attached.providerWorkspaceId, 'ws4c-reattach.txt'),
        ).resolves.toEqual(Buffer.from('reattached\n'));
      } finally {
        if (created !== undefined) {
          await firstProvider.terminateWorkspace(created.providerWorkspaceId);
        }
      }
      expect(await firstProvider.getStatus(created.providerWorkspaceId)).toBe('terminated');
    },
    120_000,
  );
});

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
    const [creation] = sdk.creates;
    expect(creation).toBeDefined();
    if (creation === undefined) throw new Error('workspace create input missing');
    const { command, ...creationWithoutCommand } = creation;
    expect(creation.sandboxName).toMatch(/^zapp-writer-[a-f0-9]{32}$/);
    expect(command.slice(0, 4)).toEqual([
      '/usr/bin/dumb-init',
      '--',
      '/bin/bash',
      '-lc',
    ]);
    expect(command[4]).toContain(`/workspace/${IDS.branchId}/.zapp-writer.lock`);
    expect({ ...creationWithoutCommand, sandboxName: '<stable-hash>' }).toEqual(
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
          ZAPP_WORKSPACE_ROOT: `/workspace/${IDS.branchId}`,
          NPM_CONFIG_STORE_DIR: '/cache/pnpm',
          PNPM_STORE_DIR: '/cache/pnpm',
          PLAYWRIGHT_BROWSERS_PATH: '/cache/ms-playwright',
        },
        sandboxName: '<stable-hash>',
        volume: {
          name: `vol-proj_${IDS.projectId}`,
          mounts: [
            { mountPath: '/cache', subPath: '/cache' },
          ],
        },
        encryptedPorts: [8877, 8080],
        readinessProbe: { kind: 'tcp', port: 8877, intervalMs: 250 },
        timeoutMs: 14_400_000,
      },
    );
    expect(sdk.sandbox.readinessTimeouts).toEqual([30_000]);
    expect(sdk.sandbox.healthTokens).toEqual(['agent-test-token', 'agent-test-token']);
    expect(await provider.getStatus(handle.providerWorkspaceId)).toBe('ready');

    await provider.terminateWorkspace(handle.providerWorkspaceId);
    await provider.terminateWorkspace(handle.providerWorkspaceId);
    expect(sdk.sandbox.terminateCalls).toBe(1);
    expect(await provider.getStatus(handle.providerWorkspaceId)).toBe('terminated');
  });

  it('accepts the locked c58 image health payload without managed-dev-server evidence', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.sandbox.healthResults = [true];
    sdk.sandbox.legacyHealthPayload = true;
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

    expect(handle.status).toBe('ready');
    await provider.terminateWorkspace(handle.providerWorkspaceId);
  });

  it('selects the web-test image and seeds its pinned browsers into the project cache for verifier workspaces', async () => {
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

    const handle = await provider.createWorkspace({
      ...createInput(),
      purpose: 'verifier',
      imageTag: IMAGE_LOCK.environments.dev.images['forge-web-test'].publishedName,
    });

    expect(handle.imageTag).toBe('forge-web-test:2026-08-08-c58a416');
    expect(sdk.creates[0]).toMatchObject({
      appName: 'zapp-workspaces',
      digest: 'im-eVxjg43Gv7bQrkH0CbwrrX',
      publishedName: 'forge-web-test:2026-08-08-c58a416',
    });
    expect(sdk.creates[0]?.command[4]).toContain('/ms-playwright');
    expect(sdk.creates[0]?.command[4]).toContain('/cache/ms-playwright');
    expect(sdk.creates[0]?.command[4]).toContain('ln -s');
    expect(sdk.creates[0]?.command[4]).not.toContain('cp -a');
    await provider.terminateWorkspace(handle.providerWorkspaceId);
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

  it('returns 409 and releases the failed row when the branch already has an active writer', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.createError = new BranchLockedError(IDS.branchId);
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    const rows = new MemoryWorkspaceRows();
    const app = buildTestApp({
      provider,
      rows,
      workspaceGit: WORKSPACE_GIT_FIXTURE,
      serviceTokens,
      now: () => NOW,
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/internal/workspaces',
      headers: {
        'x-zapp-service-token': SERVICE_TOKEN,
        'x-zapp-organization-id': IDS.organizationId,
        'x-zapp-project-id': IDS.projectId,
        'idempotency-key': OPERATION_KEY,
      },
      payload: {
        workspace: requestedRow(),
        branchName: 'main',
        runId: IDS.runId,
        taskId: IDS.taskId,
        purpose: 'builder',
        env: {},
        networkProfile: 'dependency_install',
        operationKey: OPERATION_KEY,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'branch_locked',
      message: 'The branch already has an active writer.',
    });
    await expect(
      rows.get(IDS.workspaceId, IDS.organizationId, IDS.projectId),
    ).resolves.toMatchObject({ status: 'terminated', providerWorkspaceId: null });
  });

  it('returns 404 before claiming or creating when the durable project ownership lookup fails', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
    });
    const rows = new MemoryWorkspaceRows();
    rows.projectOwned = false;
    const app = buildTestApp({
      provider,
      rows,
      workspaceGit: WORKSPACE_GIT_FIXTURE,
      serviceTokens,
      now: () => NOW,
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/internal/workspaces',
      headers: {
        'x-zapp-service-token': SERVICE_TOKEN,
        'x-zapp-organization-id': IDS.organizationId,
        'x-zapp-project-id': IDS.projectId,
        'idempotency-key': OPERATION_KEY,
      },
      payload: {
        workspace: requestedRow(),
        branchName: 'main',
        runId: IDS.runId,
        taskId: IDS.taskId,
        purpose: 'builder',
        env: {},
        networkProfile: 'dependency_install',
        operationKey: OPERATION_KEY,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(sdk.creates).toHaveLength(0);
    expect(rows.transitions).toHaveLength(0);
  });

  it('records the complete network policy before provider allocation and fails closed when recording fails', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    const rows = new MemoryWorkspaceRows();
    const record = vi.fn(() => Promise.resolve());
    const app = buildTestApp({
      provider,
      rows,
      workspaceGit: WORKSPACE_GIT_FIXTURE,
      serviceTokens,
      networkPolicies: { record },
      now: () => NOW,
    });
    apps.push(app);
    await app.ready();
    const request = {
      method: 'POST' as const,
      url: '/internal/workspaces',
      headers: {
        'x-zapp-service-token': SERVICE_TOKEN,
        'x-zapp-organization-id': IDS.organizationId,
        'x-zapp-project-id': IDS.projectId,
        'idempotency-key': OPERATION_KEY,
      },
      payload: {
        workspace: requestedRow(),
        branchName: 'main',
        runId: IDS.runId,
        taskId: IDS.taskId,
        purpose: 'builder' as const,
        env: {},
        networkProfile: 'dependency_install' as const,
        integrationDomains: ['api.stripe.com'],
        operationKey: OPERATION_KEY,
      },
    };

    const response = await app.inject(request);
    expect(response.statusCode).toBe(201);
    expect(record).toHaveBeenCalledWith({
      operationKey: OPERATION_KEY,
      organizationId: IDS.organizationId,
      projectId: IDS.projectId,
      workspaceId: IDS.workspaceId,
      policy: {
        profile: 'dependency_install',
        outboundDomains: ['api.stripe.com', 'github.com', 'registry.npmjs.org'],
        blockAll: false,
      },
      providerEnforced: false,
      recordedAt: NOW,
    });
    const blockedSdk = new FakeModalWorkspaceSdk();
    const blockedRows = new MemoryWorkspaceRows();
    const blocked = buildTestApp({
      provider: createModalSandboxProvider({
        environment: 'dev',
        imageLock: IMAGE_LOCK,
        agentToken: AGENT_TOKEN,
        sdkFactory: () => blockedSdk,
      }),
      rows: blockedRows,
      workspaceGit: WORKSPACE_GIT_FIXTURE,
      serviceTokens,
      networkPolicies: { record: () => Promise.reject(new Error('audit unavailable')) },
      now: () => NOW,
    });
    apps.push(blocked);
    await blocked.ready();
    const blockedResponse = await blocked.inject(request);
    expect(blockedResponse.statusCode).toBe(500);
    expect(blockedSdk.creates).toHaveLength(0);
    expect(blockedRows.transitions).toHaveLength(0);
  });

  it.each([
    {
      name: 'organization header is missing',
      headers: { 'x-zapp-project-id': IDS.projectId },
    },
    {
      name: 'project header is missing',
      headers: { 'x-zapp-organization-id': IDS.organizationId },
    },
    {
      name: 'organization header differs from the workspace row',
      headers: {
        'x-zapp-organization-id': OTHER_ORGANIZATION_ID,
        'x-zapp-project-id': IDS.projectId,
      },
    },
    {
      name: 'project header differs from the workspace row',
      headers: {
        'x-zapp-organization-id': IDS.organizationId,
        'x-zapp-project-id': OTHER_PROJECT_ID,
      },
    },
  ])('rejects create before persistence or provider access when $name', async ({ headers }) => {
    const sdk = new FakeModalWorkspaceSdk();
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    const rows = new MemoryWorkspaceRows();
    const app = buildTestApp({ provider, rows, workspaceGit: WORKSPACE_GIT_FIXTURE, serviceTokens, now: () => NOW });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/internal/workspaces',
      headers: {
        'x-zapp-service-token': SERVICE_TOKEN,
        'idempotency-key': OPERATION_KEY,
        ...headers,
      },
      payload: {
        workspace: requestedRow(),
        branchName: 'main',
        runId: IDS.runId,
        taskId: IDS.taskId,
        purpose: 'builder',
        env: {},
        networkProfile: 'dependency_install',
        operationKey: OPERATION_KEY,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(sdk.creates).toHaveLength(0);
    expect(rows.transitions).toHaveLength(0);
  });

  it.each([
    {
      name: 'status across organizations',
      method: 'GET' as const,
      path: '',
      organizationId: OTHER_ORGANIZATION_ID,
      projectId: IDS.projectId,
    },
    {
      name: 'status across projects',
      method: 'GET' as const,
      path: '',
      organizationId: IDS.organizationId,
      projectId: OTHER_PROJECT_ID,
    },
    {
      name: 'terminate across organizations',
      method: 'POST' as const,
      path: '/terminate',
      organizationId: OTHER_ORGANIZATION_ID,
      projectId: IDS.projectId,
    },
    {
      name: 'terminate across projects',
      method: 'POST' as const,
      path: '/terminate',
      organizationId: IDS.organizationId,
      projectId: OTHER_PROJECT_ID,
    },
  ])('returns 404 without row or provider disclosure for $name', async (testCase) => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    const rows = new MemoryWorkspaceRows();
    rows.seed({
      ...requestedRow(),
      providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
      status: 'ready',
    });
    const app = buildTestApp({ provider, rows, workspaceGit: WORKSPACE_GIT_FIXTURE, serviceTokens, now: () => NOW });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: testCase.method,
      url: `/internal/workspaces/${IDS.workspaceId}${testCase.path}`,
      headers: {
        'x-zapp-service-token': SERVICE_TOKEN,
        'x-zapp-organization-id': testCase.organizationId,
        'x-zapp-project-id': testCase.projectId,
        'idempotency-key': OPERATION_KEY,
      },
      ...(testCase.method === 'POST' ? { payload: { operationKey: OPERATION_KEY } } : {}),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: 'workspace_not_found',
      message: 'Workspace was not found.',
    });
    expect(response.body).not.toContain(IDS.workspaceId);
    expect(response.body).not.toContain(sdk.sandbox.providerWorkspaceId);
    expect(sdk.getWorkspaceCalls).toBe(0);
    expect(sdk.sandbox.terminateCalls).toBe(0);
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
    const app = buildTestApp({ provider, rows, workspaceGit: WORKSPACE_GIT_FIXTURE, serviceTokens, now: () => NOW });
    apps.push(app);
    await app.ready();
    const body = {
      workspace: requestedRow(),
      branchName: 'main',
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
      'x-zapp-project-id': IDS.projectId,
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
      headers: {
        'x-zapp-service-token': SERVICE_TOKEN,
        'x-zapp-organization-id': IDS.organizationId,
        'x-zapp-project-id': IDS.projectId,
      },
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
    const app = buildTestApp({ provider, rows, workspaceGit: WORKSPACE_GIT_FIXTURE, serviceTokens, now: () => NOW });
    apps.push(app);
    await app.ready();
    const headers = {
      'x-zapp-service-token': SERVICE_TOKEN,
      'x-zapp-organization-id': IDS.organizationId,
      'x-zapp-project-id': IDS.projectId,
      'idempotency-key': OPERATION_KEY,
    };
    const payload = {
      workspace: requestedRow(),
      branchName: 'main',
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
    const app = buildTestApp({ provider, rows, workspaceGit: WORKSPACE_GIT_FIXTURE, serviceTokens, now: () => NOW });
    apps.push(app);
    await app.ready();
    const request = {
      method: 'POST',
      url: '/internal/workspaces',
      headers: {
        'x-zapp-service-token': SERVICE_TOKEN,
        'x-zapp-organization-id': IDS.organizationId,
        'x-zapp-project-id': IDS.projectId,
        'idempotency-key': OPERATION_KEY,
      },
      payload: {
        workspace: requestedRow(),
        branchName: 'main',
        runId: IDS.runId,
        taskId: IDS.taskId,
        purpose: 'builder',
        env: {},
        networkProfile: 'dependency_install',
        operationKey: OPERATION_KEY,
      },
    } as const;
    const response = await app.inject(request);

    expect(response.statusCode).toBe(502);
    expect(sdk.sandbox.terminateCalls).toBe(1);
    expect(rows.transitions.at(-1)).toEqual({
      status: 'terminated',
      providerWorkspaceId: 'sb-modal-4a',
    });
    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(502);
    expect(sdk.creates).toHaveLength(1);
  });

  it('requires service authentication and rejects missing idempotency or extra boundary fields', async () => {
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: 'agent-test-token',
      sdkFactory: () => new FakeModalWorkspaceSdk(),
    });
    const rows = new MemoryWorkspaceRows();
    const app = buildTestApp({ provider, rows, workspaceGit: WORKSPACE_GIT_FIXTURE, serviceTokens, now: () => NOW });
    apps.push(app);
    await app.ready();
    const validBody = {
      workspace: requestedRow(),
      branchName: 'main',
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

  it.skipIf(!hasModalCredentials)(
    'proxies preview health through the locked real Modal tunnel [skipped without MODAL_TOKEN_ID and MODAL_TOKEN_SECRET]',
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
        agentToken: `ws12-${Date.now().toString(36)}`,
      });
      const transport = createFetchPreviewTransport(provider);
      let handle: WorkspaceHandle | undefined;
      try {
        handle = await provider.createWorkspace({
          ...createInput(),
          imageTag: lock.environments.dev.images['forge-node-base'].publishedName,
        });
        const response = await transport.request({
          providerWorkspaceId: handle.providerWorkspaceId,
          method: 'GET',
          path: '/__zapp/healthz',
          publicOrigin: new URL('https://acceptance.preview.zapp.test'),
          headers: { accept: 'application/json' },
        });
        const chunks: Buffer[] = [];
        for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual({ status: 'ok' });
        expect(JSON.stringify(response)).not.toContain('modal');
      } finally {
        if (handle !== undefined) await provider.terminateWorkspace(handle.providerWorkspaceId);
      }
    },
    120_000,
  );

  it.skipIf(!hasModalCredentials)(
    'enforces one active writer per branch on the project Volume [skipped without MODAL_TOKEN_ID and MODAL_TOKEN_SECRET]',
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
        agentToken: `ws9-${Date.now().toString(36)}`,
      });
      let first: WorkspaceHandle | undefined;
      let otherBranch: WorkspaceHandle | undefined;
      try {
        first = await provider.createWorkspace({
          ...createInput(),
          imageTag: lock.environments.dev.images['forge-node-base'].publishedName,
        });
        await expect(
          provider.createWorkspace({
            ...createInput(),
            runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NX',
            taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NY',
            imageTag: lock.environments.dev.images['forge-node-base'].publishedName,
          }),
        ).rejects.toBeInstanceOf(BranchLockedError);
        otherBranch = await provider.createWorkspace({
          ...createInput(),
          branchId: 'br_01J8ME7YQZJ2V9Q0X3T5B6K7NZ',
          runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NZ',
          taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NZ',
          imageTag: lock.environments.dev.images['forge-node-base'].publishedName,
        });
        expect(await provider.getStatus(otherBranch.providerWorkspaceId)).toBe('ready');
      } finally {
        if (first !== undefined) await provider.terminateWorkspace(first.providerWorkspaceId);
        if (otherBranch !== undefined) {
          await provider.terminateWorkspace(otherBranch.providerWorkspaceId);
        }
      }
    },
    180_000,
  );
});

describe('agent proxy and unguarded conformance', () => {
  const hasModalCredentials =
    typeof process.env.MODAL_TOKEN_ID === 'string' &&
    process.env.MODAL_TOKEN_ID !== '' &&
    typeof process.env.MODAL_TOKEN_SECRET === 'string' &&
    process.env.MODAL_TOKEN_SECRET !== '';

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
      provider.killExec(providerWorkspaceId, 41, '123e4567-e89b-42d3-a456-426614174000'),
    ).resolves.toEqual({ killed: true });
    await expect(provider.readFile(providerWorkspaceId, 'src/space name.ts')).resolves.toEqual(
      Buffer.from('file bytes'),
    );
    await provider.writeFile(providerWorkspaceId, 'src/index.ts', Buffer.from('next'));
    await expect(
      provider.listFiles(providerWorkspaceId, '.', { glob: '*.ts', maxDepth: 2 }),
    ).resolves.toEqual([{ path: 'src/index.ts', type: 'file' }]);
    await expect(
      provider.git(providerWorkspaceId, { operation: 'status', args: ['--short'] }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: 'clean',
      stderr: '',
    });
    await expect(provider.health(providerWorkspaceId)).resolves.toMatchObject({ ok: true });
    await expect(provider.metrics(providerWorkspaceId)).resolves.toMatchObject({
      activeChildren: 0,
    });
    const beforeGuardedSnapshot = sdk.sandbox.agentRequests.length;
    await expect(
      provider.readFileForUpdate(providerWorkspaceId, 'src/index.ts'),
    ).rejects.toMatchObject({
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
    await expect(provider.startDevServer(providerWorkspaceId, EXECUTION_CONTRACT)).resolves.toEqual(
      {
        port: 4173,
        pid: 71,
        supervisorId: 'supervisor-start',
        ownership: 'process_group',
      },
    );
    await expect(
      provider.restartDevServer(providerWorkspaceId, EXECUTION_CONTRACT),
    ).resolves.toEqual({
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
        ? jsonResponse({
            ...JSON.parse(Buffer.from(strictAgentResponse(request).body).toString('utf8')),
            extra: true,
          })
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

  it('settles an aborted stream even when the Modal body read never settles', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    sdk.sandbox.stallStreamAfterStarted = true;
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
    });
    const abort = new AbortController();
    const records: WorkspaceAgentStreamRecord[] = [];
    const consumption = (async () => {
      for await (const record of provider.execStream(
        {
          providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
          command: 'sleep',
          args: ['30'],
          timeoutMs: 30_000,
        },
        undefined,
        abort.signal,
      )) {
        records.push(record);
        if (record.type === 'started') abort.abort();
      }
    })();

    try {
      await expect(
        within(consumption, 100, 'Aborted stream remained blocked on its Modal body read.'),
      ).resolves.toBeUndefined();
      expect(records).toHaveLength(1);
      expect(sdk.sandbox.agentRequests.map(({ path }) => path)).toEqual([
        '/exec',
        '/exec/41/kill',
      ]);
      expect(sdk.sandbox.streamCancelCalls).toBeGreaterThan(0);
    } finally {
      sdk.sandbox.releaseStalledStream();
      await consumption.catch(() => undefined);
    }
  });

  it('WS-13 maps cursor logs and emits idempotent attributed preview lifecycle events', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
    }) as unknown as AgentProxyProvider;
    const rows = new MemoryWorkspaceRows();
    await rows.claimCreate(
      requestedRow(),
      {
        runId: IDS.runId,
        taskId: IDS.taskId,
        purpose: 'builder',
        branchId: IDS.branchId,
        branchName: 'main',
      },
      {
        resourceProfile: 'small',
        imageTag: IMAGE_LOCK.environments.dev.images['forge-node-base'].publishedName,
        createdAt: NOW,
        requiredTags: createInputTags(),
      },
    );
    await rows.transition(IDS.workspaceId, 'started', {
      providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
    });
    await rows.transition(IDS.workspaceId, 'ready');

    await expect(
      provider.readDevServerLogs(sdk.sandbox.providerWorkspaceId, { after: 6, limit: 10 }),
    ).resolves.toMatchObject({
      entries: [{ cursor: 7, stream: 'stdout', message: 'ready\n' }],
      nextCursor: 7,
      state: 'ready',
    });
    expect(sdk.sandbox.agentRequests.at(-1)).toMatchObject({
      method: 'GET',
      path: '/dev-server/logs',
      query: { after: '6', limit: '10' },
    });

    const storedEvents: Array<{
      eventKey: string;
      type: string;
      organizationId: string;
      projectId: string;
      runId: string;
      taskId?: string;
      payload: Record<string, unknown>;
    }> = [];
    const eventKeys = new Set<string>();
    const events = {
      emit: vi.fn((event: (typeof storedEvents)[number]) => {
        if (!eventKeys.has(event.eventKey)) {
          eventKeys.add(event.eventKey);
          storedEvents.push(event);
        }
        return Promise.resolve();
      }),
    };
    const app = buildTestApp({
      provider,
      rows,
      workspaceGit: WORKSPACE_GIT_FIXTURE,
      serviceTokens,
      events,
      previewFailurePollIntervalMs: 5,
      now: () => NOW,
    } as never);
    await app.ready();
    const headers = {
      'x-zapp-service-token': SERVICE_TOKEN,
      'x-zapp-organization-id': IDS.organizationId,
      'x-zapp-project-id': IDS.projectId,
      'idempotency-key': OPERATION_KEY,
    };
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.inject({
          method: 'POST',
          url: `/internal/workspaces/${IDS.workspaceId}/dev-server/start`,
          headers,
          payload: { contract: EXECUTION_CONTRACT },
        });
        expect(response.statusCode).toBe(200);
      }
      const logs = await app.inject({
        method: 'GET',
        url: `/internal/workspaces/${IDS.workspaceId}/dev-server/logs?after=6&limit=10`,
        headers: {
          'x-zapp-service-token': SERVICE_TOKEN,
          'x-zapp-organization-id': IDS.organizationId,
          'x-zapp-project-id': IDS.projectId,
        },
      });
      expect(logs.statusCode).toBe(200);
      expect(logs.json()).toMatchObject({ nextCursor: 7, state: 'ready' });
      expect(storedEvents.map(({ type }) => type)).toEqual([
        'preview.starting',
        'preview.ready',
      ]);
      expect(storedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            organizationId: IDS.organizationId,
            projectId: IDS.projectId,
            runId: IDS.runId,
            taskId: IDS.taskId,
          }),
        ]),
      );
      expect(JSON.stringify(storedEvents)).not.toContain(sdk.sandbox.providerWorkspaceId);

      const transientReadyFailure = vi.fn((event: (typeof storedEvents)[number]) => {
        if (event.type === 'preview.ready' && transientReadyFailure.mock.calls.length === 2) {
          return Promise.reject(new Error('CP-13 unavailable'));
        }
        if (!eventKeys.has(event.eventKey)) {
          eventKeys.add(event.eventKey);
          storedEvents.push(event);
        }
        return Promise.resolve();
      });
      events.emit.mockImplementation(transientReadyFailure);
      const retryKey = `op_${'c'.repeat(64)}`;
      const readyDeliveryFailed = await app.inject({
        method: 'POST',
        url: `/internal/workspaces/${IDS.workspaceId}/dev-server/start`,
        headers: { ...headers, 'idempotency-key': retryKey },
        payload: { contract: EXECUTION_CONTRACT },
      });
      expect(readyDeliveryFailed.statusCode).toBe(500);
      expect(storedEvents.filter(({ type }) => type === 'preview.failed')).toHaveLength(0);
      const readyRetry = await app.inject({
        method: 'POST',
        url: `/internal/workspaces/${IDS.workspaceId}/dev-server/start`,
        headers: { ...headers, 'idempotency-key': retryKey },
        payload: { contract: EXECUTION_CONTRACT },
      });
      expect(readyRetry.statusCode).toBe(200);
      expect(storedEvents.filter(({ type }) => type === 'preview.ready')).toHaveLength(2);

      sdk.sandbox.agentResponder = (request) =>
        request.path === '/dev-server/logs'
          ? jsonResponse({
              entries: [],
              nextCursor: 7,
              truncated: false,
              state: 'failed',
              failureId: 'devfail_supervisor-start',
            })
          : strictAgentResponse(request);
      await vi.waitFor(() => {
        expect(
          storedEvents.filter(
            ({ type, payload }) =>
              type === 'preview.failed' && payload.code === 'restart_limit_exceeded',
          ),
        ).toHaveLength(1);
      });
      const terminalDeliveriesBeforeRead = events.emit.mock.calls.filter(
        ([event]) =>
          event.type === 'preview.failed' &&
          event.payload.code === 'restart_limit_exceeded',
      ).length;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const terminalLogs = await app.inject({
          method: 'GET',
          url: `/internal/workspaces/${IDS.workspaceId}/dev-server/logs?after=7&limit=10`,
          headers: {
            'x-zapp-service-token': SERVICE_TOKEN,
            'x-zapp-organization-id': IDS.organizationId,
            'x-zapp-project-id': IDS.projectId,
          },
        });
        expect(terminalLogs.statusCode).toBe(200);
      }
      expect(
        events.emit.mock.calls.filter(
          ([event]) =>
            event.type === 'preview.failed' &&
            event.payload.code === 'restart_limit_exceeded',
        ),
      ).toHaveLength(terminalDeliveriesBeforeRead);
      expect(
        storedEvents.filter(
          ({ type, payload }) =>
            type === 'preview.failed' && payload.code === 'restart_limit_exceeded',
        ),
      ).toHaveLength(1);

      sdk.sandbox.agentResponder = (request) =>
        request.path === '/dev-server/restart'
          ? jsonResponse({ error: 'restart failed' }, 500)
          : strictAgentResponse(request);
      const failed = await app.inject({
        method: 'POST',
        url: `/internal/workspaces/${IDS.workspaceId}/dev-server/restart`,
        headers: { ...headers, 'idempotency-key': `op_${'b'.repeat(64)}` },
        payload: { contract: EXECUTION_CONTRACT },
      });
      expect(failed.statusCode).toBe(500);
      expect(storedEvents.map(({ type }) => type)).toEqual([
        'preview.starting',
        'preview.ready',
        'preview.starting',
        'preview.ready',
        'preview.failed',
        'preview.starting',
        'preview.failed',
      ]);
    } finally {
      await app.close();
    }
  });

  it('WS-13 restores terminal monitoring after service restart without a logs request', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    let logPolls = 0;
    sdk.sandbox.agentResponder = (request) => {
      if (request.path === '/dev-server/logs') {
        logPolls += 1;
        return jsonResponse({
          entries: [],
          nextCursor: 0,
          truncated: false,
          state: 'failed',
          failureId: 'devfail_restored-supervisor',
        });
      }
      return strictAgentResponse(request);
    };
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
    }) as unknown as AgentProxyProvider;
    const rows = new MemoryWorkspaceRows();
    rows.seed({
      ...requestedRow(),
      status: 'ready',
      providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
    });
    const stored: string[] = [];
    const app = buildTestApp({
      provider,
      rows,
      workspaceGit: WORKSPACE_GIT_FIXTURE,
      serviceTokens,
      events: {
        emit: (event: { readonly eventKey: string }) => {
          stored.push(event.eventKey);
          return Promise.resolve();
        },
      },
      previewFailurePollIntervalMs: 5,
      now: () => NOW,
    } as never);
    try {
      await app.ready();
      await vi.waitFor(() => {
        expect(stored).toEqual([
          `ws13:failure:${IDS.workspaceId}:devfail_restored-supervisor`,
        ]);
      });
      expect(logPolls).toBeGreaterThan(0);
      await vi.waitFor(() => {
        expect(rows.isPreviewMonitorEnabled(IDS.workspaceId)).toBe(false);
      });
    } finally {
      await app.close();
    }
  });

  it('WS-13 stops restored monitoring after confirmed workspace termination', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    let logPolls = 0;
    sdk.sandbox.agentResponder = (request) => {
      if (request.path === '/dev-server/logs') {
        logPolls += 1;
        return jsonResponse({
          entries: [],
          nextCursor: 0,
          truncated: false,
          state: 'ready',
          failureId: null,
        });
      }
      return strictAgentResponse(request);
    };
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
    }) as unknown as AgentProxyProvider;
    const rows = new MemoryWorkspaceRows();
    rows.seed({
      ...requestedRow(),
      status: 'ready',
      providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
    });
    const app = buildTestApp({
      provider,
      rows,
      workspaceGit: WORKSPACE_GIT_FIXTURE,
      serviceTokens,
      previewFailurePollIntervalMs: 5,
      now: () => NOW,
    } as never);
    try {
      await app.ready();
      await vi.waitFor(() => {
        expect(logPolls).toBeGreaterThan(0);
      });
      const terminated = await app.inject({
        method: 'POST',
        url: `/internal/workspaces/${IDS.workspaceId}/terminate`,
        headers: {
          'x-zapp-service-token': SERVICE_TOKEN,
          'x-zapp-organization-id': IDS.organizationId,
          'x-zapp-project-id': IDS.projectId,
          'idempotency-key': OPERATION_KEY,
        },
        payload: { operationKey: OPERATION_KEY },
      });
      expect(terminated.statusCode).toBe(200);
      const pollsAtTermination = logPolls;
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(logPolls).toBe(pollsAtTermination);
    } finally {
      await app.close();
    }
  });

  it('WS-13 keeps one durable monitor owner and termination through another replica stops it', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    sdk.sandbox.agentResponder = (request) =>
      request.path === '/dev-server/logs'
        ? jsonResponse({
            entries: [],
            nextCursor: 0,
            truncated: false,
            state: 'ready',
            failureId: null,
          })
        : strictAgentResponse(request);
    const rows = new MemoryWorkspaceRows();
    rows.seed({
      ...requestedRow(),
      status: 'ready',
      providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
    });
    const ownerByWorkspace = new Map<string, string>();
    const leaseByWorkspace = new Map<string, string>();
    const enabled = new Set<string>([IDS.workspaceId]);
    let leaseSequence = 0;
    const previewMonitors = {
      activateAndClaim(workspaceId: string, ownerId: string) {
        enabled.add(workspaceId);
        return this.claim(workspaceId, ownerId);
      },
      claim(workspaceId: string, ownerId: string) {
        if (!enabled.has(workspaceId) || ownerByWorkspace.has(workspaceId)) {
          return Promise.resolve(undefined);
        }
        leaseSequence += 1;
        const leaseToken = `${ownerId}:${String(leaseSequence)}`;
        ownerByWorkspace.set(workspaceId, ownerId);
        leaseByWorkspace.set(workspaceId, leaseToken);
        return Promise.resolve(leaseToken);
      },
      renew(workspaceId: string, leaseToken: string) {
        return Promise.resolve(
          enabled.has(workspaceId) && leaseByWorkspace.get(workspaceId) === leaseToken,
        );
      },
      complete(workspaceId: string, leaseToken: string) {
        if (leaseByWorkspace.get(workspaceId) !== leaseToken) return Promise.resolve(false);
        enabled.delete(workspaceId);
        ownerByWorkspace.delete(workspaceId);
        leaseByWorkspace.delete(workspaceId);
        return Promise.resolve(true);
      },
      revoke(workspaceId: string) {
        enabled.delete(workspaceId);
        ownerByWorkspace.delete(workspaceId);
        leaseByWorkspace.delete(workspaceId);
        return Promise.resolve();
      },
      release(workspaceId: string, leaseToken: string) {
        if (leaseByWorkspace.get(workspaceId) === leaseToken) {
          ownerByWorkspace.delete(workspaceId);
          leaseByWorkspace.delete(workspaceId);
        }
        return Promise.resolve();
      },
    };
    let firstReplicaPolls = 0;
    let secondReplicaPolls = 0;
    let thirdReplicaPolls = 0;
    const terminalEventKeys: string[] = [];
    let staleReadStarted!: () => void;
    const staleReadIsActive = new Promise<void>((resolve) => {
      staleReadStarted = resolve;
    });
    let resolveStaleRead!: (
      value: Awaited<ReturnType<AgentProxyProvider['readDevServerLogs']>>,
    ) => void;
    const staleRead = new Promise<
      Awaited<ReturnType<AgentProxyProvider['readDevServerLogs']>>
    >((resolve) => {
      resolveStaleRead = resolve;
    });
    const providerFor = (count: () => void, blockFirstRead = false): AgentProxyProvider => {
      const replica = createModalSandboxProvider({
        environment: 'dev',
        imageLock: IMAGE_LOCK,
        agentToken: AGENT_TOKEN,
        sdkFactory: () => sdk,
      }) as unknown as AgentProxyProvider;
      const readLogs = replica.readDevServerLogs.bind(replica);
      let blocked = false;
      replica.readDevServerLogs = (...args) => {
        count();
        if (blockFirstRead && !blocked) {
          blocked = true;
          staleReadStarted();
          return staleRead;
        }
        return readLogs(...args);
      };
      return replica;
    };
    const common = {
      rows,
      workspaceGit: WORKSPACE_GIT_FIXTURE,
      serviceTokens,
      previewFailurePollIntervalMs: 5,
      previewMonitorStandbyPollIntervalMs: 5,
      previewMonitorLeaseMs: 25,
      previewMonitors,
      events: {
        emit(event: { readonly eventKey: string }) {
          terminalEventKeys.push(event.eventKey);
          return Promise.resolve();
        },
      },
      now: () => NOW,
    } as const;
    const first = buildTestApp({
      ...common,
      provider: providerFor(() => {
        firstReplicaPolls += 1;
      }, true),
      previewMonitorOwnerId: 'sandbox-replica-a',
    } as never);
    const second = buildTestApp({
      ...common,
      provider: providerFor(() => {
        secondReplicaPolls += 1;
      }),
      previewMonitorOwnerId: 'sandbox-replica-b',
    } as never);
    const appsToClose = new Set<ReturnType<typeof buildTestApp>>([first, second]);
    try {
      await first.ready();
      await staleReadIsActive;
      await second.ready();
      expect(ownerByWorkspace.get(IDS.workspaceId)).toBe('sandbox-replica-a');
      await first.close();
      appsToClose.delete(first);
      await vi.waitFor(() => {
        expect(ownerByWorkspace.get(IDS.workspaceId)).toBe('sandbox-replica-b');
        expect(secondReplicaPolls).toBeGreaterThan(0);
      });
      resolveStaleRead({
        entries: [],
        nextCursor: 0,
        truncated: false,
        state: 'failed',
        failureId: 'devfail_stale-owner',
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(terminalEventKeys).toEqual([]);

      const third = buildTestApp({
        ...common,
        provider: providerFor(() => {
          thirdReplicaPolls += 1;
        }),
        previewMonitorOwnerId: 'sandbox-replica-c',
      } as never);
      appsToClose.add(third);
      await third.ready();
      expect(thirdReplicaPolls).toBe(0);
      const terminated = await third.inject({
        method: 'POST',
        url: `/internal/workspaces/${IDS.workspaceId}/terminate`,
        headers: {
          'x-zapp-service-token': SERVICE_TOKEN,
          'x-zapp-organization-id': IDS.organizationId,
          'x-zapp-project-id': IDS.projectId,
          'idempotency-key': OPERATION_KEY,
        },
        payload: { operationKey: OPERATION_KEY },
      });
      expect(terminated.statusCode).toBe(200);
      const pollsAtTermination = firstReplicaPolls + secondReplicaPolls + thirdReplicaPolls;
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      expect(firstReplicaPolls + secondReplicaPolls + thirdReplicaPolls).toBe(
        pollsAtTermination,
      );
      expect(ownerByWorkspace.has(IDS.workspaceId)).toBe(false);
    } finally {
      await Promise.all(
        [...appsToClose].map(async (app) => {
          await app.close();
        }),
      );
    }
  });

  it('WS-13 releases a standby claim that completes during app shutdown', async () => {
    const sdk = new FakeModalWorkspaceSdk();
    sdk.present = true;
    let logPolls = 0;
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: IMAGE_LOCK,
      agentToken: AGENT_TOKEN,
      sdkFactory: () => sdk,
    }) as unknown as AgentProxyProvider;
    provider.readDevServerLogs = () => {
      logPolls += 1;
      return Promise.resolve({
        entries: [],
        nextCursor: 0,
        truncated: false,
        state: 'ready',
        failureId: null,
      });
    };
    const rows = new MemoryWorkspaceRows();
    rows.seed({
      ...requestedRow(),
      status: 'ready',
      providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
    });
    let claimCalls = 0;
    let lateClaimStarted!: () => void;
    const claimIsPending = new Promise<void>((resolve) => {
      lateClaimStarted = resolve;
    });
    let resolveLateClaim!: (leaseToken: string) => void;
    const lateClaim = new Promise<string>((resolve) => {
      resolveLateClaim = resolve;
    });
    const released: string[] = [];
    const previewMonitors = {
      activateAndClaim: () => Promise.resolve('unexpected-activation'),
      claim: () => {
        claimCalls += 1;
        if (claimCalls === 1) return Promise.resolve(undefined);
        lateClaimStarted();
        return lateClaim;
      },
      renew: () => Promise.resolve(false),
      complete: () => Promise.resolve(false),
      revoke: () => Promise.resolve(),
      release: (_workspaceId: string, leaseToken: string) => {
        released.push(leaseToken);
        return Promise.resolve();
      },
    };
    const app = buildTestApp({
      provider,
      rows,
      workspaceGit: WORKSPACE_GIT_FIXTURE,
      serviceTokens,
      previewMonitors,
      previewMonitorOwnerId: 'closing-replica',
      previewFailurePollIntervalMs: 5,
      previewMonitorStandbyPollIntervalMs: 5,
      now: () => NOW,
    } as never);

    await app.ready();
    await claimIsPending;
    const closing = app.close();
    resolveLateClaim('lease-completed-during-close');
    await closing;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(logPolls).toBe(0);
    expect(released).toEqual(['lease-completed-during-close']);
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
      branchId: IDS.branchId,
      branchName: 'main',
    }, {
      resourceProfile: 'small',
      imageTag: IMAGE_LOCK.environments.dev.images['forge-node-base'].publishedName,
      createdAt: NOW,
      requiredTags: createInputTags(),
    });
    await rows.transition(IDS.workspaceId, 'started', {
      providerWorkspaceId: sdk.sandbox.providerWorkspaceId,
    });
    await rows.transition(IDS.workspaceId, 'ready');
    const app = buildTestApp({ provider, rows, workspaceGit: WORKSPACE_GIT_FIXTURE, serviceTokens, now: () => NOW });
    await app.ready();
    const headers = {
      'x-zapp-service-token': SERVICE_TOKEN,
      'x-zapp-organization-id': IDS.organizationId,
      'x-zapp-project-id': IDS.projectId,
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
          'x-zapp-project-id': IDS.projectId,
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
      expect(sdk.sandbox.agentRequests.some((request) => request.path.includes('attacker'))).toBe(
        false,
      );
    } finally {
      await app.close();
    }
  });

  it.skipIf(!hasModalCredentials)(
    'runs the bounded live WS-13 supervisor acceptance [skipped without MODAL_TOKEN_ID and MODAL_TOKEN_SECRET]',
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
        agentToken: `ws13-${Date.now().toString(36)}`,
      });
      let handle: WorkspaceHandle | undefined;
      const abortListener = new AbortController();
      let unrelatedListener: Promise<void> | undefined;
      let unrelatedListenerSettled: Promise<void> | undefined;

      try {
        handle = await provider.createWorkspace({
          ...createInput(),
          branchId: newId('br'),
          imageTag: lock.environments.dev.images['forge-node-base'].publishedName,
        });
        const providerWorkspaceId = handle.providerWorkspaceId;
        const managedPort = 43_175;
        const managedScript = `require('node:http').createServer((_request, response) => response.end('ready')).listen(${String(managedPort)}, '127.0.0.1'); setInterval(() => {}, 1000);`;
        const managedContract: ExecutionContract = {
          ...EXECUTION_CONTRACT,
          install: { command: 'true' },
          develop: {
            command: `node -e ${JSON.stringify(managedScript)}`,
            port: managedPort,
          },
        };

        const started = await provider.startDevServer(providerWorkspaceId, managedContract);
        expect(started).toMatchObject({ port: managedPort, ownership: 'process_group' });
        const restarted = await provider.restartDevServer(providerWorkspaceId, managedContract);
        expect(restarted).toMatchObject({ port: managedPort, ownership: 'process_group' });
        expect(restarted.pid).not.toBe(started.pid);
        expect(restarted.supervisorId).not.toBe(started.supervisorId);

        const unrelatedPort = 43_176;
        let resolveListenerReady = (): void => undefined;
        let rejectListenerReady: (error: unknown) => void = () => undefined;
        const listenerReady = new Promise<void>((resolveReady, rejectReady) => {
          resolveListenerReady = resolveReady;
          rejectListenerReady = rejectReady;
        });
        let observedStarted = false;
        let observedReady = false;
        let unrelatedPid: number | undefined;
        unrelatedListener = (async () => {
          try {
            for await (const record of provider.execStream(
              {
                providerWorkspaceId,
                command: 'node',
                args: [
                  '-e',
                  `require('node:http').createServer((_request, response) => response.end('unrelated')).listen(${String(unrelatedPort)}, '127.0.0.1', () => console.log('listener-ready')); setInterval(() => {}, 1000);`,
                ],
                timeoutMs: 30_000,
              },
              undefined,
              abortListener.signal,
            )) {
              if (record.type === 'started') {
                unrelatedPid = record.pid;
                observedStarted = true;
              }
              if (record.type === 'stdout' && record.data.includes('listener-ready')) {
                observedReady = true;
              }
              if (observedStarted && observedReady) resolveListenerReady();
            }
            if (!observedStarted || !observedReady) {
              rejectListenerReady(new Error('Unrelated listener stream ended before readiness.'));
            }
          } catch (error) {
            rejectListenerReady(error);
            throw error;
          }
        })();
        unrelatedListenerSettled = unrelatedListener.then(
          () => undefined,
          () => undefined,
        );
        await within(
          listenerReady,
          15_000,
          'Timed out waiting for the unrelated listener readiness evidence.',
        );
        const unrelatedContract: ExecutionContract = {
          ...EXECUTION_CONTRACT,
          install: { command: 'true' },
          develop: {
            command: `node -e ${JSON.stringify('setInterval(() => {}, 1000);')}`,
            port: unrelatedPort,
          },
        };
        await expect(
          provider.startDevServer(providerWorkspaceId, unrelatedContract),
        ).rejects.toThrow();
        abortListener.abort();
        await expect(
          within(
            unrelatedListener,
            10_000,
            'Timed out waiting for the unrelated listener to stop after abort.',
          ),
        ).resolves.toBeUndefined();
        expect(unrelatedPid).toBeGreaterThan(0);
        await expect(
          provider.exec({
            providerWorkspaceId,
            command: 'sh',
            args: ['-lc', `kill -0 ${String(unrelatedPid)} 2>/dev/null`],
            timeoutMs: 10_000,
          }),
        ).resolves.toMatchObject({ exitCode: 1 });
      } finally {
        abortListener.abort();
        try {
          if (handle !== undefined) await provider.terminateWorkspace(handle.providerWorkspaceId);
        } finally {
          if (unrelatedListenerSettled !== undefined) {
            await within(
              unrelatedListenerSettled,
              5_000,
              'Timed out waiting for the unrelated listener during cleanup.',
            ).catch(() => undefined);
          }
        }
      }
    },
    120_000,
  );

  it.skipIf(!hasModalCredentials)(
    'runs the live Modal unguarded conformance matrix [skipped without MODAL_TOKEN_ID and MODAL_TOKEN_SECRET]',
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
        agentToken: `ws4b-${Date.now().toString(36)}`,
      });
      const prefix = `ws4b-${Date.now().toString(36)}`;
      let handle: WorkspaceHandle | undefined;

      try {
        handle = await provider.createWorkspace({
          ...createInput(),
          imageTag: lock.environments.dev.images['forge-node-base'].publishedName,
        });
        const providerWorkspaceId = handle.providerWorkspaceId;
        const run = (command: string, args: string[], timeoutMs = 10_000) =>
          provider.exec({ providerWorkspaceId, command, args, timeoutMs });
        const atomicPath = `${prefix}-atomic.txt`;
        const sourcePath = `${prefix}-source.txt`;
        const destinationPath = `${prefix}-destination.txt`;

        await provider.writeFilesAtomically(providerWorkspaceId, [
          { path: atomicPath, data: Buffer.from('live atomic marker\n') },
          { path: sourcePath, data: Buffer.from('live rename marker\n') },
          { path: destinationPath, data: Buffer.from('replace me\n') },
        ]);
        await expect(provider.readFile(providerWorkspaceId, atomicPath)).resolves.toEqual(
          Buffer.from('live atomic marker\n'),
        );
        await expect(
          provider.search(providerWorkspaceId, {
            pattern: 'live atomic marker',
            path: atomicPath,
            fixedStrings: true,
          }),
        ).resolves.toMatchObject({ exitCode: 0, stderr: '', truncated: false });
        await provider.renameFile(providerWorkspaceId, {
          source: sourcePath,
          destination: destinationPath,
          overwrite: 'replace',
        });
        await expect(provider.readFile(providerWorkspaceId, destinationPath)).resolves.toEqual(
          Buffer.from('live rename marker\n'),
        );
        await expect(provider.deleteFile(providerWorkspaceId, atomicPath)).resolves.toEqual({
          alreadyAbsent: false,
        });
        await expect(provider.deleteFile(providerWorkspaceId, atomicPath)).resolves.toEqual({
          alreadyAbsent: true,
        });

        const serializedPath = `${prefix}-serialized.txt`;
        await provider.writeFile(providerWorkspaceId, serializedPath, Buffer.from('before\n'));
        const serializationFillers = Array.from({ length: 500 }, (_, index) => ({
          path: `${prefix}-serialization-filler-${String(index)}`,
          data: Buffer.alloc(0),
        }));
        let resolveSerializationWatcherStarted = (): void => undefined;
        let resolveSerializationStageSeen = (): void => undefined;
        const serializationWatcherStarted = new Promise<void>((resolveStarted) => {
          resolveSerializationWatcherStarted = resolveStarted;
        });
        const serializationStageSeen = new Promise<void>((resolveSeen) => {
          resolveSerializationStageSeen = resolveSeen;
        });
        const serializationWatcher = (async () => {
          for await (const record of provider.execStream({
            providerWorkspaceId,
            command: 'sh',
            args: [
              '-lc',
              "while ! find /workspace -maxdepth 1 -name '.zapp-atomic-*.stage' -print -quit | grep -q .; do :; done; printf 'stage-seen\\n'",
            ],
            timeoutMs: 30_000,
          })) {
            if (record.type === 'started') resolveSerializationWatcherStarted();
            if (record.type === 'stdout' && record.data.includes('stage-seen')) {
              resolveSerializationStageSeen();
            }
          }
        })();
        await serializationWatcherStarted;
        const atomicWrite = provider.writeFilesAtomically(providerWorkspaceId, [
          ...serializationFillers,
          { path: serializedPath, data: Buffer.from('atomic\n') },
        ]);
        await serializationStageSeen;
        const ordinaryWrite = provider.writeFile(
          providerWorkspaceId,
          serializedPath,
          Buffer.from('ordinary\n'),
        );
        await Promise.all([atomicWrite, ordinaryWrite, serializationWatcher]);
        await expect(provider.readFile(providerWorkspaceId, serializedPath)).resolves.toEqual(
          Buffer.from('ordinary\n'),
        );
        await expect(
          run('sh', ['-lc', `rm -f /workspace/${prefix}-serialization-filler-*`]),
        ).resolves.toMatchObject({ exitCode: 0 });

        const modePath = `${prefix}-mode.sh`;
        await provider.writeFile(providerWorkspaceId, modePath, Buffer.from('before\n'));
        await expect(run('chmod', ['640', `/workspace/${modePath}`])).resolves.toMatchObject({
          exitCode: 0,
        });
        await provider.writeFilesAtomically(providerWorkspaceId, [
          { path: modePath, data: Buffer.from('after\n') },
        ]);
        await expect(run('stat', ['-c', '%a', `/workspace/${modePath}`])).resolves.toMatchObject({
          exitCode: 0,
          stdout: '640\n',
        });

        const aliasTarget = `${prefix}-alias-target.txt`;
        const hardAlias = `${prefix}-hard-alias.txt`;
        const leafAlias = `${prefix}-leaf-alias.txt`;
        const realParent = `${prefix}-real`;
        const aliasParent = `${prefix}-parent-alias`;
        await provider.writeFile(providerWorkspaceId, aliasTarget, Buffer.from('alias before\n'));
        await expect(
          run('sh', [
            '-lc',
            `ln /workspace/${aliasTarget} /workspace/${hardAlias} && ln -s ${aliasTarget} /workspace/${leafAlias} && mkdir /workspace/${realParent} && ln -s ${realParent} /workspace/${aliasParent} && printf canonical > /workspace/${realParent}/canonical.txt`,
          ]),
        ).resolves.toMatchObject({ exitCode: 0 });
        for (const files of [
          [
            { path: aliasTarget, data: Buffer.from('lexical one\n') },
            { path: `./${aliasTarget}`, data: Buffer.from('lexical two\n') },
          ],
          [
            { path: aliasTarget, data: Buffer.from('inode one\n') },
            { path: hardAlias, data: Buffer.from('inode two\n') },
          ],
          [
            { path: `${realParent}/canonical.txt`, data: Buffer.from('canonical one\n') },
            { path: `${aliasParent}/canonical.txt`, data: Buffer.from('canonical two\n') },
          ],
          [{ path: leafAlias, data: Buffer.from('leaf mutation\n') }],
        ]) {
          await expect(provider.writeFilesAtomically(providerWorkspaceId, files)).rejects.toThrow(
            'Workspace agent rejected the request with status 400',
          );
        }
        await expect(provider.readFile(providerWorkspaceId, aliasTarget)).resolves.toEqual(
          Buffer.from('alias before\n'),
        );
        await expect(run('readlink', [`/workspace/${leafAlias}`])).resolves.toMatchObject({
          exitCode: 0,
          stdout: `${aliasTarget}\n`,
        });

        const caseUpper = `${prefix}-CaseFold.txt`;
        const caseLower = `${prefix}-casefold.txt`;
        const composed = `${prefix}-caf\u00e9.txt`;
        const decomposed = `${prefix}-cafe\u0301.txt`;
        await provider.writeFilesAtomically(providerWorkspaceId, [
          { path: caseUpper, data: Buffer.from('upper\n') },
          { path: caseLower, data: Buffer.from('lower\n') },
          { path: composed, data: Buffer.from('composed\n') },
          { path: decomposed, data: Buffer.from('decomposed\n') },
        ]);
        await expect(provider.readFile(providerWorkspaceId, caseUpper)).resolves.toEqual(
          Buffer.from('upper\n'),
        );
        await expect(provider.readFile(providerWorkspaceId, caseLower)).resolves.toEqual(
          Buffer.from('lower\n'),
        );
        await expect(provider.readFile(providerWorkspaceId, composed)).resolves.toEqual(
          Buffer.from('composed\n'),
        );
        await expect(provider.readFile(providerWorkspaceId, decomposed)).resolves.toEqual(
          Buffer.from('decomposed\n'),
        );

        const rollbackPath = `${prefix}-rollback.txt`;
        const rollbackBlocker = `${prefix}-rollback-blocker`;
        await provider.writeFile(
          providerWorkspaceId,
          rollbackPath,
          Buffer.from('rollback before\n'),
        );
        await expect(run('chmod', ['640', `/workspace/${rollbackPath}`])).resolves.toMatchObject({
          exitCode: 0,
        });
        let resolveFlipperReady = (): void => undefined;
        const flipperReady = new Promise<void>((resolveReady) => {
          resolveFlipperReady = resolveReady;
        });
        let flipperOutput = '';
        const flipper = (async () => {
          for await (const record of provider.execStream({
            providerWorkspaceId,
            command: 'sh',
            args: [
              '-lc',
              `printf 'rollback-watcher-ready\n'; while ! find /workspace -maxdepth 1 -name '.zapp-atomic-*-0.stage' -print -quit | grep -q .; do :; done; mkdir /workspace/${rollbackBlocker} && printf 'rollback-injected\n'`,
            ],
            timeoutMs: 30_000,
          })) {
            if (record.type === 'stdout') {
              flipperOutput += record.data;
              if (flipperOutput.includes('rollback-watcher-ready\n')) resolveFlipperReady();
            }
          }
        })();
        await flipperReady;
        let rollbackError: unknown;
        const rollbackRequest = provider
          .writeFilesAtomically(providerWorkspaceId, [
            { path: rollbackPath, data: Buffer.alloc(8 * 1_024 * 1_024, 'a') },
            { path: rollbackBlocker, data: Buffer.from('blocked\n') },
          ])
          .catch((error: unknown) => {
            rollbackError = error;
          });
        await flipper;
        expect(flipperOutput).toContain('rollback-injected\n');
        await rollbackRequest;
        expect(rollbackError).toBeInstanceOf(Error);
        await expect(provider.readFile(providerWorkspaceId, rollbackPath)).resolves.toEqual(
          Buffer.from('rollback before\n'),
        );
        await expect(
          run('stat', ['-c', '%a', `/workspace/${rollbackPath}`]),
        ).resolves.toMatchObject({
          exitCode: 0,
          stdout: '640\n',
        });
        await expect(
          provider.listFiles(providerWorkspaceId, '.', {
            glob: '.zapp-atomic-*',
            maxDepth: 1,
          }),
        ).resolves.toEqual([]);
        await expect(
          provider.search(providerWorkspaceId, {
            pattern: 'not present',
            path: destinationPath,
            fixedStrings: true,
          }),
        ).resolves.toMatchObject({ exitCode: 1, stdout: '', truncated: false });
        await expect(
          provider.search(providerWorkspaceId, { pattern: 'outside', path: '../outside' }),
        ).rejects.toThrow();

        await expect(provider.deleteFile(providerWorkspaceId, rollbackBlocker)).rejects.toThrow();
        await expect(run('rmdir', [`/workspace/${rollbackBlocker}`])).resolves.toMatchObject({
          exitCode: 0,
        });
        const absentPath = `${prefix}-absent.txt`;
        await expect(provider.deleteFile(providerWorkspaceId, absentPath)).resolves.toEqual({
          alreadyAbsent: true,
        });
        await expect(provider.deleteFile(providerWorkspaceId, absentPath)).resolves.toEqual({
          alreadyAbsent: true,
        });

        await expect(
          provider.renameFile(providerWorkspaceId, {
            source: aliasTarget,
            destination: hardAlias,
            overwrite: 'replace',
          }),
        ).rejects.toThrow();
        await expect(
          provider.renameFile(providerWorkspaceId, {
            source: destinationPath,
            destination: `./${destinationPath}`,
            overwrite: 'replace',
          }),
        ).rejects.toThrow();

        const guardedPath = `${prefix}-guarded.txt`;
        await provider.writeFile(providerWorkspaceId, guardedPath, Buffer.from('guarded before\n'));
        await expect(
          provider.readFileForUpdate(providerWorkspaceId, guardedPath),
        ).rejects.toMatchObject({
          name: 'AtomicWriteConflictError',
          code: 'atomic_write_conflict',
          message: 'Atomic file changed before commit',
        });
        await expect(
          provider.writeFilesAtomically(providerWorkspaceId, [
            {
              path: guardedPath,
              data: Buffer.from('guarded after\n'),
              expectedRevision: 'unsupported-live-revision',
            },
          ]),
        ).rejects.toMatchObject({
          name: 'AtomicWriteConflictError',
          code: 'atomic_write_conflict',
          message: 'Atomic file changed before commit',
        });
        await expect(provider.readFile(providerWorkspaceId, guardedPath)).resolves.toEqual(
          Buffer.from('guarded before\n'),
        );

        const managedPort = 43_173;
        const managedScript = `require('node:http').createServer((_request, response) => response.end('ready')).listen(${String(managedPort)}, '127.0.0.1'); setInterval(() => {}, 1000);`;
        const managedContract: ExecutionContract = {
          ...EXECUTION_CONTRACT,
          install: { command: 'true' },
          develop: {
            command: `node -e ${JSON.stringify(managedScript)}`,
            port: managedPort,
          },
        };
        const started = await provider.startDevServer(providerWorkspaceId, managedContract);
        expect(started).toMatchObject({ port: managedPort, ownership: 'process_group' });
        const restarted = await provider.restartDevServer(providerWorkspaceId, managedContract);
        expect(restarted).toMatchObject({ port: managedPort, ownership: 'process_group' });
        expect(restarted.pid).not.toBe(started.pid);
        expect(restarted.supervisorId).not.toBe(started.supervisorId);

        const unrelatedPort = 43_174;
        const abortListener = new AbortController();
        let resolveListenerStarted = (): void => undefined;
        let resolveListenerReady = (): void => undefined;
        const listenerStarted = new Promise<void>((resolveStarted) => {
          resolveListenerStarted = resolveStarted;
        });
        const listenerReady = new Promise<void>((resolveReady) => {
          resolveListenerReady = resolveReady;
        });
        let unrelatedPid: number | undefined;
        const unrelatedListener = (async () => {
          for await (const record of provider.execStream(
            {
              providerWorkspaceId,
              command: 'node',
              args: [
                '-e',
                `require('node:http').createServer((_request, response) => response.end('unrelated')).listen(${String(unrelatedPort)}, '127.0.0.1', () => console.log('listener-ready')); setInterval(() => {}, 1000);`,
              ],
              timeoutMs: 30_000,
            },
            undefined,
            abortListener.signal,
          )) {
            if (record.type === 'started') {
              unrelatedPid = record.pid;
              resolveListenerStarted();
            }
            if (record.type === 'stdout' && record.data.includes('listener-ready')) {
              resolveListenerReady();
            }
          }
        })();
        await Promise.all([listenerStarted, listenerReady]);
        const unrelatedContract: ExecutionContract = {
          ...EXECUTION_CONTRACT,
          install: { command: 'true' },
          develop: {
            command: `node -e ${JSON.stringify('setInterval(() => {}, 1000);')}`,
            port: unrelatedPort,
          },
        };
        await expect(
          provider.startDevServer(providerWorkspaceId, unrelatedContract),
        ).rejects.toThrow();
        abortListener.abort();
        await expect(unrelatedListener).resolves.toBeUndefined();
        expect(unrelatedPid).toBeGreaterThan(0);
        await expect(
          run('sh', ['-lc', `kill -0 ${String(unrelatedPid)} 2>/dev/null`]),
        ).resolves.toMatchObject({ exitCode: 1 });
      } finally {
        if (handle !== undefined) await provider.terminateWorkspace(handle.providerWorkspaceId);
      }
    },
    240_000,
  );
});

interface AgentProxyProvider {
  exec(input: {
    providerWorkspaceId: string;
    command: string;
    args: string[];
    timeoutMs: number;
  }): Promise<unknown>;
  execStream(input: {
    providerWorkspaceId: string;
    command: string;
    args: string[];
    timeoutMs: number;
  }): AsyncIterable<unknown>;
  killExec(providerWorkspaceId: string, pid: number, executionId: string): Promise<unknown>;
  readFile(providerWorkspaceId: string, path: string): Promise<Uint8Array>;
  writeFile(providerWorkspaceId: string, path: string, data: Uint8Array): Promise<void>;
  listFiles(
    providerWorkspaceId: string,
    path: string,
    options?: { glob?: string; maxDepth?: number },
  ): Promise<unknown>;
  git(providerWorkspaceId: string, input: unknown): Promise<unknown>;
  health(providerWorkspaceId: string): Promise<unknown>;
  metrics(providerWorkspaceId: string): Promise<unknown>;
  readFileForUpdate(providerWorkspaceId: string, path: string): Promise<unknown>;
  writeFilesAtomically(
    providerWorkspaceId: string,
    files: readonly { path: string; data: Uint8Array; expectedRevision?: string }[],
  ): Promise<void>;
  search(providerWorkspaceId: string, input: unknown): Promise<unknown>;
  deleteFile(providerWorkspaceId: string, path: string): Promise<{ alreadyAbsent: boolean }>;
  renameFile(providerWorkspaceId: string, input: unknown): Promise<void>;
  startDevServer(providerWorkspaceId: string, contract: ExecutionContract): Promise<unknown>;
  restartDevServer(providerWorkspaceId: string, contract: ExecutionContract): Promise<unknown>;
  readDevServerLogs(
    providerWorkspaceId: string,
    query: { readonly after: number; readonly limit: number },
  ): Promise<unknown>;
}
