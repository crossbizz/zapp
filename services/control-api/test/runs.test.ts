import { afterEach, describe, expect, it } from 'vitest';

import { newId } from '@zapp/contracts';
import type { AgentRun, Branch, Workspace } from '@zapp/db';
import type { AuthIdentity } from '../src/auth/port.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import {
  buildHarness,
  signIn,
  type Harness,
  type HarnessOptions,
  type TestSession,
} from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

/**
 * The CP-9 public run lifecycle, through the real HTTP stack.
 *
 * The port is intentionally a recording fake: the assertions are about the
 * control plane's public contract (the persisted row and exactly one durable
 * workflow start), not a Temporal emulator's implementation details.
 */

const OWNER: AuthIdentity = {
  externalId: 'runs-test-owner',
  email: 'owner@runs.test',
  displayName: 'Rina Runowner',
};

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((built) => built.app.close()));
});

interface StartCall {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly mode: string;
  readonly prompt: string;
}

class FakeOrchestratorPort {
  readonly starts: StartCall[] = [];
  readonly signals: { readonly runId: string; readonly signal: string }[] = [];

  startRun(input: StartCall): Promise<void> {
    this.starts.push(input);
    return Promise.resolve();
  }

  signalRun(input: { readonly run: AgentRun; readonly signal: string }): Promise<boolean> {
    this.signals.push({ runId: input.run.id, signal: input.signal });
    return Promise.resolve(true);
  }
}

class FakeSandboxServicePort {
  readonly calls: string[] = [];
  failCreate = false;

  createWorkspace(): Promise<{ providerWorkspaceId: string; status: string }> {
    this.calls.push('create');
    if (this.failCreate) {
      return Promise.reject(new Error('sandbox unavailable'));
    }
    return Promise.resolve({
      providerWorkspaceId: `sandbox-${String(this.calls.length)}`,
      status: 'provisioning',
    });
  }

  startWorkspace(): Promise<{ status: string }> {
    this.calls.push('start');
    return Promise.resolve({ status: 'started' });
  }

  checkpointWorkspace(): Promise<{ snapshotRef: string }> {
    this.calls.push('checkpoint');
    return Promise.resolve({ snapshotRef: 'snapshot-01' });
  }

  terminateWorkspace(): Promise<void> {
    this.calls.push('terminate');
    return Promise.resolve();
  }

  previewWorkspace(): Promise<{ url: string; expiresAt: string }> {
    this.calls.push('preview');
    return Promise.resolve({
      url: 'https://preview.zapp.test/workspace',
      expiresAt: '2026-08-05T00:00:00.000Z',
    });
  }
}

interface Wired {
  readonly built: Harness;
  readonly data: InMemoryTenantData;
  readonly owner: TestSession;
  readonly organizationId: string;
  readonly orchestrator: FakeOrchestratorPort;
  readonly as: (session: TestSession) => Record<string, string>;
}

async function wire(options: { sandbox?: FakeSandboxServicePort } = {}): Promise<Wired> {
  const data = new InMemoryTenantData();
  const orchestrator = new FakeOrchestratorPort();
  const built = buildHarness({
    tenantDb: data.factory,
    // CP-9 will add this injected dependency. Keeping the fake in the test
    // first lets the HTTP assertion demonstrate the missing route today.
    orchestrator,
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
  } as HarnessOptions);
  harnesses.push(built);

  const owner = await signIn(built, OWNER);
  const organization = await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Run Factory' },
  });
  expect(organization.statusCode, organization.body).toBe(201);
  const organizationId = organization.json<{ organization: { id: string } }>().organization.id;

  return {
    built,
    data,
    owner,
    organizationId,
    orchestrator,
    as: (session) => ({ ...session.headers, [ORGANIZATION_HEADER]: organizationId }),
  };
}

async function createProject(wired: Wired): Promise<{ id: string }> {
  const response = await wired.built.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: wired.as(wired.owner),
    payload: { name: 'Run Target' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ project: { id: string } }>().project;
}

async function joinViewer(wired: Wired): Promise<TestSession> {
  const invited = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/organizations/${wired.organizationId}/invites`,
    headers: wired.owner.headers,
    payload: { email: 'viewer@runs.test', role: 'viewer' },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  const viewer = await signIn(wired.built, {
    externalId: 'runs-test-viewer',
    email: 'viewer@runs.test',
    displayName: 'Vera Viewer',
  });
  const accepted = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/invites/${invited.json<{ token: string }>().token}/accept`,
    headers: viewer.headers,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return viewer;
}

