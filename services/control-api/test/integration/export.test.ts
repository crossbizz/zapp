import { fileURLToPath } from 'node:url';

import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { newId } from '@zapp/contracts';
import { createDb, type Db } from '@zapp/db';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadArtifactStorageEnv } from '../../src/env.js';
import { createDbAuditSink } from '../../src/plugins/audit.js';
import { createS3AttachmentStorage } from '../../src/routes/attachments.js';
import {
  buildProjectExportTar,
  createDatabaseProjectExportSource,
} from '../../src/routes/export.js';
import { credentialGate } from '../support/credentials.js';
import { hasDatabase, testDatabaseUrl } from './helpers.js';

const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../../../packages/db/drizzle', import.meta.url),
);
const DATABASE_SUFFIX = '_cp18_export_test';

function exportDatabaseUrl(url: string): string {
  const parsed = new URL(testDatabaseUrl(url));
  const name = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  parsed.pathname = `/${name.replace(/_control_api_test$/u, DATABASE_SUFFIX)}`;
  return parsed.toString();
}

async function setUpDatabase(): Promise<Db> {
  const url = exportDatabaseUrl(process.env.DATABASE_URL ?? '');
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//u, ''));
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const admin = createDb(maintenance.toString());
  try {
    await admin.sql.unsafe(`create database "${name}"`);
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      (error as { code?: unknown }).code !== '42P04'
    ) {
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
  console.warn(`[@zapp/control-api] project export integration skipped: ${artifactGate.reason}`);
}

function tarEntry(tar: Buffer, wanted: string): Buffer | undefined {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return undefined;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const size = Number.parseInt(
      header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim(),
      8,
    );
    const start = offset + 512;
    if (name === wanted) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

describe.skipIf(!enabled)('CP-18 PostgreSQL and MinIO portable export', () => {
  let database: Db;

  beforeAll(async () => {
    database = await setUpDatabase();
  }, 180_000);

  afterAll(async () => {
    await database.close();
  });

  it('projects names without ciphertext, records audit atomically, and downloads the tar', async () => {
    const now = new Date('2026-08-12T14:00:00.000Z');
    const userId = newId('user');
    const organizationId = newId('org');
    const projectId = newId('proj');
    const specificationId = newId('spec');
    const secretId = newId('sec');
    await database.sql.begin(async (tx) => {
      await tx`insert into users (id, email, display_name)
               values (${userId}, ${`${userId}@export.test.invalid`}, 'Exporter')`;
      await tx`insert into organizations (id, name, slug)
               values (${organizationId}, 'Export', ${`export-${organizationId.slice(-8).toLowerCase()}`})`;
      await tx`insert into projects
               (id, organization_id, name, slug, source_type, support_level, created_by)
               values (${projectId}, ${organizationId}, 'Portable', 'portable', 'prompt', 'compatible', ${userId})`;
      await tx`insert into specifications
               (id, organization_id, project_id, version, status, content_json, created_by)
               values (${specificationId}, ${organizationId}, ${projectId}, 1, 'approved', ${JSON.stringify({ title: 'Portable' })}::jsonb, ${userId})`;
      await tx`insert into secret_metadata
               (id, organization_id, project_id, environment_id, name, encrypted_value_ref, created_by, key_version)
               values (${secretId}, ${organizationId}, ${projectId}, null, 'DATABASE_URL', ${`pg:secret_ciphertexts/${secretId}`}, ${userId}, 1)`;
      await tx`insert into secret_ciphertexts (secret_id, ciphertext, iv, auth_tag, wrapped_dek)
               values (${secretId}, 'ciphertext-sentinel', 'iv-sentinel', 'tag-sentinel', 'dek-sentinel')`;
    });

    const source = createDatabaseProjectExportSource(database.db);
    const projected = await source.collect({ organizationId, projectId });
    if (projected === undefined) throw new Error('project export projection disappeared');
    expect(projected.environmentVariableNames).toEqual(['DATABASE_URL']);
    expect(JSON.stringify(projected)).not.toMatch(/ciphertext-sentinel|dek-sentinel|encrypted_value_ref/iu);

    const exportId = newId('art');
    const tar = buildProjectExportTar({
      projectId,
      exportId,
      gitBundle: Buffer.from('integration git bundle'),
      data: projected,
    });
    const storage = loadArtifactStorageEnv();
    const objects = createS3AttachmentStorage(storage);
    const key = `org/${organizationId}/project/${projectId}/exports/${exportId}.tar`;
    await objects.put({ key, body: tar, contentType: 'application/x-tar' });
    const url = await objects.signGet({ key, expiresInSeconds: 300 });
    const downloaded = await fetch(url);
    expect(downloaded.status).toBe(200);
    const body = Buffer.from(await downloaded.arrayBuffer());
    expect(tarEntry(body, 'repository.bundle')).toEqual(Buffer.from('integration git bundle'));
    expect(JSON.parse(tarEntry(body, 'environment-variable-names.json')?.toString('utf8') ?? 'null'))
      .toEqual(['DATABASE_URL']);
    expect(body.includes(Buffer.from('ciphertext-sentinel'))).toBe(false);

    const audit = createDbAuditSink(database.db);
    await expect(
      source.record({
        organizationId,
        projectId,
        exportId,
        storageRef: key,
        contentHash: 'a'.repeat(64),
        byteSize: tar.length,
        operationKey: `op_${'b'.repeat(64)}`,
        createdAt: now,
        audit: async (tx) => {
          await audit.record(tx, {
            organizationId,
            actorType: 'user',
            actorId: userId,
            action: 'project.exported',
            targetType: 'artifact',
            targetId: exportId,
            metadata: { projectId },
            occurredAt: now,
          });
        },
      }),
    ).resolves.toBe('created');
    await expect(source.get({ organizationId, projectId, exportId })).resolves.toMatchObject({
      storageRef: key,
      contentHash: 'a'.repeat(64),
      byteSize: tar.length,
    });
    const [counts] = await database.sql<{ artifacts: string; audits: string }[]>`
      select
        (select count(*) from artifacts where id = ${exportId})::text as artifacts,
        (select count(*) from audit_events where target_id = ${exportId})::text as audits
    `;
    expect(counts).toEqual({ artifacts: '1', audits: '1' });

    const client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: true,
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
    });
    await client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
  }, 180_000);
});
