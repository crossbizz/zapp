import { ApiErrorSchema, IdempotencyHeader, newId } from '@zapp/contracts';
import { projectContracts } from '@zapp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../src/auth/cookies.js';
import { createDbUserStore } from '../../src/auth/users.js';
import { GitServiceError, type GitServicePort } from '../../src/git/port.js';
import { createDbOrganizationStore, type OrganizationStore } from '../../src/orgs/store.js';
import { createDbAuditSink } from '../../src/plugins/audit.js';
import { IDEMPOTENT_REPLAY_HEADER } from '../../src/plugins/idempotency.js';
import { ORGANIZATION_HEADER } from '../../src/plugins/tenant.js';
import { createTenantDbFactory } from '../../src/tenant/db.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import { TEST_AUTH_CONFIG, TEST_RATE_LIMITS, cookieJar, cookiesOf } from '../support/harness.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

/**
 * The project lifecycle against a real PostgreSQL (CP-6).
 *
 * `test/projects.test.ts` proves the routes behave; this proves the things only
 * a database can be asked about:
 *
 *   - **The transaction is real.** Creating a project writes five rows —
 *     project, repository, branch, two environments — plus an `audit_events`
 *     row, and a git service that refuses inside it leaves *none* of them.
 *     Counted in the tables, not inferred from the response.
 *   - **The slug uniqueness is the index's**, not a read-then-write in the
 *     service: `projects_org_slug_idx` is per `(organization_id, slug)`, so two
 *     tenants owning `checkout` is a fact about the schema rather than about
 *     this code path.
 *   - **The keyset page is SQL.** Ordering, the cursor and the extra-row probe
 *     are exercised against rows Postgres sorted.
 *
 * Env-gated on the FND-7 dev stack: with no `DATABASE_URL` this suite skips
 * loudly, and never passes silently.
 */

/** Fails on demand, so the rollback can be provoked rather than argued about. */
class ScriptedGitService implements GitServicePort {
  fail = false;
  readonly calls: { projectId: string; projectSlug: string; defaultBranch: string }[] = [];

  createRepository(input: {
    organizationId: string;
    projectId: string;
    projectSlug: string;
    defaultBranch: string;
  }): Promise<{ internalRepoRef: string }> {
    this.calls.push({
      projectId: input.projectId,
      projectSlug: input.projectSlug,
      defaultBranch: input.defaultBranch,
    });
    if (this.fail) {
      return Promise.reject(new GitServiceError('forgejo refused'));
    }
    return Promise.resolve({ internalRepoRef: `${input.organizationId}/${input.projectSlug}` });
  }
}

interface Member {
  readonly userId: string;
  readonly headers: Record<string, string>;
}

interface CreatedBody {
  readonly project: { id: string; slug: string; archivedAt: string | null };
  readonly repository: { id: string; internalRepoRef: string; defaultBranch: string };
  readonly branches: { id: string; name: string; status: string }[];
  readonly environments: { id: string; name: string; type: string }[];
}

/** The same body on a read, where the repository is nullable — see the route. */
type ReadBody = Omit<CreatedBody, 'repository'> & {
  readonly repository: CreatedBody['repository'] | null;
};

