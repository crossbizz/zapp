import { newId } from '@zapp/contracts';
import { expect, it, vi } from 'vitest';

import {
  composeSandboxApp,
  composeSandboxGovernor,
  loadSandboxPlanLimits,
} from '../src/compose.js';

const testCapacity = {
  claim: () => Promise.resolve({ status: 'queued' as const, queuePosition: 2 }),
  release: () => Promise.resolve(),
  claimExpired: () => Promise.resolve([]),
  renewExpired: () => Promise.resolve(false),
  completeExpired: () => Promise.resolve(),
  releaseExpired: () => Promise.resolve(),
  listOrganization: () => Promise.resolve([]),
};

it('uses the explicit local organization limit without changing production plan data', async () => {
  const organizationId = newId('org');
  const projectId = newId('proj');
  const claim = vi.fn(() =>
    Promise.resolve({
      status: 'admitted' as const,
      deadlineAt: new Date('2026-08-11T01:00:00.000Z'),
    }),
  );
  const governor = composeSandboxGovernor({
    ownerId: 'sandbox-local-test',
    globalLimit: 100,
    localOrganizationLimit: 10,
    now: () => new Date('2026-08-11T00:00:00.000Z'),
    capacity: { ...testCapacity, claim },
    plans: await loadSandboxPlanLimits(),
    organizations: { findById: () => Promise.resolve({ plan: 'trial' }) },
    actions: {
      checkpointAndTerminate: () => Promise.resolve(),
      terminate: () => Promise.resolve(),
    },
    audit: { recordTerminateAll: () => Promise.resolve() },
    scheduler: { setInterval: () => ({}), clearInterval: () => undefined },
  });

  await governor.admit({
    workspaceId: newId('ws'),
    organizationId,
    projectId,
    runId: newId('run'),
    taskId: newId('task'),
    purpose: 'builder',
    operationKey: `op_${'c'.repeat(64)}`,
  });

  expect(claim).toHaveBeenCalledWith(expect.objectContaining({ organizationLimit: 10 }));
});

it('rejects a real workspace create through production composition before provider creation', async () => {
  const organizationId = newId('org');
  const projectId = newId('proj');
  const row = {
    id: newId('ws'),
    organizationId,
    projectId,
    branchId: newId('br'),
    provider: 'modal' as const,
    providerWorkspaceId: null,
    status: 'requested' as const,
    resourceProfile: 'small' as const,
    snapshotRef: null,
    createdAt: new Date('2026-08-11T00:00:00.000Z'),
    lastActiveAt: null,
    terminatedAt: null,
  };
  const createWorkspace = vi.fn();
  const database = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ plan: 'trial' }]) }),
      }),
    }),
  } as never;
  const app = await composeSandboxApp({
    database,
    testOnlyCapacity: testCapacity,
    governor: {
      ownerId: 'sandbox-production-test',
      globalLimit: 100,
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      actions: {
        checkpointAndTerminate: () => Promise.resolve(),
        terminate: () => Promise.resolve(),
      },
      audit: { recordTerminateAll: () => Promise.resolve() },
      scheduler: { setInterval: () => ({}), clearInterval: () => undefined },
    },
    app: {
      logger: false,
      telemetryRelay: {
        authorized: () => true,
        forwardMetrics: () => Promise.resolve(),
      },
      provider: {
        lockedImageTag: 'forge-node-base:test',
        attachmentEnvironment: 'zapp-dev',
        imageTagForPurpose: () => 'forge-node-base:test',
        createWorkspace,
      } as never,
      rows: {
        projectOwnedBy: () => Promise.resolve(true),
        claimCreate: () => Promise.resolve({ created: true, row }),
        transition: (_workspaceId: string, status: string) => Promise.resolve({ ...row, status }),
        listAttachments: () => Promise.resolve([]),
      } as never,
      previewMonitors: {} as never,
      serviceTokens: {
        verifyServiceToken: () =>
          Promise.resolve({
            ok: true as const,
            claims: { service: 'control-api', audience: 'sandbox-service' },
          }),
      },
      workspaceGit: {
        bootstrap: () => Promise.resolve(),
        push: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      },
      secrets: { resolve: () => Promise.resolve([]) } as never,
      networkPolicies: { record: () => Promise.resolve() },
      events: { emit: () => Promise.resolve() },
      now: () => new Date('2026-08-11T00:00:00.000Z'),
    },
  });

  const operationKey = `op_${'a'.repeat(64)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/internal/workspaces',
    headers: {
      'x-zapp-service-token': 'service-token',
      'x-zapp-organization-id': organizationId,
      'x-zapp-project-id': projectId,
      'idempotency-key': operationKey,
    },
    payload: {
      workspace: row,
      branchName: 'main',
      runId: newId('run'),
      taskId: newId('task'),
      purpose: 'builder',
      env: {},
      networkProfile: 'restricted_verification',
      operationKey,
    },
  });

  expect(response.statusCode).toBe(429);
  expect(response.json()).toEqual({
    code: 'sandbox_quota_exceeded',
    message: 'The organization sandbox quota is currently full.',
    queuePosition: 2,
  });
  expect(createWorkspace).not.toHaveBeenCalled();
  await app.close();
});

it('rejects the test-only capacity seam outside the test environment', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  try {
    await expect(
      composeSandboxApp({
        database: {} as never,
        governor: {} as never,
        app: {} as never,
        testOnlyCapacity: testCapacity,
      }),
    ).rejects.toThrow('testOnlyCapacity may only be used when NODE_ENV=test');
  } finally {
    vi.unstubAllEnvs();
  }
});
