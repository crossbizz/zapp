import { internalRepoRef, newId } from '@zapp/contracts';
import { describe, expect, it } from 'vitest';

import { ForgejoError } from '../src/forgejo/client.js';
import { createForgejoGitProvider } from '../src/provider/forgejo.js';
import { GitProviderConflictError } from '../src/provider/types.js';
import { createFakeForgejo, type Route } from './support/fake-forgejo.js';

/**
 * The provider's own decisions, against a scripted Forgejo.
 *
 * What is worth testing here is exactly what is *not* a straight passthrough:
 * which writes are skipped because a read already answered, which conflict
 * statuses are tolerated, and which one is refused. Whether Forgejo really
 * answers 403 to a duplicate branch-protection rule is not this file's business
 * — `test/integration/forgejo.test.ts` asks the real instance.
 */

const ORGANIZATION = newId('org');
const PROJECT = newId('proj');
const REF = internalRepoRef({ organizationId: ORGANIZATION, projectId: PROJECT });
const [OWNER, NAME] = REF.split('/') as [string, string];
const SHA = 'a'.repeat(40);
const NOW = new Date('2026-03-01T00:00:00.000Z');

const REPO_BODY = {
  clone_url: `https://git.test/${REF}.git`,
  created_at: '2026-02-14T10:00:00Z',
  default_branch: 'main',
  empty: true,
};

function provider(routes: Record<string, Route>) {
  const forgejo = createFakeForgejo(routes);
  return { forgejo, git: createForgejoGitProvider({ client: forgejo, now: () => NOW }) };
}

/** An instance where the tenant's organization and repository both already exist. */
function existing(): Record<string, Route> {
  return {
    [`GET /orgs/${OWNER}`]: { status: 200, body: { username: OWNER } },
    [`GET /repos/${OWNER}/${NAME}`]: { status: 200, body: REPO_BODY },
  };
}

describe('createRepository', () => {
  it('creates the tenant organization on the first project, and the repository under it', async () => {
    const { forgejo, git } = provider({
      'POST /orgs': { status: 201, body: {} },
      [`POST /orgs/${OWNER}/repos`]: { status: 201, body: REPO_BODY },
    });

    const created = await git.createRepository({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      defaultBranch: 'main',
    });

    expect(created.internalRepoRef).toBe(REF);
    expect(created.cloneUrl).toBe(REPO_BODY.clone_url);
    // Forgejo's creation time, not ours: `repositories.provisioned_at` answers
    // "when did this start existing", and on a retry the answer is the first
    // attempt's.
    expect(created.provisionedAt).toEqual(new Date(REPO_BODY.created_at));

    const org = forgejo.writes.find((call) => call.path === '/orgs');
    // Private, always: a public organization lists its repositories to every
    // authenticated user of the instance, including other tenants' ephemeral
    // scoped users (GIT-3).
    expect(org?.body).toMatchObject({ username: OWNER, visibility: 'private' });

    const repo = forgejo.writes.find((call) => call.path === `/orgs/${OWNER}/repos`);
    expect(repo?.body).toMatchObject({ name: NAME, private: true, auto_init: false });
  });

  it('does not seed an initial commit', async () => {
    const { forgejo, git } = provider({
      'POST /orgs': { status: 201, body: {} },
      [`POST /orgs/${OWNER}/repos`]: { status: 201, body: REPO_BODY },
    });

    await git.createRepository({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      defaultBranch: 'main',
    });

    // The control plane writes `branches.head_commit_sha` as null at creation
    // (CP-6) and the workspace service reports the first commit. A README
    // committed here would put those two out of step from the moment the project
    // exists — and would put a file in the customer's history they did not write.
    expect(forgejo.writes.at(-1)?.body).toMatchObject({ auto_init: false });
  });

  it('is idempotent: an existing repository is returned, not recreated', async () => {
    const { forgejo, git } = provider(existing());

    const created = await git.createRepository({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      defaultBranch: 'main',
    });

    expect(created.internalRepoRef).toBe(REF);
    // This call happens *inside* the transaction that creates the project row,
    // so a retry after a lost response must not be the thing that makes the
    // project uncreatable.
    expect(forgejo.writes).toEqual([]);
  });

  it('reads back a repository another caller created between the check and the create', async () => {
    const { forgejo, git } = provider({
      [`GET /orgs/${OWNER}`]: { status: 200, body: {} },
      // Absent when we look, present by the time we write: the race two
      // concurrent project creates produce.
      [`GET /repos/${OWNER}/${NAME}`]: { status: 404, then: { status: 200, body: REPO_BODY } },
      [`POST /orgs/${OWNER}/repos`]: { status: 409 },
    });

    const created = await git.createRepository({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      defaultBranch: 'main',
    });

    // Read back rather than assumed: the conflicting create returns no body, and
    // inventing a clone URL would put a guess on a `repositories` row.
    expect(created.cloneUrl).toBe(REPO_BODY.clone_url);
    expect(forgejo.calls.filter((call) => call.path === `/repos/${OWNER}/${NAME}`)).toHaveLength(2);
  });

  it('refuses a 2xx that carries no clone URL rather than storing undefined', async () => {
    const { git } = provider({
      [`GET /orgs/${OWNER}`]: { status: 200, body: {} },
      [`GET /repos/${OWNER}/${NAME}`]: { status: 404 },
      [`POST /orgs/${OWNER}/repos`]: { status: 201, body: { created_at: '2026-02-14T10:00:00Z' } },
    });

    await expect(
      git.createRepository({
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        defaultBranch: 'main',
      }),
    ).rejects.toThrow(/clone_url/);
  });

  it('lets a transport failure through rather than reading it as "not there"', async () => {
    const { git } = provider({
      [`GET /orgs/${OWNER}`]: { error: new ForgejoError('GET', `/orgs/${OWNER}`, 0, 'transport') },
    });

    // A 404 means the thing is not there; a 0 means we could not tell — which is
    // not a state to create over.
    await expect(
      git.createRepository({
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        defaultBranch: 'main',
      }),
    ).rejects.toBeInstanceOf(ForgejoError);
  });
});

