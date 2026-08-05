import { RELEASE_BRANCH_PATTERN, internalRepoRef, newId } from '@zapp/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ForgejoError } from '../src/forgejo/client.js';
import { GitProviderConflictError } from '../src/provider/types.js';
import { DEFAULT_TOKEN_TTL_SECONDS, MAX_TOKEN_TTL_SECONDS } from '../src/tokens.js';
import {
  harness,
  newProject,
  serviceHeaders,
  serviceToken,
  type Harness,
} from './support/harness.js';

/**
 * The service's HTTP surface: who may reach it, what it derives for itself, and
 * what it refuses to tell a caller.
 *
 * Everything here is this codebase's behaviour rather than Forgejo's, which is
 * why the provider is a fake. Forgejo's behaviour — what a 404 means, whether a
 * duplicate create is idempotent — is proved against the real instance in
 * `test/integration/forgejo.test.ts`.
 */

let h: Harness;

beforeEach(() => {
  h = harness();
});

afterEach(async () => {
  await h.app.close();
});

const project = newProject();

describe('the service-token gate', () => {
  it('refuses a request with no token', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/repositories',
      payload: { organizationId: project.organizationId, projectId: project.projectId },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'service_unauthenticated' } });
    // The gate runs before the handler, so nothing about a tenant was touched.
    expect(h.provider.calls).toEqual([]);
  });

  it('refuses a request that carries a user credential, token or not', async () => {
    const token = await serviceToken();

    for (const headers of [
      { ...serviceHeaders(token), authorization: 'Bearer whatever' },
      { ...serviceHeaders(token), cookie: 'zapp_session=abc' },
    ]) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/internal/git/repositories',
        headers,
        payload: { organizationId: project.organizationId, projectId: project.projectId },
      });

      // Refused, not ignored. Ignoring a cookie would let a request a browser
      // sent ambiently succeed on the strength of a header, which is the shape
      // of every CSRF bug — against a service holding a Git admin token.
      expect(response.statusCode).toBe(401);
    }
    expect(h.provider.calls).toEqual([]);
  });

  it('refuses a token minted for another audience', async () => {
    // A credential captured on its way to the control plane's decrypt route is
    // not a credential for this service.
    const token = await serviceToken('sandbox-service', { aud: 'control-api:secrets.decrypt' });

    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/repositories',
      headers: serviceHeaders(token),
      payload: { organizationId: project.organizationId, projectId: project.projectId },
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an expired token', async () => {
    const minutesAgo = new Date(Date.now() - 20 * 60_000);
    const token = await serviceToken('control-api', { now: minutesAgo });

    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/repositories',
      headers: serviceHeaders(token),
      payload: { organizationId: project.organizationId, projectId: project.projectId },
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses the header sent twice', async () => {
    const token = await serviceToken();
    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/repositories',
      // Taking the first is how a request presenting two credentials gets judged
      // on whichever one is not being checked.
      headers: { 'x-zapp-service-token': [token, 'forged'] },
      payload: { organizationId: project.organizationId, projectId: project.projectId },
    });

    expect(response.statusCode).toBe(401);
  });

  it('answers 403 — not 401 — for a verified caller outside the allowlist', async () => {
    const restricted = harness({ callers: ['release-service'] });
    try {
      const response = await restricted.app.inject({
        method: 'POST',
        url: '/internal/git/repositories',
        headers: serviceHeaders(await serviceToken('sandbox-service')),
        payload: { organizationId: project.organizationId, projectId: project.projectId },
      });

      // The caller is authenticated and already knows the route exists; telling
      // it that its *reach* is the problem is what makes a misconfigured
      // deployment debuggable. Decided before the handler, so it learns nothing
      // about the tenant it named.
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'service_not_allowed' } });
      expect(restricted.provider.calls).toEqual([]);
    } finally {
      await restricted.app.close();
    }
  });

  it('leaves /healthz open, and independent of Forgejo', async () => {
    // Infrastructure, not API: a liveness probe that needed a credential is a
    // liveness probe an expired secret takes the service out of rotation with.
    const response = await h.app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(h.provider.calls).toEqual([]);
  });
});

