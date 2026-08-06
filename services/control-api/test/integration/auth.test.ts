import { newId } from '@zapp/contracts';
import { memberships, organizations } from '@zapp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';
import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { AuthPortError, type AuthIdentity, type AuthPort } from '../../src/auth/port.js';
import { createStytchAuthPort, type StytchFault } from '../../src/auth/stytch.js';
import { createDbUserStore } from '../../src/auth/users.js';
import { credentialGate } from '../support/credentials.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import { TEST_AUTH_CONFIG, cookieJar, cookiesOf } from '../support/harness.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

/**
 * The two halves of CP-2 that a unit test cannot reach: the rows a login
 * actually writes, and the provider it actually talks to. Both are env-gated
 * and skip visibly — `DATABASE_URL` for the first (FND-7's dev stack, and the
 * CI service container), `STYTCH_PROJECT_ID` + `STYTCH_SECRET` for the second
 * (AGENTS.md §10: an M1 credential, absent while this was written).
 *
 * "Skip visibly" is now enforced rather than asserted: both gates run through
 * `credentialGate`, which treats `.env.example`'s placeholders as absent. See
 * the comment above the Stytch gate below for what that cost.
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
      {
        id: organizationId,
        name: 'Acme',
        slug: `acme-${organizationId}`,
        settingsJson: {
          defaultModelPolicy: {
            allowedModels: [
              'anthropic/claude-sonnet-5',
              'model with spaces',
              42,
              'anthropic/claude-sonnet-5',
            ],
          },
        },
      },
      { id: removedOrganizationId, name: 'Former', slug: `former-${removedOrganizationId}` },
    ]);
    await database.db.insert(memberships).values([
      { organizationId, userId: user?.id ?? '', role: 'builder', status: 'active' },
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
      memberships: { allowedModels: string[]; organization: { id: string }; role: string }[];
    } = response.json();
    expect(body.user.id).toBe(user?.id);
    // A removed membership is not a membership: it stays in the table as the
    // record of an access change and must never appear here.
    expect(body.memberships).toEqual([
      {
        allowedModels: ['anthropic/claude-sonnet-5'],
        organization: { id: organizationId, name: 'Acme', slug: `acme-${organizationId}` },
        role: 'builder',
        status: 'active',
      },
    ]);
  });
});

/**
 * `credentialGate`, not `!== ''`.
 *
 * This suite used to be gated on "the variables are non-empty", which
 * `.env.example`'s `STYTCH_SECRET=replace-me` satisfies — and
 * `scripts/dev-up.sh` copies `.env.example` to `.env`. So on any developer
 * machine with a stock `.env`, and for anyone who exported one before running
 * the suite, this ran against a project id of all zeros and a secret of
 * `replace-me`, and reported *2 passed in 239 ms*. The assertions could not have
 * failed: both of them accepted any failure at all. See
 * `../support/credentials.ts`.
 *
 * Only the two variables `turbo.json` names in `test:integration`'s `env` list
 * are gated on. turbo 2 runs tasks in strict env mode, so a third name would be
 * stripped from the task environment and this suite would skip *even with real
 * credentials exported* — the exact failure that cost GIT-2/GIT-3 a whole task.
 * `STYTCH_PUBLIC_TOKEN` is only read by `getAuthorizationUrl`, which builds a
 * URL and calls nothing, so nothing below needs it.
 */
const stytchGate = credentialGate(['STYTCH_PROJECT_ID', 'STYTCH_SECRET']);

if (!stytchGate.present) {
  console.warn(
    `[@zapp/control-api] Stytch integration tests SKIPPED — not run, not passed: ${stytchGate.reason} (M1 credential, AGENTS.md §10)`,
  );
}

describe.skipIf(!stytchGate.present)('Stytch B2B, against the live test project', () => {
  // Built per test rather than in the suite body: vitest still *collects* a
  // skipped `describe`, and the Stytch client throws on an empty project id —
  // which would turn "skipped, no credentials" into a failing suite.
  const connect = (faults: StytchFault[]): AuthPort =>
    createStytchAuthPort({
      projectId: process.env['STYTCH_PROJECT_ID'] ?? '',
      secret: process.env['STYTCH_SECRET'] ?? '',
      publicToken: process.env['STYTCH_PUBLIC_TOKEN'] ?? '',
      onFault: (fault) => faults.push(fault),
    });

  /**
   * The assertion that makes this suite mean something.
   *
   * Every call below is a *failing* call — deliberately, because the passing
   * ones would create state in a project shared with whoever else is testing.
   * A failing call proves nothing on its own: garbage credentials fail too, and
   * that is exactly how this suite passed against `replace-me`. What separates
   * the two is *which* failure came back —
   *
   *   - `kind: 'rejected'` means Stytch authenticated us and then declined to
   *     honour the token we asked about. Impossible without credentials it
   *     accepts.
   *   - `kind: 'misconfigured'` is what a wrong project id or secret produces.
   *   - `kind: 'unreachable'` means nothing answered, so nothing was proven.
   *
   * — and that a Stytch `request_id` came back at all, which is a value only
   * Stytch mints. Together: a real round trip happened, and Stytch accepted us
   * while rejecting the subject.
   */
  function expectStytchAnsweredAboutTheSubject(faults: readonly StytchFault[]): void {
    expect(faults, 'the adapter reported no provider failure at all').toHaveLength(1);
    const fault = faults[0];
    expect(
      fault?.kind,
      `expected Stytch to reject the subject; got ${fault?.kind ?? 'nothing'} ` +
        `(error_type=${fault?.errorType ?? 'none'}, status=${String(fault?.statusCode ?? 0)}). ` +
        'A `misconfigured` here means STYTCH_PROJECT_ID / STYTCH_SECRET are not credentials this project accepts.',
    ).toBe('rejected');
    // Only Stytch mints one of these, so its presence is the round trip.
    expect(fault?.requestId ?? '', 'no Stytch request_id came back').not.toBe('');
  }

  it('is refused a session token the project never issued, and says so as a rejection', async () => {
    const faults: StytchFault[] = [];

    // Still null, still not a throw — `AuthPort.verifySession`'s contract.
    expect(await connect(faults).verifySession('not-a-session-jwt')).toBeNull();
    expectStytchAnsweredAboutTheSubject(faults);
  }, 30_000);

  it('rejects a discovery token the project never issued, as an AuthPortError', async () => {
    const faults: StytchFault[] = [];
    const error = await connect(faults)
      .exchangeCode('not-a-real-token')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AuthPortError);
    expect((error as AuthPortError).code).toBe('exchange_failed');
    // Whatever Stytch said, the client sees our words…
    expect((error as AuthPortError).message).toBe('Sign-in could not be completed.');
    // …and the operator sees which of the two things went wrong.
    expectStytchAnsweredAboutTheSubject(faults);
  }, 30_000);
});
