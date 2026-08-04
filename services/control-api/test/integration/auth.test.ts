import { newId } from '@zapp/contracts';
import { memberships, organizations } from '@zapp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';
import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { AuthPortError, type AuthIdentity, type AuthPort } from '../../src/auth/port.js';
import { createStytchAuthPort } from '../../src/auth/stytch.js';
import { createDbUserStore } from '../../src/auth/users.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import { TEST_AUTH_CONFIG, cookieJar, cookiesOf } from '../support/harness.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

/**
 * The two halves of CP-2 that a unit test cannot reach: the rows a login
 * actually writes, and the provider it actually talks to. Both are env-gated
 * and skip visibly — `DATABASE_URL` for the first (FND-7's dev stack, and the
 * CI service container), `STYTCH_PROJECT_ID` + `STYTCH_SECRET` for the second
 * (AGENTS.md §10: an M1 credential, absent while this was written).
 */

const ALICE: AuthIdentity = {
  externalId: 'member-test-alice',
  email: 'alice@acme.test',
  displayName: 'Alice Example',
  avatarUrl: 'https://cdn.fake.test/alice.png',
};

describe.skipIf(!hasDatabase)('sign-in, against PostgreSQL', () => {
  let database: TestDatabase;
  let app: AppInstance;
  let port: FakeAuthPort;

  beforeAll(async () => {
    database = await setUpTestDatabase();
    port = new FakeAuthPort();
    app = buildApp({
      logger: false,
      auth: { port, users: createDbUserStore(database.db), config: TEST_AUTH_CONFIG },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    await database.truncateIdentity();
  });

  /** login → provider → callback, returning the cookie jar the browser would hold. */
  async function login(identity: AuthIdentity, code: string): Promise<Map<string, string>> {
    const start = await app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
    port.issueCode(code, identity);

    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(start.headers['set-cookie'])) },
    });
    expect(callback.statusCode).toBe(302);
    return cookiesOf(callback.headers['set-cookie']);
  }

  it('creates the user row on a first login', async () => {
    await login(ALICE, 'first-login');

    const rows = await database.db.query.users.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: 'alice@acme.test',
      displayName: 'Alice Example',
      avatarUrl: 'https://cdn.fake.test/alice.png',
    });
    expect(rows[0]?.id).toMatch(/^user_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(rows[0]?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('links a second login to the same row and refreshes the profile', async () => {
    await login(ALICE, 'first-login');
    const [created] = await database.db.query.users.findMany();

    await login(
      { ...ALICE, displayName: 'Alice Renamed', avatarUrl: 'https://cdn.fake.test/new.png' },
      'second-login',
    );

    const rows = await database.db.query.users.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created?.id);
    expect(rows[0]).toMatchObject({
      displayName: 'Alice Renamed',
      avatarUrl: 'https://cdn.fake.test/new.png',
    });
  });

  it('answers /v1/me with the memberships that are actually in the tables', async () => {
    const cookies = await login(ALICE, 'first-login');
    const [user] = await database.db.query.users.findMany();
    const organizationId = newId('org');
    const removedOrganizationId = newId('org');

    await database.db.insert(organizations).values([
      { id: organizationId, name: 'Acme', slug: `acme-${organizationId}` },
      { id: removedOrganizationId, name: 'Former', slug: `former-${removedOrganizationId}` },
    ]);
    await database.db.insert(memberships).values([
      { organizationId, userId: user?.id ?? '', role: 'owner', status: 'active' },
      {
        organizationId: removedOrganizationId,
        userId: user?.id ?? '',
        role: 'viewer',
        status: 'removed',
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: `${SESSION_COOKIE}=${cookies.get(SESSION_COOKIE) ?? ''}` },
    });

    expect(response.statusCode).toBe(200);
    const body: {
      user: { id: string };
      memberships: { organization: { id: string }; role: string }[];
    } = response.json();
    expect(body.user.id).toBe(user?.id);
    // A removed membership is not a membership: it stays in the table as the
    // record of an access change and must never appear here.
    expect(body.memberships).toEqual([
      {
        organization: { id: organizationId, name: 'Acme', slug: `acme-${organizationId}` },
        role: 'owner',
        status: 'active',
      },
    ]);
  });
});

const hasStytch =
  (process.env['STYTCH_PROJECT_ID'] ?? '') !== '' && (process.env['STYTCH_SECRET'] ?? '') !== '';

if (!hasStytch) {
  console.warn(
    '[@zapp/control-api] Stytch integration tests skipped: STYTCH_PROJECT_ID / STYTCH_SECRET are unset (M1 credential, AGENTS.md §10)',
  );
}

describe.skipIf(!hasStytch)('Stytch B2B, against the live test project', () => {
  // Built per test rather than in the suite body: vitest still *collects* a
  // skipped `describe`, and the Stytch client throws on an empty project id —
  // which would turn "skipped, no credentials" into a failing suite.
  const connect = (): AuthPort =>
    createStytchAuthPort({
      projectId: process.env['STYTCH_PROJECT_ID'] ?? '',
      secret: process.env['STYTCH_SECRET'] ?? '',
      publicToken: process.env['STYTCH_PUBLIC_TOKEN'] ?? '',
    });

  it('answers null for a session token the project does not know', async () => {
    // Proves the credentials, the host selection and the null-not-throw
    // contract in one call — without creating anything in a shared project.
    expect(await connect().verifySession('not-a-session-jwt')).toBeNull();
  }, 30_000);

  it('rejects a discovery token the project never issued, as an AuthPortError', async () => {
    const error = await connect()
      .exchangeCode('not-a-real-token')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AuthPortError);
    expect((error as AuthPortError).code).toBe('exchange_failed');
    // Whatever Stytch said, the client sees our words.
    expect((error as AuthPortError).message).toBe('Sign-in could not be completed.');
  }, 30_000);
});
