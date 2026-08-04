import { internalRepoRef, parseInternalRepoRef } from '@zapp/contracts';

import { ForgejoError, type ForgejoClient } from '../forgejo/client.js';
import {
  GitProviderConflictError,
  type BranchRef,
  type CommitDetail,
  type CommitPage,
  type CommitSummary,
  type CreateRepositoryInput,
  type CreatedRepository,
  type GitProvider,
} from './types.js';

/**
 * Forgejo, behind the provider-neutral contract (plan 06 GIT-2).
 *
 * Three rules run through every method here.
 *
 * **1. Tenancy is a namespace, not a filter.** A project's repository lives at
 * `org_{orgId}/proj_{projectId}` — a Forgejo *organization* per zapp
 * organization, created lazily on the tenant's first project. That is not
 * cosmetic: it is what makes GIT-3's repository-scoped tokens work at all. A
 * scoped token belongs to an ephemeral user who is a collaborator on exactly one
 * private repository, so every other repository — in this tenant and in every
 * other — answers 404 to it, over the API and over `git clone` alike. Tenant
 * isolation on the Git host is therefore Forgejo's own permission check rather
 * than a `WHERE` clause we have to remember to write.
 *
 * **2. Every write is idempotent, and idempotent by asking first.** Repository
 * creation runs *inside* the transaction that creates the project row
 * (`services/control-api/src/git/port.ts`), so a retry after a lost response must
 * not be the thing that makes a project uncreatable. Each write below is
 * therefore a question followed by a create only on "no", plus a tolerated
 * conflict status for the case where two callers asked at once. What is
 * deliberately *not* idempotent is the one operation where silence would lose
 * information — see {@link GitProviderConflictError}.
 *
 * **3. "Not there" and "could not tell" are different answers.** A 404 becomes
 * `undefined` or an empty list; a timeout or a refused connection stays an
 * exception (`ForgejoError`, status 0). The distinction is what stops a
 * transient outage being read as "the repository does not exist" by a caller
 * that would then create a second one.
 *
 * One Forgejo behaviour is worth knowing about because it shows up in tests and
 * in logs rather than in code: **a push is processed asynchronously.** For a
 * second or two after `git push` returns, `GET /branches/{name}` still answers
 * 404 and the repository still reports itself empty. Nothing here papers over
 * that with a sleep — `getBranch` reports what the API says — and callers that
 * need "the branch as of the push that just finished" have to poll, which
 * `test/integration/forgejo.test.ts` does explicitly.
 */

interface RepositoryResponse {
  readonly clone_url?: string;
  readonly created_at?: string;
  readonly default_branch?: string;
  readonly empty?: boolean;
}

interface BranchResponse {
  readonly name?: string;
  readonly commit?: { readonly id?: string };
}

interface CommitAuthor {
  readonly name?: string;
  readonly email?: string;
  readonly date?: string;
}

interface CommitResponse {
  readonly sha?: string;
  readonly commit?: {
    readonly message?: string;
    readonly author?: CommitAuthor;
    readonly committer?: CommitAuthor;
  };
  readonly parents?: readonly { readonly sha?: string }[];
  readonly stats?: { readonly additions?: number; readonly deletions?: number };
  readonly files?: readonly unknown[];
}

interface TagResponse {
  readonly commit?: { readonly sha?: string };
}

interface ProtectionResponse {
  readonly rule_name?: string;
}

/**
 * Forgejo's answer to a duplicate, which is not one status.
 *
 * 409 for a branch and a tag, 422 for an organization, and **403** for a branch
 * protection rule — that last one probed against Forgejo 9.0.3 rather than
 * guessed, because it is the one that looks like a permissions failure and is
 * not. Tolerated only on a create that this module has already established is
 * needed, so the ambiguity costs nothing: a genuine permissions failure on that
 * path would fail the read that preceded it.
 */
const ALREADY_EXISTS = [403, 409, 422];

