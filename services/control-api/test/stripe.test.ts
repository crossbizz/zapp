import { newId } from '@zapp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type AppInstance } from '../src/app.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../src/auth/cookies.js';
import { createDbUserStore } from '../src/auth/users.js';
import {
  createGeneratedAppStripeIntegrationPort,
  createStripeAccountClient,
  createStripeCredentialReader,
  GENERATED_APP_STRIPE_SECRET_NAME,
  type StripeAccountPort,
} from '../src/integrations/stripe/connect.js';
import { createDbOrganizationStore, type OrganizationStore } from '../src/orgs/store.js';
import { createDbAuditSink } from '../src/plugins/audit.js';
import { createSecretVault } from '../src/secrets/vault.js';
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

const RESTRICTED_KEY = ['rk', 'test', 'fixturegeneratedapp'].join('_');
const ACCOUNT_ID = 'acct_generated_app_fixture';

describe.skipIf(!hasDatabase)('generated-app Stripe connection, on PostgreSQL', () => {
  let database: TestDatabase;
  let app: AppInstance;
  let auth: FakeAuthPort;
  let organizations: OrganizationStore;
  let organizationId: string;
  let projectId: string;
  let requestHeaders: Record<string, string>;
  const accountCalls: Array<{ readonly apiKey: string }> = [];
  const accounts: StripeAccountPort = {
    retrieve(input) {
      accountCalls.push(input);
      return Promise.resolve({ id: ACCOUNT_ID });
    },
  };

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
        integrationPort: createGeneratedAppStripeIntegrationPort({
          database: database.db,
          masterKey: TEST_MASTER_KEY,
          accounts,
        }),
      },
      limits: { config: TEST_RATE_LIMITS },
    });
    await app.ready();

    const login = await app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(login.headers.location as string).searchParams.get('state') ?? '';
    auth.issueCode('stripe-owner-code', {
      externalId: 'stripe-owner',
      email: 'owner@stripe.test',
      displayName: 'Stripe Owner',
    });
    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=stripe-owner-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(login.headers['set-cookie'])) },
    });
    expect(callback.statusCode, callback.body).toBe(302);
    const cookies = cookiesOf(callback.headers['set-cookie']);
    const [user] = await database.sql<{ id: string }[]>`
      select id from users where email = 'owner@stripe.test'
    `;
    if (user === undefined) throw new Error('sign-in created no Stripe owner');
    const created = await organizations.create({
      name: 'Stripe Org',
      slug: `stripe-${newId('org').slice(4, 12)}`,
      creatorUserId: user.id,
      now: new Date('2026-08-11T12:00:00.000Z'),
      link: () => Promise.resolve({ externalOrgId: 'external-stripe-org' }),
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
      payload: { name: 'Stripe Project' },
    });
    expect(project.statusCode, project.body).toBe(201);
    projectId = project.json<{ project: { id: string } }>().project.id;
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('vaults the generated-app key under its own scope and audit stream', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/integrations/stripe/connect',
      headers: { ...requestHeaders, 'idempotency-key': 'stripe-connect-01' },
      payload: {
        projectId,
        apiKey: RESTRICTED_KEY,
        configuration: { accountId: ACCOUNT_ID, mode: 'test' },
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.body).not.toContain(RESTRICTED_KEY);
    expect(response.json()).toMatchObject({
      connection: {
        provider: 'stripe',
        projectId,
        configuration: { accountId: ACCOUNT_ID, mode: 'test' },
      },
    });
    const [secret] = await database.sql<Array<{ id: string; name: string }>>`
      select id, name from secret_metadata where project_id = ${projectId}
    `;
    expect(secret).toMatchObject({ name: GENERATED_APP_STRIPE_SECRET_NAME });
    const [connection] = await database.sql<Record<string, unknown>[]>`
      select * from integration_connections where project_id = ${projectId} and provider = 'stripe'
    `;
    expect(connection).toMatchObject({
      configuration_json: { accountId: ACCOUNT_ID, mode: 'test' },
    });
    expect(JSON.stringify(connection)).not.toContain(RESTRICTED_KEY);
    const [audit] = await database.sql<Array<{ metadata_json: Record<string, unknown> }>>`
      select metadata_json from audit_events
       where organization_id = ${organizationId} and action = 'integration.connected'
       order by occurred_at desc limit 1
    `;
    expect(audit?.metadata_json).toMatchObject({
      provider: 'stripe',
      projectId,
      credentialScope: 'generated_app',
    });
    expect(accountCalls).toEqual([{ apiKey: RESTRICTED_KEY }]);

    if (secret === undefined) throw new Error('Stripe connection created no credential');
    const vault = createSecretVault({
      tenantDb: createTenantDbFactory(database.db),
      masterKey: TEST_MASTER_KEY,
    });
    const platformReads: string[] = [];
    const tenantDb = createTenantDbFactory(database.db);
    const platform = createStripeCredentialReader({
      vault,
      tenantDb,
      scope: 'platform_billing',
    });
    await expect(
      platform.read({
        organizationId,
        projectId: null,
        secretId: secret.id,
        audit: (_tx, read) => {
          platformReads.push(read.name);
          return Promise.resolve();
        },
      }),
    ).resolves.toBeUndefined();
    expect(platformReads).toEqual([]);

    const generated = createStripeCredentialReader({ vault, tenantDb, scope: 'generated_app' });
    await expect(
      generated.read({
        organizationId,
        projectId,
        secretId: secret.id,
        audit: () => Promise.resolve(),
      }),
    ).resolves.toBe(RESTRICTED_KEY);
  });

  it('refuses an unrestricted Stripe secret key before calling Stripe or the vault', async () => {
    const project = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: requestHeaders,
      payload: { name: 'Restricted Key Only' },
    });
    expect(project.statusCode, project.body).toBe(201);
    const otherProjectId = project.json<{ project: { id: string } }>().project.id;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/integrations/stripe/connect',
      headers: { ...requestHeaders, 'idempotency-key': 'stripe-unrestricted-01' },
      payload: {
        projectId: otherProjectId,
        apiKey: ['sk', 'test', 'fixtureunrestricted'].join('_'),
        configuration: { accountId: ACCOUNT_ID, mode: 'test' },
      },
    });

    expect(response.statusCode).toBe(502);
    expect(accountCalls).toEqual([{ apiKey: RESTRICTED_KEY }]);
    const connections = await database.sql<Array<{ id: string }>>`
      select id from integration_connections where project_id = ${otherProjectId}
    `;
    const credentials = await database.sql<Array<{ id: string }>>`
      select id from secret_metadata where project_id = ${otherProjectId}
    `;
    expect(connections).toEqual([]);
    expect(credentials).toEqual([]);
  });
});

const liveGate = credentialGate([
  'STRIPE_GENERATED_APP_RESTRICTED_KEY',
  'STRIPE_GENERATED_APP_ACCOUNT_ID',
]);
if (!liveGate.present) {
  process.stderr.write(
    `[@zapp/control-api] generated-app Stripe live test SKIPPED — not run, not passed: ${liveGate.reason}\n`,
  );
}

describe('live generated-app Stripe account', () => {
  it.skipIf(!liveGate.present)(
    `retrieves the account with its restricted key (${liveGate.present ? 'credentials present' : liveGate.reason})`,
    async () => {
      const account = await createStripeAccountClient().retrieve({
        apiKey: process.env['STRIPE_GENERATED_APP_RESTRICTED_KEY'] ?? '',
      });
      expect(account.id).toBe(process.env['STRIPE_GENERATED_APP_ACCOUNT_ID']);
    },
    30_000,
  );
});