describe('getBranch', () => {
  it('reports an unborn default branch as absent rather than as an error', async () => {
    const { git } = provider({ [`GET /repos/${OWNER}/${NAME}/branches/main`]: { status: 404 } });

    // Which is what every project's `main` is until its first commit.
    expect(await git.getBranch(REF, 'main')).toBeUndefined();
  });

  it('escapes a branch name containing a slash', async () => {
    const { forgejo, git } = provider({
      [`GET /repos/${OWNER}/${NAME}/branches/release%2F1`]: {
        status: 200,
        body: { name: 'release/1', commit: { id: SHA } },
      },
    });

    expect(await git.getBranch(REF, 'release/1')).toEqual({ name: 'release/1', headSha: SHA });
    expect(forgejo.calls.at(-1)?.path).toContain('release%2F1');
  });
});

describe('compareCommits', () => {
  it('bounds UTF-8 patches and file metadata from the exact Forgejo comparison', async () => {
    const after = 'b'.repeat(40);
    const patch = '🙂'.repeat(300_000);
    const { forgejo, git } = provider({
      [`GET /repos/${OWNER}/${NAME}/compare/${SHA}...${after}`]: {
        status: 200,
        body: {
          files: [{ filename: 'src/index.ts', status: 'modified', additions: 2, deletions: 1, patch }],
        },
      },
    });

    const result = await git.compareCommits(REF, SHA, after);

    expect(result).toMatchObject({
      beforeSha: SHA,
      afterSha: after,
      changedFiles: 1,
      filesTruncated: false,
      patchTruncated: true,
    });
    expect(Buffer.byteLength(result?.patch ?? '', 'utf8')).toBeLessThanOrEqual(1_048_576);
    expect(result?.patch.endsWith('🙂')).toBe(true);
    expect(forgejo.calls.at(-1)?.path).toBe(`/repos/${OWNER}/${NAME}/compare/${SHA}...${after}`);
  });
});

describe('createBranch', () => {
  it('tolerates a branch that already points at the requested commit', async () => {
    const { git } = provider({
      [`POST /repos/${OWNER}/${NAME}/branches`]: { status: 409 },
      [`GET /repos/${OWNER}/${NAME}/branches/release%2F1`]: {
        status: 200,
        body: { name: 'release/1', commit: { id: SHA } },
      },
    });

    await expect(git.createBranch(REF, 'release/1', SHA)).resolves.toBeUndefined();
  });

  it('refuses a branch of the same name at a different commit', async () => {
    const { git } = provider({
      [`POST /repos/${OWNER}/${NAME}/branches`]: { status: 409 },
      [`GET /repos/${OWNER}/${NAME}/branches/release%2F1`]: {
        status: 200,
        body: { name: 'release/1', commit: { id: 'b'.repeat(40) } },
      },
    });

    // Reporting success would tell a caller its code is somewhere it is not.
    await expect(git.createBranch(REF, 'release/1', SHA)).rejects.toBeInstanceOf(
      GitProviderConflictError,
    );
  });
});

describe('protectBranch', () => {
  it('leaves an existing rule exactly as it is', async () => {
    const { forgejo, git } = provider({
      [`GET /repos/${OWNER}/${NAME}/branch_protections/release%2F*`]: {
        status: 200,
        body: { rule_name: 'release/*' },
      },
    });

    await git.protectBranch(REF, 'release/*');

    // Re-applying would overwrite a rule an operator may have tightened. The
    // job is "make sure it is protected", not "make sure it is protected the way
    // I would have".
    expect(forgejo.writes).toEqual([]);
  });

  it('refuses every push rather than only force-pushes', async () => {
    const { forgejo, git } = provider({
      [`GET /repos/${OWNER}/${NAME}/branch_protections/release%2F*`]: { status: 404 },
      [`POST /repos/${OWNER}/${NAME}/branch_protections`]: { status: 201, body: {} },
    });

    await git.protectBranch(REF, 'release/*');

    // A release branch records what was released; a commit landing on it
    // afterwards makes the release evidence describe code that is no longer
    // there.
    expect(forgejo.writes[0]?.body).toMatchObject({ rule_name: 'release/*', enable_push: false });
  });
});

