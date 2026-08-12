import { idSchema } from '@zapp/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadArtifactStorageEnv } from '../../src/env.js';
import {
  createAgentEventArchiveJob,
  createPostgresAgentEventArchiveDatabase,
  createS3AgentEventArchiveObjectStore,
  restoreRunEvents,
} from '../../src/jobs/archive.js';
import { credentialGate } from '../support/credentials.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

const artifactGate = credentialGate([
  'ARTIFACT_ENDPOINT',
  'ARTIFACT_REGION',
  'ARTIFACT_BUCKET',
  'ARTIFACT_KEY',
  'ARTIFACT_SECRET',
]);
const enabled = hasDatabase && artifactGate.present;

if (!artifactGate.present) {
  console.warn(`[@zapp/control-api] archive integration skipped: ${artifactGate.reason}`);
}

describe.skipIf(!enabled)('OPS-14 real partition and object archive', () => {
  let database: TestDatabase;
  const userId = idSchema('user').parse('user_01J8ME7YQZJ2V9Q0X3T5B6K7NC');
  const organizationId = idSchema('org').parse('org_01J8ME7YQZJ2V9Q0X3T5B6K7NC');
  const projectId = idSchema('proj').parse('proj_01J8ME7YQZJ2V9Q0X3T5B6K7NC');
  const runId = idSchema('run').parse('run_01J8ME7YQZJ2V9Q0X3T5B6K7NC');
  const eventId = idSchema('evt').parse('evt_01J8ME7YQZJ2V9Q0X3T5B6K7NC');

  beforeAll(async () => {
    database = await setUpTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.truncateIdentity();
    await database.sql.unsafe('drop table if exists "agent_events_2025_01"');
    await database.sql`select create_event_partition('2025-01-01'::date)`;
    await database.sql.begin(async (tx) => {
      await tx`insert into users (id, email, display_name)
               values (${userId}, 'archive@test.invalid', 'Archive')`;
      await tx`insert into organizations (id, name, slug)
               values (${organizationId}, 'Archive', 'archive')`;
      await tx`insert into projects
               (id, organization_id, name, slug, source_type, support_level, created_by)
               values (${projectId}, ${organizationId}, 'Archive', 'archive', 'prompt', 'compatible', ${userId})`;
      await tx`insert into agent_runs
               (id, organization_id, project_id, mode, app_type, request_fingerprint, status, started_by, budget_json, plan_max_credits)
               values (${runId}, ${organizationId}, ${projectId}, 'build', 'web', ${'a'.repeat(64)}, 'completed', ${userId}, '{}'::jsonb, 1)`;
      await tx`insert into agent_events
               (id, organization_id, project_id, run_id, sequence, type, payload_json, visibility, occurred_at)
               values (${eventId}, ${organizationId}, ${projectId}, ${runId}, 1, 'run.created', '{"source":"archive-test"}'::jsonb, 'user', '2025-01-04T00:00:00.000Z')`;
    });
  });

  it('uploads verified JSONL, drops the old partition, and rehydrates read-only events', async () => {
    const objectStore = createS3AgentEventArchiveObjectStore(loadArtifactStorageEnv());
    const archiveDatabase = createPostgresAgentEventArchiveDatabase({
      async query(statement) {
        return await database.sql.unsafe(statement);
      },
    });
    const result = await createAgentEventArchiveJob({
      database: archiveDatabase,
      objectStore,
    }).run(new Date('2025-05-03T00:00:00.000Z'));

    expect(result.archived).toBe(1);
    const [partition] = await database.sql<{ partition: string | null }[]>`
      select to_regclass('public.agent_events_2025_01')::text as partition
    `;
    expect(partition?.partition).toBeNull();
    await expect(
      restoreRunEvents({
        objectStore,
        archiveKey: 'archives/agent-events/2025/01/agent_events_2025_01.jsonl',
        runId,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: eventId,
        runId,
        occurredAt: '2025-01-04T00:00:00.000Z',
        payload: { source: 'archive-test' },
      }),
    ]);
  });
});
