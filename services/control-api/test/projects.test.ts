import { ApiErrorSchema, IdempotencyHeader } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { GitServiceError, type GitServicePort } from '../src/git/port.js';
import { IDEMPOTENT_REPLAY_HEADER } from '../src/plugins/idempotency.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

/**
 * The project lifecycle (CP-6), through the real HTTP pipeline.
 *
 * The identity provider, the stores and the clock are substituted; the session
 * plugin, the CSRF rule, the PRD §22.2 matrix, the idempotency plugin, the audit
 * seam and every route are the shipping code. What is asserted is what a client
 * experiences — the status, the envelope, and whether the rows behind the
 * request actually exist afterwards.
 *
 * Three properties get more attention than the rest, because each of them is a
 * way this surface could be quietly wrong:
 *
 * 1. **Creation is atomic.** A project is a project row, a repository, a `main`
 *    branch and two environments. The git service is called inside the
 *    transaction, so one that refuses must leave *nothing* — not a project with
 *    no repository, which is a project nobody can build.
 * 2. **The slug is unique per organization and nowhere else.** The same slug in
 *    two tenants is two projects. If it were not, a 409 would tell one tenant
 *    what another has named.
 * 3. **A retry is not a second project.** `Idempotency-Key` is the client's only
 *    protection against a dropped response, and a replay has to return the first
 *    project rather than create a second.
 *
 * The equivalents against a real database — real transactions, real SQL scoping
 * — are in `test/integration/projects.test.ts` and
 * `test/integration/tenant-isolation.test.ts`.
 */

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((built) => built.app.close()));
});

const OWNER: AuthIdentity = {
  externalId: 'projects-test-owner',
  email: 'owner@acme.test',
  displayName: 'Olivia Owner',
};
const BUILDER: AuthIdentity = {
  externalId: 'projects-test-builder',
  email: 'builder@acme.test',
  displayName: 'Bruno Builder',
};
const VIEWER: AuthIdentity = {
  externalId: 'projects-test-viewer',
  email: 'viewer@acme.test',
  displayName: 'Vera Viewer',
};
const OUTSIDER: AuthIdentity = {
  externalId: 'projects-test-outsider',
  email: 'owner@other.test',
  displayName: 'Otto Outsider',
};

function errorOf(response: { json: () => unknown }): string {
  return ApiErrorSchema.parse(response.json()).error.code;
}

function detailsOf(response: { json: () => unknown }): Record<string, unknown> | undefined {
  return ApiErrorSchema.parse(response.json()).error.details;
}

interface Wired {
  readonly built: Harness;
  readonly data: InMemoryTenantData;
  readonly owner: TestSession;
  readonly organizationId: string;
  /** `member`'s headers, naming `organizationId` unless told otherwise. */
  as: (member: TestSession, organizationId?: string) => Record<string, string>;
}

/** A harness with the tenant surface wired, one organization, and its Owner. */
async function wire(options: { git?: GitServicePort } = {}): Promise<Wired> {
  const data = new InMemoryTenantData();
  const built = buildHarness({
    tenantDb: data.factory,
    ...(options.git === undefined ? {} : { git: options.git }),
  });
  harnesses.push(built);

  const owner = await signIn(built, OWNER);
  const created = await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Acme Rockets' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const organizationId = created.json<{ organization: { id: string } }>().organization.id;

  return {
    built,
    data,
    owner,
    organizationId,
    as: (member, organization = organizationId) => ({
      ...member.headers,
      [ORGANIZATION_HEADER]: organization,
    }),
  };
}

/** Adds `identity` to `wired`'s organization at `role`, and returns their session. */
async function join(
  wired: Wired,
  identity: AuthIdentity,
  role: 'owner' | 'builder' | 'viewer',
): Promise<TestSession> {
  const invited = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/organizations/${wired.organizationId}/invites`,
    headers: wired.owner.headers,
    payload: { email: identity.email, role },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  const token = invited.json<{ token: string }>().token;

  const session = await signIn(wired.built, identity);
  const accepted = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/invites/${token}/accept`,
    headers: session.headers,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return session;
}

