import { newId } from '@zapp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../src/auth/cookies.js';
import { createDbUserStore } from '../../src/auth/users.js';
import { createRecordOnlyGitService } from '../../src/git/port.js';
import {
  createGitHubImportPublisher,
  GitHubImportQueueMessageSchema,
} from '../../src/integrations/github/import-queue.js';
import { createDbOrganizationStore, type OrganizationStore } from '../../src/orgs/store.js';
import { createDbAuditSink } from '../../src/plugins/audit.js';
import { IDEMPOTENT_REPLAY_HEADER } from '../../src/plugins/idempotency.js';
import { ORGANIZATION_HEADER } from '../../src/plugins/tenant.js';
import { createTenantDbFactory } from '../../src/tenant/db.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import {
  TEST_AUTH_CONFIG,
  TEST_CAPABILITY_SCAN,
  TEST_RATE_LIMITS,
  cookieJar,
  cookiesOf,
} from '../support/harness.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

const INSTALLATION_ID = '41122';
const REPOSITORY = 'zapp/example';
const BRANCH = 'feature/import';
const OPERATION_KEY = 'github-import-durable-retry-0001';
const NOW = new Date('2026-08-11T12:00:00.000Z');

interface Member {
  readonly userId: string;
  readonly headers: Record<string, string>;
}

