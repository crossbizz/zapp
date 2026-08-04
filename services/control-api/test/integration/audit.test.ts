import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../src/auth/cookies.js';
import { createDbUserStore } from '../../src/auth/users.js';
import { createInMemoryInviteStore } from '../../src/orgs/invites.js';
import { createDbOrganizationStore, type OrganizationStore } from '../../src/orgs/store.js';
import { createDbAuditSink, type AuditRecord, type AuditSink } from '../../src/plugins/audit.js';
import { ORGANIZATION_HEADER } from '../../src/plugins/tenant.js';
import { createTenantDbFactory } from '../../src/tenant/db.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import { TEST_AUTH_CONFIG, TEST_RATE_LIMITS, cookieJar, cookiesOf } from '../support/harness.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

/**
 * The audit trail against a real `audit_events` table.
 *
 * The claim CP-5 has to earn is one sentence — **the audit row is written in the
 * same transaction as the mutation** — and it is only provable here. A unit test
 * with an in-memory sink can see that a row was *offered*; only PostgreSQL can
 * say whether it survived, and only a deliberately failed transaction can say
 * whether it disappears with the change it describes.
 *
 * So every test below either counts rows in the table or forces a rollback and
 * counts them again. Nothing asks the sink what it thinks it did.
 */

const ALICE = {
  externalId: 'audit-test-alice',
  email: 'alice@acme.test',
  displayName: 'Alice Example',
};
const BOB = {
  externalId: 'audit-test-bob',
  email: 'bob@acme.test',
  displayName: 'Bob Example',
};

/** The failure every rollback assertion is built on. */
const AUDIT_FAILED = new Error('audit sink refused');