describe('POST /internal/git/repositories', () => {
  it('derives the ref from the ids and protects release branches before answering', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/repositories',
      headers: serviceHeaders(await serviceToken()),
      payload: { organizationId: project.organizationId, projectId: project.projectId },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      internalRepoRef: project.ref,
      cloneUrl: `https://git.test/${project.ref}.git`,
      provisionedAt: '2026-02-01T00:00:00.000Z',
    });

    // Protection is applied *inside* the create, before the caller is told the
    // repository exists: otherwise there is a window in which a new project's
    // release branches are unprotected, exactly as long as it takes something to
    // notice the project.
    expect(h.provider.calls.map((call) => call.method)).toEqual([
      'createRepository',
      'protectBranch',
    ]);
    expect(h.provider.calls[1]?.args).toEqual([project.ref, RELEASE_BRANCH_PATTERN]);
  });

  it('refuses a body that names a repository instead of a project', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/repositories',
      headers: serviceHeaders(await serviceToken()),
      payload: {
        organizationId: project.organizationId,
        projectId: project.projectId,
        // A caller that could name a ref could name *any* ref, and this service
        // holds an admin token. Strict schemas are what make that unexpressible
        // rather than merely discouraged.
        internalRepoRef: 'org_01j8me7yqzj2v9q0x3t5b6k7n9/proj_01j8me7yqzj2v9q0x3t5b6k7na',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(h.provider.calls).toEqual([]);
  });

  it('refuses ids of the wrong entity', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/repositories',
      headers: serviceHeaders(await serviceToken()),
      payload: { organizationId: newId('proj'), projectId: newId('org') },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('never lets provider text reach the caller', async () => {
    const leak = 'token 0123456789abcdef0123456789abcdef01234567';
    h.provider.failNext('createRepository', new ForgejoError('POST', '/orgs/x/repos', 500, leak));

    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/repositories',
      headers: serviceHeaders(await serviceToken()),
      payload: { organizationId: project.organizationId, projectId: project.projectId },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'git_provider_failed' } });
    // A Forgejo error quotes the request that failed, and that request carries
    // our admin token. The body says what happened and nothing about why.
    expect(response.body).not.toContain(leak);
    expect(response.body).not.toContain('0123456789abcdef');
  });

  it('reports a conflict the caller can act on as a conflict', async () => {
    h.provider.failNext(
      'createRepository',
      new GitProviderConflictError('tag rel_1 already exists at a different commit'),
    );

    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/repositories',
      headers: serviceHeaders(await serviceToken()),
      payload: { organizationId: project.organizationId, projectId: project.projectId },
    });

    // 409 rather than 502: this message is ours, written for the caller, and the
    // caller is the thing that can fix it.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'git_conflict' } });
  });
});

