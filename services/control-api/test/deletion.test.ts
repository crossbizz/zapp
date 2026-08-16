import { IdempotencyHeader, newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createProjectDeletionJob,
  decideExistingProjectDeletion,
  type ClaimedProjectDeletion,
  type DeletionStore,
  type ProjectDeletionRequestStore,
  type ProjectDeletionStatus,
  type ProjectDeletionTarget,
} from '../src/jobs/deletion.js';
import { IDEMPOTENT_REPLAY_HEADER } from '../src/plugins/idempotency.js';
import { NO_TRANSACTION } from '../src/plugins/audit.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const NOW = new Date('2026-08-12T12:00:00.000Z');
const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async (built) => {
      await built.app.close();
    }),
  );
});

function deletion(): ClaimedProjectDeletion {
  return {
    projectId: newId('proj'),
    organizationId: newId('org'),
    leaseOwner: 'worker-a',
    snapshotsStatus: 'pending',
    gitStatus: 'pending',
    objectsStatus: 'pending',
    postgresStatus: 'pending',
  };
}

class MemoryDeletionStore implements DeletionStore {
  current: ClaimedProjectDeletion | undefined = deletion();
  readonly verified: ProjectDeletionTarget[] = [];
  readonly failures: string[] = [];
  rejectNextMark = false;

  claim() {
    return Promise.resolve(this.current);
  }

  markVerified(_projectId: string, target: ProjectDeletionTarget) {
    if (this.rejectNextMark) {
      this.rejectNextMark = false;
      return Promise.reject(new Error('database unavailable'));
    }
    this.verified.push(target);
    if (this.current !== undefined) {
      this.current = {
        ...this.current,
        [`${target}Status`]: 'verified',
      };
    }
    return Promise.resolve(true);
  }

  fail(_projectId: string, errorCode: string) {
    this.failures.push(errorCode);
    return Promise.resolve(true);
  }
}

class MemoryRequestStore implements ProjectDeletionRequestStore {
  readonly projects = new Set<string>();
  readonly rows = new Map<string, ProjectDeletionStatus>();
  readonly operationKeys = new Map<string, string>();
  calls = 0;

  async enqueue(input: Parameters<ProjectDeletionRequestStore['enqueue']>[0]) {
    this.calls += 1;
    if (!this.projects.has(`${input.organizationId}:${input.projectId}`)) {
      return { kind: 'not_found' as const };
    }
    const existing = this.rows.get(input.projectId);
    if (existing !== undefined) {
      if (this.operationKeys.get(input.projectId) === input.operationKey) {
        return { kind: 'replay' as const, deletion: existing };
      }
      if (existing.status !== 'failed') return { kind: 'conflict' as const };
      const restarted: ProjectDeletionStatus = {
        ...existing,
        completedAt: null,
        requestedAt: input.now.toISOString(),
        status: 'queued',
      };
      await input.audit(NO_TRANSACTION, restarted);
      this.operationKeys.set(input.projectId, input.operationKey);
      this.rows.set(input.projectId, restarted);
      return { kind: 'accepted' as const, deletion: restarted };
    }
    const deletion: ProjectDeletionStatus = {
      projectId: input.projectId,
      status: 'queued',
      targets: { snapshots: 'pending', git: 'pending', objects: 'pending', postgres: 'pending' },
      requestedAt: input.now.toISOString(),
      completedAt: null,
    };
    await input.audit(NO_TRANSACTION, deletion);
    this.operationKeys.set(input.projectId, input.operationKey);
    this.rows.set(input.projectId, deletion);
    return { kind: 'accepted' as const, deletion };
  }

  get(organizationId: string, projectId: string) {
    return Promise.resolve(
      this.projects.has(`${organizationId}:${projectId}`) ? this.rows.get(projectId) : undefined,
    );
  }

  async enqueueOrganization(
    input: Parameters<ProjectDeletionRequestStore['enqueueOrganization']>[0],
  ) {
    const projectIds = [...this.projects]
      .filter((key) => key.startsWith(`${input.organizationId}:`))
      .map((key) => key.slice(input.organizationId.length + 1));
    const output: ProjectDeletionStatus[] = [];
    for (const projectId of projectIds) {
      const existing = this.rows.get(projectId);
      if (existing !== undefined) {
        output.push(existing);
        continue;
      }
      const deletion: ProjectDeletionStatus = {
        projectId,
        status: 'queued',
        targets: { snapshots: 'pending', git: 'pending', objects: 'pending', postgres: 'pending' },
        requestedAt: input.now.toISOString(),
        completedAt: null,
      };
      await input.audit(NO_TRANSACTION, deletion);
      this.rows.set(projectId, deletion);
      output.push(deletion);
    }
    return output;
  }
}

