import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimWorkspaceAutoWake,
  ensureProjectWorkspace,
  restartWorkspaceOnce,
  selectProjectWorkspace,
  type ProjectWorkspace,
} from '../src/components/builder/workspace-session';

const baseWorkspace: ProjectWorkspace = {
  branchId: 'br_00000000000000000000000000',
  createdAt: '2026-08-15T06:00:00.000Z',
  id: 'ws_00000000000000000000000000',
  lastActiveAt: null,
  organizationId: 'org_00000000000000000000000000',
  projectId: 'proj_00000000000000000000000000',
  provider: 'docker',
  providerWorkspaceId: 'provider-workspace',
  resourceProfile: 'standard',
  snapshotRef: null,
  status: 'ready',
  terminatedAt: null,
};

void test('claims one automatic wake across preview remounts and expires the claim', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const now = Date.parse('2026-08-15T06:00:00.000Z');

  assert.equal(claimWorkspaceAutoWake(storage, baseWorkspace.id, now), true);
  assert.equal(claimWorkspaceAutoWake(storage, baseWorkspace.id, now + 1_000), false);
  assert.equal(claimWorkspaceAutoWake(storage, baseWorkspace.id, now + 30_000), true);
});

void test('rejects expired and foreign-branch workspaces while keeping the preferred live workspace', () => {
  const terminated = {
    ...baseWorkspace,
    createdAt: '2026-08-15T06:10:00.000Z',
    id: 'ws_11111111111111111111111111',
    providerWorkspaceId: null,
    status: 'terminated' as const,
    terminatedAt: '2026-08-15T06:10:01.000Z',
  };
  const preferred = {
    ...baseWorkspace,
    id: 'ws_22222222222222222222222222',
  };
  const newer = {
    ...baseWorkspace,
    createdAt: '2026-08-15T06:05:00.000Z',
    id: 'ws_33333333333333333333333333',
  };
  const foreignBranch = {
    ...baseWorkspace,
    branchId: 'br_99999999999999999999999999',
    id: 'ws_99999999999999999999999999',
  };

  assert.equal(
    selectProjectWorkspace(
      [terminated, foreignBranch, newer, preferred],
      baseWorkspace.branchId ?? undefined,
      preferred.id,
    )?.id,
    preferred.id,
  );
  assert.equal(
    selectProjectWorkspace([terminated, foreignBranch], baseWorkspace.branchId ?? undefined)?.id,
    undefined,
  );
});

void test('rehydrates a project workspace from its real branch when all sandboxes expired', async () => {
  const branchId = 'br_44444444444444444444444444';
  const created = {
    ...baseWorkspace,
    branchId,
    id: 'ws_55555555555555555555555555',
  };
  const createCalls: Array<{ readonly branchId: string; readonly projectId: string }> = [];
  const client = {
    listProjectWorkspaces: () =>
      Promise.resolve({
        workspaces: [
          {
            ...baseWorkspace,
            providerWorkspaceId: null,
            status: 'terminated' as const,
            terminatedAt: '2026-08-15T06:10:01.000Z',
          },
        ],
      }),
    createWorkspace: (projectId: string, requestedBranchId: string) => {
      createCalls.push({ branchId: requestedBranchId, projectId });
      return Promise.resolve({ workspace: created });
    },
  };

  const result = await ensureProjectWorkspace(client, {
    branchId,
    projectId: baseWorkspace.projectId,
  });

  assert.equal(result.recovered, true);
  assert.equal(result.workspace.id, created.id);
  assert.deepEqual(createCalls, [{ branchId, projectId: baseWorkspace.projectId }]);
});

void test('coalesces concurrent workspace recovery when the workspace list is stale', async () => {
  const branchId = 'br_66666666666666666666666666';
  const created = {
    ...baseWorkspace,
    branchId,
    id: 'ws_77777777777777777777777777',
  };
  let createCount = 0;
  let releaseCreate: (() => void) | undefined;
  const createReleased = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const client = {
    listProjectWorkspaces: () => Promise.resolve({ workspaces: [] }),
    createWorkspace: async () => {
      createCount += 1;
      await createReleased;
      return { workspace: created };
    },
  };
  const input = { branchId, projectId: baseWorkspace.projectId };

  const first = ensureProjectWorkspace(client, input);
  const second = ensureProjectWorkspace(client, input);
  await Promise.resolve();
  await Promise.resolve();
  releaseCreate?.();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(createCount, 1);
  assert.equal(firstResult.workspace.id, created.id);
  assert.equal(secondResult.workspace.id, created.id);
});

void test('restarts a recovered workspace once across concurrent preview effects', async () => {
  let restartCount = 0;
  let releaseRestart: (() => void) | undefined;
  const restartReleased = new Promise<void>((resolve) => {
    releaseRestart = resolve;
  });
  const client = {
    restartDevServer: async () => {
      restartCount += 1;
      await restartReleased;
      return { port: 3000 };
    },
  };

  const first = restartWorkspaceOnce(client, baseWorkspace.id);
  const second = restartWorkspaceOnce(client, baseWorkspace.id);
  await Promise.resolve();
  releaseRestart?.();
  await Promise.all([first, second]);

  assert.equal(restartCount, 1);
});
