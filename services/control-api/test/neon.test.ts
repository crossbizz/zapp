import { randomBytes } from 'node:crypto';

import { newId } from '@zapp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type AppInstance } from '../src/app.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../src/auth/cookies.js';
import { createDbUserStore } from '../src/auth/users.js';
import {
  configureNeonRoleSeparation,
  createNeonManagementClient,
  createNeonValidationBranchPort,
  ensureNeonPreviewBranch,
  readNeonSchema,
  type NeonManagementPort,
  type NeonSqlPort,
} from '../src/integrations/neon/branches.js';
import {
  createNeonIntegrationPort,
  type NeonProjectManagementPort,
} from '../src/integrations/neon/connect.js';
import { createNeonMigrationValidationAdapter } from '../src/integrations/neon/migrations.js';
import { createDbOrganizationStore, type OrganizationStore } from '../src/orgs/store.js';
import { createDbAuditSink } from '../src/plugins/audit.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { createTenantDbFactory } from '../src/tenant/db.js';
import { FakeAuthPort } from './support/fake-auth-port.js';
import {
  TEST_AUTH_CONFIG,
  TEST_MASTER_KEY,
  TEST_RATE_LIMITS,
  cookieJar,
  cookiesOf,
} from './support/harness.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './integration/helpers.js';
import { credentialGate } from './support/credentials.js';

const FIXTURE_API_KEY = randomBytes(32).toString('base64url');

describe('Neon migration validation', () => {
  it('creates, validates, and deletes a temporary verification branch', async () => {
    const events: string[] = [];
    const expiresAt = new Date('2026-08-11T13:00:00.000Z');
    const adapter = createNeonMigrationValidationAdapter({
      projectId: 'spring-example-302709',
      apiKey: FIXTURE_API_KEY,
      parentBranchId: 'br-preview-123',
      databaseName: 'neondb',
      runId: 'run_01JNEONVALIDATION',
      now: () => new Date('2026-08-11T12:00:00.000Z'),
      ttlMs: 60 * 60 * 1_000,
      history: {
        pendingMigrations: () =>
          Promise.resolve([
            {
              path: 'migrations/0001_create_widgets.sql',
              sql: 'create table widgets(id bigint primary key);',
            },
          ]),
      },
      branches: {
        createValidationBranch(input) {
          if (input.expiresAt === undefined) throw new Error('validation branch requires expiry');
          events.push(`created:${input.name}:${input.expiresAt.toISOString()}`);
          expect(input).toMatchObject({
            projectId: 'spring-example-302709',
            parentBranchId: 'br-preview-123',
            name: 'verify/run-run_01JNEONVALIDATION',
          });
          expect(input.apiKey).toBe(FIXTURE_API_KEY);
          expect(input.expiresAt).toEqual(expiresAt);
          return Promise.resolve({
            branchId: 'br-validation-456',
            migrationConnectionString: 'postgresql://migration@validation.test/neondb',
          });
        },
        deleteBranch(input) {
          events.push(`deleted:${input.branchId}`);
          return Promise.resolve();
        },
      },
      sql: {
        open(connectionString) {
          expect(connectionString).toBe('postgresql://migration@validation.test/neondb');
          return Promise.resolve({
            execute(statement) {
              events.push(statement === 'select 1' ? 'smoke:passed' : `applied:${statement}`);
              return Promise.resolve();
            },
            query: () => Promise.resolve([]),
            close: () => Promise.resolve(),
          });
        },
      },
      reversibility: {
        classify: () => Promise.resolve('compensating'),
      },
      smokeQueries: ['select 1'],
    });

    await expect(
      adapter.validatePendingMigrations({ commitSha: 'a'.repeat(40), workspaceRoot: '.' }),
    ).resolves.toEqual({
      kind: 'validated',
      provider: 'neon',
      isolatedTarget: { kind: 'neon_branch', reference: 'br-validation-456' },
      migrations: [
        {
          path: 'migrations/0001_create_widgets.sql',
          sql: 'create table widgets(id bigint primary key);',
        },
      ],
      applyStatus: 'passed',
      smokeStatus: 'passed',
      cleanupStatus: 'passed',
      reversibility: 'compensating',
    });
    expect(events).toEqual([
      'created:verify/run-run_01JNEONVALIDATION:2026-08-11T13:00:00.000Z',
      'applied:create table widgets(id bigint primary key);',
      'smoke:passed',
      'deleted:br-validation-456',
    ]);
  });

  it('deletes the temporary branch when migration application fails', async () => {
    const events: string[] = [];
    const adapter = createNeonMigrationValidationAdapter({
      projectId: 'spring-example-302709',
      apiKey: FIXTURE_API_KEY,
      parentBranchId: 'br-preview-123',
      databaseName: 'neondb',
      runId: 'run_01JNEONFAILURE',
      history: {
        pendingMigrations: () =>
          Promise.resolve([{ path: 'migrations/0002_bad.sql', sql: 'select broken' }]),
      },
      branches: {
        createValidationBranch: () =>
          Promise.resolve({
            branchId: 'br-validation-failed',
            migrationConnectionString: 'postgresql://migration@validation.test/neondb',
          }),
        deleteBranch(input) {
          events.push(`deleted:${input.branchId}`);
          return Promise.resolve();
        },
      },
      sql: {
        open: () =>
          Promise.resolve({
            execute() {
              events.push('apply:failed');
              return Promise.reject(new Error('migration rejected'));
            },
            query: () => Promise.resolve([]),
            close() {
              events.push('connection:closed');
              return Promise.resolve();
            },
          }),
      },
      reversibility: { classify: () => Promise.resolve('unavailable') },
    });

    await expect(
      adapter.validatePendingMigrations({ commitSha: 'b'.repeat(40), workspaceRoot: '.' }),
    ).resolves.toMatchObject({
      kind: 'validated',
      provider: 'neon',
      applyStatus: 'failed',
      smokeStatus: 'failed',
      cleanupStatus: 'passed',
    });
    expect(events).toEqual(['apply:failed', 'connection:closed', 'deleted:br-validation-failed']);
  });
});