/** Whether an error is Forgejo saying "no such thing", as opposed to "I could not tell". */
function isMissing(error: unknown): boolean {
  return error instanceof ForgejoError && error.status === 404;
}

/**
 * The statuses that mean "this history has no commits in it".
 *
 * Two, and the second was a surprise the integration suite caught rather than
 * something guessed here: an *unknown branch* answers 404, and an **empty
 * repository** answers **409** with "Git Repository is empty" (Forgejo 9.0.3).
 * Every zapp project is empty from the moment it is created until its first run
 * pushes, so treating only 404 as "no commits" made a freshly created project
 * look broken to its own first caller.
 */
function isEmptyHistory(error: unknown): boolean {
  return isMissing(error) || (error instanceof ForgejoError && error.status === 409);
}

function toDate(value: string | undefined, fallback: Date): Date {
  if (value === undefined) {
    return fallback;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function toCommitSummary(commit: CommitResponse, fallbackDate: Date): CommitSummary {
  return {
    sha: commit.sha ?? '',
    message: commit.commit?.message ?? '',
    authorName: commit.commit?.author?.name ?? '',
    authorEmail: commit.commit?.author?.email ?? '',
    // The *committer* date, not the author's: an author date is metadata a
    // commit carries from wherever it was written and can be any value at all,
    // while the committer date is when this history came to be.
    committedAt: toDate(commit.commit?.committer?.date, fallbackDate),
  };
}

export interface ForgejoProviderOptions {
  readonly client: ForgejoClient;
  /** Injected in tests so a timestamp is asserted rather than tolerated. */
  readonly now?: () => Date;
}

export function createForgejoGitProvider(options: ForgejoProviderOptions): GitProvider {
  const { client } = options;
  const now = options.now ?? ((): Date => new Date());

  /** `owner/name`, escaped for a path. Refuses any ref this system did not derive. */
  function pathOf(ref: string): string {
    const { owner, name } = parseInternalRepoRef(ref);
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  /**
   * The tenant's Forgejo organization, created on its first project.
   *
   * Lazily rather than when the zapp organization is created, for a plain
   * reason: an organization with no projects needs no namespace, and a
   * provisioning step that runs at signup is a step that can fail at signup.
   */
  async function ensureOrganization(owner: string): Promise<void> {
    const existing = await client.send({
      method: 'GET',
      path: `/orgs/${encodeURIComponent(owner)}`,
      allow: [404],
    });
    if (existing.status !== 404) {
      return;
    }
    await client.send({
      method: 'POST',
      path: '/orgs',
      body: {
        username: owner,
        // Private, always. A public organization lists its repositories to every
        // authenticated user of the instance — which includes the ephemeral,
        // repository-scoped users GIT-3 mints for other tenants.
        visibility: 'private',
        description: 'zapp.build tenant',
      },
      allow: ALREADY_EXISTS,
    });
  }

  /**
   * Named rather than reached for through `this`: the returned object is a port,
   * and a port's methods get destructured. `this.getBranch(…)` inside
   * `createBranch` would work until somebody wrote `const { createBranch } =
   * provider`, and then it would throw at the one moment it matters — the
   * conflict path.
   */
  async function getBranch(ref: string, name: string): Promise<BranchRef | undefined> {
    const response = await client.send<BranchResponse>({
      method: 'GET',
      // Branch names contain slashes (`release/1`), so the segment is escaped
      // rather than interpolated: an unescaped one is a different API path.
      path: `${pathOf(ref)}/branches/${encodeURIComponent(name)}`,
      allow: [404],
    });
    if (response.status === 404 || response.body === undefined) {
      // Including the default branch of a repository nothing has pushed to,
      // which is what every project's `main` is until its first commit.
      return undefined;
    }
    return {
      name: response.body.name ?? name,
      headSha: response.body.commit?.id ?? null,
    };
  }

  return {
    getBranch,

    async createRepository(input: CreateRepositoryInput): Promise<CreatedRepository> {
      const ref = internalRepoRef(input);
      const { owner, name } = parseInternalRepoRef(ref);
      await ensureOrganization(owner);

      const existing = await client.send<RepositoryResponse>({
        method: 'GET',
        path: pathOf(ref),
        allow: [404],
      });

      let repository = existing.body;
      if (existing.status === 404) {
        const created = await client.send<RepositoryResponse>({
          method: 'POST',
          path: `/orgs/${encodeURIComponent(owner)}/repos`,
          body: {
            name,
            private: true,
            /**
             * **No initial commit.** The control plane writes
             * `branches.head_commit_sha` as null when it creates the project row
             * (plan 02 CP-6) and the workspace service reports the first commit;
             * a README committed here would put those two out of step from the
             * moment the project exists, and would put a file in the customer's
             * history that they did not write.
             */
            auto_init: false,
            default_branch: input.defaultBranch,
            ...(input.description === undefined ? {} : { description: input.description }),
          },
          allow: ALREADY_EXISTS,
        });
        repository =
          created.body ??
          // A tolerated conflict: somebody else created it between our read and
          // our write. Read it back rather than assume what it looks like.
          (await client.send<RepositoryResponse>({ method: 'GET', path: pathOf(ref) })).body;
      }

      const cloneUrl = repository?.clone_url;
      if (cloneUrl === undefined || cloneUrl === '') {
        // Reachable only if Forgejo answered 2xx with a body that is not a
        // repository. Loud, because the alternative is handing the control plane
        // a clone URL of `undefined` to store on a row.
        throw new ForgejoError('POST', pathOf(ref), 0, 'repository response carried no clone_url');
      }

      return {
        internalRepoRef: ref,
        cloneUrl,
        /**
         * Forgejo's own creation time, not ours. This lands on
         * `repositories.provisioned_at`, which answers "when did this repository
         * start existing" — and on the retry path the answer is the first
         * attempt's, not the retry's.
         */
        provisionedAt: toDate(repository?.created_at, now()),
      };
    },

    async deleteRepository(ref: string): Promise<void> {
      // 404 is success: the caller's goal was that it not exist.
      await client.send({ method: 'DELETE', path: pathOf(ref), allow: [404] });
    },

    async createBranch(ref: string, name: string, fromSha: string): Promise<void> {
      const created = await client.send({
        method: 'POST',
        path: `${pathOf(ref)}/branches`,
        body: { new_branch_name: name, old_ref_name: fromSha },
        allow: [409],
      });
      if (created.status !== 409) {
        return;
      }

      // Already there. Idempotent *only* if it is the branch that was asked for:
      // a branch of the same name at a different commit is a different branch,
      // and reporting success would tell a caller its code is somewhere it is
      // not.
      const existing = await getBranch(ref, name);
      if (existing !== undefined && existing.headSha !== fromSha) {
        throw new GitProviderConflictError(`branch ${name} already exists at a different commit`);
      }
    },

    async protectBranch(ref: string, pattern: string): Promise<void> {
      const existing = await client.send<ProtectionResponse>({
        method: 'GET',
        path: `${pathOf(ref)}/branch_protections/${encodeURIComponent(pattern)}`,
        allow: [404],
      });
      if (existing.status !== 404) {
        // Left exactly as it is. Re-applying would overwrite a rule an operator
        // may have tightened, and this method's job is "make sure it is
        // protected", not "make sure it is protected the way I would have".
        return;
      }

      await client.send({
        method: 'POST',
        path: `${pathOf(ref)}/branch_protections`,
        body: {
          rule_name: pattern,
          /**
           * PRD §19.1's "protected release branches", spelled out. No push at
           * all — not merely "no force push": a release branch records what was
           * released, and a commit landing on it afterwards makes the release
           * evidence describe code that is no longer there. Forgejo has no
           * separate force-push flag; refusing every push covers both, and
           * `test/integration/forgejo.test.ts` proves a scoped *write* token is
           * refused by it.
           *
           * `apply_to_admins` is deliberately left at its default of false. The
           * platform admin token is what *creates* release branches and tags on
           * behalf of plan 07's release service, and it is held by this service
           * alone — it never reaches a workspace, an agent or a generated app.
           * What the rule has to stop is a repository-scoped token (GIT-3),
           * which is never an administrator and is therefore always subject to
           * it.
           */
          enable_push: false,
        },
        allow: ALREADY_EXISTS,
      });
    },

    async listCommits(ref: string, branch: string, page: CommitPage): Promise<CommitSummary[]> {
      // Keyset: `sha` is Forgejo's "start listing from here", so a cursor is a
      // commit rather than an offset — which is the only form that stays correct
      // while history is being written.
      const from = page.before ?? branch;
      const query = new URLSearchParams({
        sha: from,
        limit: String(page.limit),
        stat: 'false',
        verification: 'false',
        files: 'false',
      });

      let response;
      try {
        response = await client.send<readonly CommitResponse[]>({
          method: 'GET',
          path: `${pathOf(ref)}/commits?${query.toString()}`,
        });
      } catch (error) {
        if (isEmptyHistory(error)) {
          // An empty repository and an unknown branch are different statuses and
          // the same answer — see {@link isEmptyHistory}.
          return [];
        }
        throw error;
      }

      const fallback = now();
      // `null` rather than `[]` is what an empty repository's branch list
      // returns, and JSON `null` survives the parse as `null`.
      return (response.body ?? []).map((commit) => toCommitSummary(commit, fallback));
    },

    async getCommit(ref: string, sha: string): Promise<CommitDetail | undefined> {
      // `files=true` is what makes `changedFiles` answerable — Forgejo's `stats`
      // carries additions and deletions but no file count. The cost is a
      // response proportional to the size of the commit, which is why this is
      // the single-commit endpoint and `listCommits` asks for neither.
      const query = new URLSearchParams({ stat: 'true', files: 'true', verification: 'false' });
      let response;
      try {
        response = await client.send<CommitResponse>({
          method: 'GET',
          path: `${pathOf(ref)}/git/commits/${encodeURIComponent(sha)}?${query.toString()}`,
        });
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
      if (response.body === undefined) {
        return undefined;
      }

      const commit = response.body;
      return {
        ...toCommitSummary(commit, now()),
        parents: (commit.parents ?? []).map((parent) => parent.sha ?? ''),
        additions: commit.stats?.additions ?? 0,
        deletions: commit.stats?.deletions ?? 0,
        // Counts, never contents: this crosses a service boundary and ends up in
        // events and in release evidence, and a patch body would put a
        // customer's source — and anything committed into it — in both.
        changedFiles: (commit.files ?? []).length,
      };
    },

    async createTag(ref: string, tag: string, sha: string): Promise<void> {
      const created = await client.send({
        method: 'POST',
        path: `${pathOf(ref)}/tags`,
        body: { tag_name: tag, target: sha },
        allow: [409],
      });
      if (created.status !== 409) {
        return;
      }

      /**
       * The one write here that refuses to be idempotent in silence.
       *
       * A tag that already points at this commit is the retry we wanted to
       * tolerate. A tag of the same name pointing at a *different* commit is a
       * release identifier that has been reused, and moving it would make an
       * existing release's evidence describe code that was never released
       * (master plan §Global Constraints: a production release references an
       * exact SHA). So: read it, compare, and refuse rather than move.
       */
      const existing = await client.send<TagResponse>({
        method: 'GET',
        path: `${pathOf(ref)}/tags/${encodeURIComponent(tag)}`,
        allow: [404],
      });
      const existingSha = existing.body?.commit?.sha;
      if (existingSha !== sha) {
        throw new GitProviderConflictError(`tag ${tag} already exists at a different commit`);
      }
    },
  };
}