interface CreatedProject {
  readonly project: { id: string; slug: string; name: string; supportLevel: string };
  readonly repository: { id: string; internalRepoRef: string; defaultBranch: string };
  readonly branches: { name: string; status: string }[];
  readonly environments: { name: string; type: string }[];
}

/** The same body on a read, where the repository is nullable — see the route. */
type ReadProject = Omit<CreatedProject, 'repository'> & {
  readonly repository: CreatedProject['repository'] | null;
};

/** `POST /v1/projects` as the Owner, expecting it to succeed. */
async function create(
  wired: Wired,
  payload: Record<string, unknown>,
  session = wired.owner,
): Promise<CreatedProject> {
  const response = await wired.built.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: wired.as(session),
    payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<CreatedProject>();
}

describe('creating a project', () => {
  it('writes the project, its repository, its default branch and both environments', async () => {
    const wired = await wire();

    const created = await create(wired, { name: 'Checkout Service', sourceType: 'blank' });

    expect(created.project).toMatchObject({
      slug: 'checkout-service',
      name: 'Checkout Service',
      // Earned by a capability scan (PRD §7.1, plan 05 VF-3), never claimed by
      // the client — the create body has no field for it at all.
      supportLevel: 'compatible',
    });
    expect(created.repository.defaultBranch).toBe('main');
    expect(created.repository.internalRepoRef).toContain('checkout-service');
    expect(created.branches.map((branch) => branch.name)).toEqual(['main']);
    expect(created.branches[0]?.status).toBe('active');
    expect(created.environments.map((environment) => environment.name)).toEqual([
      'preview',
      'production',
    ]);
    expect(created.environments.map((environment) => environment.type)).toEqual([
      'preview',
      'production',
    ]);

    // In the store, not only in the answer: the rows are what every later
    // request reads.
    expect(wired.data.repositories).toHaveLength(1);
    expect(wired.data.branches).toHaveLength(1);
    expect(wired.data.environments).toHaveLength(2);
  });

  it('records one audit row naming everything it created', async () => {
    const wired = await wire();

    const created = await create(wired, { name: 'Audited' });

    const entry = wired.built.audit.events.find((event) => event.action === 'project.created');
    expect(entry).toMatchObject({
      organizationId: wired.organizationId,
      actorType: 'user',
      actorId: wired.owner.userId,
      targetType: 'project',
      targetId: created.project.id,
    });
    expect(entry?.metadata).toMatchObject({
      slug: 'audited',
      sourceType: 'prompt',
      repositoryId: created.repository.id,
      defaultBranch: 'main',
      environments: ['preview', 'production'],
    });
  });

  it('creates nothing at all when the git service refuses', async () => {
    // The rollback, from the outside. A project row that survived this would be
    // a project with no repository — buildable by nothing, and holding a slug
    // the client's retry would then collide with.
    const wired = await wire({
      git: {
        createRepository: () => Promise.reject(new GitServiceError('forgejo is down')),
      },
    });

    const response = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: wired.as(wired.owner),
      payload: { name: 'Doomed' },
    });

    expect(response.statusCode, response.body).toBe(502);
    expect(errorOf(response)).toBe('project_create_failed');
    // The provider's own words never reach the client.
    expect(response.body).not.toContain('forgejo');

    expect(wired.data.projects).toEqual([]);
    expect(wired.data.repositories).toEqual([]);
    expect(wired.data.branches).toEqual([]);
    expect(wired.data.environments).toEqual([]);
    expect(wired.built.audit.events.filter((event) => event.action === 'project.created')).toEqual(
      [],
    );

    const listed = await wired.built.app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: wired.as(wired.owner),
    });
    expect(listed.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('refuses a slug the caller chose and this tenant already has', async () => {
    const wired = await wire();
    await create(wired, { name: 'Checkout', slug: 'checkout' });

    const again = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: wired.as(wired.owner),
      payload: { name: 'Checkout Two', slug: 'checkout' },
    });

    expect(again.statusCode, again.body).toBe(409);
    expect(errorOf(again)).toBe('project_slug_taken');
    expect(wired.data.projects).toHaveLength(1);
  });

  it('varies a slug it derived itself rather than refusing', async () => {
    const wired = await wire();
    const first = await create(wired, { name: 'Checkout' });
    const second = await create(wired, { name: 'Checkout' });

    expect(first.project.slug).toBe('checkout');
    expect(second.project.slug).toMatch(/^checkout-[0-9a-f]{6}$/);
  });

  it('lets another tenant own the same slug, because the slug is never a global oracle', async () => {
    // The 409 above must never be reachable across tenants: it would answer
    // "does organization X have a project called Y" for anyone who can create a
    // project.
    const wired = await wire();
    await create(wired, { name: 'Checkout', slug: 'checkout' });

    const outsider = await signIn(wired.built, OUTSIDER);
    const other = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: outsider.headers,
      payload: { name: 'Other Co' },
    });
    const otherOrgId = other.json<{ organization: { id: string } }>().organization.id;

    const response = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...outsider.headers, [ORGANIZATION_HEADER]: otherOrgId },
      payload: { name: 'Checkout', slug: 'checkout' },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<CreatedProject>().project.slug).toBe('checkout');
    expect(wired.data.projects).toHaveLength(2);
  });

  it('returns the first project when a request is retried with its Idempotency-Key', async () => {
    const wired = await wire();
    const payload = { name: 'Retried' };
    const headers = { ...wired.as(wired.owner), [IdempotencyHeader]: 'retry-key-0001' };

    const first = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload,
    });
    const second = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload,
    });

    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
    expect(second.json<CreatedProject>().project.id).toBe(first.json<CreatedProject>().project.id);
    // The point of the header: one project, not two, and one repository.
    expect(wired.data.projects).toHaveLength(1);
    expect(wired.data.repositories).toHaveLength(1);
  });

  it('refuses a Viewer, and writes nothing', async () => {
    const wired = await wire();
    const viewer = await join(wired, VIEWER, 'viewer');

    const response = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: wired.as(viewer),
      payload: { name: 'Viewer Project' },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(errorOf(response)).toBe('permission_denied');
    expect(detailsOf(response)).toEqual({ action: 'create_project' });
    expect(wired.data.projects).toEqual([]);
  });

  it('accepts only the source types plan 02 owns', async () => {
    const wired = await wire();

    for (const sourceType of ['prompt', 'blank', 'template', 'github_import']) {
      const response = await wired.built.app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: wired.as(wired.owner),
        payload: { name: `From ${sourceType}`, sourceType },
      });
      expect(response.statusCode, response.body).toBe(201);
    }

    // CP-4's placeholder spellings. `github_import` is what plan 06's import
    // task writes, and one column with two spellings of one thing is a column
    // every later query has to know that about.
    for (const sourceType of ['github', 'upload']) {
      const response = await wired.built.app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: wired.as(wired.owner),
        payload: { name: 'Legacy', sourceType },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(errorOf(response)).toBe('validation_failed');
    }
  });
});