describe.skipIf(!hasDatabase)('the audit trail, against PostgreSQL', () => {
  let database: TestDatabase;
  let store: OrganizationStore;
  let sink: AuditSink;
  let app: AppInstance;
  let port: FakeAuthPort;
  /** Flipped by a test that wants every audit write to fail. */
  let auditFails = false;

  beforeAll(async () => {
    database = await setUpTestDatabase();
    store = createDbOrganizationStore(database.db);
    const real = createDbAuditSink(database.db);
    // A sink that can be taken away mid-request: the only way to ask "what
    // happens to the mutation when the row cannot be written" through the HTTP
    // pipeline rather than through the store's own API.
    sink = {
      record: async (tx, event) => {
        await real.record(tx, event);
        if (auditFails) {
          throw AUDIT_FAILED;
        }
      },
      recordDetached: async (event) => {
        await real.recordDetached(event);
        if (auditFails) {
          throw AUDIT_FAILED;
        }
      },
    };
    port = new FakeAuthPort();
    app = buildApp({
      logger: false,
      auth: { port, users: createDbUserStore(database.db), config: TEST_AUTH_CONFIG },
      orgs: { organizations: store, invites: createInMemoryInviteStore(), audit: sink },
      tenant: { tenantDb: createTenantDbFactory(database.db) },
      limits: { config: TEST_RATE_LIMITS },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    auditFails = false;
    port.organizationCreateFails = false;
    await database.truncateIdentity();
  });

  /** login → callback, returning the headers a signed-in browser would send. */
  async function signIn(identity: typeof ALICE): Promise<{
    userId: string;
    headers: Record<string, string>;
  }> {
    const code = `auth-code-${identity.email}`;
    const start = await app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
    port.issueCode(code, identity);
    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(start.headers['set-cookie'])) },
    });
    const cookies = cookiesOf(callback.headers['set-cookie']);
    const [row] = await database.sql<{ id: string }[]>`
      select id from users where email = ${identity.email}
    `;
    if (row === undefined) {
      throw new Error(`sign-in created no user for ${identity.email}`);
    }
    return {
      userId: row.id,
      headers: { cookie: cookieJar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
    };
  }

  async function rows(): Promise<
    { action: string; actor_id: string; target_id: string | null; metadata_json: unknown }[]
  > {
    return await database.sql`
      select action, actor_id, target_id, metadata_json from audit_events order by id
    `;
  }

  async function count(table: 'organizations' | 'projects' | 'audit_events'): Promise<number> {
    const [row] = await database.sql<{ count: string }[]>`
      select count(*)::text as count from ${database.sql(table)}
    `;
    return Number(row?.count ?? '-1');
  }

  /** An organization owned by Alice, created through the API. */
  async function found(): Promise<{ userId: string; headers: Record<string, string>; id: string }> {
    const alice = await signIn(ALICE);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: alice.headers,
      payload: { name: 'Acme Rockets' },
    });
    expect(response.statusCode, response.body).toBe(201);
    return {
      ...alice,
      id: response.json<{ organization: { id: string } }>().organization.id,
    };
  }

  it('writes a real row for a real mutation', async () => {
    const acme = await found();

    const written = await rows();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: 'organization.created',
      actor_id: acme.userId,
      target_id: acme.id,
    });
    expect(written[0]?.metadata_json).toMatchObject({ slug: 'acme-rockets' });
  });

  it('loses the row when the mutation rolls back', async () => {
    // The claim, proved from the table: an audit row that is written and then
    // orphaned by a failed transaction would be a trail describing something
    // that never happened — and a trail you would believe.
    const alice = await signIn(ALICE);

    await expect(
      store.create({
        name: 'Acme',
        slug: 'acme',
        creatorUserId: alice.userId,
        now: new Date(),
        link: () => Promise.resolve({ externalOrgId: 'organization-test' }),
        audit: async (tx, created) => {
          await sink.record(tx, auditRecordFor(created.organization.id, alice.userId));
          // The row is in the transaction at this point. Everything after this
          // line is about whether it stays there.
          throw AUDIT_FAILED;
        },
      }),
    ).rejects.toBe(AUDIT_FAILED);

    expect(await count('audit_events')).toBe(0);
    expect(await count('organizations')).toBe(0);
  });

  it('refuses the mutation when the row cannot be written', async () => {
    const alice = await signIn(ALICE);
    auditFails = true;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: alice.headers,
      payload: { name: 'Acme Rockets' },
    });

    // The whole request fails rather than succeeding unrecorded, and nothing
    // survives it.
    expect(response.statusCode).toBe(500);
    expect(await count('organizations')).toBe(0);
    expect(await count('audit_events')).toBe(0);
  });

  it('keeps a project and its row together, or neither', async () => {
    const acme = await found();
    const tenant = { ...acme.headers, [ORGANIZATION_HEADER]: acme.id };

    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: tenant,
      payload: { name: 'Checkout' },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect((await rows()).at(-1)).toMatchObject({ action: 'project.created' });
    expect(await count('projects')).toBe(1);

    auditFails = true;
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: tenant,
      payload: { name: 'Billing' },
    });

    expect(refused.statusCode).toBe(500);
    // Still one project and one project row: the second attempt left nothing.
    expect(await count('projects')).toBe(1);
    expect((await rows()).filter((row) => row.action === 'project.created')).toHaveLength(1);
  });

  it('records the role that was requested, not one a re-read might have found', async () => {
    const acme = await found();
    const bob = await signIn(BOB);
    await store.addMember({
      organizationId: acme.id,
      userId: bob.userId,
      role: 'viewer',
      now: new Date(),
      audit: () => Promise.resolve(),
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${acme.id}/members/${bob.userId}`,
      headers: acme.headers,
      payload: { role: 'builder' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ membership: { role: string } }>().membership.role).toBe('builder');
    expect((await rows()).at(-1)).toMatchObject({
      action: 'member.role_changed',
      target_id: bob.userId,
      metadata_json: { role: 'builder' },
    });
  });

  it('records a removal with the role that was lost', async () => {
    const acme = await found();
    const bob = await signIn(BOB);
    await store.addMember({
      organizationId: acme.id,
      userId: bob.userId,
      role: 'builder',
      now: new Date(),
      audit: () => Promise.resolve(),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${acme.id}/members/${bob.userId}`,
      headers: acme.headers,
    });

    expect(response.statusCode).toBe(204);
    // The membership row now says `removed`, so this is the only record of what
    // the person could do before.
    expect((await rows()).at(-1)).toMatchObject({
      action: 'member.removed',
      metadata_json: { role: 'builder' },
    });
  });

  it('never writes a credential into the table', async () => {
    const acme = await found();

    const invited = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${acme.id}/invites`,
      headers: acme.headers,
      payload: { email: BOB.email, role: 'builder' },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { token } = invited.json<{ token: string }>();

    const written = await rows();
    expect(written.at(-1)).toMatchObject({ action: 'member.invited' });
    // This table is read years from now; the invite is a bearer credential.
    expect(JSON.stringify(written)).not.toContain(token);
  });

  it('records the joiner as the actor when an invitation is accepted', async () => {
    const acme = await found();
    const invited = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${acme.id}/invites`,
      headers: acme.headers,
      payload: { email: BOB.email, role: 'builder' },
    });
    const { token } = invited.json<{ token: string }>();
    const bob = await signIn(BOB);

    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      headers: bob.headers,
    });

    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await rows()).at(-1)).toMatchObject({
      action: 'member.joined',
      // The actor is the person who accepted, taken from their session — not
      // the Owner who sent the invitation.
      actor_id: bob.userId,
      target_id: bob.userId,
    });
  });

  it('leaves the invitation claimable when the membership write fails', async () => {
    // The mandatory fold, end to end: claim and membership are one unit of
    // work, so a failure must not spend the invite. Before this, the invitee
    // was left on `410 invite_used` holding a link that could never work.
    const acme = await found();
    const invited = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${acme.id}/invites`,
      headers: acme.headers,
      payload: { email: BOB.email, role: 'builder' },
    });
    const { token } = invited.json<{ token: string }>();
    const bob = await signIn(BOB);

    auditFails = true;
    const failed = await app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      headers: bob.headers,
    });
    expect(failed.statusCode).toBe(500);
    expect(await database.sql`select 1 from memberships where user_id = ${bob.userId}`).toEqual([]);

    auditFails = false;
    const retried = await app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      headers: bob.headers,
    });

    // The same link, still good.
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json<{ role: string }>().role).toBe('builder');
  });

  it('cannot be edited or deleted once written', async () => {
    // Append-only is enforced by `packages/db/drizzle/0003`, and this service
    // exports no update and no delete for the table. Both halves matter: a
    // correction is another row, never an edit.
    await found();

    await expect(database.sql`delete from audit_events`).rejects.toThrow();
    await expect(database.sql`update audit_events set action = 'tampered'`).rejects.toThrow();
    expect(await count('audit_events')).toBe(1);
  });

  /** One well-formed record, for the tests that write through the sink directly. */
  function auditRecordFor(organizationId: string, actorId: string): AuditRecord {
    return {
      organizationId,
      actorType: 'user',
      actorId,
      action: 'organization.created',
      targetType: 'organization',
      targetId: organizationId,
      metadata: { slug: 'acme' },
      occurredAt: new Date(),
    };
  }
});
