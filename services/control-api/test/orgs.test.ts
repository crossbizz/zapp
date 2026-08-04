import { ApiErrorSchema } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { hashInviteToken, INVITE_TTL_MS } from '../src/orgs/invites.js';
import { SlugSchema } from '../src/slug.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';

/**
 * The organization surface, exercised through the real HTTP pipeline: the
 * identity provider, the user store, the organization store and the clock are
 * substituted, and the session plugin, the CSRF rule, the RBAC matrix, the
 * invite lifecycle and the audit seam are the shipping code.
 */

const harnesses: Harness[] = [];

function harness(options?: Parameters<typeof buildHarness>[0]): Harness {
  const built = buildHarness(options);
  harnesses.push(built);
  return built;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((built) => built.app.close()));
});

const OWNER: AuthIdentity = {
  externalId: 'member-test-alice',
  email: 'alice@acme.test',
  displayName: 'Alice Example',
};
const OTHER: AuthIdentity = {
  externalId: 'member-test-bob',
  email: 'bob@acme.test',
  displayName: 'Bob Example',
};
const THIRD: AuthIdentity = {
  externalId: 'member-test-carol',
  email: 'carol@acme.test',
  displayName: 'Carol Example',
};

interface Founded {
  readonly built: Harness;
  readonly owner: TestSession;
  readonly organizationId: string;
}

/** Signs `identity` in and creates one organization for them. */
async function found(
  built: Harness,
  identity: AuthIdentity = OWNER,
  name = 'Acme Rockets',
): Promise<Founded> {
  const owner = await signIn(built, identity);
  const response = await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name },
  });
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json<{ organization: { id: string } }>();
  return { built, owner, organizationId: body.organization.id };
}

