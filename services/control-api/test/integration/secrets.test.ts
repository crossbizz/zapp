import { ApiErrorSchema, newId } from '@zapp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../src/auth/cookies.js';
import { createDbUserStore } from '../../src/auth/users.js';
import { SERVICE_TOKEN_HEADER } from '../../src/internal/service-auth.js';
import { createDbOrganizationStore, type OrganizationStore } from '../../src/orgs/store.js';
import { createDbAuditSink } from '../../src/plugins/audit.js';
import { ORGANIZATION_HEADER } from '../../src/plugins/tenant.js';
import { decryptSecret } from '../../src/secrets/crypto.js';
import { createTenantDbFactory } from '../../src/tenant/db.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import { FakeServiceTokens } from '../support/fake-service-tokens.js';
import {
  TEST_AUTH_CONFIG,
  TEST_MASTER_KEY,
  TEST_RATE_LIMITS,
  cookieJar,
  cookiesOf,
} from '../support/harness.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

/**
 * The vault against a real PostgreSQL (CP-7).
 *
 * `test/secrets.test.ts` proves the routes behave. This proves the four things
 * only a database can be asked about:
 *
 *   - **The plaintext is nowhere in the tables.** Not "the response omits it" —
 *     every text column of both tables is searched for the value that was
 *     stored, which is the assertion a code review cannot make.
 *   - **The name uniqueness is the index's**, per environment, with a null
 *     environment as its own scope — two partial unique indexes rather than one,
 *     because Postgres treats NULLs as distinct (`packages/db/drizzle/0007`).
 *   - **The delete cascades.** No ciphertext outlives the metadata row that
 *     named it, and that is the schema's doing rather than a second statement
 *     somebody could forget.
 *   - **The decrypt and its audit row share a transaction.** With the audit
 *     insert made to fail, the request answers 500 and no value comes out.
 *
 * Env-gated on the FND-7 dev stack: with no `DATABASE_URL` this suite skips
 * loudly, and never passes silently.
 */

const SANDBOX = 'sandbox-service';
const PLAINTEXT = 'postgres://zapp:hunter2-do-not-leak@db.internal:5432/acme';

interface Member {
  readonly userId: string;
  readonly headers: Record<string, string>;
}

