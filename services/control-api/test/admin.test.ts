import { ApiErrorSchema, SignalRunInputSchema, newId } from '@zapp/contracts';
import type { AgentRun, Artifact, Workspace } from '@zapp/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import {
  TerminateOrganizationInputSchema,
  TerminateWorkspaceInputSchema,
} from '../src/sandbox/port.js';
import type { UsageLedgerRepository } from '../src/usage/ledger.js';
import { EMPTY_WORKSPACE_USAGE, InMemoryTenantData } from './support/tenant-db.js';
import {
  buildHarness,
  signIn,
  type Harness,
  type TestSession,
} from './support/harness.js';

const STAFF_ID = 'user_00000000000000000000000001';
const SUPPORT_HEADER = 'x-zapp-support-session';
const STAFF: AuthIdentity = {
  externalId: 'support-staff',
  email: 'support@zapp.test',
  displayName: 'Support Staff',
};
const NORMAL: AuthIdentity = {
  externalId: 'normal-user',
  email: 'normal@zapp.test',
  displayName: 'Normal User',
};
const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

interface Wired {
  readonly built: Harness;
  readonly data: InMemoryTenantData;
  readonly staff: TestSession;
  readonly organizationId: string;
  readonly projectId: string;
  readonly run: AgentRun;
  readonly workspace: Workspace;
  readonly signalRun: ReturnType<typeof vi.fn>;
  readonly terminateWorkspace: ReturnType<typeof vi.fn>;
  readonly terminateOrganization: ReturnType<typeof vi.fn>;
  startSupportSession(reason?: string): Promise<{ token: string; expiresAt: string }>;
}

async function wire(options: { readonly enabled?: boolean } = {}): Promise<Wired> {
  const data = new InMemoryTenantData();
  const signalRun = vi.fn(() => Promise.resolve({ applied: true }));
  const terminateWorkspace = vi.fn(() =>
    Promise.resolve({
      status: 'terminated' as const,
      terminatedAt: new Date('2026-08-12T08:15:00.000Z'),
    }),
  );
  const terminateOrganization = vi.fn(() => Promise.resolve({ terminated: 3 }));
  const usage = {
    getUsageSummary: vi.fn(() =>
      Promise.resolve({
        byCategory: [{ category: 'model_tokens', quantity: '12' }],
        byProject: [],
        byRun: [],
      }),
    ),
  } as unknown as UsageLedgerRepository;
  const built = buildHarness({
    tenantDb: data.factory,
    orchestrator: { startRun: vi.fn(), signalRun },
    supportSandbox: {
      terminateWorkspace,
      terminateOrganization,
    },
    usageLedger: usage,
    admin: {
      enabled: options.enabled ?? true,
      staffUserIds: [STAFF_ID],
    },
  });
  harnesses.push(built);
  const staff = await signIn(built, STAFF);
  expect(staff.userId).toBe(STAFF_ID);
  const createdOrganization = await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: staff.headers,
    payload: { name: 'Support Customer' },
  });
  expect(createdOrganization.statusCode, createdOrganization.body).toBe(201);
  const organizationId = createdOrganization.json<{ organization: { id: string } }>().organization.id;
  const createdProject = await built.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { ...staff.headers, 'x-organization-id': organizationId },
    payload: { name: 'Customer App', sourceType: 'prompt' },
  });
  expect(createdProject.statusCode, createdProject.body).toBe(201);
  const projectId = createdProject.json<{ project: { id: string } }>().project.id;
  const run: AgentRun = {
    id: newId('run'),
    organizationId,
    projectId,
    branchId: null,
    mode: 'build',
    appType: 'web',
    model: null,
    requestFingerprint: 'a'.repeat(64),
    status: 'running',
    specificationId: null,
    temporalWorkflowId: 'workflow-support-test',
    startedBy: staff.userId,
    budgetJson: {},
    planMaxCredits: '1000.0000',
    startedAt: new Date('2026-08-12T10:00:00.000Z'),
    completedAt: null,
  };
  data.runs.push(run);
  const workspace: Workspace = {
    id: newId('ws'),
    organizationId,
    projectId,
    branchId: null,
    provider: 'modal',
    providerWorkspaceId: 'modal-support-test',
    status: 'active',
    resourceProfile: 'standard',
    runId: run.id,
    taskId: null,
    purpose: 'builder',
    environment: 'zapp-dev',
    imageTag: 'zapp-test@sha256:abc',
    previewMonitorEnabled: false,
    previewMonitorOwnerId: null,
    previewMonitorLeaseExpiresAt: null,
    snapshotRef: null,
    ...EMPTY_WORKSPACE_USAGE,
    createdAt: new Date('2026-08-12T10:00:00.000Z'),
    lastActiveAt: new Date('2026-08-12T10:01:00.000Z'),
    terminatedAt: null,
  };
  data.workspaces.push(workspace);

  async function startSupportSession(reason = 'Investigating ticket ZAPP-123') {
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/admin/support-sessions',
      headers: { ...staff.headers, 'idempotency-key': 'support-session-test-key' },
      payload: { organizationId, reason },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ token: string; expiresAt: string }>();
  }

  return {
    built,
    data,
    staff,
    organizationId,
    projectId,
    run,
    workspace,
    signalRun,
    terminateWorkspace,
    terminateOrganization,
    startSupportSession,
  };
}