/** Invites `identity` at `role`, accepts as them, and returns their session. */
async function join(
  founded: Founded,
  identity: AuthIdentity,
  role: 'owner' | 'builder' | 'viewer',
): Promise<TestSession> {
  const invited = await founded.built.app.inject({
    method: 'POST',
    url: `/v1/organizations/${founded.organizationId}/invites`,
    headers: founded.owner.headers,
    payload: { email: identity.email, role },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  const { token } = invited.json<{ token: string }>();

  const session = await signIn(founded.built, identity);
  const accepted = await founded.built.app.inject({
    method: 'POST',
    url: `/v1/invites/${token}/accept`,
    headers: session.headers,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return session;
}

function errorOf(response: { json: () => unknown }): string {
  return ApiErrorSchema.parse(response.json()).error.code;
}

describe('POST /v1/organizations', () => {
  it('creates the organization, makes the creator an Owner and seeds the trial plan', async () => {
    const built = harness();
    const owner = await signIn(built, OWNER);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Acme Rockets, Inc.' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      organization: { id: string; name: string; slug: string; plan: string };
      role: string;
    }>();
    expect(body.organization.name).toBe('Acme Rockets, Inc.');
    expect(body.organization.slug).toBe('acme-rockets-inc');
    expect(body.organization.plan).toBe('trial');
    expect(body.role).toBe('owner');

    // The membership is what authorization reads; the response only reports it.
    const membership = await built.organizations.membership(body.organization.id, owner.userId);
    expect(membership).toEqual({
      organizationId: body.organization.id,
      userId: owner.userId,
      role: 'owner',
      status: 'active',
    });
  });

  it('creates the paired provider organization with the same name and slug', async () => {
    const built = harness();
    const owner = await signIn(built, OWNER);

    await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Acme Rockets' },
    });

    expect(built.port.createdOrganizations).toEqual([
      { name: 'Acme Rockets', slug: 'acme-rockets' },
    ]);
  });

  it('rolls the organization back when the provider refuses it', async () => {
    const built = harness();
    const owner = await signIn(built, OWNER);
    built.port.organizationCreateFails = true;

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Acme Rockets' },
    });

    expect(response.statusCode).toBe(502);
    expect(errorOf(response)).toBe('organization_create_failed');
    // The attempt happened, and nothing survived it: no orphan organization, no
    // membership pointing at one.
    expect(built.port.createdOrganizations).toHaveLength(1);
    expect(built.organizations.organizations.size).toBe(0);
    expect(built.organizations.memberships.size).toBe(0);
    expect(built.audit.events).toHaveLength(0);
  });

  it('suffixes a derived slug that is already taken', async () => {
    const built = harness();
    const first = await found(built, OWNER, 'Acme Rockets');
    const second = await signIn(built, OTHER);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: second.headers,
      payload: { name: 'Acme Rockets' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ organization: { id: string; slug: string } }>();
    expect(body.organization.slug).toMatch(/^acme-rockets-[0-9a-f]{6}$/);
    expect(body.organization.id).not.toBe(first.organizationId);
    // The provider gets the slug that was actually written, not the one the
    // first attempt asked for: the pair has to agree on which organization
    // this is.
    expect(built.port.createdOrganizations.at(-1)).toEqual({
      name: 'Acme Rockets',
      slug: body.organization.slug,
    });
  });

  it('refuses a slug the client chose and someone else holds', async () => {
    const built = harness();
    await found(built, OWNER, 'Acme Rockets');
    const second = await signIn(built, OTHER);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: second.headers,
      payload: { name: 'Something Else', slug: 'acme-rockets' },
    });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response)).toBe('slug_taken');
  });

  it('folds accents into the slug rather than dropping the letters', async () => {
    const built = harness();
    const owner = await signIn(built, OWNER);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Café Zünd' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ organization: { name: string; slug: string } }>();
    expect(body.organization.slug).toBe('cafe-zund');
    // The slug is a handle; the name is kept exactly as it was given.
    expect(body.organization.name).toBe('Café Zünd');
  });

  it('falls back to a random slug for a name with nothing sluggable in it', async () => {
    const built = harness();
    const owner = await signIn(built, OWNER);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: '株式会社' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ organization: { slug: string } }>().organization.slug).toMatch(
      /^org-[0-9a-f]{6}$/,
    );
  });

  it('never derives a slug its own schema would reject', async () => {
    // A one-character name reduces to a one-character slug, which `SlugSchema`
    // refuses at two — so the row could be created and then never accepted back
    // by a `PATCH` that touched only the name (plan 02 CP-3 review).
    const built = harness();
    const owner = await signIn(built, OWNER);

    for (const name of ['A', '李', '.']) {
      const response = await built.app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: owner.headers,
        payload: { name },
      });

      expect(response.statusCode, name).toBe(201);
      const { slug } = response.json<{ organization: { slug: string } }>().organization;
      expect(SlugSchema.safeParse(slug).success, `${name} → ${slug}`).toBe(true);
      expect(slug).toMatch(/^org-[0-9a-f]{6}$/);
    }
  });

  it('records the creation in the audit trail, actor and all', async () => {
    const built = harness();
    const { owner, organizationId } = await found(built);

    expect(built.audit.events).toHaveLength(1);
    const [event] = built.audit.events;
    expect(event).toMatchObject({
      organizationId,
      actorType: 'user',
      actorId: owner.userId,
      action: 'organization.created',
      targetType: 'organization',
      targetId: organizationId,
    });
    expect(event?.metadata).toMatchObject({ slug: 'acme-rockets' });
  });

  it('requires a session', async () => {
    const built = harness();

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      payload: { name: 'Acme Rockets' },
    });

    expect(response.statusCode).toBe(401);
    expect(errorOf(response)).toBe('unauthenticated');
  });

  it('requires the CSRF header from a cookie-borne session', async () => {
    const built = harness();
    const owner = await signIn(built, OWNER);

    // The cookie without the header: exactly what a cross-site form post would
    // send, since the browser attaches the session by itself.
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: owner.cookie },
      payload: { name: 'Acme Rockets' },
    });

    expect(response.statusCode).toBe(403);
    expect(errorOf(response)).toBe('csrf_required');
    expect(built.organizations.organizations.size).toBe(0);
  });
});

