import { newId } from '@zapp/contracts';
import { readFile } from 'node:fs/promises';
import {
  createSupabaseMigrationPort,
  createSupabaseProjectDataPort,
  type MigrationPort,
  type ProjectDataPort,
} from '../../../packages/agent-tools/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type AppInstance } from '../src/app.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../src/auth/cookies.js';
import { createDbUserStore } from '../src/auth/users.js';
import {
  createSupabaseIntegrationPort,
  type SupabaseManagementPort,
} from '../src/integrations/supabase/connect.js';
import {
  analyzeSupabaseMigration,
  assertManagedRlsCoverage,
  createSupabaseMigrationPipeline,
  createSupabaseMigrationValidationAdapter,
  renderOwnerScopedRlsArtifacts,
  type SupabaseMigrationRuntime,
} from '../src/integrations/supabase/migrations.js';
import {
  createSupabaseManagementClient,
  provisionDevelopmentProject,
  type SupabaseProvisioningPort,
} from '../src/integrations/supabase/provision.js';
import {
  createPostgresMetaClient,
  generateSupabaseTypes,
  readSupabaseSchema,
  type SupabaseSchemaPort,
  type SupabaseTypegenRuntime,
} from '../src/integrations/supabase/schema.js';
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
import { credentialGate } from './support/credentials.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './integration/helpers.js';

const ACCESS_TOKEN = 'supabase-management-token-must-never-be-plaintext';
const ANON_KEY = 'supabase-anon-key-must-never-be-plaintext';
const PROJECT_REF = 'fixture-project-ref';

const POLICY_TEMPLATE = new URL(
  '../../../templates/supabase/rls/owner-policy.sql.hbs',
  import.meta.url,
);
const TEST_TEMPLATE = new URL(
  '../../../templates/supabase/rls/owner-scope.test.sql.hbs',
  import.meta.url,
);

class FixtureManagementPort implements SupabaseManagementPort {
  readonly calls: Array<{ readonly projectRef: string; readonly accessToken: string }> = [];