describe('the read routes', () => {
  it('answers a branch, and 404 for one that has never been pushed to', async () => {
    const url = `/internal/git/repositories/${project.organizationId}/${project.projectId}/branches?name=main`;
    const headers = serviceHeaders(await serviceToken());

    const found = await h.app.inject({ method: 'GET', url, headers });
    expect(found.json()).toEqual({ name: 'main', headSha: 'a'.repeat(40) });

    h.provider.branch = undefined;
    const missing = await h.app.inject({ method: 'GET', url, headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'branch_not_found' } });
  });

  it('reads a branch name containing a slash', async () => {
    // `release/1` is the shape every protected branch has, and an unescaped one
    // is a different API path.
    await h.app.inject({
      method: 'GET',
      url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/branches?name=release%2F1`,
      headers: serviceHeaders(await serviceToken()),
    });

    expect(h.provider.calls.at(-1)?.args).toEqual([project.ref, 'release/1']);
  });

  it('pages commits by asking for one more than it returns', async () => {
    h.provider.commits = Array.from({ length: 5 }, (_unused, index) => ({
      sha: String(index).repeat(40).slice(0, 40),
      message: `commit ${String(index)}`,
      authorName: 'a',
      authorEmail: 'a@b.c',
      committedAt: new Date('2026-02-01T00:00:00.000Z'),
    }));

    const response = await h.app.inject({
      method: 'GET',
      url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/commits?branch=main&limit=2`,
      headers: serviceHeaders(await serviceToken()),
    });

    const body = response.json<{ items: { sha: string }[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(2);
    // The extra row's presence is the whole of "there is another page", and
    // asking that way costs one commit rather than a count.
    expect(h.provider.calls.at(-1)?.args[2]).toEqual({ limit: 3 });

    // The cursor is the **third** commit — the first of the next page — not the
    // last one returned. Git history is walked from a commit *inclusively*
    // (verified against Forgejo 9.0.3), unlike the control plane's keyset
    // cursors, which are exclusive `lt(id, cursor)` bounds. Handing back the
    // last returned sha here would repeat it on every page boundary.
    expect(body.nextCursor).toBe(h.provider.commits[2]?.sha);
    expect(body.items.map((item) => item.sha)).not.toContain(body.nextCursor);
  });

  it('follows its own cursor without skipping or repeating a commit', async () => {
    const commits = Array.from({ length: 4 }, (_unused, index) => ({
      sha: String(index).repeat(40).slice(0, 40),
      message: `commit ${String(index)}`,
      authorName: 'a',
      authorEmail: 'a@b.c',
      committedAt: new Date('2026-02-01T00:00:00.000Z'),
    }));
    h.provider.commits = commits;
    const headers = serviceHeaders(await serviceToken());
    const base = `/internal/git/repositories/${project.organizationId}/${project.projectId}/commits?branch=main&limit=2`;

    const first = (await h.app.inject({ method: 'GET', url: base, headers })).json<{
      items: { sha: string }[];
      nextCursor: string;
    }>();

    // The fake answers from the head of its list, so the second page is
    // simulated by dropping what the first page consumed — which is what an
    // inclusive cursor at `nextCursor` would ask Forgejo for.
    h.provider.commits = commits.slice(2);
    const second = (
      await h.app.inject({ method: 'GET', url: `${base}&before=${first.nextCursor}`, headers })
    ).json<{ items: { sha: string }[]; nextCursor: string | null }>();

    expect(first.items.map((item) => item.sha)).toEqual([commits[0]?.sha, commits[1]?.sha]);
    // The cursor commit is the first item of page two: inclusive, so it appears
    // exactly once across the two pages.
    expect(second.items.map((item) => item.sha)).toEqual([commits[2]?.sha, commits[3]?.sha]);
    expect(second.nextCursor).toBeNull();
    expect(h.provider.calls.at(-1)?.args[2]).toEqual({ limit: 3, before: first.nextCursor });
  });

  it('reports the last page as an explicit null cursor', async () => {
    h.provider.commits = [
      {
        sha: 'b'.repeat(40),
        message: 'only',
        authorName: 'a',
        authorEmail: 'a@b.c',
        committedAt: new Date('2026-02-01T00:00:00.000Z'),
      },
    ];

    const response = await h.app.inject({
      method: 'GET',
      url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/commits?branch=main&limit=10`,
      headers: serviceHeaders(await serviceToken()),
    });

    // Never absent: "the field is missing" must not be readable as "no more
    // results" (FND-10).
    expect(response.json()).toMatchObject({ nextCursor: null });
  });

  it('refuses a cursor that is not a resolved commit', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/commits?branch=main&before=HEAD~3`,
      headers: serviceHeaders(await serviceToken()),
    });

    expect(response.statusCode).toBe(400);
  });

  it('answers a commit with a diffstat and no file contents', async () => {
    h.provider.commit = {
      sha: 'c'.repeat(40),
      message: 'fix',
      authorName: 'a',
      authorEmail: 'a@b.c',
      committedAt: new Date('2026-02-01T00:00:00.000Z'),
      parents: ['d'.repeat(40)],
      additions: 3,
      deletions: 1,
      changedFiles: 2,
    };

    const response = await h.app.inject({
      method: 'GET',
      url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/commits/${'c'.repeat(40)}`,
      headers: serviceHeaders(await serviceToken()),
    });

    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ additions: 3, deletions: 1, changedFiles: 2 });
    // Counts, never contents: this ends up in events and in release evidence,
    // and a patch body would put a customer's source in both.
    expect(Object.keys(body)).not.toContain('files');
    expect(Object.keys(body)).not.toContain('patch');
  });
});

describe('the write routes', () => {
  it('cuts a branch from a resolved sha and refuses a ref', async () => {
    const url = `/internal/git/repositories/${project.organizationId}/${project.projectId}/branches`;
    const headers = serviceHeaders(await serviceToken());

    const created = await h.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { name: 'release/1', fromSha: 'e'.repeat(40) },
    });
    expect(created.statusCode).toBe(201);
    expect(h.provider.calls.at(-1)?.args).toEqual([project.ref, 'release/1', 'e'.repeat(40)]);

    // A branch cut from a moving target is a race, and a release cut from one is
    // a release nobody can reproduce.
    const refused = await h.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { name: 'release/2', fromSha: 'main' },
    });
    expect(refused.statusCode).toBe(400);
  });

  it('tags a resolved sha', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/tags`,
      headers: serviceHeaders(await serviceToken()),
      payload: { tag: 'rel_01j8me7yqzj2v9q0x3t5b6k7n9', sha: 'f'.repeat(40) },
    });

    expect(response.statusCode).toBe(201);
    expect(h.provider.calls.at(-1)?.args).toEqual([
      project.ref,
      'rel_01j8me7yqzj2v9q0x3t5b6k7n9',
      'f'.repeat(40),
    ]);
  });

  it('deletes by project, deriving the ref', async () => {
    const other = newProject();
    const response = await h.app.inject({
      method: 'DELETE',
      url: `/internal/git/repositories/${other.organizationId}/${other.projectId}`,
      headers: serviceHeaders(await serviceToken()),
    });

    expect(response.statusCode).toBe(204);
    expect(h.provider.calls.at(-1)?.args).toEqual([
      internalRepoRef({ organizationId: other.organizationId, projectId: other.projectId }),
    ]);
  });
});

describe('POST /internal/git/tokens', () => {
  it('rejects a caller-controlled reason as an unknown field', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/tokens',
      headers: serviceHeaders(await serviceToken('sandbox-service')),
      payload: {
        organizationId: project.organizationId,
        projectId: project.projectId,
        access: 'write',
        reason: 'sentinel-token-value-must-never-enter-audit',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed' } });
    expect(h.tokens.calls).toEqual([]);
  });

  it('mints from the verified caller, not from the body', async () => {
    const runId = newId('run');
    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/tokens',
      headers: serviceHeaders(await serviceToken('sandbox-service')),
      payload: {
        organizationId: project.organizationId,
        projectId: project.projectId,
        access: 'write',
        ttlSec: 120,
        runId,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      token: 'forgejo-token-value',
      username: 'zt-1900000000-0123456789ab',
      expiresAt: '2026-02-01T00:05:00.000Z',
    });
    // The audit row's actor comes from the signature. A caller cannot claim a
    // credential was some other service's doing.
    expect(h.tokens.calls.at(-1)?.args[0]).toMatchObject({
      organizationId: project.organizationId,
      projectId: project.projectId,
      access: 'write',
      ttlSec: 120,
      requestingService: 'sandbox-service',
      runId,
    });
  });

  it('defaults the TTL and refuses one over the ceiling', async () => {
    const headers = serviceHeaders(await serviceToken());
    const body = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      access: 'read',
    };

    await h.app.inject({ method: 'POST', url: '/internal/git/tokens', headers, payload: body });
    expect(h.tokens.calls.at(-1)?.args[0]).toMatchObject({ ttlSec: DEFAULT_TOKEN_TTL_SECONDS });

    const tooLong = await h.app.inject({
      method: 'POST',
      url: '/internal/git/tokens',
      headers,
      payload: { ...body, ttlSec: MAX_TOKEN_TTL_SECONDS + 1 },
    });
    // A 400 naming the field, not a 500 from a thrown Error: the bound is part
    // of the contract, so it belongs in the schema as well as in the service.
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('refuses an access level that is not read or write', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/tokens',
      headers: serviceHeaders(await serviceToken()),
      payload: {
        organizationId: project.organizationId,
        projectId: project.projectId,
        access: 'admin',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(h.tokens.calls).toEqual([]);
  });

  it('tells nothing between here and the caller to keep the response', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/tokens',
      headers: serviceHeaders(await serviceToken()),
      payload: {
        organizationId: project.organizationId,
        projectId: project.projectId,
        access: 'read',
      },
    });

    // The body is a credential — the one response in this service that is.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('needs a service token like every other route', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/tokens',
      payload: {
        organizationId: project.organizationId,
        projectId: project.projectId,
        access: 'write',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(h.tokens.calls).toEqual([]);
  });
});