describe.skipIf(!hasDatabase)('GitHub import failed retry, on PostgreSQL', () => {
  let database: TestDatabase;
  let organizations: OrganizationStore;
  let app: AppInstance;
  let auth: FakeAuthPort;
  let owner: Member;
  let organizationId: string;

  async function signIn(email: string): Promise<Member> {
    const code = `auth-code-${email}`;
    const start = await app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
    auth.issueCode(code, { externalId: `external-${email}`, email, displayName: email });
    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(start.headers['set-cookie'])) },
    });
    expect(callback.statusCode, callback.body).toBe(302);
    const cookies = cookiesOf(callback.headers['set-cookie']);
    const [user] = await database.sql<{ id: string }[]>`
      select id from users where email = ${email}
    `;
    if (user === undefined) throw new Error('sign-in created no user');
    return {
      userId: user.id,
      headers: {
        cookie: cookieJar(cookies),
        [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '',
      },
    };
  }

  function headers(): Record<string, string> {
    return { ...owner.headers, [ORGANIZATION_HEADER]: organizationId };
  }

  function enqueue(projectId: string) {
    return app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/import/github`,
      headers: { ...headers(), 'idempotency-key': OPERATION_KEY },
      payload: { installationId: INSTALLATION_ID, repo: REPOSITORY, branch: BRANCH },
    });
  }

  beforeAll(async () => {
    database = await setUpTestDatabase();
    await database.truncateIdentity();
    organizations = createDbOrganizationStore(database.db);
    auth = new FakeAuthPort();
    app = buildApp({
      logger: false,
      now: () => NOW,
      auth: { port: auth, users: createDbUserStore(database.db), config: TEST_AUTH_CONFIG },
      orgs: { organizations, audit: createDbAuditSink(database.db) },
      tenant: {
        tenantDb: createTenantDbFactory(database.db),
        git: createRecordOnlyGitService(),
        capabilityScan: TEST_CAPABILITY_SCAN,
      },
      limits: { config: TEST_RATE_LIMITS },
    });
    await app.ready();
    owner = await signIn('owner@github-import-retry.test');
    organizationId = (
      await organizations.create({
        name: 'GitHub import retry',
        slug: 'github-import-retry',
        creatorUserId: owner.userId,
        now: NOW,
        link: () => Promise.resolve({ externalOrgId: 'external-github-import-retry' }),
        audit: () => Promise.resolve(),
      })
    ).organization.id;
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('requeues exactly one persisted stage and exposes it through polling', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...headers(), 'idempotency-key': 'create-github-import-retry-project' },
      payload: { name: 'Durable Retry', sourceType: 'github_import' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const projectId = created.json<{ project: { id: string } }>().project.id;
    await database.sql`
      insert into integration_connections
        (id, organization_id, project_id, provider, status, credential_ref, configuration_json)
      values
        (${newId('intc')}, ${organizationId}, null, 'github', 'connected', null,
         ${JSON.stringify({ installationId: INSTALLATION_ID })}::jsonb)
    `;

    const accepted = await enqueue(projectId);
    expect(accepted.statusCode, accepted.body).toBe(202);
    const sent: string[] = [];
    const publisher = createGitHubImportPublisher({
      database: database.db,
      queue: { send: (body) => { sent.push(body); return Promise.resolve(); } },
      now: () => new Date('2026-08-11T12:01:00.000Z'),
    });
    expect(await publisher.publishOnce(10)).toBe(1);
    expect(GitHubImportQueueMessageSchema.parse(JSON.parse(sent[0] ?? ''))).toEqual({
      projectId,
      stage: 'queued',
    });

    await database.sql`
      update github_imports
         set status = 'failed', error_code = 'mirror_failed',
             updated_at = ${'2026-08-11T12:02:00.000Z'}::timestamptz
       where project_id = ${projectId}
    `;
    const failed = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/import/github`,
      headers: headers(),
    });
    expect(failed.json()).toMatchObject({ status: 'failed', errorCode: 'mirror_failed' });

    const retries = await Promise.all([enqueue(projectId), enqueue(projectId)]);
    expect(retries.map((response) => response.statusCode)).toEqual([202, 202]);
    expect(retries.map((response) => response.headers[IDEMPOTENT_REPLAY_HEADER])).toEqual([
      undefined,
      undefined,
    ]);
    const [mirrorState] = await database.sql<
      { status: string; error_code: string | null; stage: string; delivery_status: string; attempts: number; published_at: Date | null }[]
    >`
      select imports.status, imports.error_code, outbox.stage,
             outbox.status as delivery_status, outbox.attempts, outbox.published_at
        from github_imports imports
        join github_import_outbox outbox on outbox.project_id = imports.project_id
       where imports.project_id = ${projectId} and outbox.stage = 'queued'
    `;
    expect(mirrorState).toEqual({
      status: 'queued',
      error_code: null,
      stage: 'queued',
      delivery_status: 'pending',
      attempts: 0,
      published_at: null,
    });
    expect(await publisher.publishOnce(10)).toBe(1);
    expect(await publisher.publishOnce(10)).toBe(0);
    expect(sent.slice(1).map((body) => GitHubImportQueueMessageSchema.parse(JSON.parse(body)))).toEqual([
      { projectId, stage: 'queued' },
    ]);
    const queuedPoll = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/import/github`,
      headers: headers(),
    });
    expect(queuedPoll.json()).toMatchObject({ status: 'queued', errorCode: null });

    await database.sql`
      update github_imports
         set status = 'failed', external_repo_ref = ${REPOSITORY},
             head_commit_sha = ${'a'.repeat(40)}, scan_id = ${`github-import:${projectId}`},
             error_code = 'scan_unavailable',
             updated_at = ${'2026-08-11T12:03:00.000Z'}::timestamptz
       where project_id = ${projectId}
    `;
    await database.sql`
      insert into github_import_outbox
        (project_id, stage, status, attempts, next_attempt_at, created_at, published_at)
      values
        (${projectId}, 'scan_pending', 'published', 1,
         ${'2026-08-11T12:03:00.000Z'}::timestamptz,
         ${'2026-08-11T12:03:00.000Z'}::timestamptz,
         ${'2026-08-11T12:03:01.000Z'}::timestamptz)
      on conflict (project_id, stage) do update
        set status = excluded.status, attempts = excluded.attempts,
            next_attempt_at = excluded.next_attempt_at, published_at = excluded.published_at
    `;

    const scanRetry = await enqueue(projectId);
    expect(scanRetry.statusCode, scanRetry.body).toBe(202);
    const scanPoll = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/import/github`,
      headers: headers(),
    });
    expect(scanPoll.json()).toMatchObject({ status: 'scan_pending', errorCode: null });
    expect(await publisher.publishOnce(10)).toBe(1);
    expect(await publisher.publishOnce(10)).toBe(0);
    expect(GitHubImportQueueMessageSchema.parse(JSON.parse(sent.at(-1) ?? ''))).toEqual({
      projectId,
      stage: 'scan_pending',
    });
  }, 60_000);
});