  connectExisting(input: {
    readonly projectRef: string;
    readonly accessToken: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly projectRef: string; readonly url: string; readonly anonKey: string }> {
    this.calls.push(input);
    return Promise.resolve({
      projectRef: input.projectRef,
      url: `https://${input.projectRef}.supabase.co`,
      anonKey: ANON_KEY,
    });
  }
}

describe('Supabase migration pipeline and owner-scoped RLS', () => {
  it('classifies destructive SQL through AR-5 before migration execution', () => {
    expect(analyzeSupabaseMigration('alter table public.todos drop column legacy')).toEqual({
      destructive: true,
      approvalRequired: true,
      approvalReason: 'destructive_migration',
    });
    expect(
      analyzeSupabaseMigration('alter table public.todos add column completed boolean'),
    ).toEqual({
      destructive: false,
      approvalRequired: false,
    });
  });

  it('renders valid owner-scoped policy and cross-user pgTAP SQL for a fixture table', async () => {
    const templates = {
      policy: await readFile(POLICY_TEMPLATE, 'utf8'),
      test: await readFile(TEST_TEMPLATE, 'utf8'),
    };

    const rendered = renderOwnerScopedRlsArtifacts({
      tables: [{ schema: 'public', table: 'todos', ownerColumn: 'owner_id' }],
      templates,
      fixtureOwnerId: '11111111-1111-4111-8111-111111111111',
      otherUserId: '22222222-2222-4222-8222-222222222222',
    });

    expect(rendered.policySql).toMatch(
      /alter table\s+"public"\."todos"\s+enable row level security;/u,
    );
    expect(rendered.policySql).toMatch(/\(select auth\.uid\(\)\) =\s+"owner_id"/u);
    expect(rendered.testSql).toContain('select plan(4);');
    expect(rendered.testSql).toContain('fixture row exists before the denial check');
    expect(rendered.testSql).toContain('from pg_policies');
    expect(rendered.testSql).toContain('array[0::bigint]');
    expect(`${rendered.policySql}\n${rendered.testSql}`).not.toMatch(/\{\{[^}]+\}\}/u);
  });

  it('rejects a Managed RLS artifact set with a policy-less table', () => {
    expect(() => {
      assertManagedRlsCoverage({
        managedTables: [
          { schema: 'public', table: 'todos', ownerColumn: 'owner_id' },
          { schema: 'public', table: 'profiles', ownerColumn: 'user_id' },
        ],
        policyTables: [{ schema: 'public', table: 'todos' }],
      });
    }).toThrow('managed_rls_policy_missing:public.profiles');
  });

  it('writes a keyed migration and applies preview through the official linked CLI flow', async () => {
    const writes = new Map<string, Uint8Array>([
      ['supabase/migrations/20260811123500_existing.sql', new TextEncoder().encode('select 1;\n')],
    ]);
    const execCalls: Array<Parameters<SupabaseMigrationRuntime['exec']>[0]> = [];
    const runtime = {
      exec(input: Parameters<SupabaseMigrationRuntime['exec']>[0]) {
        execCalls.push(input);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
      listFiles: () =>
        Promise.resolve([...writes.keys()].map((path) => ({ path, type: 'file' as const }))),
      readFile(path: string) {
        const value = writes.get(path);
        return value === undefined
          ? Promise.reject(new Error('file_not_found'))
          : Promise.resolve(value);
      },
      writeFilesAtomically(files: readonly { readonly path: string; readonly data: Uint8Array }[]) {
        for (const file of files) writes.set(file.path, file.data);
        return Promise.resolve();
      },
    } satisfies SupabaseMigrationRuntime;
    const pipeline = createSupabaseMigrationPipeline({
      runtime,
      connections: {
        forEnvironment: () =>
          Promise.resolve({
            projectRef: PROJECT_REF,
            accessToken: ACCESS_TOKEN,
            scope: 'preview',
          }),
      },
      now: () => new Date('2026-08-11T12:34:56.000Z'),
    });
    const signal = new AbortController().signal;
    const result = await pipeline.executeMigration(
      { environmentId: 'env_preview', migration: 'create table public.todos(id uuid);' },
      {
        organizationId: 'org_scope',
        projectId: 'proj_scope',
        runId: 'run_scope',
        taskId: 'task_scope',
        step: 'migration',
        idempotencyKey: 'run_scope:task_scope:migration:execute_migration',
      },
      signal,
    );

    expect(result).toMatchObject({ status: 'applied' });
    const migrationPath = [...writes.keys()].find((path) => path.includes('_agent_'));
    expect(migrationPath).toMatch(
      /^supabase\/migrations\/20260811123501_agent_[a-f0-9]{12}\.sql$/u,
    );
    expect(new TextDecoder().decode(writes.get(migrationPath ?? ''))).toBe(
      'create table public.todos(id uuid);\n',
    );
    expect(execCalls).toEqual([
      {
        cmd: 'supabase',
        args: ['link', '--project-ref', PROJECT_REF],
        env: { SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN },
        timeoutMs: 120_000,
      },
      {
        cmd: 'supabase',
        args: ['db', 'push', '--linked', '--include-all'],
        env: { SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN },
        timeoutMs: 120_000,
      },
      {
        cmd: 'supabase',
        args: ['test', 'db', '--linked'],
        env: { SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN },
        timeoutMs: 120_000,
      },
    ]);

    await expect(
      pipeline.executeMigration(
        { environmentId: 'env_preview', migration: 'create table public.todos(id uuid);' },
        {
          organizationId: 'org_scope',
          projectId: 'proj_scope',
          runId: 'run_scope',
          taskId: 'task_scope',
          step: 'migration',
          idempotencyKey: 'run_scope:task_scope:migration:execute_migration',
        },
        signal,
      ),
    ).resolves.toEqual(result);
    expect([...writes.keys()].filter((path) => path.includes('_agent_'))).toEqual([migrationPath]);
  });

  it('returns a VF-16 Supabase-shadow receipt whose paths become release evidence', async () => {
    const migrations = new Map([
      ['supabase/migrations/20260811000100_add_todos.sql', 'create table todos(id uuid);'],
      [
        'supabase/migrations/20260811000200_drop_legacy.sql',
        'alter table todos drop column legacy;',
      ],
    ]);
    const runtime = {
      exec: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      listFiles: () =>
        Promise.resolve([...migrations.keys()].map((path) => ({ path, type: 'file' as const }))),
      readFile(path: string) {
        return Promise.resolve(new TextEncoder().encode(migrations.get(path) ?? ''));
      },
      writeFilesAtomically: () => Promise.resolve(),
    } satisfies SupabaseMigrationRuntime;
    const adapter = createSupabaseMigrationValidationAdapter({
      runtime,
      projectRef: PROJECT_REF,
      accessToken: ACCESS_TOKEN,
      history: {
        pendingPaths: () => Promise.resolve([...migrations.keys()]),
      },
      shadow: {
        validate: () =>
          Promise.resolve({
            reference: 'shadow-validation-01',
            applyStatus: 'passed',
            smokeStatus: 'passed',
            cleanupStatus: 'passed',
            reversibility: 'compensating',
          }),
      },
    });

    await expect(
      adapter.validatePendingMigrations({ commitSha: 'a'.repeat(40), workspaceRoot: '.' }),
    ).resolves.toEqual({
      kind: 'validated',
      provider: 'supabase',
      isolatedTarget: { kind: 'supabase_shadow', reference: 'shadow-validation-01' },
      migrations: [...migrations].map(([path, sql]) => ({ path, sql })),
      applyStatus: 'passed',
      smokeStatus: 'passed',
      cleanupStatus: 'passed',
      reversibility: 'compensating',
    });
  });
});

describe('Supabase schema and type generation', () => {
  it('reads tables from the postgres-meta boundary and binds the agent schema read', async () => {
    const requests: string[] = [];
    const schemaPort: SupabaseSchemaPort = createPostgresMetaClient({
      baseUrl: (projectRef) => `https://meta.test/${projectRef}`,
      fetch: (input) => {
        requests.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: 17,
                schema: 'public',
                name: 'todos',
                columns: [
                  { name: 'id', data_type: 'uuid', is_nullable: false },
                  { name: 'title', data_type: 'text', is_nullable: false },
                ],
              },
            ]),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      },
    });

    await expect(
      readSupabaseSchema(schemaPort, {
        projectRef: PROJECT_REF,
        accessToken: ACCESS_TOKEN,
      }),
    ).resolves.toEqual({
      dialect: 'postgresql',
      tables: [
        {
          id: 17,
          schema: 'public',
          name: 'todos',
          columns: [
            { name: 'id', dataType: 'uuid', nullable: false },
            { name: 'title', dataType: 'text', nullable: false },
          ],
        },
      ],
    });
    expect(requests).toEqual([`https://meta.test/${PROJECT_REF}/tables?included_schemas=public`]);
  });

  it('runs the official CLI without a shell redirect and writes the type artifact', async () => {
    const execCalls: Array<Parameters<SupabaseTypegenRuntime['exec']>[0]> = [];
    const writes = new Map<string, Uint8Array>();
    const runtime = {
      exec(input: Parameters<SupabaseTypegenRuntime['exec']>[0]) {
        execCalls.push(input);
        return Promise.resolve({
          exitCode: 0,
          stdout: 'export type Database = { public: { Tables: {} } };\n',
          stderr: '',
          durationMs: 1,
          truncated: false,
        });
      },
      writeFile(path: string, data: Uint8Array) {
        writes.set(path, data);
        return Promise.resolve();
      },
    } satisfies SupabaseTypegenRuntime;

    await expect(
      generateSupabaseTypes({
        runtime,
        projectRef: PROJECT_REF,
        accessToken: ACCESS_TOKEN,
        outputPath: 'src/database.types.ts',
      }),
    ).resolves.toEqual({ path: 'src/database.types.ts', bytes: 51 });

    expect(execCalls).toEqual([
      {
        cmd: 'supabase',
        args: ['gen', 'types', 'typescript', '--project-id', PROJECT_REF, '--schema', 'public'],
        env: { SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN },
        timeoutMs: 120_000,
      },
    ]);
    expect(new TextDecoder().decode(writes.get('src/database.types.ts'))).toBe(
      'export type Database = { public: { Tables: {} } };\n',
    );
  });

  it('requires connect-existing when the current plan does not permit provisioning', async () => {
    const provider: SupabaseProvisioningPort = {
      createDevelopmentProject: () => {
        throw new Error('provisioning must not be called');
      },
    };

    await expect(
      provisionDevelopmentProject(provider, {
        accessToken: ACCESS_TOKEN,
        organizationSlug: 'provider-org',
        name: 'Development',
        region: 'us-west-1',
        planAllowsProvision: false,
      }),
    ).resolves.toEqual({ outcome: 'connect_existing_required' });
  });

  it('uses the current project ref, API-key, and provisioning payload contracts', async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const client = createSupabaseManagementClient({
      baseUrl: 'https://management.test/v1',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requests.push({ url, ...(init === undefined ? {} : { init }) });
        if (init?.method === 'POST') {
          return Promise.resolve(
            new Response(JSON.stringify({ ref: PROJECT_REF }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        const body = url.endsWith('/api-keys')
          ? [
              { name: 'masked_secret', type: 'secret', api_key: null },
              { name: 'anon', type: 'legacy', api_key: ANON_KEY },
            ]
          : { ref: PROJECT_REF };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });

    await expect(
      client.connectExisting({ projectRef: PROJECT_REF, accessToken: ACCESS_TOKEN }),
    ).resolves.toEqual({
      projectRef: PROJECT_REF,
      url: `https://${PROJECT_REF}.supabase.co`,
      anonKey: ANON_KEY,
    });
    await expect(
      provisionDevelopmentProject(client, {
        accessToken: ACCESS_TOKEN,
        organizationSlug: 'provider-org',
        name: 'Development',
        region: 'us-west-1',
        databasePassword: 'correct-horse-battery-staple',
        planAllowsProvision: true,
      }),
    ).resolves.toEqual({ outcome: 'provisioned', projectRef: PROJECT_REF });
    const provision = requests.find((request) => request.init?.method === 'POST');
    const body = provision?.init?.body;
    if (typeof body !== 'string') throw new Error('provisioning request had no JSON body');
    expect(body).toBe(
      JSON.stringify({
        organization_slug: 'provider-org',
        name: 'Development',
        region_selection: { type: 'specific', code: 'us-west-1' },
        db_pass: 'correct-horse-battery-staple',
      }),
    );
  });

  it('binds schema reads to the tenant environment and migrations only to the pipeline', async () => {
    const base = {
      readLogs: () => Promise.resolve({}),
      readTestResults: () => Promise.resolve({}),
      readDatabaseSchema: () => Promise.reject(new Error('base schema port must not be used')),
      readLatestProjectContract: () => Promise.resolve({}),
    } satisfies ProjectDataPort;
    const connectionCalls: unknown[] = [];
    const data = createSupabaseProjectDataPort({
      base,
      connections: {
        forEnvironment(input) {
          connectionCalls.push(input);
          return Promise.resolve({ projectRef: PROJECT_REF, accessToken: ACCESS_TOKEN });
        },
      },
      schema: {
        readSchema: () =>
          Promise.resolve({
            dialect: 'postgresql',
            tables: [{ schema: 'public', name: 'todos' }],
          }),
      },
    });
    const context = {
      organizationId: 'org_scope',
      projectId: 'proj_scope',
      runId: 'run_scope',
      taskId: 'task_scope',
      step: 'inspect',
    };
    const signal = new AbortController().signal;
    await expect(
      data.readDatabaseSchema({ environmentId: 'env_preview' }, context, signal),
    ).resolves.toEqual({
      ok: true,
      dialect: 'postgresql',
      schema: '[{"schema":"public","name":"todos"}]',
    });
    expect(connectionCalls).toEqual([
      {
        organizationId: 'org_scope',
        projectId: 'proj_scope',
        environmentId: 'env_preview',
      },
    ]);

    const migrationCalls: unknown[] = [];
    const pipeline: MigrationPort = {
      executeMigration(input, mutationContext) {
        migrationCalls.push({ input, mutationContext });
        return Promise.resolve({ migrationId: 'mig_1', status: 'applied' });
      },
    };
    const migrations = createSupabaseMigrationPort(pipeline);
    await expect(
      migrations.executeMigration(
        { environmentId: 'env_production', migration: 'create table todos(id uuid)' },
        { ...context, idempotencyKey: 'migration-01' },
        signal,
      ),
    ).resolves.toEqual({ migrationId: 'mig_1', status: 'applied' });
    expect(migrationCalls).toEqual([
      {
        input: {
          environmentId: 'env_production',
          migration: 'create table todos(id uuid)',
        },
        mutationContext: { ...context, idempotencyKey: 'migration-01' },
      },
    ]);
  });
});

describe.skipIf(!hasDatabase)('Supabase connection persistence, on PostgreSQL', () => {
  let database: TestDatabase;
  let app: AppInstance;
  let auth: FakeAuthPort;
  let organizations: OrganizationStore;
  let organizationId: string;
  let projectId: string;
  let headers: Record<string, string>;
  const management = new FixtureManagementPort();

  beforeAll(async () => {
    database = await setUpTestDatabase();
    await database.truncateIdentity();
    auth = new FakeAuthPort();
    organizations = createDbOrganizationStore(database.db);
    app = buildApp({
      logger: false,
      auth: { port: auth, users: createDbUserStore(database.db), config: TEST_AUTH_CONFIG },
      orgs: { organizations, audit: createDbAuditSink(database.db) },
      tenant: {
        tenantDb: createTenantDbFactory(database.db),
        integrationPort: createSupabaseIntegrationPort({
          database: database.db,
          masterKey: TEST_MASTER_KEY,
          management,
        }),
      },
      limits: { config: TEST_RATE_LIMITS },
    });
    await app.ready();

    const login = await app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(login.headers.location as string).searchParams.get('state') ?? '';
    auth.issueCode('supabase-owner-code', {
      externalId: 'supabase-owner',
      email: 'owner@supabase.test',
      displayName: 'Supabase Owner',
    });
    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=supabase-owner-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(login.headers['set-cookie'])) },
    });
    expect(callback.statusCode, callback.body).toBe(302);
    const cookies = cookiesOf(callback.headers['set-cookie']);
    const [user] = await database.sql<{ id: string }[]>`
      select id from users where email = 'owner@supabase.test'
    `;
    if (user === undefined) throw new Error('sign-in created no Supabase owner');

    const created = await organizations.create({
      name: 'Supabase Org',
      slug: `supabase-${newId('org').slice(4, 12)}`,
      creatorUserId: user.id,
      now: new Date('2026-08-11T12:00:00.000Z'),
      link: () => Promise.resolve({ externalOrgId: 'external-supabase-org' }),
      audit: () => Promise.resolve(),
    });
    organizationId = created.organization.id;
    headers = {
      cookie: cookieJar(cookies),
      [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '',
      [ORGANIZATION_HEADER]: organizationId,
    };

    const project = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { name: 'Supabase Project' },
    });
    expect(project.statusCode, project.body).toBe(201);
    projectId = project.json<{ project: { id: string } }>().project.id;
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('stores only credential references and wires separate environment secrets', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/integrations/supabase/connect',
      headers: { ...headers, 'idempotency-key': 'supabase-connect-01' },
      payload: {
        projectId,
        accessToken: ACCESS_TOKEN,
        configuration: { projectRef: PROJECT_REF },
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.body).not.toContain(ACCESS_TOKEN);
    expect(response.body).not.toContain(ANON_KEY);
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
      Array<{ id: string; type: string; database_connection_id: string | null }>
    >`
      select id, type, database_connection_id
        from environments
       where project_id = ${projectId}
       order by type
    `;

    expect(connection).toMatchObject({
      provider: 'supabase',
      project_id: projectId,
      status: 'connected',
      configuration_json: { projectRef: PROJECT_REF },
    });
    expect(String(connection?.['credential_ref'])).toMatch(/^pg:secret_ciphertexts\/sec_/);
    expect(metadata.map((row) => row['name']).sort()).toEqual([
      'SUPABASE_ACCESS_TOKEN',
      'SUPABASE_ANON_KEY',
      'SUPABASE_ANON_KEY',
      'SUPABASE_URL',
      'SUPABASE_URL',
    ]);
    expect(environments).toHaveLength(2);
    expect(
      environments.every((environment) => environment.database_connection_id === connectionId),
    ).toBe(true);
    for (const row of [connection, ...metadata, ...ciphertexts]) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(ACCESS_TOKEN);
      expect(serialized).not.toContain(ANON_KEY);
    }
    expect(management.calls).toEqual([{ projectRef: PROJECT_REF, accessToken: ACCESS_TOKEN }]);
  });
});

const liveGate = credentialGate(['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF']);
if (!liveGate.present) {
  process.stderr.write(
    `[@zapp/control-api] Supabase live test SKIPPED — not run, not passed: ${liveGate.reason}\n`,
  );
}

describe('live Supabase Management API', () => {
  it.skipIf(!liveGate.present)(
    `reads a real project and its API keys (${liveGate.present ? 'credentials present' : liveGate.reason})`,
    async () => {
      const client = createSupabaseManagementClient();
      const connected = await client.connectExisting({
        projectRef: process.env['SUPABASE_PROJECT_REF'] ?? '',
        accessToken: process.env['SUPABASE_ACCESS_TOKEN'] ?? '',
      });
      expect(connected.projectRef).toBe(process.env['SUPABASE_PROJECT_REF']);
      expect(new URL(connected.url).protocol).toBe('https:');
      expect(connected.anonKey.length).toBeGreaterThan(0);
    },
    30_000,
  );
});
