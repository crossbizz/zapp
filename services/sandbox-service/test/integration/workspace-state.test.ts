import { fileURLToPath } from 'node:url';

import {
  branches,
  createDb,
  organizations,
  projects,
  users,
  workspaces,
  type Db,
} from '@zapp/db';
import { newId } from '@zapp/contracts';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresWorkspaceStateStore } from '../../src/state/postgres.js';

const hasDatabase = (process.env['DATABASE_URL'] ?? '') !== '';
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../../../packages/db/drizzle', import.meta.url),
);

function testDatabaseUrl(source: string): string {
  const url = new URL(source);
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(database)) {
    throw new Error('DATABASE_URL must name a safe database');
  }
  url.pathname = `/${database.replace(/(_sandbox_service_ws13)?_test$/u, '')}_sandbox_service_ws13_test`;
  return url.toString();
}

async function openTestDatabase(): Promise<Db> {
  const url = testDatabaseUrl(process.env['DATABASE_URL'] ?? '');
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
    await migrate(drizzle(migrationClient), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await migrationClient.end();
  }
  return createDb(url);
}

describe.skipIf(!hasDatabase)('Postgres workspace state', () => {
  let handle: Db | undefined;

  beforeAll(async () => {
    handle = await openTestDatabase();
  }, 30_000);

  afterAll(async () => {
    await handle?.close();
  }, 30_000);

  it('restores durable attachment attribution and fences monitor ownership across replicas', async () => {
    if (handle === undefined) throw new Error('test database was not initialized');
    const organizationId = newId('org');
    const userId = newId('user');
    const projectId = newId('proj');
    const branchId = newId('br');
    const workspaceId = newId('ws');
    const runId = newId('run');
    const taskId = newId('task');
    const createdAt = new Date('2026-08-09T20:00:00.000Z');

    await handle.db.insert(organizations).values({
      id: organizationId,
      name: 'workspace state fixture',
      slug: `workspace-state-${organizationId}`,
    });
    await handle.db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      displayName: 'Workspace state fixture',
    });
    await handle.db.insert(projects).values({
      id: projectId,
      organizationId,
      name: 'workspace state fixture',
      slug: `workspace-state-${projectId}`,
      sourceType: 'prompt',
      supportLevel: 'verified',
      createdBy: userId,
    });
    await handle.db.insert(branches).values({
      id: branchId,
      organizationId,
      projectId,
      name: 'main',
      status: 'active',
    });
    await handle.db.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      projectId,
      branchId,
      provider: 'modal',
      status: 'requested',
      resourceProfile: 'small',
      createdAt,
    });

    let now = createdAt;
    const first = createPostgresWorkspaceStateStore(handle.db, () => now);
    const row = {
      id: workspaceId,
      organizationId,
      projectId,
      branchId,
      provider: 'modal' as const,
      providerWorkspaceId: null,
      status: 'requested' as const,
      resourceProfile: 'small' as const,
      snapshotRef: null,
      createdAt,
      lastActiveAt: null,
      terminatedAt: null,
    };
    const attachment = {
      resourceProfile: 'small' as const,
      imageTag: 'forge-node-base:2026-08-09-6b22eea',
      createdAt,
      requiredTags: {
        org_id: organizationId,
        project_id: projectId,
        branch_id: branchId,
        run_id: runId,
        task_id: taskId,
        purpose: 'preview' as const,
        environment: 'zapp-dev' as const,
      },
    };
    await expect(
      first.claimCreate(
        row,
        { runId, taskId, purpose: 'preview', branchId, branchName: 'main' },
        attachment,
      ),
    ).resolves.toMatchObject({ created: true, row: { id: workspaceId } });
    await first.transition(workspaceId, 'provisioning', undefined, 'requested');
    await first.bindProviderWorkspaceId(workspaceId, 'sb-durable', 'provisioning');
    await first.transition(workspaceId, 'started', undefined, 'provisioning');
    await first.transition(workspaceId, 'ready', undefined, 'started');
    const firstLease = await first.activateAndClaim(workspaceId, 'replica-a', 100);
    expect(firstLease).toMatch(/^replica-a:/u);
    if (firstLease === undefined) throw new Error('first monitor lease was not acquired');

    const restarted = createPostgresWorkspaceStateStore(handle.db, () => now);
    const restored = await restarted.listAttachments();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.row.id).toBe(workspaceId);
    expect(restored[0]?.row.providerWorkspaceId).toBe('sb-durable');
    expect(restored[0]?.attachment).toEqual(attachment);
    expect(await restarted.claim(workspaceId, 'replica-b', 100)).toBeUndefined();
    expect(await restarted.renew(workspaceId, firstLease, 100)).toBe(true);

    now = new Date(now.getTime() + 101);
    const secondLease = await restarted.claim(workspaceId, 'replica-b', 100);
    expect(secondLease).toMatch(/^replica-b:/u);
    if (secondLease === undefined) throw new Error('standby monitor lease was not acquired');
    expect(await first.complete(workspaceId, firstLease)).toBe(false);

    await restarted.revoke(workspaceId);
    now = new Date(now.getTime() + 200);
    expect(await first.renew(workspaceId, firstLease, 100)).toBe(false);
    expect(await restarted.renew(workspaceId, secondLease, 100)).toBe(false);
    expect(await restarted.claim(workspaceId, 'replica-b', 100)).toBeUndefined();
  });
});
