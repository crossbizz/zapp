import { fileURLToPath } from 'node:url';

import { branches, createDb, organizations, projects, users, type Db } from '@zapp/db';
import { newId } from '@zapp/contracts';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresWorkspaceStateStore } from '../../src/state/postgres.js';
import { buildApp } from '../../src/app.js';
import type { WorkspaceAgentProvider } from '../../src/routes/workspaces.js';

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

  it('restores attachment ownership and autonomously replays a finalized undelivered category', async () => {
    if (handle === undefined) throw new Error('test database was not initialized');
    const database = handle.db;
    const organizationId = newId('org');
    const userId = newId('user');
    const projectId = newId('proj');
    const branchId = newId('br');
    const workspaceId = newId('ws');
    const runId = newId('run');
    const taskId = newId('task');
    const createdAt = new Date('2026-08-09T20:00:00.000Z');

    await database.insert(organizations).values({
      id: organizationId,
      name: 'workspace state fixture',
      slug: `workspace-state-${organizationId}`,
    });
    await database.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      displayName: 'Workspace state fixture',
    });
    await database.insert(projects).values({
      id: projectId,
      organizationId,
      name: 'workspace state fixture',
      slug: `workspace-state-${projectId}`,
      sourceType: 'prompt',
      supportLevel: 'verified',
      createdBy: userId,
    });
    await database.insert(branches).values({
      id: branchId,
      organizationId,
      projectId,
      name: 'main',
      status: 'active',
    });
    let now = createdAt;
    const first = createPostgresWorkspaceStateStore(database, () => now);
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

    const restarted = createPostgresWorkspaceStateStore(database, () => now);
    const restored = await restarted.listAttachments();
    const restoredWorkspace = restored.find(({ row: candidate }) => candidate.id === workspaceId);
    expect(restoredWorkspace?.row.providerWorkspaceId).toBe('sb-durable');
    expect(restoredWorkspace?.attachment).toEqual(attachment);
    await expect(restarted.listProject(organizationId, projectId)).resolves.toEqual([
      expect.objectContaining({ id: workspaceId, providerWorkspaceId: 'sb-durable' }),
    ]);
    await expect(
      restarted.listProject('org_01J8ME7YQZJ2V9Q0X3T5B6K7NZ', projectId),
    ).resolves.toEqual([]);
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

    let meteringNow = createdAt.getTime();
    const ledgerRows: Array<{ category: string; quantity: string; id: string }> = [];
    const deliveredLedgerIds = new Set<string>();
    let failFirstMemoryDelivery = true;
    let providerTerminated = false;
    const provider = {
      lockedImageTag: attachment.imageTag,
      attachmentEnvironment: 'zapp-dev',
      imageTagForPurpose: () => attachment.imageTag,
      metrics: () =>
        Promise.resolve({
          at: new Date(meteringNow).toISOString(),
          activeChildren: 0,
          cpu: { userMicros: 0, systemMicros: 0 },
          memory: {
            rssBytes: 0,
            heapTotalBytes: 0,
            heapUsedBytes: 0,
            externalBytes: 0,
            arrayBuffersBytes: 0,
          },
        }),
      terminateWorkspace: () => {
        providerTerminated = true;
        return Promise.resolve();
      },
      getStatus: () => Promise.resolve(providerTerminated ? 'terminated' : 'ready'),
    } as unknown as WorkspaceAgentProvider;
    const buildMeteredApp = () =>
      buildApp({
        provider,
        rows: createPostgresWorkspaceStateStore(database, () => new Date(meteringNow)),
        previewMonitors: createPostgresWorkspaceStateStore(database, () => new Date(meteringNow)),
        governor: {
          admit: () => Promise.reject(new Error('not used')),
          release: () => Promise.resolve(),
          sweepExpired: () => Promise.resolve(),
          terminateAll: () => Promise.resolve({ terminated: 0 }),
          start: () => undefined,
          stop: () => Promise.resolve(),
        },
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
        secrets: {
          resolve: () => Promise.resolve([]),
        } as never,
        networkPolicies: { record: () => Promise.resolve() },
        events: { emit: () => Promise.resolve() },
        usageMetering: {
          database,
          pricing: {
            cpuSecondUsd: 0.00001,
            memoryGibSecondUsd: 0.00001,
            creditsPerUsd: 100,
          },
          ledger: {
            appendIfAbsent(row) {
              if (deliveredLedgerIds.has(row.id)) return Promise.resolve();
              if (row.category === 'sandbox_mem_gib_seconds' && failFirstMemoryDelivery) {
                failFirstMemoryDelivery = false;
                return Promise.reject(new Error('simulated crash before memory delivery'));
              }
              deliveredLedgerIds.add(row.id);
              ledgerRows.push({ id: row.id, category: row.category, quantity: row.quantity });
              return Promise.resolve();
            },
          },
          nowMs: () => meteringNow,
          scheduler: { setInterval: () => ({}), clearInterval: () => undefined },
        },
        now: () => new Date(meteringNow),
      });

    const firstApp = buildMeteredApp();
    await firstApp.ready();
    meteringNow += 1_000;
    await firstApp.close();
    const secondApp = buildMeteredApp();
    await secondApp.ready();
    meteringNow += 1_000;
    const terminated = await secondApp.inject({
      method: 'POST',
      url: `/internal/workspaces/${workspaceId}/terminate`,
      headers: {
        'x-zapp-service-token': 'control-api-token',
        'x-zapp-organization-id': organizationId,
        'x-zapp-project-id': projectId,
        'idempotency-key': `op_${'b'.repeat(64)}`,
      },
      payload: { operationKey: `op_${'b'.repeat(64)}` },
    });
    expect(ledgerRows.map(({ category }) => category)).toEqual(['sandbox_cpu_seconds']);
    expect(terminated.statusCode).toBe(500);
    await secondApp.close();
    const recoveryApp = buildMeteredApp();
    await recoveryApp.ready();
    for (let attempt = 0; attempt < 100 && ledgerRows.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await recoveryApp.close();
    expect(ledgerRows.map(({ category, quantity }) => ({ category, quantity }))).toEqual([
      { category: 'sandbox_cpu_seconds', quantity: '1' },
      { category: 'sandbox_mem_gib_seconds', quantity: '2' },
    ]);
    expect(new Set(ledgerRows.map(({ id }) => id)).size).toBe(2);
  });
});