describe('GET /v1/organizations', () => {
  it('lists only the caller’s own memberships', async () => {
    const built = harness();
    const mine = await found(built, OWNER, 'Acme Rockets');
    await found(built, OTHER, 'Someone Else');

    const response = await built.app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: mine.owner.headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: { organization: { id: string }; role: string; status: string }[];
      nextCursor: string | null;
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.organization.id).toBe(mine.organizationId);
    expect(body.items[0]?.role).toBe('owner');
    // FND-10: explicitly null, never absent.
    expect(body.nextCursor).toBeNull();
  });

  it('pages with the cursor it hands out', async () => {
    // The envelope promises keyset pagination on every list. It used to answer
    // `nextCursor: null` unconditionally, which is a promise a client cannot
    // act on and a page size nobody chose (plan 02 CP-3 review).
    const built = harness();
    const first = await found(built, OWNER, 'Acme One');
    const second = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: first.owner.headers,
      payload: { name: 'Acme Two' },
    });
    const secondId = second.json<{ organization: { id: string } }>().organization.id;

    const page = await built.app.inject({
      method: 'GET',
      url: '/v1/organizations?limit=1',
      headers: first.owner.headers,
    });
    const body = page.json<{
      items: { organization: { id: string } }[];
      nextCursor: string | null;
    }>();
    expect(body.items.map((item) => item.organization.id)).toEqual([secondId]);
    expect(body.nextCursor).toBe(secondId);

    const next = await built.app.inject({
      method: 'GET',
      url: `/v1/organizations?limit=1&cursor=${body.nextCursor ?? ''}`,
      headers: first.owner.headers,
    });
    const rest = next.json<{
      items: { organization: { id: string } }[];
      nextCursor: string | null;
    }>();
    expect(rest.items.map((item) => item.organization.id)).toEqual([first.organizationId]);
    // The last page says so rather than promising a third.
    expect(rest.nextCursor).toBeNull();
  });

  it('refuses a cursor that is not one', async () => {
    const built = harness();
    const founded = await found(built);

    const response = await built.app.inject({
      method: 'GET',
      url: '/v1/organizations?cursor=not-an-id',
      headers: founded.owner.headers,
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response)).toBe('validation_failed');
  });

  it('requires a session', async () => {
    const built = harness();

    const response = await built.app.inject({ method: 'GET', url: '/v1/organizations' });

    expect(response.statusCode).toBe(401);
  });
});

