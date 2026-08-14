import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  createDb,
  organizations,
  projects,
  sandboxCapacityAdmissions,
  users,
  workspaces,
  type Db,
} from '@zapp/db';
import { newId } from '@zapp/contracts';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createSandboxCapacityRepository } from '../src/state/capacity.js';

const hasDatabase = (process.env['DATABASE_URL'] ?? '') !== '';
const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
);
const testDatabaseSuffix = randomBytes(6).toString('hex');
let openedTestDatabaseUrl: string | undefined;

function testDatabaseUrl(source: string): string {
  const url = new URL(source);
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(database)) {
    throw new Error('DATABASE_URL must name a safe database');
  }
  url.pathname = `/${database.replace(/_test$/u, '')}_capacity_${testDatabaseSuffix}_test`;
  return url.toString();
}

async function openTestDatabase(): Promise<Db> {
  const url = testDatabaseUrl(process.env['DATABASE_URL'] ?? '');
  openedTestDatabaseUrl = url;
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//u, ''));
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  const maintenance = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => undefined });
  try {
    const found = await maintenance<{ found: number }[]>`
      select 1 as found from pg_database where datname = ${name}
    `;
    if (found.length === 0) await maintenance.unsafe(`create database "${name}"`);
  } catch (error) {
    if ((error as { readonly code?: unknown }).code !== '42P04') throw error;
  } finally {
    await maintenance.end();
  }
  const migrationClient = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(migrationClient), { migrationsFolder });
  } finally {
    await migrationClient.end();
  }
  return createDb(url);
}

function operationKey(seed: string): string {
  return `op_${seed.padEnd(64, seed).slice(0, 64)}`;
}