describe.skipIf(!hasDatabase)('the project lifecycle, on PostgreSQL', () => {
  let database: TestDatabase;
  let store: OrganizationStore;
  let app: AppInstance;
  let port: FakeAuthPort;
  let git: ScriptedGitService;
  let owner: Member;
  let organizationId: string;
  /** A second tenant, for the half of slug uniqueness that must *not* collide. */
  let neighbour: Member;
  let neighbourOrganizationId: string;

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
      headers: {
        cookie: cookieJar(cookies),
        [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '',
      },
    };
  }

  function as(member: Member, organization: string): Record<string, string> {
    return { ...member.headers, [ORGANIZATION_HEADER]: organization };
  }

  async function create(
    payload: Record<string, unknown>,
    member: Member = owner,
    organization: string = organizationId,
  ): Promise<CreatedBody> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: as(member, organization),
      payload,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<CreatedBody>();
  }

  /** Rows of one table for one project, straight from the database. */
  async function rowsFor(table: string, projectId: string): Promise<{ id: string }[]> {
    return await database.sql<{ id: string }[]>`
      select id from ${database.sql.unsafe(table)} where project_id = ${projectId}
    `;
  }

  beforeAll(async () => {
    database = await setUpTestDatabase();
    await database.truncateIdentity();
    store = createDbOrganizationStore(database.db);
    port = new FakeAuthPort();
    git = new ScriptedGitService();
    app = buildApp({
      logger: false,
      auth: { port, users: createDbUserStore(database.db), config: TEST_AUTH_CONFIG },
      orgs: { organizations: store, audit: createDbAuditSink(database.db) },
      tenant: { tenantDb: createTenantDbFactory(database.db), git },
      limits: { config: TEST_RATE_LIMITS },
    });
    await app.ready();

    owner = await signIn('owner@lifecycle.test');
    neighbour = await signIn('owner@neighbour.test');
    const now = new Date();
    organizationId = (
      await store.create({
        name: 'lifecycle',
        slug: 'lifecycle',
        creatorUserId: owner.userId,
        now,
        link: () => Promise.resolve({ externalOrgId: 'external-lifecycle' }),
        audit: noAudit,
      })
    ).organization.id;
    neighbourOrganizationId = (
      await store.create({
        name: 'neighbour',
        slug: 'neighbour',
        creatorUserId: neighbour.userId,
        now,
        link: () => Promise.resolve({ externalOrgId: 'external-neighbour' }),
        audit: noAudit,
      })
    ).organization.id;
  }, 180_000);

  beforeEach(() => {
    git.fail = false;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('writes the project, repository, branch and both environments in one transaction', async () => {
    const created = await create({
      name: 'Transactional',
      slug: `tx-${newId('proj').slice(-6).toLowerCase()}`,
    });

    const [project] = await database.sql<
      { id: string; organization_id: string; support_level: string; source_type: string }[]
    >`
      select id, organization_id, support_level, source_type
        from projects where id = ${created.project.id}
    `;
    expect(project).toMatchObject({
      organization_id: organizationId,
      // Earned by a scan, never claimed by the client (PRD §7.1).
      support_level: 'compatible',
      source_type: 'prompt',
    });

    const [repository] = await database.sql<
      {
        organization_id: string;
        provider: string;
        internal_repo_ref: string;
        external_repo_ref: string | null;
        default_branch: string;
        sync_policy: string;
      }[]
    >`
      select organization_id, provider, internal_repo_ref, external_repo_ref,
             default_branch, sync_policy
        from repositories where project_id = ${created.project.id}
    `;
    expect(repository).toMatchObject({
      organization_id: organizationId,
      provider: 'internal',
      external_repo_ref: null,
      default_branch: 'main',
      sync_policy: 'none',
    });

    const branchRows = await database.sql<{ name: string; status: string }[]>`
      select name, status from branches where project_id = ${created.project.id}
    `;
    expect(branchRows).toEqual([{ name: 'main', status: 'active' }]);

    const environmentRows = await database.sql<{ name: string; type: string }[]>`
      select name, type from environments
        where project_id = ${created.project.id} order by id
    `;
    expect(environmentRows).toEqual([
      { name: 'preview', type: 'preview' },
      { name: 'production', type: 'production' },
    ]);

    // The audit row is in the same transaction as all of it (CP-5).
    const audit = await database.sql<{ action: string; target_id: string; actor_id: string }[]>`
      select action, target_id, actor_id from audit_events
        where target_id = ${created.project.id} and action = 'project.created'
    `;
    expect(audit).toEqual([
      { action: 'project.created', target_id: created.project.id, actor_id: owner.userId },
    ]);

    // The git service was asked about the slug that was actually written.
    expect(git.calls.at(-1)).toMatchObject({
      projectId: created.project.id,
      projectSlug: created.project.slug,
      defaultBranch: 'main',
    });
  });

  it('leaves no row behind when the git service refuses', async () => {
    // The rollback, in the tables. A project row surviving this is a project
    // with no repository — nothing can build it, and the slug it holds is one
    // the client's retry then collides with.
    git.fail = true;
    const slug = `rolled-back-${newId('proj').slice(-6).toLowerCase()}`;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: as(owner, organizationId),
      payload: { name: 'Rolled Back', slug },
    });

    expect(response.statusCode, response.body).toBe(502);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('project_create_failed');

    const projects = await database.sql<{ id: string }[]>`
      select id from projects where slug = ${slug}
    `;
    expect(projects).toEqual([]);

    // And nothing that hangs off a project either — the ids were minted inside
    // the transaction, so the only way to look for them is by what they point
    // at, which is the project that does not exist.
    const attempted = git.calls.at(-1);
    expect(attempted?.projectSlug).toBe(slug);
    const projectId = attempted?.projectId ?? '';
    expect(await rowsFor('repositories', projectId)).toEqual([]);
    expect(await rowsFor('branches', projectId)).toEqual([]);
    expect(await rowsFor('environments', projectId)).toEqual([]);
    const audit = await database.sql<{ id: string }[]>`
      select id from audit_events where target_id = ${projectId}
    `;
    expect(audit).toEqual([]);

    // The same slug is free immediately afterwards, which is the property the
    // rollback exists for.
    git.fail = false;
    const retried = await create({ name: 'Rolled Back', slug });
    expect(retried.project.slug).toBe(slug);
  });

  it('holds the slug unique per organization, and only per organization', async () => {
    await create({ name: 'Checkout', slug: 'checkout' });

    const again = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: as(owner, organizationId),
      payload: { name: 'Checkout Again', slug: 'checkout' },
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(ApiErrorSchema.parse(again.json()).error.code).toBe('project_slug_taken');

    // The other tenant owns `checkout` too, and neither of them can tell.
    const theirs = await create(
      { name: 'Checkout', slug: 'checkout' },
      neighbour,
      neighbourOrganizationId,
    );
    expect(theirs.project.slug).toBe('checkout');

    const rows = await database.sql<{ organization_id: string }[]>`
      select organization_id from projects where slug = 'checkout' order by organization_id
    `;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.organization_id))).toEqual(
      new Set([organizationId, neighbourOrganizationId]),
    );
  });

  it('does not create a second project when a request is retried with its key', async () => {
    const headers = { ...as(owner, organizationId), [IdempotencyHeader]: 'integration-retry-01' };
    const payload = { name: 'Retried', slug: 'retried-once' };

    const first = await app.inject({ method: 'POST', url: '/v1/projects', headers, payload });
    const second = await app.inject({ method: 'POST', url: '/v1/projects', headers, payload });

    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
    expect(second.json<CreatedBody>().project.id).toBe(first.json<CreatedBody>().project.id);

    const rows = await database.sql<{ id: string }[]>`
      select id from projects where slug = 'retried-once'
    `;
    expect(rows).toHaveLength(1);
  });

  it('pages by a cursor Postgres ordered, and hides archived projects until asked', async () => {
    const ids: string[] = [];
    for (const name of ['Page One', 'Page Two', 'Page Three']) {
      ids.push((await create({ name, slug: `paged-${String(ids.length)}` })).project.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/projects?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const response = await app.inject({ method: 'GET', url, headers: as(owner, organizationId) });
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json<{ items: { id: string }[]; nextCursor: string | null }>();
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);

    // Every project this tenant has, each exactly once, newest first.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice(0, 3)).toEqual([...ids].reverse());

    const archived = ids[0] ?? '';
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${archived}`,
      headers: as(owner, organizationId),
      payload: { archived: true },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<CreatedBody>().project.archivedAt).not.toBe(null);

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/projects?limit=100',
      headers: as(owner, organizationId),
    });
    const visible = listed.json<{ items: { id: string }[] }>().items.map((item) => item.id);
    expect(visible).not.toContain(archived);

    const all = await app.inject({
      method: 'GET',
      url: '/v1/projects?limit=100&includeArchived=true',
      headers: as(owner, organizationId),
    });
    expect(all.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toContain(
      archived,
    );

    // The archival is audited, in the same transaction as the update.
    const audit = await database.sql<{ metadata_json: { archived?: boolean } }[]>`
      select metadata_json from audit_events
        where target_id = ${archived} and action = 'project.updated'
    `;
    expect(audit.at(-1)?.metadata_json).toMatchObject({ archived: true });
  });

  it('reads back the project with its repository, branches and environments', async () => {
    const created = await create({ name: 'Readable', slug: 'readable' });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${created.project.id}`,
      headers: as(owner, organizationId),
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<ReadBody>();
    expect(body.repository?.id).toBe(created.repository.id);
    expect(body.branches.map((branch) => branch.name)).toEqual(['main']);
    expect(body.environments.map((environment) => environment.name)).toEqual([
      'preview',
      'production',
    ]);
  });

  it('answers the contract route with the newest version, and 404 until there is one', async () => {
    const created = await create({ name: 'Scanned', slug: 'scanned' });

    const before = await app.inject({
      method: 'GET',
      url: `/v1/projects/${created.project.id}/contract`,
      headers: as(owner, organizationId),
    });
    expect(before.statusCode, before.body).toBe(404);
    expect(ApiErrorSchema.parse(before.json()).error.code).toBe('project_contract_not_found');

    // Written directly: plan 05's VF-3 owns the pipeline that produces these,
    // and the read path has to be pinned before it exists.
    for (const version of [1, 2]) {
      await database.db.insert(projectContracts).values({
        id: newId('pc'),
        organizationId,
        projectId: created.project.id,
        version,
        detectedFramework: version === 1 ? 'next' : 'remix',
        contractJson: { version: 1, package_manager: 'pnpm', workspace_root: '.' },
      });
    }

    const after = await app.inject({
      method: 'GET',
      url: `/v1/projects/${created.project.id}/contract`,
      headers: as(owner, organizationId),
    });
    expect(after.statusCode, after.body).toBe(200);
    expect(
      after.json<{ contract: { version: number; detectedFramework: string; contract: unknown } }>()
        .contract,
    ).toMatchObject({
      version: 2,
      detectedFramework: 'remix',
      contract: { version: 1, package_manager: 'pnpm', workspace_root: '.' },
    });
  });

  it('accepts a scan request and records it, without inventing a contract', async () => {
    const created = await create({ name: 'To Scan', slug: 'to-scan' });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${created.project.id}/scan`,
      headers: as(owner, organizationId),
    });

    expect(response.statusCode, response.body).toBe(202);
    // `accepted`: the request was taken, nothing was enqueued (plan 02 CP-6
    // review). A `queued` a worker will never dequeue is a promise, not a status.
    expect(response.json<{ scan: { status: string } }>().scan.status).toBe('accepted');

    const audit = await database.sql<{ action: string }[]>`
      select action from audit_events
        where target_id = ${created.project.id} and action = 'project.scan_requested'
    `;
    expect(audit).toHaveLength(1);

    const contracts = await database.sql<{ id: string }[]>`
      select id from project_contracts where project_id = ${created.project.id}
    `;
    expect(contracts).toEqual([]);
  });
});