describe('PATCH /v1/organizations/:orgId', () => {
  it('lets an Owner rename the organization', async () => {
    const built = harness();
    const founded = await found(built);

    const response = await built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${founded.organizationId}`,
      headers: founded.owner.headers,
      payload: { name: 'Acme Astronautics' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ organization: { name: string } }>().organization.name).toBe(
      'Acme Astronautics',
    );
    expect((await built.organizations.findById(founded.organizationId))?.name).toBe(
      'Acme Astronautics',
    );
    expect(built.audit.events.at(-1)).toMatchObject({
      action: 'organization.updated',
      metadata: { fields: ['name'] },
    });
  });

  it('refuses a Builder, naming the permission they lack', async () => {
    const built = harness();
    const founded = await found(built);
    const builder = await join(founded, OTHER, 'builder');

    const response = await built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${founded.organizationId}`,
      headers: builder.headers,
      payload: { name: 'Builders R Us' },
    });

    expect(response.statusCode).toBe(403);
    const body = ApiErrorSchema.parse(response.json());
    expect(body.error.code).toBe('permission_denied');
    expect(body.error.details).toEqual({ action: 'manage_organization' });
    expect((await built.organizations.findById(founded.organizationId))?.name).toBe('Acme Rockets');
  });

  it('tells a non-member that the organization does not exist', async () => {
    const built = harness();
    const founded = await found(built);
    const stranger = await signIn(built, OTHER);

    const response = await built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${founded.organizationId}`,
      headers: stranger.headers,
      payload: { name: 'Mine Now' },
    });

    // 404, not 403: a 403 would confirm the organization exists.
    expect(response.statusCode).toBe(404);
    expect(errorOf(response)).toBe('organization_not_found');
  });

  it('refuses a slug another organization holds', async () => {
    const built = harness();
    const founded = await found(built, OWNER, 'Acme Rockets');
    await found(built, OTHER, 'Beta Works');

    const response = await built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${founded.organizationId}`,
      headers: founded.owner.headers,
      payload: { slug: 'beta-works' },
    });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response)).toBe('slug_taken');
  });

  it('rejects a patch that changes nothing', async () => {
    const built = harness();
    const founded = await found(built);

    const response = await built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${founded.organizationId}`,
      headers: founded.owner.headers,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response)).toBe('validation_failed');
  });
});

describe('POST /v1/organizations/:orgId/invites', () => {
  it('issues a single-use token that expires in seven days', async () => {
    const built = harness();
    const founded = await found(built);

    const before = built.now().getTime();
    const response = await built.app.inject({
      method: 'POST',
      url: `/v1/organizations/${founded.organizationId}/invites`,
      headers: founded.owner.headers,
      payload: { email: 'Bob@Acme.test', role: 'builder' },
    });
    const after = built.now().getTime();

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      invite: { email: string; role: string; expiresAt: string };
      token: string;
    }>();
    expect(body.invite.email).toBe('bob@acme.test');
    expect(body.invite.role).toBe('builder');
    // A window rather than an instant: the clock advances between the request
    // and this assertion, and a test that demands otherwise fails on a slow day
    // rather than on a real one.
    const expiresAt = new Date(body.invite.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + INVITE_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + INVITE_TTL_MS);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    // A credential in a response body is a credential a cache must not keep.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('stores the token hashed and never in the clear', async () => {
    const built = harness();
    const founded = await found(built);

    const response = await built.app.inject({
      method: 'POST',
      url: `/v1/organizations/${founded.organizationId}/invites`,
      headers: founded.owner.headers,
      payload: { email: OTHER.email, role: 'viewer' },
    });
    const { token } = response.json<{ token: string }>();

    // The hash opens it…
    expect(
      await built.invites.claim({
        tokenHash: hashInviteToken(token),
        email: OTHER.email,
        complete: () => Promise.resolve(undefined),
      }),
    ).toMatchObject({ status: 'claimed' });
    // …and nothing anywhere else — the store, or the audit trail it wrote —
    // contains the token itself.
    expect(JSON.stringify([...built.audit.events])).not.toContain(token);
  });

  it('refuses a Builder', async () => {
    const built = harness();
    const founded = await found(built);
    const builder = await join(founded, OTHER, 'builder');

    const response = await built.app.inject({
      method: 'POST',
      url: `/v1/organizations/${founded.organizationId}/invites`,
      headers: builder.headers,
      payload: { email: THIRD.email, role: 'viewer' },
    });

    expect(response.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(response.json()).error.details).toEqual({
      action: 'manage_members',
    });
  });

  it('records the invitation without the token', async () => {
    const built = harness();
    const founded = await found(built);

    await built.app.inject({
      method: 'POST',
      url: `/v1/organizations/${founded.organizationId}/invites`,
      headers: founded.owner.headers,
      payload: { email: OTHER.email, role: 'viewer' },
    });

    expect(built.audit.events.at(-1)).toMatchObject({
      action: 'member.invited',
      targetType: 'invite',
      metadata: { email: OTHER.email, role: 'viewer' },
    });
  });
});

describe('POST /v1/invites/:token/accept', () => {
  /** Issues an invite and returns its token. */
  async function invite(
    founded: Founded,
    email: string,
    role: 'owner' | 'builder' | 'viewer' = 'builder',
  ): Promise<string> {
    const response = await founded.built.app.inject({
      method: 'POST',
      url: `/v1/organizations/${founded.organizationId}/invites`,
      headers: founded.owner.headers,
      payload: { email, role },
    });
    return response.json<{ token: string }>().token;
  }

  it('adds the invited member at the invited role', async () => {
    const built = harness();
    const founded = await found(built);
    const token = await invite(founded, OTHER.email, 'builder');
    const bob = await signIn(built, OTHER);

    const response = await built.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      headers: bob.headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ role: string }>().role).toBe('builder');
    expect(await built.organizations.membership(founded.organizationId, bob.userId)).toMatchObject({
      role: 'builder',
      status: 'active',
    });
    expect(built.audit.events.at(-1)).toMatchObject({
      action: 'member.joined',
      actorId: bob.userId,
      targetId: bob.userId,
    });
  });

  it('is single use', async () => {
    const built = harness();
    const founded = await found(built);
    const token = await invite(founded, OTHER.email);
    const bob = await signIn(built, OTHER);

    const first = await built.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      headers: bob.headers,
    });
    const second = await built.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      headers: bob.headers,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(410);
    expect(errorOf(second)).toBe('invite_used');
  });

  it('expires after seven days', async () => {
    const built = harness();
    const founded = await found(built);
    const token = await invite(founded, OTHER.email);
    // The clock moves *before* the sign-in: a session lasts twelve hours (PRD
    // §22.1), so a week later the only person who can present this invite is
    // one who has signed in since.
    built.advance(INVITE_TTL_MS + 1);
    const bob = await signIn(built, OTHER);

    const response = await built.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      headers: bob.headers,
    });

    expect(response.statusCode).toBe(410);
    expect(errorOf(response)).toBe('invite_expired');
    expect(
      await built.organizations.membership(founded.organizationId, bob.userId),
    ).toBeUndefined();
  });

  it('refuses a different account, and leaves the invite unspent', async () => {
    const built = harness();
    const founded = await found(built);
    const token = await invite(founded, OTHER.email);
    const carol = await signIn(built, THIRD);

    const wrong = await built.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      headers: carol.headers,
    });

    expect(wrong.statusCode).toBe(403);
    expect(errorOf(wrong)).toBe('invite_email_mismatch');
    expect(
      await built.organizations.membership(founded.organizationId, carol.userId),
    ).toBeUndefined();

    // The person it was actually for can still use it: the wrong recipient must
    // not be able to burn someone else's invitation.
    const bob = await signIn(built, OTHER);
    const right = await built.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      headers: bob.headers,
    });
    expect(right.statusCode).toBe(200);
  });

  it('does not exist for a token nobody issued', async () => {
    const built = harness();
    await found(built);
    const bob = await signIn(built, OTHER);

    const response = await built.app.inject({
      method: 'POST',
      url: `/v1/invites/${'0'.repeat(64)}/accept`,
      headers: bob.headers,
    });

    expect(response.statusCode).toBe(404);
    expect(errorOf(response)).toBe('invite_not_found');
  });

  it('never lowers a role the member already holds', async () => {
    const built = harness();
    const founded = await found(built);
    // An invite to the Owner themselves, at the lowest role there is.
    const token = await invite(founded, OWNER.email, 'viewer');

    const response = await built.app.inject({
      method: 'POST',
      url: `/v1/invites/${token}/accept`,
      headers: founded.owner.headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ role: string }>().role).toBe('owner');
    expect(
      await built.organizations.membership(founded.organizationId, founded.owner.userId),
    ).toMatchObject({ role: 'owner' });
  });
});

describe('PATCH /v1/organizations/:orgId/members/:userId', () => {
  it('lets an Owner change a member’s role', async () => {
    const built = harness();
    const founded = await found(built);
    const bob = await join(founded, OTHER, 'builder');

    const response = await built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${founded.organizationId}/members/${bob.userId}`,
      headers: founded.owner.headers,
      payload: { role: 'viewer' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ membership: { role: string } }>().membership.role).toBe('viewer');
    expect(built.audit.events.at(-1)).toMatchObject({
      action: 'member.role_changed',
      targetId: bob.userId,
      metadata: { role: 'viewer' },
    });
  });

  it('refuses to demote the last Owner', async () => {
    const built = harness();
    const founded = await found(built);
    await join(founded, OTHER, 'builder');

    const response = await built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${founded.organizationId}/members/${founded.owner.userId}`,
      headers: founded.owner.headers,
      payload: { role: 'builder' },
    });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response)).toBe('last_owner');
    // Still an Owner, and therefore still able to fix it.
    expect(
      await built.organizations.membership(founded.organizationId, founded.owner.userId),
    ).toMatchObject({ role: 'owner' });
  });

  it('allows the demotion once a second Owner exists', async () => {
    const built = harness();
    const founded = await found(built);
    await join(founded, OTHER, 'owner');

    const response = await built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${founded.organizationId}/members/${founded.owner.userId}`,
      headers: founded.owner.headers,
      payload: { role: 'viewer' },
    });

    expect(response.statusCode).toBe(200);
    expect(
      await built.organizations.membership(founded.organizationId, founded.owner.userId),
    ).toMatchObject({ role: 'viewer' });
  });

  it('refuses a Builder', async () => {
    const built = harness();
    const founded = await found(built);
    const builder = await join(founded, OTHER, 'builder');

    const response = await built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${founded.organizationId}/members/${founded.owner.userId}`,
      headers: builder.headers,
      payload: { role: 'viewer' },
    });

    expect(response.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(response.json()).error.details).toEqual({
      action: 'manage_members',
    });
  });

  it('404s a user who is not a member', async () => {
    const built = harness();
    const founded = await found(built);
    const stranger = await signIn(built, OTHER);

    const response = await built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${founded.organizationId}/members/${stranger.userId}`,
      headers: founded.owner.headers,
      payload: { role: 'viewer' },
    });

    expect(response.statusCode).toBe(404);
    expect(errorOf(response)).toBe('member_not_found');
  });
});

