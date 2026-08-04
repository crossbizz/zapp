import { newId } from '@zapp/contracts';
import { organizations } from '@zapp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';
import { createDbUserStore } from '../../src/auth/users.js';
import { createDbOrganizationStore, type OrganizationStore } from '../../src/orgs/store.js';
import { createInMemoryAuditSink } from '../../src/plugins/audit.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import { TEST_AUTH_CONFIG, cookieJar, cookiesOf } from '../support/harness.js';
import { describeOrganizationStore } from '../support/store-contract.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../src/auth/cookies.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

/**
 * CP-3 against a real PostgreSQL. Three things live here that a unit test
 * cannot reach:
 *
 *   - the shared `OrganizationStore` contract, run against the Drizzle store —
 *     the same suite `test/org-store.test.ts` runs against the double, so the
 *     two cannot diverge;
 *   - the rollback, proved by counting rows rather than by asking the store; and
 *   - the last-owner guard under genuine concurrency, which is the one property
 *     the in-memory double cannot have an opinion about.
 */

const ALICE = {
  externalId: 'member-test-alice',
  email: 'alice@acme.test',
  displayName: 'Alice Example',
};

/** Store calls whose subject is not the audit trail still have to pass a hook. */
const noAudit = (): Promise<void> => Promise.resolve();

describe.skipIf(!hasDatabase)('organizations, against PostgreSQL', () => {
  let database: TestDatabase;
  let store: OrganizationStore;

  beforeAll(async () => {
    database = await setUpTestDatabase();
    store = createDbOrganizationStore(database.db);
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.truncateIdentity();
  });

  async function createUser(email: string): Promise<string> {
    const id = newId('user');
    await database.sql`
      insert into users (id, email, display_name) values (${id}, ${email}, ${email})
    `;
    return id;
  }

  async function count(table: 'organizations' | 'memberships'): Promise<number> {
    const [row] = await database.sql<{ count: string }[]>`
      select count(*)::text as count from ${database.sql(table)}
    `;
    return Number(row?.count ?? '-1');
  }

  it('leaves no organization row behind when the provider refuses', async () => {
    const alice = await createUser('alice@acme.test');

    await expect(
      store.create({
        name: 'Acme',
        slug: 'acme',
        creatorUserId: alice,
        now: new Date(),
        link: () => Promise.reject(new Error('provider refused')),
        audit: noAudit,
      }),
    ).rejects.toThrow('provider refused');

    // Counted in SQL, not asked of the store: the point is that the transaction
    // rolled back, and only the table can say so.
    expect(await count('organizations')).toBe(0);
    expect(await count('memberships')).toBe(0);
  });

  it('keeps an Owner when two demotions overlap', async () => {
    const alice = await createUser('alice@acme.test');
    const bob = await createUser('bob@acme.test');
    const created = await store.create({
      name: 'Acme',
      slug: 'acme',
      creatorUserId: alice,
      now: new Date(),
      link: () => Promise.resolve({ externalOrgId: 'organization-test' }),
      audit: noAudit,
    });
    const organizationId = created.organization.id;
    await store.addMember({
      organizationId,
      userId: bob,
      role: 'owner',
      now: new Date(),
      audit: noAudit,
    });

    // The interleaving is staged rather than hoped for: an open transaction
    // demotes Bob and holds, and Alice's demotion arrives while it is still
    // uncommitted. Under `READ COMMITTED` the `EXISTS` guard alone would read
    // the pre-image, see Bob as the replacement Owner, and let Alice go too —
    // leaving an organization nobody can administer. The row lock is what makes
    // the second writer wait and then re-read.
    let releaseLock = (): void => {};
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const locker = database.sql.begin(async (tx) => {
      await tx`
        update memberships set role = 'viewer'
         where organization_id = ${organizationId} and user_id = ${bob}
      `;
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    let outcome: unknown;
    const pending = store.setRole(organizationId, alice, 'viewer', noAudit).then((result) => {
      outcome = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Still waiting on the other transaction — not racing it.
    expect(outcome).toBeUndefined();

    releaseLock();
    await locker;
    await pending;

    expect(outcome).toBe('last_owner');
    const [owners] = await database.sql<{ count: string }[]>`
      select count(*)::text as count from memberships
       where organization_id = ${organizationId} and role = 'owner' and status = 'active'
    `;
    expect(owners?.count).toBe('1');
  });

  describe('POST /v1/organizations', () => {
    let app: AppInstance;
    let port: FakeAuthPort;

    beforeAll(async () => {
      port = new FakeAuthPort();
      app = buildApp({
        logger: false,
        auth: { port, users: createDbUserStore(database.db), config: TEST_AUTH_CONFIG },
        orgs: { organizations: store, audit: createInMemoryAuditSink() },
      });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    /** login → callback, returning the headers a signed-in browser would send. */
    async function signIn(): Promise<Record<string, string>> {
      const start = await app.inject({ method: 'GET', url: '/v1/auth/login' });
      const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
      port.issueCode('auth-code-1', ALICE);
      const callback = await app.inject({
        method: 'GET',
        url: `/v1/auth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
        headers: { cookie: cookieJar(cookiesOf(start.headers['set-cookie'])) },
      });
      const cookies = cookiesOf(callback.headers['set-cookie']);
      return { cookie: cookieJar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' };
    }

    it('writes the organization and the creator’s Owner membership', async () => {
      port.organizationCreateFails = false;
      const headers = await signIn();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers,
        payload: { name: 'Acme Rockets' },
      });

      expect(response.statusCode, response.body).toBe(201);
      const rows = await database.db.select().from(organizations);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ slug: 'acme-rockets', plan: 'trial' });
      expect(await count('memberships')).toBe(1);
    });

    it('persists nothing when the provider refuses', async () => {
      const headers = await signIn();
      port.organizationCreateFails = true;

      const response = await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers,
        payload: { name: 'Acme Rockets' },
      });

      expect(response.statusCode).toBe(502);
      expect(await count('organizations')).toBe(0);
      expect(await count('memberships')).toBe(0);
      port.organizationCreateFails = false;
    });
  });
});

describe.skipIf(!hasDatabase)('the Drizzle store', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await setUpTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  describeOrganizationStore('drizzle', async () => {
    await database.truncateIdentity();
    return {
      store: createDbOrganizationStore(database.db),
      createUser: async (email: string) => {
        const id = newId('user');
        await database.sql`
          insert into users (id, email, display_name) values (${id}, ${email}, ${email})
        `;
        return id;
      },
    };
  });
});