describe('Neon management and schema boundaries', () => {
  it('exhausts cursor pagination before resolving the default branch', async () => {
    const urls: string[] = [];
    const responses = [
      {
        branches: [{ id: 'br-feature-123', name: 'feature', default: false }],
        pagination: { next: 'opaque-next-page' },
      },
      {
        branches: [{ id: 'br-main-456', name: 'main', default: true }],
        pagination: {},
      },
    ];
    const management = createNeonManagementClient({
      baseUrl: 'https://neon.test/api/v2',
      fetch(input) {
        urls.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        const body = responses.shift();
        if (body === undefined) throw new Error('unexpected pagination request');
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });

    await expect(
      management.listBranches({
        projectId: 'spring-example-302709',
        apiKey: FIXTURE_API_KEY,
      }),
    ).resolves.toEqual([
      { id: 'br-feature-123', name: 'feature', isDefault: false },
      { id: 'br-main-456', name: 'main', isDefault: true },
    ]);
    expect(urls).toEqual([
      'https://neon.test/api/v2/projects/spring-example-302709/branches?limit=400',
      'https://neon.test/api/v2/projects/spring-example-302709/branches?limit=400&cursor=opaque-next-page',
    ]);
  });

  it('creates a dedicated preview branch from the default production branch', async () => {
    const created: unknown[] = [];
    const management: NeonManagementPort = {
      getProject: () => Promise.resolve({ projectId: 'spring-example-302709' }),
      listBranches: () => Promise.resolve([{ id: 'br-main-456', name: 'main', isDefault: true }]),
      createBranch(input) {
        created.push(input);
        return Promise.resolve({
          id: 'br-preview-123',
          name: input.name,
          parentBranchId: input.parentBranchId,
          isDefault: false,
        });
      },
      deleteBranch: () => Promise.resolve(),
      branchConnection: () => Promise.reject(new Error('not needed')),
    };

    await expect(
      ensureNeonPreviewBranch({
        management,
        projectId: 'spring-example-302709',
        apiKey: FIXTURE_API_KEY,
        name: 'preview/zapp-proj_01JNEON',
        parentBranchId: 'br-main-456',
      }),
    ).resolves.toMatchObject({ id: 'br-preview-123', parentBranchId: 'br-main-456' });
    expect(created).toEqual([
      {
        projectId: 'spring-example-302709',
        apiKey: FIXTURE_API_KEY,
        name: 'preview/zapp-proj_01JNEON',
        parentBranchId: 'br-main-456',
      },
    ]);
  });

  it('creates an expiring branch with a compute and deletes it after use', async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const responses = [
      new Response(
        JSON.stringify({
          branch: {
            id: 'br-validation-456',
            name: 'verify/run-run_01JNEONVALIDATION',
            parent_id: 'br-preview-123',
            default: false,
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
      new Response(null, { status: 204 }),
    ];
    const management = createNeonManagementClient({
      baseUrl: 'https://neon.test/api/v2',
      fetch(input, init) {
        requests.push({
          url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          ...(init === undefined ? {} : { init }),
        });
        const response = responses.shift();
        if (response === undefined) throw new Error('unexpected Neon request');
        return Promise.resolve(response);
      },
    });

    const branch = await management.createBranch({
      projectId: 'spring-example-302709',
      apiKey: FIXTURE_API_KEY,
      parentBranchId: 'br-preview-123',
      name: 'verify/run-run_01JNEONVALIDATION',
      expiresAt: new Date('2026-08-11T13:00:00.000Z'),
    });
    await management.deleteBranch({
      projectId: 'spring-example-302709',
      apiKey: FIXTURE_API_KEY,
      branchId: branch.id,
    });

    expect(branch).toEqual({
      id: 'br-validation-456',
      name: 'verify/run-run_01JNEONVALIDATION',
      parentBranchId: 'br-preview-123',
      isDefault: false,
    });
    expect(requests.map(({ url, init }) => ({ url, method: init?.method }))).toEqual([
      {
        url: 'https://neon.test/api/v2/projects/spring-example-302709/branches',
        method: 'POST',
      },
      {
        url: 'https://neon.test/api/v2/projects/spring-example-302709/branches/br-validation-456',
        method: 'DELETE',
      },
    ]);
    expect(requests[0]?.init?.body).toBe(
      JSON.stringify({
        branch: {
          name: 'verify/run-run_01JNEONVALIDATION',
          parent_id: 'br-preview-123',
          expires_at: '2026-08-11T13:00:00Z',
        },
        endpoints: [{ type: 'read_write' }],
      }),
    );
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(
      `Bearer ${FIXTURE_API_KEY}`,
    );
  });

  it('selects the explicitly configured database for branch connections', async () => {
    const urls: string[] = [];
    const responses = [
      new Response(
        JSON.stringify({
          databases: [
            { name: 'otherdb', owner_name: 'other_owner' },
            { name: 'appdb', owner_name: 'app_owner' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
      new Response(JSON.stringify({ uri: 'postgresql://app_owner@db.test/appdb' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    const management = createNeonManagementClient({
      baseUrl: 'https://neon.test/api/v2',
      fetch(input) {
        urls.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        const response = responses.shift();
        if (response === undefined) throw new Error('unexpected connection request');
        return Promise.resolve(response);
      },
    });

    await expect(
      management.branchConnection({
        projectId: 'spring-example-302709',
        apiKey: FIXTURE_API_KEY,
        branchId: 'br-preview-123',
        databaseName: 'appdb',
      }),
    ).resolves.toEqual({
      databaseName: 'appdb',
      roleName: 'app_owner',
      uri: 'postgresql://app_owner@db.test/appdb',
    });
    expect(urls[1]).toContain('database_name=appdb');
    expect(urls[1]).toContain('role_name=app_owner');
  });

  it('deletes a created validation branch when connection discovery fails', async () => {
    const deleted: string[] = [];
    const management: NeonManagementPort = {
      getProject: () => Promise.resolve({ projectId: 'spring-example-302709' }),
      listBranches: () => Promise.resolve([]),
      createBranch: (input) =>
        Promise.resolve({
          id: 'br-orphan-risk',
          name: input.name,
          parentBranchId: input.parentBranchId,
          isDefault: false,
        }),
      branchConnection: () => Promise.reject(new Error('connection discovery failed')),
      deleteBranch(input) {
        deleted.push(input.branchId);
        return Promise.resolve();
      },
    };
    const branches = createNeonValidationBranchPort(management);

    await expect(
      branches.createValidationBranch({
        projectId: 'spring-example-302709',
        apiKey: FIXTURE_API_KEY,
        parentBranchId: 'br-preview-123',
        name: 'verify/run-run_01JCOMPENSATE',
        databaseName: 'appdb',
        expiresAt: new Date('2026-08-11T13:00:00.000Z'),
      }),
    ).rejects.toThrow('connection discovery failed');
    expect(deleted).toEqual(['br-orphan-risk']);
  });

  it('reconciles a deterministic validation branch after a lost create response', async () => {
    let listCalls = 0;
    const management: NeonManagementPort = {
      getProject: () => Promise.resolve({ projectId: 'spring-example-302709' }),
      listBranches() {
        listCalls += 1;
        return Promise.resolve(
          listCalls === 1
            ? []
            : [
                {
                  id: 'br-response-lost',
                  name: 'verify/run-run_01JRECONCILE',
                  parentBranchId: 'br-preview-123',
                  isDefault: false,
                },
              ],
        );
      },
      createBranch: () => Promise.reject(new Error('response lost after create')),
      branchConnection: () =>
        Promise.resolve({
          databaseName: 'appdb',
          roleName: 'migration',
          uri: 'postgresql://migration@validation.test/appdb',
        }),
      deleteBranch: () => Promise.resolve(),
    };

    await expect(
      createNeonValidationBranchPort(management).createValidationBranch({
        projectId: 'spring-example-302709',
        apiKey: FIXTURE_API_KEY,
        parentBranchId: 'br-preview-123',
        name: 'verify/run-run_01JRECONCILE',
        databaseName: 'appdb',
        expiresAt: new Date('2026-08-11T13:00:00.000Z'),
      }),
    ).resolves.toEqual({
      branchId: 'br-response-lost',
      migrationConnectionString: 'postgresql://migration@validation.test/appdb',
    });
    expect(listCalls).toBe(2);
  });

  it('reads schema metadata through SQL without exposing a management credential', async () => {
    const statements: string[] = [];
    const schema = await readNeonSchema({
      execute: () => Promise.resolve(),
      query(statement) {
        statements.push(statement);
        return Promise.resolve([
          {
            table_schema: 'public',
            table_name: 'widgets',
            column_name: 'id',
            data_type: 'bigint',
            is_nullable: 'NO',
          },
          {
            table_schema: 'public',
            table_name: 'widgets',
            column_name: 'label',
            data_type: 'text',
            is_nullable: 'YES',
          },
        ]);
      },
      close: () => Promise.resolve(),
    });

    expect(schema).toEqual({
      dialect: 'postgresql',
      tables: [
        {
          schema: 'public',
          name: 'widgets',
          columns: [
            { name: 'id', dataType: 'bigint', nullable: false },
            { name: 'label', dataType: 'text', nullable: true },
          ],
        },
      ],
    });
    expect(statements[0]).toContain("table_schema not in ('pg_catalog', 'information_schema')");
  });
});

describe.skipIf(!hasDatabase)('Neon connection-role separation, on PostgreSQL', () => {
  let database: TestDatabase;
  const suffix = randomBytes(6).toString('hex');
  const appRole = `zapp_app_${suffix}`;
  const table = `neon_role_probe_${suffix}`;

  beforeAll(async () => {
    database = await setUpTestDatabase();
    await database.sql.unsafe(`create table public."${table}" (id bigint primary key)`);
  }, 180_000);

  afterAll(async () => {
    await database.sql.unsafe(`drop table if exists public."${table}"`);
    await database.sql.unsafe(`drop owned by "${appRole}"`);
    await database.sql.unsafe(`drop role if exists "${appRole}"`);
    await database.close();
  });

  it('gives the app role DML access but denies DDL', async () => {
    const sql: NeonSqlPort = {
      execute(statement) {
        return database.sql.unsafe(statement).then(() => undefined);
      },
      query(statement) {
        return database.sql.unsafe(statement);
      },
      close: () => Promise.resolve(),
    };
    await configureNeonRoleSeparation({
      sql,
      appRole,
      appPassword: randomBytes(24).toString('base64url'),
    });

    await expect(
      database.sql.begin(async (tx) => {
        await tx.unsafe(`set local role "${appRole}"`);
        await tx.unsafe(`insert into public."${table}" (id) values (1)`);
        await tx.unsafe(`select id from public."${table}"`);
      }),
    ).resolves.toBeUndefined();

    await expect(
      database.sql.begin(async (tx) => {
        await tx.unsafe(`set local role "${appRole}"`);
        await tx.unsafe(`alter table public."${table}" add column forbidden text`);
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe.skipIf(!hasDatabase)('Neon connection persistence, on PostgreSQL', () => {
  let database: TestDatabase;
  let app: AppInstance;
  let auth: FakeAuthPort;
  let organizations: OrganizationStore;
  let organizationId: string;
  let projectId: string;
  let requestHeaders: Record<string, string>;
  let integrationFailure: unknown;
  const apiKey = randomBytes(32).toString('base64url');
  const testConnectionUrl = (role: 'app' | 'migration', hostname: string): string => {
    const url = new URL('postgresql://database.test/neondb');
    url.username = role;
    url.password = randomBytes(18).toString('hex');
    url.hostname = hostname;
    return url.toString();
  };
  const previewAppUrl = testConnectionUrl('app', 'preview.test');
  const previewMigrationUrl = testConnectionUrl('migration', 'preview.test');
  const productionAppUrl = testConnectionUrl('app', 'production.test');
  const productionMigrationUrl = testConnectionUrl('migration', 'production.test');
  const calls: Parameters<NeonProjectManagementPort['connectExisting']>[0][] = [];
  let managementDelayMs = 0;
  const management: NeonProjectManagementPort = {
    async connectExisting(input) {
      calls.push(input);
      if (managementDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, managementDelayMs));
      }
      return {
        projectId: input.projectId,
        databaseName: input.databaseName,
        previewBranchId: 'br-preview-123',
        productionBranchId: 'br-main-456',
        preview: {
          appConnectionString: previewAppUrl,
          migrationConnectionString: previewMigrationUrl,
        },
        production: {
          appConnectionString: productionAppUrl,
          migrationConnectionString: productionMigrationUrl,
        },
      };
    },
  };

  beforeAll(async () => {
    database = await setUpTestDatabase();
    await database.truncateIdentity();
    auth = new FakeAuthPort();
    organizations = createDbOrganizationStore(database.db);
    const neonIntegration = createNeonIntegrationPort({
      database: database.db,
      masterKey: TEST_MASTER_KEY,
      management,
    });
    app = buildApp({
      logger: false,
      auth: { port: auth, users: createDbUserStore(database.db), config: TEST_AUTH_CONFIG },
      orgs: { organizations, audit: createDbAuditSink(database.db) },
      tenant: {
        tenantDb: createTenantDbFactory(database.db),
        integrationPort: {
          async connect(input) {
            try {
              return await neonIntegration.connect(input);
            } catch (error) {
              integrationFailure = error;
              throw error;
            }
          },
        },
      },
      limits: { config: TEST_RATE_LIMITS },
    });
    await app.ready();

    const login = await app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(login.headers.location as string).searchParams.get('state') ?? '';
    auth.issueCode('neon-owner-code', {
      externalId: 'neon-owner',
      email: 'owner@neon.test',
      displayName: 'Neon Owner',
    });
    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=neon-owner-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(login.headers['set-cookie'])) },
    });
    expect(callback.statusCode, callback.body).toBe(302);
    const cookies = cookiesOf(callback.headers['set-cookie']);
    const [user] = await database.sql<{ id: string }[]>`
      select id from users where email = 'owner@neon.test'
    `;
    if (user === undefined) throw new Error('sign-in created no Neon owner');

    const created = await organizations.create({
      name: 'Neon Org',
      slug: `neon-${newId('org').slice(4, 12)}`,
      creatorUserId: user.id,
      now: new Date('2026-08-11T12:00:00.000Z'),
      link: () => Promise.resolve({ externalOrgId: 'external-neon-org' }),
      audit: () => Promise.resolve(),
    });
    organizationId = created.organization.id;
    requestHeaders = {
      cookie: cookieJar(cookies),
      [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '',
      [ORGANIZATION_HEADER]: organizationId,
    };
    const project = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: requestHeaders,
      payload: { name: 'Neon Project' },
    });
    expect(project.statusCode, project.body).toBe(201);
    projectId = project.json<{ project: { id: string } }>().project.id;
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('vaults the API key and separate app and migration connection strings', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/integrations/neon/connect',
      headers: { ...requestHeaders, 'idempotency-key': 'neon-connect-01' },
      payload: {
        projectId,
        apiKey,
        configuration: { projectId: 'spring-example-302709', databaseName: 'neondb' },
      },
    });

    const failure =
      integrationFailure instanceof Error
        ? integrationFailure.message
            .replaceAll(apiKey, '[redacted]')
            .replaceAll(previewAppUrl, '[redacted]')
            .replaceAll(previewMigrationUrl, '[redacted]')
            .replaceAll(productionAppUrl, '[redacted]')
            .replaceAll(productionMigrationUrl, '[redacted]')
        : response.body;
    expect(response.statusCode, failure).toBe(201);
    for (const secret of [
      apiKey,
      previewAppUrl,
      previewMigrationUrl,
      productionAppUrl,
      productionMigrationUrl,
    ]) {
      expect(response.body).not.toContain(secret);
    }
    const connectionId = response.json<{ connection: { id: string } }>().connection.id;
    const [connection] = await database.sql<Record<string, unknown>[]>`
      select * from integration_connections where id = ${connectionId}
    `;
    const metadata = await database.sql<Record<string, unknown>[]>`
      select * from secret_metadata where project_id = ${projectId} order by name, environment_id
    `;
    const ciphertexts = await database.sql<Record<string, unknown>[]>`
      select ciphertext.*
        from secret_ciphertexts ciphertext
        join secret_metadata metadata on metadata.id = ciphertext.secret_id
       where metadata.project_id = ${projectId}
    `;
    const environments = await database.sql<
      Array<{ type: string; database_connection_id: string | null }>
    >`
      select type, database_connection_id from environments where project_id = ${projectId}
    `;

    expect(connection).toMatchObject({
      provider: 'neon',
      project_id: projectId,
      status: 'connected',
      configuration_json: {
        projectId: 'spring-example-302709',
        databaseName: 'neondb',
        previewBranchId: 'br-preview-123',
        productionBranchId: 'br-main-456',
      },
    });
    expect(String(connection?.['credential_ref'])).toMatch(/^pg:secret_ciphertexts\/sec_/);
    expect(metadata.map((row) => row['name']).sort()).toEqual([
      'NEON_API_KEY',
      'NEON_DATABASE_URL',
      'NEON_DATABASE_URL',
      'NEON_MIGRATION_DATABASE_URL',
      'NEON_MIGRATION_DATABASE_URL',
    ]);
    expect(environments).toHaveLength(2);
    expect(
      environments.every((environment) => environment.database_connection_id === connectionId),
    ).toBe(true);
    for (const row of [connection, ...metadata, ...ciphertexts]) {
      const serialized = JSON.stringify(row);
      for (const secret of [
        apiKey,
        previewAppUrl,
        previewMigrationUrl,
        productionAppUrl,
        productionMigrationUrl,
      ]) {
        expect(serialized).not.toContain(secret);
      }
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      projectId: 'spring-example-302709',
      apiKey,
      previewBranchName: `preview/zapp-${projectId}`,
      databaseName: 'neondb',
    });
    expect(calls[0]?.appRole).toMatch(/^zapp_app_[a-f0-9]{16}$/);
  });

  it('serializes concurrent connect keys so only the winning credentials are persisted', async () => {
    const project = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: requestHeaders,
      payload: { name: 'Concurrent Neon Project' },
    });
    expect(project.statusCode, project.body).toBe(201);
    const concurrentProjectId = project.json<{ project: { id: string } }>().project.id;
    const beforeCalls = calls.length;
    managementDelayMs = 100;
    const payload = {
      projectId: concurrentProjectId,
      apiKey,
      configuration: { projectId: 'spring-example-302709', databaseName: 'neondb' },
    };
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/integrations/neon/connect',
        headers: { ...requestHeaders, 'idempotency-key': 'neon-concurrent-01' },
        payload,
      }),
      app.inject({
        method: 'POST',
        url: '/v1/integrations/neon/connect',
        headers: { ...requestHeaders, 'idempotency-key': 'neon-concurrent-02' },
        payload,
      }),
    ]);
    managementDelayMs = 0;

    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(first.json<{ connection: { id: string } }>().connection.id).toBe(
      second.json<{ connection: { id: string } }>().connection.id,
    );
    expect(calls).toHaveLength(beforeCalls + 1);
    const [count] = await database.sql<{ count: number }[]>`
      select count(*)::int as count
        from integration_connections
       where project_id = ${concurrentProjectId} and provider = 'neon'
    `;
    expect(count?.count).toBe(1);
  });
});

const liveGate = credentialGate(['NEON_API_KEY', 'NEON_PROJECT_ID']);
if (!liveGate.present) {
  process.stderr.write(
    `[@zapp/control-api] Neon live test SKIPPED — not run, not passed: ${liveGate.reason}\n`,
  );
}

describe('live Neon Management API', () => {
  it.skipIf(!liveGate.present)(
    `reads a real project and its branches (${liveGate.present ? 'credentials present' : liveGate.reason})`,
    async () => {
      const management = createNeonManagementClient();
      const input = {
        projectId: process.env['NEON_PROJECT_ID'] ?? '',
        apiKey: process.env['NEON_API_KEY'] ?? '',
      };
      await expect(management.getProject(input)).resolves.toEqual({ projectId: input.projectId });
      const branches = await management.listBranches(input);
      expect(branches.some((branch) => branch.isDefault)).toBe(true);
    },
    30_000,
  );
});