describe.skipIf(!hasDatabase)('PostgreSQL sandbox capacity repository', () => {
  let handle: Db | undefined;
  let sequence = 0;

  beforeAll(async () => {
    handle = await openTestDatabase();
  }, 30_000);

  afterEach(async () => {
    if (handle === undefined) return;
    await handle.db.delete(sandboxCapacityAdmissions);
    await handle.db.delete(workspaces);
    await handle.db.delete(projects);
    await handle.db.delete(users);
    await handle.db.delete(organizations);
  });

  afterAll(async () => {
    await handle?.close();
    if (openedTestDatabaseUrl !== undefined) {
      const target = new URL(openedTestDatabaseUrl);
      const name = decodeURIComponent(target.pathname.replace(/^\//u, ''));
      target.pathname = '/postgres';
      const maintenance = postgres(target.toString(), { max: 1, onnotice: () => undefined });
      try {
        await maintenance.unsafe(`drop database if exists "${name}"`);
      } finally {
        await maintenance.end();
      }
    }
  }, 30_000);

  async function scope(name: string): Promise<{
    organizationId: string;
    projectId: string;
    runId: string;
    taskId: string;
    workspaceId: string;
  }> {
    if (handle === undefined) throw new Error('test database was not initialized');
    sequence += 1;
    const organizationId = newId('org');
    const projectId = newId('proj');
    const userId = newId('user');
    const workspaceId = newId('ws');
    await handle.db.insert(organizations).values({
      id: organizationId,
      name,
      slug: `capacity-${String(sequence)}-${organizationId}`,
    });
    await handle.db.insert(users).values({
      id: userId,
      displayName: name,
      email: `${userId}@example.test`,
    });
    await handle.db.insert(projects).values({
      id: projectId,
      organizationId,
      name,
      slug: `capacity-${String(sequence)}-${projectId}`,
      sourceType: 'prompt',
      supportLevel: 'compatible',
      createdBy: userId,
    });
    await handle.db.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      projectId,
      provider: 'modal',
      status: 'requested',
      resourceProfile: 'small',
    });
    return {
      organizationId,
      projectId,
      runId: newId('run'),
      taskId: newId('task'),
      workspaceId,
    };
  }

  function claimInput(
    identity: Awaited<ReturnType<typeof scope>>,
    seed: string,
    requestedAt = new Date('2026-08-13T10:00:00.000Z'),
  ) {
    return {
      ...identity,
      purpose: 'builder' as const,
      operationKey: operationKey(seed),
      requestedAt,
      budgetMs: 60_000,
      globalLimit: 2,
      organizationLimit: 1,
    };
  }

  it('atomically enforces global and organization limits under concurrent claims', async () => {
    if (handle === undefined) throw new Error('test database was not initialized');
    const repository = createSandboxCapacityRepository(handle.db);
    const first = await scope('first tenant');
    const sameTenant = await scope('same tenant workspace');
    await handle.db
      .update(workspaces)
      .set({ organizationId: first.organizationId, projectId: first.projectId })
      .where(eq(workspaces.id, sameTenant.workspaceId));
    const second = await scope('second tenant');

    const decisions = await Promise.all([
      repository.claim(claimInput(first, 'a')),
      repository.claim(
        claimInput(
          { ...sameTenant, organizationId: first.organizationId, projectId: first.projectId },
          'b',
        ),
      ),
      repository.claim(claimInput(second, 'c')),
    ]);

    expect(decisions.filter(({ status }) => status === 'admitted')).toHaveLength(2);
    expect(decisions.filter(({ status }) => status === 'queued')).toHaveLength(1);
  });

  it('replays the original deadline after release and rejects conflicting operation identity', async () => {
    if (handle === undefined) throw new Error('test database was not initialized');
    const repository = createSandboxCapacityRepository(handle.db);
    const identity = await scope('replay tenant');
    const input = claimInput(identity, 'd');
    const first = await repository.claim(input);
    expect(first.status).toBe('admitted');
    await repository.release({
      workspaceId: identity.workspaceId,
      organizationId: identity.organizationId,
      operationKey: operationKey('e'),
    });
    await expect(repository.claim(input)).resolves.toEqual({
      status: 'replay',
      deadlineAt: new Date('2026-08-13T10:01:00.000Z'),
    });
    await expect(
      repository.claim({ ...input, taskId: newId('task') }),
    ).rejects.toThrow('conflicting identity');
  });

  it('reports a deterministic queue position after earlier active admissions', async () => {
    if (handle === undefined) throw new Error('test database was not initialized');
    const repository = createSandboxCapacityRepository(handle.db);
    const first = await scope('queue tenant');
    const second = await scope('queue tenant second workspace');
    await handle.db
      .update(workspaces)
      .set({ organizationId: first.organizationId, projectId: first.projectId })
      .where(eq(workspaces.id, second.workspaceId));
    await repository.claim(claimInput(first, 'f'));
    await expect(
      repository.claim(
        claimInput(
          { ...second, organizationId: first.organizationId, projectId: first.projectId },
          '1',
          new Date('2026-08-13T10:00:01.000Z'),
        ),
      ),
    ).resolves.toEqual({ status: 'queued', queuePosition: 2 });
  });

  it('releases only the requested tenant workspace and is idempotent', async () => {
    if (handle === undefined) throw new Error('test database was not initialized');
    const repository = createSandboxCapacityRepository(handle.db);
    const first = await scope('release tenant');
    const second = await scope('other tenant');
    await repository.claim(claimInput(first, '2'));
    await repository.claim(claimInput(second, '3'));
    await repository.release({
      workspaceId: first.workspaceId,
      organizationId: second.organizationId,
      operationKey: operationKey('4'),
    });
    expect(await repository.listOrganization({
      organizationId: first.organizationId,
      operationKey: operationKey('5'),
    })).toHaveLength(1);
    const release = {
      workspaceId: first.workspaceId,
      organizationId: first.organizationId,
      operationKey: operationKey('6'),
    };
    await repository.release(release);
    await expect(repository.release(release)).resolves.toBeUndefined();
    expect(await repository.listOrganization({
      organizationId: first.organizationId,
      operationKey: operationKey('7'),
    })).toHaveLength(0);
  });

  it('leases expired rows with skip-locked semantics and never double claims them', async () => {
    if (handle === undefined) throw new Error('test database was not initialized');
    const repository = createSandboxCapacityRepository(handle.db);
    const first = await scope('expiry tenant');
    const second = await scope('expiry other tenant');
    await repository.claim(claimInput(first, '8'));
    await repository.claim(claimInput(second, '9'));
    const now = new Date('2026-08-13T10:02:00.000Z');
    const [left, right] = await Promise.all([
      repository.claimExpired({ now, ownerId: 'worker-a', leaseMs: 30_000, limit: 1 }),
      repository.claimExpired({ now, ownerId: 'worker-b', leaseMs: 30_000, limit: 1 }),
    ]);
    expect([...left, ...right]).toHaveLength(2);
    expect(new Set([...left, ...right].map(({ workspaceId }) => workspaceId)).size).toBe(2);
    await expect(
      repository.claimExpired({ now, ownerId: 'worker-c', leaseMs: 30_000, limit: 2 }),
    ).resolves.toEqual([]);
  });

  it('requires the exact durable lease token to renew, complete, or release expiry work', async () => {
    if (handle === undefined) throw new Error('test database was not initialized');
    const repository = createSandboxCapacityRepository(handle.db);
    const identity = await scope('lease tenant');
    await repository.claim(claimInput(identity, 'a1'));
    const [claim] = await repository.claimExpired({
      now: new Date('2026-08-13T10:02:00.000Z'),
      ownerId: 'worker-a',
      leaseMs: 30_000,
      limit: 1,
    });
    if (claim === undefined) throw new Error('expired admission was not claimed');
    expect(await repository.renewExpired({
      workspaceId: identity.workspaceId,
      leaseToken: 'wrong-token',
      leaseMs: 30_000,
    })).toBe(false);
    await expect(repository.releaseExpired({
      workspaceId: identity.workspaceId,
      leaseToken: 'wrong-token',
      operationKey: operationKey('b1'),
    })).rejects.toThrow('lease token');
    expect(await repository.renewExpired({
      workspaceId: identity.workspaceId,
      leaseToken: claim.leaseToken,
      leaseMs: 30_000,
    })).toBe(true);
    await repository.releaseExpired({
      workspaceId: identity.workspaceId,
      leaseToken: claim.leaseToken,
      operationKey: operationKey('c1'),
    });
    const [reclaimed] = await repository.claimExpired({
      now: new Date('2026-08-13T10:03:00.000Z'),
      ownerId: 'worker-b',
      leaseMs: 30_000,
      limit: 1,
    });
    if (reclaimed === undefined) throw new Error('released admission was not reclaimed');
    await expect(repository.completeExpired({
      workspaceId: identity.workspaceId,
      leaseToken: 'wrong-token',
      operationKey: operationKey('d1'),
    })).rejects.toThrow('lease token');
    await repository.completeExpired({
      workspaceId: identity.workspaceId,
      leaseToken: reclaimed.leaseToken,
      operationKey: operationKey('e1'),
    });
    expect(await repository.listOrganization({
      organizationId: identity.organizationId,
      operationKey: operationKey('f1'),
    })).toHaveLength(0);
  });

  it('never lists another tenant capacity row', async () => {
    if (handle === undefined) throw new Error('test database was not initialized');
    const repository = createSandboxCapacityRepository(handle.db);
    const first = await scope('list tenant');
    const second = await scope('list other tenant');
    await repository.claim(claimInput(first, 'a2'));
    await repository.claim(claimInput(second, 'b2'));
    const rows = await repository.listOrganization({
      organizationId: first.organizationId,
      operationKey: operationKey('c2'),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: first.workspaceId,
      organizationId: first.organizationId,
    });
  });
});
