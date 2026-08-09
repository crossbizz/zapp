import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { newId } from '@zapp/contracts';
import { createDb } from '@zapp/db';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createProductionRunWorker,
  TASK_QUEUES,
  type RunActivities,
} from '../../src/worker.js';
import { runWorkflow, type RunWorkflowInput } from '../../src/workflows/run.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
if (DATABASE_URL === '') {
  throw new Error('AR-9 Postgres/Temporal integration requires DATABASE_URL');
}
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../../../packages/db/drizzle', import.meta.url),
);
const DUPLICATE_DATABASE = '42P04';

async function ar9TestDatabaseUrl(): Promise<string> {
  const testUrl = new URL(DATABASE_URL);
  const sourceName = decodeURIComponent(testUrl.pathname.replace(/^\//u, ''));
  const testName = `${sourceName.replace(/_ar9_test$/u, '')}_ar9_test`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(testName)) {
    throw new Error('AR-9 integration database name is invalid');
  }
  testUrl.pathname = `/${testName}`;
  const maintenanceUrl = new URL(testUrl);
  maintenanceUrl.pathname = '/postgres';
  const admin = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => undefined });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      select exists(select 1 from pg_database where datname = ${testName}) as exists
    `;
    if (existing[0]?.exists !== true) await admin.unsafe(`create database "${testName}"`);
  } catch (error: unknown) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      (error as { readonly code?: unknown }).code !== DUPLICATE_DATABASE
    ) {
      throw error;
    }
  } finally {
    await admin.end();
  }
  return testUrl.toString();
}

function workflowInput(runId: string): RunWorkflowInput {
  return {
    runId,
    workflowId: runId,
    organizationId: newId('org'),
    projectId: newId('proj'),
    branchId: null,
    mode: 'build',
    appType: 'web',
    model: null,
    prompt: 'Exercise the AR-9 production worker composition.',
    budget: null,
    operationKey: `op_${'a'.repeat(64)}`,
  };
}

describe('AR-9 production Postgres worker composition', () => {
  let environment: TestWorkflowEnvironment | undefined;

  afterEach(async () => {
    await environment?.teardown();
    environment = undefined;
  });

  it('runs Temporal through the concrete Postgres idempotency interceptor', async () => {
    const database = createDb(await ar9TestDatabaseUrl());
    const runId = newId('run');
    try {
      await migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER });
      environment = await TestWorkflowEnvironment.createLocal();
      const activities: RunActivities = {
        transitionRunStatus: () => Promise.resolve(),
        emitEvents: () => Promise.resolve(),
        ensureWorkspace: () => Promise.resolve({ workspaceId: 'workspace-ar9-postgres' }),
        runBuilderSession: () =>
          Promise.resolve({
            status: 'completed',
            commits: [],
            artifacts: [],
            summary: 'phase complete',
          }),
        commitAndPush: () => Promise.resolve({ commitSha: 'c'.repeat(40) }),
      };
      const worker = await createProductionRunWorker({
        connection: environment.nativeConnection,
        taskQueue: TASK_QUEUES.agentRuns,
        activities,
        database: database.db,
      });

      await worker.runUntil(async () => {
        const input = workflowInput(runId);
        await expect(
          environment?.client.workflow.execute(runWorkflow, {
            taskQueue: TASK_QUEUES.agentRuns,
            workflowId: input.workflowId,
            args: [input],
          }),
        ).resolves.toEqual({ status: 'completed', commitSha: 'c'.repeat(40) });
      });

      const rows = await database.sql<{ status: string }[]>`
        select status
          from activity_idempotency
         where idempotency_key like ${`${runId}:%`}
      `;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.status === 'completed')).toBe(true);
      await database.sql`delete from activity_idempotency where idempotency_key like ${`${runId}:%`}`;
    } finally {
      await database.close();
    }
  }, 30_000);
});