describe('DELETE /v1/organizations/:orgId/members/:userId', () => {
  it('removes a member and takes the organization out of their list', async () => {
    const built = harness();
    const founded = await found(built);
    const bob = await join(founded, OTHER, 'builder');

    const response = await built.app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${founded.organizationId}/members/${bob.userId}`,
      headers: founded.owner.headers,
    });

    expect(response.statusCode).toBe(204);
    const listed = await built.app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: bob.headers,
    });
    expect(listed.json<{ items: unknown[] }>().items).toEqual([]);
    expect(built.audit.events.at(-1)).toMatchObject({
      action: 'member.removed',
      targetId: bob.userId,
    });
  });

  it('refuses to remove the last Owner', async () => {
    const built = harness();
    const founded = await found(built);
    await join(founded, OTHER, 'viewer');

    const response = await built.app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${founded.organizationId}/members/${founded.owner.userId}`,
      headers: founded.owner.headers,
    });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response)).toBe('last_owner');
    expect(
      await built.organizations.membership(founded.organizationId, founded.owner.userId),
    ).toMatchObject({ status: 'active' });
  });

  it('refuses a Viewer', async () => {
    const built = harness();
    const founded = await found(built);
    const viewer = await join(founded, OTHER, 'viewer');

    const response = await built.app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${founded.organizationId}/members/${founded.owner.userId}`,
      headers: viewer.headers,
    });

    expect(response.statusCode).toBe(403);
    expect(errorOf(response)).toBe('permission_denied');
  });

  it('tells a non-member the organization does not exist', async () => {
    const built = harness();
    const founded = await found(built);
    const stranger = await signIn(built, OTHER);

    const response = await built.app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${founded.organizationId}/members/${founded.owner.userId}`,
      headers: stranger.headers,
    });

    expect(response.statusCode).toBe(404);
    expect(errorOf(response)).toBe('organization_not_found');
  });
});