function target(record: string[], absent = true) {
  return {
    remove(input: { organizationId: string; projectId: string; operationKey: string }) {
      record.push(`remove:${input.operationKey}`);
      return Promise.resolve();
    },
    absent(input: { organizationId: string; projectId: string }) {
      record.push(`absent:${input.organizationId}:${input.projectId}`);
      return Promise.resolve(absent);
    },
  };
}

describe('CP-17 verified project deletion job', () => {
  it('advances exactly one target per delivery in the binding order', async () => {
    const store = new MemoryDeletionStore();
    const calls: string[] = [];
    const job = createProjectDeletionJob({
      store,
      workerId: 'worker-a',
      snapshots: target(calls),
      git: target(calls),
      objects: target(calls),
      postgres: target(calls),
    });

    await expect(job.runOnce(NOW)).resolves.toEqual({ kind: 'advanced', target: 'snapshots' });
    await expect(job.runOnce(NOW)).resolves.toEqual({ kind: 'advanced', target: 'git' });
    await expect(job.runOnce(NOW)).resolves.toEqual({ kind: 'advanced', target: 'objects' });
    await expect(job.runOnce(NOW)).resolves.toEqual({ kind: 'completed', target: 'postgres' });
    expect(store.verified).toEqual(['snapshots', 'git', 'objects', 'postgres']);
    expect(calls).toHaveLength(8);
  });

  it('never verifies a target whose absence probe still finds data', async () => {
    const store = new MemoryDeletionStore();
    const job = createProjectDeletionJob({
      store,
      workerId: 'worker-a',
      snapshots: target([], false),
      git: target([]),
      objects: target([]),
      postgres: target([]),
    });

    await expect(job.runOnce(NOW)).resolves.toEqual({ kind: 'failed', target: 'snapshots' });
    expect(store.verified).toEqual([]);
    expect(store.failures).toEqual(['target_not_absent']);
  });

  it('redelivers safely when the remote delete succeeded before the durable mark', async () => {
    const store = new MemoryDeletionStore();
    store.rejectNextMark = true;
    const calls: string[] = [];
    const job = createProjectDeletionJob({
      store,
      workerId: 'worker-a',
      snapshots: target(calls),
      git: target([]),
      objects: target([]),
      postgres: target([]),
    });

    await expect(job.runOnce(NOW)).resolves.toEqual({ kind: 'failed', target: 'snapshots' });
    await expect(job.runOnce(NOW)).resolves.toEqual({ kind: 'advanced', target: 'snapshots' });
    expect(calls.filter((call) => call.startsWith('remove:'))).toHaveLength(2);
    expect(calls[0]).toMatch(/^remove:op_[a-f0-9]{64}$/u);
  });

  it('does no work when no deletion is claimable', async () => {
    const store = new MemoryDeletionStore();
    store.current = undefined;
    const job = createProjectDeletionJob({
      store,
      workerId: 'worker-a',
      snapshots: target([]),
      git: target([]),
      objects: target([]),
      postgres: target([]),
    });
    await expect(job.runOnce(NOW)).resolves.toEqual({ kind: 'idle' });
  });
});

describe('CP-17 deletion request retries', () => {
  it('accepts a fresh key only after an explicit failed state', () => {
    const request = {
      operationKey: 'delete-project-retry-0002',
      requestFingerprint: 'fingerprint-0002',
      requestedBy: newId('user'),
    };
    const existing = {
      operationKey: 'delete-project-retry-0001',
      requestFingerprint: 'fingerprint-0001',
      requestedBy: newId('user'),
      status: 'failed' as const,
    };

    expect(decideExistingProjectDeletion(existing, request)).toBe('restart');
    expect(decideExistingProjectDeletion({ ...existing, status: 'running' }, request)).toBe(
      'conflict',
    );
    expect(
      decideExistingProjectDeletion(existing, {
        operationKey: existing.operationKey,
        requestFingerprint: existing.requestFingerprint,
        requestedBy: existing.requestedBy,
      }),
    ).toBe('replay');
  });
});