describe.skipIf(!hasDatabase)('the secrets vault, on PostgreSQL', () => {
  let database: TestDatabase;
  let store: OrganizationStore;
  let app: AppInstance;
  let port: FakeAuthPort;
  let owner: Member;
  let organizationId: string;
  let projectId: string;
  let environmentIds: string[];
  let serviceToken: string;

  const noAudit = (): Promise<void> => Promise.resolve();

  async function signIn(email: string): Promise<Member> {
    const code = `auth-code-${email}`;
    const start = await app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
    port.issueCode(code, { externalId: `external-${email}`, email, displayName: email });

    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(start.headers['set-cookie'])) },
    });
    expect(callback.statusCode, callback.body).toBe(302);

    const cookies = cookiesOf(callback.headers['set-cookie']);
    const [row] = await database.sql<{ id: string }[]>`
      select id from users where email = ${email}
    `;
    if (row === undefined) {
      throw new Error(`sign-in created no user for ${email}`);
    }
    return {
      userId: row.id,
      headers: { cookie: cookieJar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
    };
  }

  function as(member: Member = owner): Record<string, string> {
    return { ...member.headers, [ORGANIZATION_HEADER]: organizationId };
  }

  async function setSecret(
    body: Record<string, unknown>,
  ): Promise<{ id: string; keyVersion: number }> {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/secrets`,
      headers: as(),
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ secret: { id: string; keyVersion: number } }>().secret;
  }

  beforeAll(async () => {
    database = await setUpTestDatabase();
    await database.truncateIdentity();
    store = createDbOrganizationStore(database.db);
    port = new FakeAuthPort();
    const serviceTokens = new FakeServiceTokens();
    serviceToken = serviceTokens.issue(SANDBOX);

    app = buildApp({
      logger: false,
      auth: { port, users: createDbUserStore(database.db), config: TEST_AUTH_CONFIG },
      orgs: { organizations: store, audit: createDbAuditSink(database.db) },
      tenant: { tenantDb: createTenantDbFactory(database.db) },
      secrets: { masterKey: TEST_MASTER_KEY, serviceTokens },
      limits: { config: TEST_RATE_LIMITS },
    });
    await app.ready();

    owner = await signIn('owner@vault.test');
    organizationId = (
      await store.create({
        name: 'vault',
        slug: 'vault',
        creatorUserId: owner.userId,
        now: new Date(),
        link: () => Promise.resolve({ externalOrgId: 'external-vault' }),
        audit: noAudit,
      })
    ).organization.id;

    const project = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: as(),
      payload: { name: 'Vault Project' },
    });
    expect(project.statusCode, project.body).toBe(201);
    const resources = project.json<{
      project: { id: string };
      environments: { id: string }[];
    }>();
    projectId = resources.project.id;
    environmentIds = resources.environments.map((environment) => environment.id);
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('writes no plaintext into any column of either table', async () => {
    const secret = await setSecret({
      name: 'DATABASE_URL',
      value: PLAINTEXT,
      environmentId: environmentIds[0],
    });

    // Every text column of both tables, as the database actually holds them.
    // `select *` on purpose: the question is whether the value is *anywhere*,
    // and naming the columns would only search the ones already thought about.
    const [metadata] = await database.sql<Record<string, unknown>[]>`
      select * from secret_metadata where id = ${secret.id}
    `;
    const [vault] = await database.sql<Record<string, unknown>[]>`
      select * from secret_ciphertexts where secret_id = ${secret.id}
    `;
    expect(metadata).toBeDefined();
    expect(vault).toBeDefined();

    for (const row of [metadata, vault]) {
      expect(JSON.stringify(row)).not.toContain('hunter2');
      expect(JSON.stringify(row)).not.toContain(PLAINTEXT);
    }
    // And the ciphertext really is that value — an "encryption" that stored
    // something unrelated would also pass the assertions above.
    expect(
      await decryptSecret(
        {
          ciphertext: String(vault?.['ciphertext']),
          iv: String(vault?.['iv']),
          authTag: String(vault?.['auth_tag']),
          wrappedDek: String(vault?.['wrapped_dek']),
          keyVersion: Number(metadata?.['key_version']),
        },
        TEST_MASTER_KEY,
      ),
    ).toBe(PLAINTEXT);
  });

  it('makes a name unique per environment, with no environment as its own scope', async () => {
    const [preview, production] = environmentIds;

    await setSecret({ name: 'SCOPED_KEY', value: 'preview', environmentId: preview });
    await setSecret({ name: 'SCOPED_KEY', value: 'production', environmentId: production });
    // Two rows with a null environment would both be allowed under a single
    // four-column unique index, since Postgres treats NULLs as distinct. The
    // second of these is what proves the partial index is doing its job.
    await setSecret({ name: 'SCOPED_KEY', value: 'default' });

    for (const body of [
      { name: 'SCOPED_KEY', value: 'again', environmentId: preview },
      { name: 'SCOPED_KEY', value: 'again' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/secrets`,
        headers: as(),
        payload: body,
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(ApiErrorSchema.parse(response.json()).error.code).toBe('secret_name_taken');
    }

    const rows = await database.sql<{ count: string }[]>`
      select count(*)::text as count from secret_metadata
        where project_id = ${projectId} and name = 'SCOPED_KEY'
    `;
    expect(rows[0]?.count).toBe('3');
  });

  it('drops the ciphertext with the row that named it', async () => {
    const secret = await setSecret({ name: 'DOOMED_KEY', value: PLAINTEXT });
    expect(
      await database.sql`select secret_id from secret_ciphertexts where secret_id = ${secret.id}`,
    ).toHaveLength(1);

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}/secrets/${secret.id}`,
      headers: as(),
    });
    expect(response.statusCode, response.body).toBe(204);

    // The cascade, not a second statement: no encrypted value outlives its
    // metadata row.
    expect(
      await database.sql`select secret_id from secret_ciphertexts where secret_id = ${secret.id}`,
    ).toEqual([]);
    expect(await database.sql`select id from secret_metadata where id = ${secret.id}`).toEqual([]);

    const audit = await database.sql<{ action: string }[]>`
      select action from audit_events where target_id = ${secret.id} order by occurred_at
    `;
    expect(audit.map((row) => row.action)).toEqual(['secret.created', 'secret.deleted']);
  });

  it('overwrites the stored value on a rotation, keeping exactly one vault row', async () => {
    const secret = await setSecret({ name: 'ROTATING_KEY', value: 'the-old-value' });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/secrets/${secret.id}/rotate`,
      headers: as(),
      payload: { value: 'the-new-value' },
    });
    expect(response.statusCode, response.body).toBe(200);

    const rows = await database.sql<Record<string, unknown>[]>`
      select * from secret_ciphertexts where secret_id = ${secret.id}
    `;
    expect(rows).toHaveLength(1);
    const [metadata] = await database.sql<Record<string, unknown>[]>`
      select rotated_at, key_version from secret_metadata where id = ${secret.id}
    `;
    expect(metadata?.['rotated_at']).not.toBe(null);

    // The old value is unrecoverable — which is what "rotated" has to mean.
    expect(
      await decryptSecret(
        {
          ciphertext: String(rows[0]?.['ciphertext']),
          iv: String(rows[0]?.['iv']),
          authTag: String(rows[0]?.['auth_tag']),
          wrappedDek: String(rows[0]?.['wrapped_dek']),
          keyVersion: Number(metadata?.['key_version']),
        },
        TEST_MASTER_KEY,
      ),
    ).toBe('the-new-value');
  });

  it('writes exactly one audit row per decrypt, in the reading transaction', async () => {
    const secret = await setSecret({ name: 'INJECTED_KEY', value: PLAINTEXT });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/secrets/decrypt',
      headers: { [SERVICE_TOKEN_HEADER]: serviceToken },
      payload: {
        organizationId,
        secretId: secret.id,
        reason: 'injecting into a sandbox for a run',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ value: string }>().value).toBe(PLAINTEXT);

    const rows = await database.sql<
      { actor_type: string; actor_id: string; metadata_json: Record<string, unknown> }[]
    >`
      select actor_type, actor_id, metadata_json from audit_events
        where target_id = ${secret.id} and action = 'secret.decrypted'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_type).toBe('service');
    expect(rows[0]?.actor_id).toBe(SANDBOX);
    expect(rows[0]?.metadata_json).toEqual({
      secretName: 'INJECTED_KEY',
      requestingService: SANDBOX,
      reason: 'injecting into a sandbox for a run',
    });
    expect(JSON.stringify(rows[0])).not.toContain('hunter2');
  });

  it('returns no value when the audit row cannot be written', async () => {
    /**
     * The mutation check, against a real transaction: an `audit_events` insert
     * that fails must take the read with it, so no value comes out.
     *
     * A second app over the *same* database, whose only difference is a sink
     * that rejects — which is what a failed insert looks like from inside the
     * transaction. Everything else here is the shipping path, and the secret it
     * reads is a real row written by the route above.
     */
    const secret = await setSecret({ name: 'UNAUDITABLE_KEY', value: PLAINTEXT });
    const broken = buildApp({
      logger: false,
      auth: {
        port: new FakeAuthPort(),
        users: createDbUserStore(database.db),
        config: TEST_AUTH_CONFIG,
      },
      orgs: {
        organizations: store,
        audit: {
          record: () => Promise.reject(new Error('audit_events insert failed')),
          recordDetached: () => Promise.resolve(),
        },
      },
      tenant: { tenantDb: createTenantDbFactory(database.db) },
      secrets: {
        masterKey: TEST_MASTER_KEY,
        serviceTokens: { verify: () => Promise.resolve({ service: SANDBOX }) },
      },
      limits: { config: TEST_RATE_LIMITS },
    });
    await broken.ready();

    try {
      const response = await broken.inject({
        method: 'POST',
        url: '/internal/secrets/decrypt',
        headers: { [SERVICE_TOKEN_HEADER]: serviceToken },
        payload: {
          organizationId,
          secretId: secret.id,
          reason: 'the trail is broken and this must fail',
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('hunter2');
    } finally {
      await broken.close();
    }
  });

  it('refuses to mint a second repository row for one ref', async () => {
    // `repositories_org_internal_ref_idx` (plan 02 CP-6 review): two rows
    // sharing an `internal_repo_ref` are two projects pushing to one Git
    // repository. The API cannot express it — the ref derives from the
    // immutable project id — so this asks the schema directly.
    const [existing] = await database.sql<{ internal_repo_ref: string; project_id: string }[]>`
      select internal_repo_ref, project_id from repositories where project_id = ${projectId}
    `;
    expect(existing).toBeDefined();

    await expect(
      database.sql`
        insert into repositories (id, organization_id, project_id, provider, internal_repo_ref, default_branch, sync_policy)
        values (${newId('repo')}, ${organizationId}, ${projectId}, 'internal',
                ${existing?.internal_repo_ref ?? ''}, 'main', 'none')
      `,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('leaves provisioned_at null for a record-only repository', async () => {
    // Plan 06's GIT-2 is what sets it; until then the row says honestly that the
    // repository on disk does not exist yet (plan 02 CP-6 review).
    const rows = await database.sql<{ provisioned_at: Date | null }[]>`
      select provisioned_at from repositories where project_id = ${projectId}
    `;
    expect(rows[0]?.provisioned_at).toBe(null);
  });
});