describe('POST /v1/projects/:projectId/runs', () => {
  it('creates a queued run and starts one workflow keyed by the run id', async () => {
    const wired = await wire();
    const project = await createProject(wired);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'start-run-01' },
      payload: { mode: 'build', prompt: 'Add a billing page' },
    });

    expect(response.statusCode, response.body).toBe(201);
    const run = response.json<{ run: { id: string; status: string; projectId: string } }>().run;
    expect(run).toMatchObject({ projectId: project.id, status: 'queued' });
    expect(wired.data.runs).toHaveLength(1);
    expect(wired.orchestrator.starts).toEqual([
      expect.objectContaining({
        runId: run.id,
        idempotencyKey: run.id,
        projectId: project.id,
        mode: 'build',
        prompt: 'Add a billing page',
      }),
    ]);
  });

  it('returns invalid_run_state for a completed run without signalling it', async () => {
    const wired = await wire();
    const project = await createProject(wired);
    const completed: AgentRun = {
      id: newId('run'),
      organizationId: wired.organizationId,
      projectId: project.id,
      branchId: null,
      mode: 'build',
      status: 'completed',
      specificationId: null,
      temporalWorkflowId: 'workflow-completed',
      startedBy: wired.owner.userId,
      budgetJson: null,
      startedAt: wired.built.now(),
      completedAt: wired.built.now(),
    };
    wired.data.runs.push(completed);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/runs/${completed.id}/pause`,
      headers: wired.as(wired.owner),
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_run_state');
    expect(wired.orchestrator.signals).toEqual([]);
  });

  it('does not let a Viewer start a run', async () => {
    const wired = await wire();
    const project = await createProject(wired);
    const viewer = await joinViewer(wired);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: wired.as(viewer),
      payload: { mode: 'ask', prompt: 'What is in this project?' },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(wired.data.runs).toEqual([]);
    expect(wired.orchestrator.starts).toEqual([]);
  });

  it('replays a run creation without starting a second workflow', async () => {
    const wired = await wire();
    const project = await createProject(wired);
    const headers = { ...wired.as(wired.owner), 'idempotency-key': 'run-replay-01' };

    const first = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers,
      payload: { mode: 'build', prompt: 'Implement the landing page' },
    });
    const replay = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers,
      payload: { mode: 'build', prompt: 'Implement the landing page' },
    });

    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(wired.data.runs).toHaveLength(1);
    expect(wired.orchestrator.starts).toHaveLength(1);
  });

  it('signals each applicable lifecycle action and records its matching audit action', async () => {
    const wired = await wire();
    const project = await createProject(wired);

    for (const [action, payload, auditAction] of [
      ['pause', undefined, 'run.paused'],
      ['resume', undefined, 'run.resumed'],
      ['cancel', undefined, 'run.cancelled'],
      ['redirect', { prompt: 'Use a different implementation approach' }, 'run.redirected'],
    ] as const) {
      const created = await wired.built.app.inject({
        method: 'POST',
        url: `/v1/projects/${project.id}/runs`,
        headers: { ...wired.as(wired.owner), 'idempotency-key': `signal-${action}` },
        payload: { mode: 'build', prompt: `Run for ${action}` },
      });
      const runId = created.json<{ run: { id: string } }>().run.id;
      const response = await wired.built.app.inject({
        method: 'POST',
        url: `/v1/runs/${runId}/${action}`,
        headers: wired.as(wired.owner),
        ...(payload === undefined ? {} : { payload }),
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(wired.orchestrator.signals).toContainEqual({ runId, signal: action });
      expect(wired.built.audit.events).toContainEqual(
        expect.objectContaining({ action: auditAction, targetId: runId }),
      );
    }
  });

  it('treats another tenant’s run, workspace and branch ids as not found', async () => {
    const sandbox = new FakeSandboxServicePort();
    const wired = await wire({ sandbox });
    const project = await createProject(wired);
    const foreignOrganizationId = newId('org');
    const foreignProjectId = newId('proj');
    const foreignBranch: Branch = {
      id: newId('br'),
      organizationId: foreignOrganizationId,
      projectId: foreignProjectId,
      name: 'main',
      headCommitSha: null,
      baseBranchId: null,
      status: 'active',
    };
    const foreignRun: AgentRun = {
      id: newId('run'),
      organizationId: foreignOrganizationId,
      projectId: foreignProjectId,
      branchId: foreignBranch.id,
      mode: 'build',
      status: 'running',
      specificationId: null,
      temporalWorkflowId: `workflow-${foreignOrganizationId}`,
      startedBy: wired.owner.userId,
      budgetJson: null,
      startedAt: wired.built.now(),
      completedAt: null,
    };
    const foreignWorkspace: Workspace = {
      id: newId('ws'),
      organizationId: foreignOrganizationId,
      projectId: foreignProjectId,
      branchId: foreignBranch.id,
      provider: 'modal',
      providerWorkspaceId: 'foreign-provider-workspace',
      status: 'active',
      resourceProfile: 'standard',
      snapshotRef: null,
      createdAt: wired.built.now(),
      lastActiveAt: wired.built.now(),
      terminatedAt: null,
    };
    wired.data.branches.push(foreignBranch);
    wired.data.runs.push(foreignRun);
    wired.data.workspaces.push(foreignWorkspace);

    const foreignRunRead = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/runs/${foreignRun.id}`,
      headers: wired.as(wired.owner),
    });
    const foreignRunSignal = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/runs/${foreignRun.id}/pause`,
      headers: wired.as(wired.owner),
    });
    const foreignWorkspaceRead = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${foreignWorkspace.id}`,
      headers: wired.as(wired.owner),
    });
    const foreignWorkspaceStart = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${foreignWorkspace.id}/start`,
      headers: wired.as(wired.owner),
    });
    const runWithForeignBranch = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'foreign-run-branch' },
      payload: { mode: 'build', prompt: 'Do not cross tenants', branchId: foreignBranch.id },
    });
    const workspaceWithForeignBranch = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'foreign-workspace-branch' },
      payload: { branchId: foreignBranch.id },
    });

    for (const response of [
      foreignRunRead,
      foreignRunSignal,
      foreignWorkspaceRead,
      foreignWorkspaceStart,
    ]) {
      expect(response.statusCode, response.body).toBe(404);
    }
    for (const response of [runWithForeignBranch, workspaceWithForeignBranch]) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('branch_not_found');
    }
    expect(wired.orchestrator.starts).toEqual([]);
    expect(wired.orchestrator.signals).toEqual([]);
    expect(sandbox.calls).toEqual([]);
  });
});

describe('workspace passthrough routes', () => {
  it('creates, reads, starts, checkpoints, previews and terminates a tenant workspace', async () => {
    const sandbox = new FakeSandboxServicePort();
    const wired = await wire({ sandbox });
    const project = await createProject(wired);
    const branchId = wired.data.branches.find((branch) => branch.projectId === project.id)?.id;
    expect(branchId).toBeDefined();

    const created = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'workspace-01' },
      payload: { branchId, resourceProfile: 'standard' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspace = created.json<{ workspace: { id: string; status: string } }>().workspace;
    expect(workspace.status).toBe('provisioning');

    const read = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspace.id}`,
      headers: wired.as(wired.owner),
    });
    expect(read.statusCode, read.body).toBe(200);

    const started = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/start`,
      headers: wired.as(wired.owner),
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json<{ workspace: { status: string } }>().workspace.status).toBe('started');

    const checkpoint = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/checkpoint`,
      headers: wired.as(wired.owner),
      payload: { kind: 'active' },
    });
    expect(checkpoint.statusCode, checkpoint.body).toBe(200);
    expect(checkpoint.json<{ workspace: { snapshotRef: string } }>().workspace.snapshotRef).toBe(
      'snapshot-01',
    );

    const preview = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/preview`,
      headers: wired.as(wired.owner),
      payload: { port: 3000, ttlSeconds: 300 },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json<{ preview: { url: string } }>().preview.url).toBe(
      'https://preview.zapp.test/workspace',
    );

    const terminated = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/terminate`,
      headers: wired.as(wired.owner),
    });
    expect(terminated.statusCode, terminated.body).toBe(200);
    expect(terminated.json<{ workspace: { status: string } }>().workspace.status).toBe(
      'terminated',
    );
    expect(sandbox.calls).toEqual(['create', 'start', 'checkpoint', 'preview', 'terminate']);
  });

  it('returns a tenant-safe 404, denies Viewers, replays creation, and never exposes raw fs or command routes', async () => {
    const sandbox = new FakeSandboxServicePort();
    const wired = await wire({ sandbox });
    const project = await createProject(wired);
    const branchId = wired.data.branches.find((branch) => branch.projectId === project.id)?.id;
    const viewer = await joinViewer(wired);
    const headers = { ...wired.as(wired.owner), 'idempotency-key': 'workspace-replay-01' };

    const first = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers,
      payload: { branchId },
    });
    const replay = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers,
      payload: { branchId },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    const workspaceId = first.json<{ workspace: { id: string } }>().workspace.id;
    const forbidden = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/start`,
      headers: wired.as(viewer),
    });
    const missing = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${newId('ws')}`,
      headers: wired.as(wired.owner),
    });

    expect(replay.json()).toEqual(first.json());
    expect(forbidden.statusCode, forbidden.body).toBe(403);
    expect(missing.statusCode, missing.body).toBe(404);
    expect(sandbox.calls).toEqual(['create']);
    expect(
      wired.built.app.hasRoute({ method: 'GET', url: '/v1/workspaces/:workspaceId/files' }),
    ).toBe(false);
    expect(
      wired.built.app.hasRoute({ method: 'POST', url: '/v1/workspaces/:workspaceId/exec' }),
    ).toBe(false);
  });

  it('propagates a sandbox creation failure without returning a workspace success', async () => {
    const sandbox = new FakeSandboxServicePort();
    sandbox.failCreate = true;
    const wired = await wire({ sandbox });
    const project = await createProject(wired);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers: wired.as(wired.owner),
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(502);
    expect(wired.data.workspaces).toEqual([]);
  });
});
