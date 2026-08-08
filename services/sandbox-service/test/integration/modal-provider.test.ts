import { readFile } from 'node:fs/promises';

import type { CreateWorkspaceInput, WorkspaceHandle, WorkspaceStatus } from '@zapp/contracts';
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

  get(workspaceId: string): Promise<WorkspaceLifecycleRow | undefined> {
    return Promise.resolve(this.rows.get(workspaceId));
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
