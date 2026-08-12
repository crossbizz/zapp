import { fileURLToPath } from 'node:url';

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { newId } from '@zapp/contracts';
import { createDb, type Db } from '@zapp/db';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadArtifactStorageEnv } from '../../src/env.js';
import {
  createDatabaseDeletionStore,
  createDatabaseProjectDeletionRequestStore,
  createPostgresProjectDeletionTarget,
  createProjectDeletionJob,
  createS3ProjectDeletionTarget,
  type DeletionTargetPort,
} from '../../src/jobs/deletion.js';
import { createDbAuditSink } from '../../src/plugins/audit.js';
import { createTenantDbFactory } from '../../src/tenant/db.js';
import { credentialGate } from '../support/credentials.js';
import { hasDatabase, testDatabaseUrl } from './helpers.js';

const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../../../packages/db/drizzle', import.meta.url),
);
const DELETION_DATABASE_SUFFIX = '_cp17_deletion_test';
const DUPLICATE_DATABASE = '42P04';

function deletionDatabaseUrl(url: string): string {
  const parsed = new URL(testDatabaseUrl(url));
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  parsed.pathname = `/${name.replace(/_control_api_test$/, DELETION_DATABASE_SUFFIX)}`;
  return parsed.toString();
}

function isDuplicateDatabase(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === DUPLICATE_DATABASE
  );
}

async function setUpDeletionDatabase(): Promise<Db> {
  const url = deletionDatabaseUrl(process.env.DATABASE_URL ?? '');
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  const admin = createDb(maintenanceUrl.toString());
  try {
    const existing = await admin.sql<{ oid: number }[]>`
      select oid from pg_database where datname = ${name}
    `;
    if (existing.length === 0) {
      await admin.sql.unsafe(`create database "${name}"`);
    }
  } catch (error) {
    if (!isDuplicateDatabase(error)) {
      throw error;
    }
  } finally {
    await admin.close();
  }

  const database = createDb(url);
  await migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER });
  return database;
}

const artifactGate = credentialGate([
  'ARTIFACT_ENDPOINT',
  'ARTIFACT_REGION',
  'ARTIFACT_BUCKET',
  'ARTIFACT_KEY',
  'ARTIFACT_SECRET',
]);
const enabled = hasDatabase && artifactGate.present;
if (!artifactGate.present) {
  console.warn(`[@zapp/control-api] deletion integration skipped: ${artifactGate.reason}`);
}

class RecordingTarget implements DeletionTargetPort {
  present = true;
  calls = 0;

  remove(): Promise<void> {
    this.calls += 1;
    this.present = false;
    return Promise.resolve();
  }

  absent(): Promise<boolean> {
    return Promise.resolve(!this.present);
  }
}