describe('reading projects', () => {
  it('returns the project with its repository, branches and environments', async () => {
    const wired = await wire();
    const created = await create(wired, { name: 'Readable' });

    const response = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${created.project.id}`,
      headers: wired.as(wired.owner),
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<ReadProject>();
    expect(body.project.id).toBe(created.project.id);
    expect(body.repository?.id).toBe(created.repository.id);
    expect(body.branches.map((branch) => branch.name)).toEqual(['main']);
    expect(body.environments.map((environment) => environment.name)).toEqual([
      'preview',
      'production',
    ]);
  });

  it('pages by a real cursor, in a stable order, with no repeats', async () => {
    const wired = await wire();
    const ids: string[] = [];
    for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) {
      ids.push((await create(wired, { name })).project.id);
    }
    // Newest first: monotonic ULIDs, so creation order reversed.
    const expected = [...ids].reverse();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/projects?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const response = await wired.built.app.inject({
        method: 'GET',
        url,
        headers: wired.as(wired.owner),
      });
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json<{ items: { id: string }[]; nextCursor: string | null }>();
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages, 'pagination did not terminate').toBeLessThan(10);
    } while (cursor !== null);

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
    // Three pages of 2, 2, 1 — and the last one says so with a null cursor
    // rather than by being short.
    expect(pages).toBe(3);
  });

  it('answers 404 for a project of another tenant, exactly as for one that never existed', async () => {
    const wired = await wire();
    const created = await create(wired, { name: 'Private' });

    const outsider = await signIn(wired.built, OUTSIDER);
    const other = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: outsider.headers,
      payload: { name: 'Other Co' },
    });
    const otherOrgId = other.json<{ organization: { id: string } }>().organization.id;
    const headers = { ...outsider.headers, [ORGANIZATION_HEADER]: otherOrgId };

    for (const [method, url] of [
      ['GET', `/v1/projects/${created.project.id}`],
      ['GET', `/v1/projects/${created.project.id}/contract`],
      ['GET', `/v1/projects/${created.project.id}/runs`],
      ['POST', `/v1/projects/${created.project.id}/scan`],
    ] as const) {
      const response = await wired.built.app.inject({ method, url, headers });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(404);
      expect(errorOf(response)).toBe('project_not_found');
    }

    const patched = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${created.project.id}`,
      headers,
      payload: { name: 'Mine Now' },
    });
    expect(patched.statusCode, patched.body).toBe(404);
    expect(errorOf(patched)).toBe('project_not_found');
    // And the attempt changed nothing.
    expect(wired.data.projects[0]?.name).toBe('Private');
  });
});