describe('CP-17 public project deletion API', () => {
  it('is Owner-only, idempotency-keyed, tenant-safe, auditable, and pollable', async () => {
    const tenantData = new InMemoryTenantData();
    const deletions = new MemoryRequestStore();
    const built = buildHarness({
      tenantDb: tenantData.factory,
      projectDeletions: deletions,
    });
    harnesses.push(built);
    const owner = await signIn(built, {
      externalId: 'deletion-owner',
      email: 'owner@delete.test',
      displayName: 'Delete Owner',
    });
    const createdOrg = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Deletion Org' },
    });
    const organizationId = createdOrg.json<{ organization: { id: string } }>().organization.id;
    const tenantHeaders = { ...owner.headers, [ORGANIZATION_HEADER]: organizationId };
    const createdProject = await built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: tenantHeaders,
      payload: { name: 'Disposable', sourceType: 'blank' },
    });
    const projectId = createdProject.json<{ project: { id: string } }>().project.id;
    deletions.projects.add(`${organizationId}:${projectId}`);

    const missingKey = await built.app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}`,
      headers: tenantHeaders,
    });
    expect(missingKey.statusCode).toBe(400);

    const request = {
      method: 'DELETE' as const,
      url: `/v1/projects/${projectId}`,
      headers: { ...tenantHeaders, [IdempotencyHeader]: 'delete-project-0001' },
    };
    const accepted = await built.app.inject(request);
    const replay = await built.app.inject(request);
    expect(accepted.statusCode, accepted.body).toBe(202);
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
    expect(deletions.calls).toBe(1);
    expect(
      built.audit.events.some(
        (event) => event.action === 'project.deletion_requested' && event.targetId === projectId,
      ),
    ).toBe(true);

    const status = await built.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/deletion`,
      headers: tenantHeaders,
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({ deletion: { projectId, status: 'queued' } });

    const originalOperationKey = deletions.operationKeys.get(projectId);
    const existingDeletion = deletions.rows.get(projectId);
    expect(existingDeletion).toBeDefined();
    if (existingDeletion === undefined) throw new Error('expected deletion fixture');
    deletions.rows.set(projectId, {
      ...existingDeletion,
      status: 'failed',
    });
    const retried = await built.app.inject({
      ...request,
      headers: {
        ...tenantHeaders,
        [IdempotencyHeader]: 'delete-project-retry-0001',
      },
    });
    expect(retried.statusCode, retried.body).toBe(202);
    expect(retried.json()).toMatchObject({ deletion: { projectId, status: 'queued' } });
    expect(deletions.operationKeys.get(projectId)).not.toBe(originalOperationKey);

    const builder = await signIn(built, {
      externalId: 'deletion-builder',
      email: 'builder@delete.test',
      displayName: 'Delete Builder',
    });
    await built.organizations.addMember({
      organizationId,
      userId: builder.userId,
      role: 'builder',
      now: NOW,
      audit: () => Promise.resolve(),
    });
    const forbidden = await built.app.inject({
      ...request,
      headers: {
        ...builder.headers,
        [ORGANIZATION_HEADER]: organizationId,
        [IdempotencyHeader]: 'delete-project-0002',
      },
    });
    expect(forbidden.statusCode).toBe(403);

    const foreignOrg = newId('org');
    const hidden = await built.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/deletion`,
      headers: { ...owner.headers, [ORGANIZATION_HEADER]: foreignOrg },
    });
    expect(hidden.statusCode).toBe(404);

    const cascaded = await built.app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${organizationId}`,
      headers: { ...tenantHeaders, [IdempotencyHeader]: 'delete-org-0001' },
    });
    expect(cascaded.statusCode, cascaded.body).toBe(202);
    expect(cascaded.json()).toMatchObject({ deletions: [{ projectId }] });
  });

  it('treats deletion of an empty organization as an idempotent success', async () => {
    const data = new InMemoryTenantData();
    const deletions = new MemoryRequestStore();
    const built = buildHarness({ tenantDb: data.factory, projectDeletions: deletions });
    harnesses.push(built);
    const owner = await signIn(built, {
      externalId: 'empty-org-owner',
      email: 'owner@empty-delete.test',
      displayName: 'Empty Owner',
    });
    const created = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Empty Delete Org' },
    });
    const organizationId = created.json<{ organization: { id: string } }>().organization.id;
    const request = {
      method: 'DELETE' as const,
      url: `/v1/organizations/${organizationId}`,
      headers: {
        ...owner.headers,
        [ORGANIZATION_HEADER]: organizationId,
        [IdempotencyHeader]: 'delete-empty-org-0001',
      },
    };
    expect((await built.app.inject(request)).json()).toEqual({ deletions: [] });
    const replay = await built.app.inject(request);
    expect(replay.json()).toEqual({ deletions: [] });
    expect(replay.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
  });
});
