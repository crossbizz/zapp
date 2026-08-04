import { RELEASE_BRANCH_PATTERN, internalRepoRef, newId } from '@zapp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ForgejoClient } from '../../src/forgejo/client.js';
import { createForgejoGitProvider } from '../../src/provider/forgejo.js';
import { GitProviderConflictError, type GitProvider } from '../../src/provider/types.js';
import {
  adminToken,
  credentialUrl,
  eventually,
  git,
  hasForgejo,
  integrationClient,
  removeWorkspace,
  workspace,
} from './helpers.js';

/**
 * The Forgejo provider, against a real Forgejo (plan 06 GIT-2).
 *
 * `test/provider.test.ts` proves what this codebase decides — which writes are
 * skipped, which conflicts are tolerated. This file proves the half no fake can:
 * that the repository exists afterwards, that it is *private*, that a clone URL
 * works, and that `release/*` protection actually refuses a push. Those are
 * claims about Forgejo, and a scripted client asserting them would only be
 * asserting what we believed while writing it.
 *
 * Skips loudly without the dev stack — see `helpers.ts`.
 */

describe.skipIf(!hasForgejo)('the Forgejo provider, against a real instance', () => {
  let client: ForgejoClient;
  let provider: GitProvider;
  /** Organizations this suite created, removed in `afterAll` and nothing else. */
  const created: { organizationId: string; projectId: string }[] = [];

  function project(): { organizationId: string; projectId: string; ref: string } {
    const organizationId = newId('org');
    const projectId = newId('proj');
    created.push({ organizationId, projectId });
    return { organizationId, projectId, ref: internalRepoRef({ organizationId, projectId }) };
  }

  beforeAll(() => {
    client = integrationClient();
    provider = createForgejoGitProvider({ client });
  });

  afterAll(async () => {
    // Deletes only what this suite made. The dev instance belongs to a
    // developer, and a test that tidied up more than it created would be a test
    // that deleted their work.
    // Repositories first, then organizations: Forgejo answers a delete of an
    // organization that still owns one with a 500.
    for (const { organizationId, projectId } of created) {
      const [owner, name] = internalRepoRef({ organizationId, projectId }).split('/') as [
        string,
        string,
      ];
      await client.send({ method: 'DELETE', path: `/repos/${owner}/${name}`, allow: [404] });
    }
    for (const owner of new Set(created.map((entry) => entry.organizationId.toLowerCase()))) {
      await client.send({ method: 'DELETE', path: `/orgs/${owner}`, allow: [404] });
    }
  });

  it('creates a private, empty repository under a per-tenant organization', async () => {
    const { organizationId, projectId, ref } = project();

    const repository = await provider.createRepository({
      organizationId,
      projectId,
      defaultBranch: 'main',
    });

    expect(repository.internalRepoRef).toBe(ref);
    expect(repository.cloneUrl).toContain(ref);
    // Not a guess: the row this lands on (`repositories.provisioned_at`) is what
    // says a clone would now succeed, and the assertions below are that claim
    // being checked.
    expect(repository.provisionedAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);

    const [owner, name] = ref.split('/') as [string, string];
    const details = await client.send<{
      private?: boolean;
      empty?: boolean;
      default_branch?: string;
    }>({ method: 'GET', path: `/repos/${owner}/${name}` });
    // Private, and empty: the control plane writes `branches.head_commit_sha` as
    // null at creation (CP-6), so a seeded README here would put the two out of
    // step from the moment the project exists.
    expect(details.body).toMatchObject({ private: true, empty: true, default_branch: 'main' });

    const org = await client.send<{ visibility?: string }>({
      method: 'GET',
      path: `/orgs/${owner}`,
    });
    // The organization was created lazily by this call, and privately: a public
    // one lists its repositories to every authenticated user of the instance.
    expect(org.body?.visibility).toBe('private');
  });

  it('is idempotent — a second create returns the same repository', async () => {
    const { organizationId, projectId } = project();
    const input = { organizationId, projectId, defaultBranch: 'main' } as const;

    const first = await provider.createRepository(input);
    const second = await provider.createRepository(input);

    // This runs inside the transaction that creates the project row, so a retry
    // after a lost response must not be what makes the project uncreatable.
    expect(second.internalRepoRef).toBe(first.internalRepoRef);
    expect(second.cloneUrl).toBe(first.cloneUrl);
    // The *first* attempt's creation time, not the retry's.
    expect(second.provisionedAt).toEqual(first.provisionedAt);
  });

  it('reports an unborn default branch as absent, then as a head once something pushes', async () => {
    const { organizationId, projectId, ref } = project();
    const repository = await provider.createRepository({
      organizationId,
      projectId,
      defaultBranch: 'main',
    });

    // Before the first push: `main` is the repository's HEAD and has no commit,
    // which is what every zapp project looks like until its first run.
    expect(await provider.getBranch(ref, 'main')).toBeUndefined();

    const dir = await workspace();
    try {
      const url = credentialUrl(repository.cloneUrl, 'zapp-admin-token', adminToken());
      expect((await git(dir, 'clone', url, 'repo')).ok).toBe(true);
      const repo = `${dir}/repo`;
      await git(repo, 'config', 'user.email', 'suite@zapp.test');
      await git(repo, 'config', 'user.name', 'zapp suite');
      expect((await git(repo, 'commit', '--allow-empty', '-m', 'first')).ok).toBe(true);
      expect((await git(repo, 'push', 'origin', 'HEAD:main')).ok).toBe(true);

      // Polled, not slept on: Forgejo processes a push asynchronously, and the
      // provider deliberately reports what the API says rather than papering
      // over the lag.
      const branch = await eventually(() => provider.getBranch(ref, 'main'), 'main to appear');
      const head = (await git(repo, 'rev-parse', 'HEAD')).output.trim();
      expect(branch.headSha).toBe(head);

      const commits = await provider.listCommits(ref, 'main', { limit: 10 });
      expect(commits[0]).toMatchObject({ sha: head, message: 'first\n' });

      const detail = await provider.getCommit(ref, head);
      // A diffstat, and no file contents: this crosses a service boundary and
      // ends up in release evidence.
      expect(detail).toMatchObject({ sha: head, additions: 0, deletions: 0, changedFiles: 0 });
      expect(detail?.parents).toEqual([]);

      await provider.createTag(ref, 'rel_01j8me7yqzj2v9q0x3t5b6k7n9', head);
      // Same tag, same commit: the retry the release service will make.
      await expect(
        provider.createTag(ref, 'rel_01j8me7yqzj2v9q0x3t5b6k7n9', head),
      ).resolves.toBeUndefined();

      // A second commit, so there is somewhere else for the tag to point.
      expect((await git(repo, 'commit', '--allow-empty', '-m', 'second')).ok).toBe(true);
      expect((await git(repo, 'push', 'origin', 'HEAD:main')).ok).toBe(true);
      const moved = (await git(repo, 'rev-parse', 'HEAD')).output.trim();
      await eventually(
        async () => ((await provider.getBranch(ref, 'main'))?.headSha === moved ? true : undefined),
        'main to advance',
      );

      // Master plan §Global Constraints: a production release references an
      // exact SHA. Moving the tag would make an existing release's evidence
      // describe code that was never released.
      await expect(
        provider.createTag(ref, 'rel_01j8me7yqzj2v9q0x3t5b6k7n9', moved),
      ).rejects.toBeInstanceOf(GitProviderConflictError);
    } finally {
      await removeWorkspace(dir);
    }
  }, 120_000);

  it('protects release branches against a push, and is idempotent about the rule', async () => {
    const { organizationId, projectId, ref } = project();
    const repository = await provider.createRepository({
      organizationId,
      projectId,
      defaultBranch: 'main',
    });

    await provider.protectBranch(ref, RELEASE_BRANCH_PATTERN);
    // Applied twice on purpose: every project create calls this, and a rule that
    // was replaced each time would discard whatever an operator had tightened.
    await provider.protectBranch(ref, RELEASE_BRANCH_PATTERN);

    const [owner, name] = ref.split('/') as [string, string];
    const rules = await client.send<{ rule_name?: string }[]>({
      method: 'GET',
      path: `/repos/${owner}/${name}/branch_protections`,
    });
    expect((rules.body ?? []).map((rule) => rule.rule_name)).toEqual([RELEASE_BRANCH_PATTERN]);

    const dir = await workspace();
    try {
      const url = credentialUrl(repository.cloneUrl, 'zapp-admin-token', adminToken());
      await git(dir, 'clone', url, 'repo');
      const repo = `${dir}/repo`;
      await git(repo, 'config', 'user.email', 'suite@zapp.test');
      await git(repo, 'config', 'user.name', 'zapp suite');
      await git(repo, 'commit', '--allow-empty', '-m', 'first');
      expect((await git(repo, 'push', 'origin', 'HEAD:main')).ok).toBe(true);

      // The property PRD §19.1 asks for, demonstrated by the server refusing:
      // `release/*` takes no push at all, so a release branch cannot acquire a
      // commit after the release that recorded it.
      const refused = await git(repo, 'push', 'origin', 'HEAD:release/1');
      expect(refused.ok).toBe(false);
      expect(refused.output).toMatch(/protected|pre-receive hook declined|rejected/i);

      // And an unprotected branch still takes one, which is what makes the
      // refusal above about the rule rather than about the credential.
      expect((await git(repo, 'push', 'origin', 'HEAD:feature/x')).ok).toBe(true);
    } finally {
      await removeWorkspace(dir);
    }
  }, 120_000);

  it('cuts a branch from an exact commit and refuses to move an existing one', async () => {
    const { organizationId, projectId, ref } = project();
    const repository = await provider.createRepository({
      organizationId,
      projectId,
      defaultBranch: 'main',
    });

    const dir = await workspace();
    try {
      const url = credentialUrl(repository.cloneUrl, 'zapp-admin-token', adminToken());
      await git(dir, 'clone', url, 'repo');
      const repo = `${dir}/repo`;
      await git(repo, 'config', 'user.email', 'suite@zapp.test');
      await git(repo, 'config', 'user.name', 'zapp suite');
      await git(repo, 'commit', '--allow-empty', '-m', 'one');
      const first = (await git(repo, 'rev-parse', 'HEAD')).output.trim();
      await git(repo, 'commit', '--allow-empty', '-m', 'two');
      const second = (await git(repo, 'rev-parse', 'HEAD')).output.trim();
      await git(repo, 'push', 'origin', 'HEAD:main');
      await eventually(() => provider.getBranch(ref, 'main'), 'main to appear');

      await provider.createBranch(ref, 'work/a', first);
      expect(await provider.getBranch(ref, 'work/a')).toMatchObject({ headSha: first });

      // The same request again is the retry we tolerate.
      await expect(provider.createBranch(ref, 'work/a', first)).resolves.toBeUndefined();
      // A different commit under the same name is not: reporting success would
      // tell the caller its code is somewhere it is not.
      await expect(provider.createBranch(ref, 'work/a', second)).rejects.toBeInstanceOf(
        GitProviderConflictError,
      );
    } finally {
      await removeWorkspace(dir);
    }
  }, 120_000);

  it('deletes a repository, and deleting a missing one is a success', async () => {
    const { organizationId, projectId, ref } = project();
    await provider.createRepository({ organizationId, projectId, defaultBranch: 'main' });

    await provider.deleteRepository(ref);
    // The caller's goal was that it not exist, and it does not.
    await expect(provider.deleteRepository(ref)).resolves.toBeUndefined();

    const [owner, name] = ref.split('/') as [string, string];
    const gone = await client.send({
      method: 'GET',
      path: `/repos/${owner}/${name}`,
      allow: [404],
    });
    expect(gone.status).toBe(404);
  });

  it('reads an empty repository as no commits rather than as an error', async () => {
    const { organizationId, projectId, ref } = project();
    await provider.createRepository({ organizationId, projectId, defaultBranch: 'main' });

    // Forgejo answers 404 here for an empty repository. "No commits" is the
    // honest answer, and an exception would make every freshly created project
    // look broken.
    expect(await provider.listCommits(ref, 'main', { limit: 10 })).toEqual([]);
  });
});