describe('updating a project', () => {
  it('lets a Builder rename, describe and archive it', async () => {
    const wired = await wire();
    const builder = await join(wired, BUILDER, 'builder');
    const created = await create(wired, { name: 'Before' });

    const renamed = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${created.project.id}`,
      headers: wired.as(builder),
      payload: { name: 'After', description: 'What it does now' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(
      renamed.json<{ project: { name: string; description: string } }>().project,
    ).toMatchObject({ name: 'After', description: 'What it does now' });

    const entry = wired.built.audit.events.find((event) => event.action === 'project.updated');
    expect(entry).toMatchObject({ targetType: 'project', targetId: created.project.id });
    // Which fields moved, not what they moved to.
    expect(entry?.metadata).toEqual({ fields: ['description', 'name'] });

    const archived = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${created.project.id}`,
      headers: wired.as(builder),
      payload: { archived: true },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json<{ project: { archivedAt: string | null } }>().project.archivedAt).not.toBe(
      null,
    );
  });

  it('hides an archived project from the list until it is asked for', async () => {
    const wired = await wire();
    const kept = await create(wired, { name: 'Kept' });
    const gone = await create(wired, { name: 'Gone' });

    await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${gone.project.id}`,
      headers: wired.as(wired.owner),
      payload: { archived: true },
    });

    const listed = await wired.built.app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: wired.as(wired.owner),
    });
    expect(listed.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toEqual([
      kept.project.id,
    ]);

    const all = await wired.built.app.inject({
      method: 'GET',
      url: '/v1/projects?includeArchived=true',
      headers: wired.as(wired.owner),
    });
    expect(all.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toEqual([
      gone.project.id,
      kept.project.id,
    ]);

    // `includeArchived=false` has to mean false. `z.coerce.boolean()` would read
    // the string "false" as true, which is a flag that cannot be turned off.
    const explicit = await wired.built.app.inject({
      method: 'GET',
      url: '/v1/projects?includeArchived=false',
      headers: wired.as(wired.owner),
    });
    expect(explicit.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toEqual([
      kept.project.id,
    ]);
  });

  it('refuses a Viewer, and leaves the project as it was', async () => {
    const wired = await wire();
    const viewer = await join(wired, VIEWER, 'viewer');
    const created = await create(wired, { name: 'Untouched' });

    const response = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${created.project.id}`,
      headers: wired.as(viewer),
      payload: { name: 'Touched' },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(errorOf(response)).toBe('permission_denied');
    expect(detailsOf(response)).toEqual({ action: 'edit_code' });
    expect(wired.data.projects[0]?.name).toBe('Untouched');
    expect(wired.built.audit.events.filter((event) => event.action === 'project.updated')).toEqual(
      [],
    );
  });

  it('refuses a slug this tenant already has, and a patch that changes nothing', async () => {
    const wired = await wire();
    await create(wired, { name: 'First', slug: 'first' });
    const second = await create(wired, { name: 'Second', slug: 'second' });

    const collided = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${second.project.id}`,
      headers: wired.as(wired.owner),
      payload: { slug: 'first' },
    });
    expect(collided.statusCode, collided.body).toBe(409);
    expect(errorOf(collided)).toBe('project_slug_taken');

    const empty = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${second.project.id}`,
      headers: wired.as(wired.owner),
      payload: {},
    });
    expect(empty.statusCode, empty.body).toBe(400);
    expect(errorOf(empty)).toBe('validation_failed');
  });
});