describe('OPS-17 audited support administration', () => {
  it('requires both the staff feature flag and the exact user allowlist', async () => {
    const wired = await wire({ enabled: false });
    const disabled = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/admin/support-sessions',
      headers: { ...wired.staff.headers, 'idempotency-key': 'disabled-support' },
      payload: { organizationId: wired.organizationId, reason: 'Customer request' },
    });
    expect(disabled.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(disabled.json()).error.code).toBe('staff_access_denied');

    const normal = await signIn(wired.built, NORMAL);
    const denied = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/admin/support-sessions',
      headers: { ...normal.headers, 'idempotency-key': 'normal-support' },
      payload: { organizationId: wired.organizationId, reason: 'Customer request' },
    });
    expect(denied.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(denied.json()).error.code).toBe('staff_access_denied');
  });

  it('returns 422 without an explicit reason and creates an org-visible time-boxed session', async () => {
    const wired = await wire();
    const missing = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/admin/support-sessions',
      headers: { ...wired.staff.headers, 'idempotency-key': 'missing-reason' },
      payload: { organizationId: wired.organizationId },
    });
    expect(missing.statusCode).toBe(422);
    expect(ApiErrorSchema.parse(missing.json()).error.code).toBe('support_reason_required');
    const tooShort = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/admin/support-sessions',
      headers: { ...wired.staff.headers, 'idempotency-key': 'short-reason' },
      payload: { organizationId: wired.organizationId, reason: 'ticket' },
    });
    expect(tooShort.statusCode).toBe(422);

    const session = await wired.startSupportSession();
    expect(session.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    const remaining = Date.parse(session.expiresAt) - wired.built.now().getTime();
    expect(remaining).toBeGreaterThanOrEqual(30 * 60_000 - 100);
    expect(remaining).toBeLessThanOrEqual(30 * 60_000);
    expect(wired.built.audit.events.at(-1)).toMatchObject({
      organizationId: wired.organizationId,
      actorType: 'support',
      actorId: wired.staff.userId,
      action: 'support.impersonation',
      targetType: 'organization',
      targetId: wired.organizationId,
      metadata: { operation: 'session.started', reason: 'Investigating ticket ZAPP-123' },
    });
  });

  it('returns tenant state and usage only after auditing the support read', async () => {
    const wired = await wire();
    const session = await wired.startSupportSession();
    const response = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/admin/organizations/${wired.organizationId}/overview?from=2026-08-01T00%3A00%3A00.000Z&to=2026-09-01T00%3A00%3A00.000Z`,
      headers: { ...wired.staff.headers, [SUPPORT_HEADER]: session.token },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      organization: { id: wired.organizationId, name: 'Support Customer' },
      projects: [
        {
          id: wired.projectId,
          name: 'Customer App',
          runs: [{ id: wired.run.id, status: 'running' }],
          workspaces: [{ id: wired.workspace.id, status: 'active', provider: 'modal' }],
        },
      ],
      usage: { byCategory: [{ category: 'model_tokens', quantity: '12' }] },
    });
    expect(JSON.stringify(response.json())).not.toMatch(/secret|ciphertext|encryptedValueRef/iu);
    expect(wired.built.audit.events.at(-1)).toMatchObject({
      actorType: 'support',
      action: 'support.impersonation',
      metadata: { operation: 'tenant.overview' },
    });
  });

  it('exposes only support events and artifact metadata in run diagnostics', async () => {
    const wired = await wire();
    wired.data.events.push(
      {
        id: newId('evt'),
        organizationId: wired.organizationId,
        projectId: wired.projectId,
        runId: wired.run.id,
        sequence: 1,
        type: 'tool.failed',
        visibility: 'support',
        occurredAt: new Date('2026-08-12T10:02:00.000Z'),
        phaseId: null,
        taskId: null,
        agentId: null,
        payloadJson: { summary: 'bounded diagnostic' },
      },
      {
        id: newId('evt'),
        organizationId: wired.organizationId,
        projectId: wired.projectId,
        runId: wired.run.id,
        sequence: 2,
        type: 'message.user',
        visibility: 'user',
        occurredAt: new Date('2026-08-12T10:03:00.000Z'),
        phaseId: null,
        taskId: null,
        agentId: null,
        payloadJson: { prompt: 'must not be returned' },
      },
    );
    const artifact: Artifact = {
      id: newId('art'),
      organizationId: wired.organizationId,
      projectId: wired.projectId,
      runId: wired.run.id,
      taskId: null,
      type: 'diagnostic_bundle',
      storageRef: 'org/private/source-code.tar.gz',
      contentHash: 'a'.repeat(64),
      metadataJson: { secretValue: 'must-not-return' },
      createdAt: new Date('2026-08-12T10:04:00.000Z'),
    };
    wired.data.artifacts.push(artifact);
    const session = await wired.startSupportSession();
    const response = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/admin/organizations/${wired.organizationId}/runs/${wired.run.id}/diagnostics`,
      headers: { ...wired.staff.headers, [SUPPORT_HEADER]: session.token },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      run: { id: wired.run.id },
      events: [{ type: 'tool.failed', payload: { summary: 'bounded diagnostic' } }],
      artifacts: [{ id: artifact.id, type: artifact.type, contentHash: artifact.contentHash }],
    });
    expect(JSON.stringify(response.json())).not.toMatch(/must not be returned|must-not-return|storageRef/iu);
  });

  it('uses the durable run and sandbox kill paths and audits every mutation as support', async () => {
    const wired = await wire();
    const session = await wired.startSupportSession('Runaway compute reported by customer');
    const runResponse = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/admin/organizations/${wired.organizationId}/runs/${wired.run.id}/terminate`,
      headers: {
        ...wired.staff.headers,
        [SUPPORT_HEADER]: session.token,
        'idempotency-key': 'support-kill-run',
      },
    });
    expect(runResponse.statusCode, runResponse.body).toBe(202);
    expect(wired.signalRun).toHaveBeenCalledOnce();
    const signalInput = SignalRunInputSchema.parse(wired.signalRun.mock.calls[0]?.[0] as unknown);
    expect(signalInput.runId).toBe(wired.run.id);
    expect(signalInput.signal).toBe('cancel');
    expect(signalInput.operationKey).toMatch(/^op_[0-9a-f]{64}$/u);

    const workspaceResponse = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/admin/organizations/${wired.organizationId}/workspaces/${wired.workspace.id}/terminate`,
      headers: {
        ...wired.staff.headers,
        [SUPPORT_HEADER]: session.token,
        'idempotency-key': 'support-kill-workspace',
      },
    });
    expect(workspaceResponse.statusCode, workspaceResponse.body).toBe(200);
    expect(wired.terminateWorkspace).toHaveBeenCalledOnce();
    const terminationInput = TerminateWorkspaceInputSchema.parse(
      wired.terminateWorkspace.mock.calls[0]?.[0] as unknown,
    );
    expect(terminationInput.operationKey).toMatch(/^op_[0-9a-f]{64}$/u);

    const terminateAllResponse = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/admin/organizations/${wired.organizationId}/terminate-all`,
      headers: {
        ...wired.staff.headers,
        [SUPPORT_HEADER]: session.token,
        'idempotency-key': 'support-kill-all-sandboxes',
      },
    });
    expect(terminateAllResponse.statusCode, terminateAllResponse.body).toBe(200);
    expect(terminateAllResponse.json()).toEqual({ terminated: 3 });
    expect(wired.terminateOrganization).toHaveBeenCalledOnce();
    const terminateOrganizationInput = TerminateOrganizationInputSchema.parse(
      wired.terminateOrganization.mock.calls[0]?.[0] as unknown,
    );
    expect(terminateOrganizationInput.organizationId).toBe(wired.organizationId);
    expect(terminateOrganizationInput.actorUserId).toBe(STAFF_ID);
    expect(terminateOrganizationInput.reason).toBe('Runaway compute reported by customer');
    const supportMutations = wired.built.audit.events.filter(
      (event) =>
        event.action === 'support.impersonation' &&
        (event.metadata['operation'] === 'run.terminate' ||
          event.metadata['operation'] === 'workspace.terminate' ||
          event.metadata['operation'] === 'organization.terminate_all'),
    );
    expect(supportMutations).toHaveLength(3);
    expect(supportMutations.every((event) => event.actorType === 'support')).toBe(true);
  });

  it('rejects an expired session and a session bound to another organization', async () => {
    const wired = await wire();
    const session = await wired.startSupportSession();
    const foreignOrganizationId = newId('org');
    const foreign = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/admin/organizations/${foreignOrganizationId}/overview?from=2026-08-01T00%3A00%3A00.000Z&to=2026-09-01T00%3A00%3A00.000Z`,
      headers: { ...wired.staff.headers, [SUPPORT_HEADER]: session.token },
    });
    expect(foreign.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(foreign.json()).error.code).toBe('organization_not_found');

    wired.built.advance(30 * 60_000 + 1);
    const expired = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/admin/organizations/${wired.organizationId}/overview?from=2026-08-01T00%3A00%3A00.000Z&to=2026-09-01T00%3A00%3A00.000Z`,
      headers: { ...wired.staff.headers, [SUPPORT_HEADER]: session.token },
    });
    expect(expired.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(expired.json()).error.code).toBe('support_session_invalid');
  });
});