describe('listCommits', () => {
  it('reads an unknown branch as no commits', async () => {
    // The fake answers 404 for anything unrouted, which is what Forgejo answers
    // for a branch that is not there.
    const { git } = provider({});

    expect(await git.listCommits(REF, 'main', { limit: 10 })).toEqual([]);
  });

  it('reads an empty repository as no commits, which is a different status', async () => {
    // 409 "Git Repository is empty", not 404 — caught by the integration suite
    // rather than guessed here. Every zapp project is empty from creation until
    // its first run pushes, so reading this as an error made a freshly created
    // project look broken to its own first caller.
    const { git } = provider({
      [`GET /repos/${OWNER}/${NAME}/commits?sha=main&limit=10&stat=false&verification=false&files=false`]:
        { status: 409 },
    });

    expect(await git.listCommits(REF, 'main', { limit: 10 })).toEqual([]);
  });

  it('still lets a real failure through', async () => {
    const { git } = provider({
      [`GET /repos/${OWNER}/${NAME}/commits?sha=main&limit=10&stat=false&verification=false&files=false`]:
        { status: 500 },
    });

    // "No commits" is an answer for an empty history and for nothing else: a
    // Git host that is broken must not read as a project with no history.
    await expect(git.listCommits(REF, 'main', { limit: 10 })).rejects.toBeInstanceOf(ForgejoError);
  });

  it('walks from the cursor rather than from the branch head', async () => {
    const { forgejo, git } = provider({
      [`GET /repos/${OWNER}/${NAME}/commits?sha=${SHA}&limit=10&stat=false&verification=false&files=false`]:
        { status: 200, body: [] },
    });

    await git.listCommits(REF, 'main', { limit: 10, before: SHA });

    // Keyset: the cursor is a commit rather than an offset, which is the only
    // form that stays correct while history is being written.
    expect(forgejo.calls.at(-1)?.path).toContain(`sha=${SHA}`);
  });

  it('takes the committer date, not the author date', async () => {
    const { git } = provider({
      [`GET /repos/${OWNER}/${NAME}/commits?sha=main&limit=1&stat=false&verification=false&files=false`]:
        {
          status: 200,
          body: [
            {
              sha: SHA,
              commit: {
                message: 'x',
                author: { name: 'A', email: 'a@b.c', date: '1999-01-01T00:00:00Z' },
                committer: { name: 'C', email: 'c@b.c', date: '2026-02-14T10:00:00Z' },
              },
            },
          ],
        },
    });

    const [commit] = await git.listCommits(REF, 'main', { limit: 1 });
    // An author date is metadata a commit carries from wherever it was written
    // and can be any value at all; the committer date is when this history came
    // to be.
    expect(commit?.committedAt).toEqual(new Date('2026-02-14T10:00:00Z'));
  });
});

describe('createTag', () => {
  it('tolerates a tag that already points at the same commit', async () => {
    const { git } = provider({
      [`POST /repos/${OWNER}/${NAME}/tags`]: { status: 409 },
      [`GET /repos/${OWNER}/${NAME}/tags/rel_1`]: { status: 200, body: { commit: { sha: SHA } } },
    });

    await expect(git.createTag(REF, 'rel_1', SHA)).resolves.toBeUndefined();
  });

  it('refuses to move a tag that points somewhere else', async () => {
    const { git } = provider({
      [`POST /repos/${OWNER}/${NAME}/tags`]: { status: 409 },
      [`GET /repos/${OWNER}/${NAME}/tags/rel_1`]: {
        status: 200,
        body: { commit: { sha: 'b'.repeat(40) } },
      },
    });

    // Master plan §Global Constraints: a production release references an exact
    // SHA. Moving the tag would make an existing release's evidence describe
    // code that was never released.
    await expect(git.createTag(REF, 'rel_1', SHA)).rejects.toBeInstanceOf(GitProviderConflictError);
  });
});

describe('every method', () => {
  it('refuses a ref this system did not derive', async () => {
    const { forgejo, git } = provider({});

    await expect(git.deleteRepository('org_x/../../etc/passwd')).rejects.toThrow(
      /Invalid internal repository ref/,
    );
    // Refused before a request is made: a ref is interpolated into an API path,
    // and this service's client carries the admin token.
    expect(forgejo.calls).toEqual([]);
  });
});