describe('the execution contract', () => {
  it('is 404 until a scan has produced one, then the newest version', async () => {
    const wired = await wire();
    const created = await create(wired, { name: 'Scannable' });

    const before = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${created.project.id}/contract`,
      headers: wired.as(wired.owner),
    });
    expect(before.statusCode, before.body).toBe(404);
    expect(errorOf(before)).toBe('project_contract_not_found');

    const project = wired.data.projects[0];
    if (project === undefined) {
      throw new Error('the project was not written');
    }
    wired.data.addContract(project, { version: 1, detectedFramework: 'next' });
    wired.data.addContract(project, { version: 2, detectedFramework: 'remix' });

    const after = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${created.project.id}/contract`,
      headers: wired.as(wired.owner),
    });
    expect(after.statusCode, after.body).toBe(200);
    // A scan appends a version rather than overwriting one (PRD §17.2), so the
    // newest is the one a client gets.
    expect(
      after.json<{ contract: { version: number; detectedFramework: string } }>().contract,
    ).toMatchObject({ version: 2, detectedFramework: 'remix' });
  });
});

describe('requesting a capability scan', () => {
  it('accepts it, audits it, and promises nothing it has not done', async () => {
    const wired = await wire();
    const created = await create(wired, { name: 'To Scan' });

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${created.project.id}/scan`,
      headers: wired.as(wired.owner),
    });

    expect(response.statusCode, response.body).toBe(202);
    const scan = response.json<{ scan: { id: string; projectId: string; status: string } }>().scan;
    expect(scan).toMatchObject({ projectId: created.project.id, status: 'queued' });
    expect(scan.id).not.toBe('');

    expect(
      wired.built.audit.events.find((event) => event.action === 'project.scan_requested'),
    ).toMatchObject({ targetType: 'project', targetId: created.project.id });

    // Nothing was produced, and the contract route says so rather than
    // inventing an empty one.
    const contract = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${created.project.id}/contract`,
      headers: wired.as(wired.owner),
    });
    expect(contract.statusCode).toBe(404);
  });

  it('refuses a Viewer', async () => {
    const wired = await wire();
    const viewer = await join(wired, VIEWER, 'viewer');
    const created = await create(wired, { name: 'Not Yours To Scan' });

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${created.project.id}/scan`,
      headers: wired.as(viewer),
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(detailsOf(response)).toEqual({ action: 'start_run' });
  });
});