describe.skipIf(!enabled)('CP-17 verified project deletion, on PostgreSQL and MinIO', () => {
  let database: Db;
  const now = new Date('2026-08-12T12:00:00.000Z');

  beforeAll(async () => {
    database = await setUpDeletionDatabase();
  }, 180_000);

  afterAll(async () => {
    await database.close();
  });

  it('polls to complete only after every store is absent and preserves audit evidence', async () => {
    const storage = loadArtifactStorageEnv();
    const s3 = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
      },
    });
    const userId = newId('user');
    const organizationId = newId('org');
    const projectId = newId('proj');
    const branchId = newId('br');
    const artifactId = newId('art');
    const storageRef = `org/${organizationId}/project/${projectId}/test/${artifactId}/proof.json`;
    await database.sql.begin(async (tx) => {
      await tx`insert into users (id, email, display_name)
               values (${userId}, ${`${userId}@deletion.test.invalid`}, 'Deletion')`;
      await tx`insert into organizations (id, name, slug)
               values (${organizationId}, 'Deletion', ${`deletion-${organizationId.slice(-8).toLowerCase()}`})`;
      await tx`insert into projects
               (id, organization_id, name, slug, source_type, support_level, created_by)
               values (${projectId}, ${organizationId}, 'Delete me', 'delete-me', 'prompt', 'compatible', ${userId})`;
      await tx`insert into branches
               (id, organization_id, project_id, name, head_commit_sha, status)
               values (${branchId}, ${organizationId}, ${projectId}, 'main', null, 'active')`;
      await tx`insert into artifacts
               (id, organization_id, project_id, type, storage_ref, content_hash, metadata_json)
               values (${artifactId}, ${organizationId}, ${projectId}, 'playwright_json_report', ${storageRef}, ${'a'.repeat(64)}, '{}'::jsonb)`;
      await tx`insert into artifact_retention
               (artifact_id, organization_id, project_id, retention_class, expires_at)
               values (${artifactId}, ${organizationId}, ${projectId}, 'test', ${'2026-09-11T12:00:00.000Z'}::timestamptz)`;
    });
    await s3.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: storageRef,
        Body: Buffer.from('{}'),
        ContentType: 'application/json',
      }),
    );

    const [seeded] = await database.sql<{ count: string }[]>`
      select count(*)::text as count from projects
       where id = ${projectId} and organization_id = ${organizationId}
    `;
    expect(seeded?.count).toBe('1');

    const requestStore = createDatabaseProjectDeletionRequestStore(database.db);
    const audit = createDbAuditSink(database.db);
    const accepted = await requestStore.enqueue({
      organizationId,
      projectId,
      requestedBy: userId,
      operationKey: `op_${'b'.repeat(64)}`,
      requestFingerprint: 'c'.repeat(64),
      now,
      audit: async (tx, deletion) => {
        await audit.record(tx, {
          organizationId,
          actorType: 'user',
          actorId: userId,
          action: 'project.deletion_requested',
          targetType: 'project',
          targetId: deletion.projectId,
          metadata: { operationKey: `op_${'b'.repeat(64)}` },
          occurredAt: now,
        });
      },
    });
    expect(accepted.kind).toBe('accepted');

    await expect(
      requestStore.enqueueOrganization({
        organizationId,
        requestedBy: userId,
        operationKey: `op_${'d'.repeat(64)}`,
        requestFingerprint: 'e'.repeat(64),
        now,
        audit: () => Promise.reject(new Error('an existing child must not append another audit')),
      }),
    ).resolves.toHaveLength(1);
    let repositoryCalled = false;
    await expect(
      createTenantDbFactory(database.db)(organizationId).projects.create({
        name: 'Too late',
        slug: 'too-late',
        description: null,
        sourceType: 'prompt',
        supportLevel: 'compatible',
        createdBy: userId,
        now,
        repository: () => {
          repositoryCalled = true;
          return Promise.resolve({ internalRepoRef: 'must-not-exist' });
        },
        audit: () => Promise.reject(new Error('a fenced create must not append an audit')),
      }),
    ).resolves.toBe('organization_deleting');
    expect(repositoryCalled).toBe(false);

    const snapshots = new RecordingTarget();
    const git = new RecordingTarget();
    const job = createProjectDeletionJob({
      store: createDatabaseDeletionStore(database.db),
      workerId: 'integration-worker',
      snapshots,
      git,
      objects: createS3ProjectDeletionTarget(storage, s3),
      postgres: createPostgresProjectDeletionTarget(database.db),
    });
    await expect(job.runOnce(now)).resolves.toEqual({ kind: 'advanced', target: 'snapshots' });
    await expect(job.runOnce(new Date(now.getTime() + 1))).resolves.toEqual({ kind: 'advanced', target: 'git' });
    await expect(job.runOnce(new Date(now.getTime() + 2))).resolves.toEqual({ kind: 'advanced', target: 'objects' });
    await expect(job.runOnce(new Date(now.getTime() + 3))).resolves.toEqual({ kind: 'completed', target: 'postgres' });

    const deletion = await requestStore.get(organizationId, projectId);
    expect(deletion).toMatchObject({
      status: 'completed',
      targets: { snapshots: 'verified', git: 'verified', objects: 'verified', postgres: 'verified' },
    });
    await expect(
      requestStore.enqueue({
        organizationId,
        projectId,
        requestedBy: userId,
        operationKey: `op_${'b'.repeat(64)}`,
        requestFingerprint: 'c'.repeat(64),
        now,
        audit: () => Promise.reject(new Error('a completed replay must not append another audit')),
      }),
    ).resolves.toMatchObject({ kind: 'replay', deletion: { status: 'completed' } });
    expect(snapshots.calls).toBe(1);
    expect(git.calls).toBe(1);
    await expect(s3.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: storageRef }))).rejects.toMatchObject({
      $metadata: { httpStatusCode: 404 },
    });
    const [counts] = await database.sql<{
      projects: string;
      branches: string;
      artifacts: string;
      audits: string;
      deletions: string;
    }[]>`
      select
        (select count(*) from projects where id = ${projectId})::text as projects,
        (select count(*) from branches where project_id = ${projectId})::text as branches,
        (select count(*) from artifacts where project_id = ${projectId})::text as artifacts,
        (select count(*) from audit_events where target_id = ${projectId})::text as audits,
        (select count(*) from project_deletions where project_id = ${projectId} and status = 'completed')::text as deletions
    `;
    expect(counts).toEqual({ projects: '0', branches: '0', artifacts: '0', audits: '1', deletions: '1' });
  }, 180_000);
});