describe('the revoke and sweep routes', () => {
  it('rejects a caller-controlled revoke reason as an unknown field', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/tokens/revoke',
      headers: serviceHeaders(await serviceToken('control-api')),
      payload: {
        organizationId: project.organizationId,
        projectId: project.projectId,
        reason: 'sentinel-token-value-must-never-enter-audit',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed' } });
    expect(h.tokens.calls).toEqual([]);
  });

  it('revokes every outstanding grant for a project', async () => {
    h.tokens.revoked = 3;

    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/tokens/revoke',
      headers: serviceHeaders(await serviceToken('control-api')),
      payload: {
        organizationId: project.organizationId,
        projectId: project.projectId,
      },
    });

    expect(response.json()).toEqual({ revoked: 3 });
    expect(h.tokens.calls.at(-1)).toMatchObject({
      method: 'revokeForProject',
      args: [
        {
          organizationId: project.organizationId,
          projectId: project.projectId,
          requestingService: 'control-api',
        },
      ],
    });
  });

  it('sweeps expired grants', async () => {
    h.tokens.revoked = 7;

    const response = await h.app.inject({
      method: 'POST',
      url: '/internal/git/tokens/sweep',
      headers: serviceHeaders(await serviceToken()),
    });

    // What makes "short-lived" true: Forgejo has no expiring token, so a
    // deadline is only a deadline if something enforces it.
    expect(response.json()).toEqual({ revoked: 7 });
    expect(h.tokens.calls.at(-1)?.method).toBe('sweepExpired');
  });

  it('does not expose the sweep to an unauthenticated caller', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/internal/git/tokens/sweep' });
    expect(response.statusCode).toBe(401);
  });
});
