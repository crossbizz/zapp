/**
 * The internal Git service, as the control plane needs it.
 *
 * Every zapp project is backed by a repository in the internal Forgejo instance
 * — internal Git is the source of truth and GitHub is a peer remote at most
 * (PRD §19.1). Creating a project therefore has a side effect outside
 * PostgreSQL, and that is the whole reason this port exists rather than a direct
 * HTTP call:
 *
 *   - **It is called inside the project's transaction** (`src/tenant/db.ts`), so
 *     a repository the git service refuses is a project that was never created.
 *     No orphan row, no project whose code has nowhere to live.
 *   - **It is substitutable**, so the route suite exercises the real
 *     transactional path — including the rollback — against a fake that fails on
 *     demand, with no Forgejo anywhere near it.
 *
 * The Forgejo implementation is plan 06's (GIT-2, `services/git-service`). What
 * ships here is the interface it will satisfy and the record-only stand-in
 * below.
 */

export interface CreateRepositoryInput {
  readonly organizationId: string;
  readonly projectId: string;
  /** Unique within the organization, which is what makes the ref below unique. */
  readonly projectSlug: string;
  readonly defaultBranch: string;
}

export interface CreatedRepository {
  /**
   * Where the repository lives in the internal instance, as `owner/name`. Stored
   * on `repositories.internal_repo_ref` and used by every later clone, push and
   * release.
   */
  readonly internalRepoRef: string;
}

/**
 * The git service refused or could not be reached. A named class rather than a
 * bare `Error` so the route can tell "the repository could not be created" from
 * a bug in our own transaction, and answer 502 rather than 500 for the first.
 */
export class GitServiceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GitServiceError';
  }
}

export interface GitServicePort {
  /**
   * Creates the project's repository with `defaultBranch` as its initial branch.
   *
   * Runs inside the creating transaction: a rejection must leave nothing behind
   * on either side, so an implementation that partially succeeded is expected to
   * clean up after itself before it throws.
   *
   * @throws {GitServiceError}
   */
  createRepository(input: CreateRepositoryInput): Promise<CreatedRepository>;
}

/**
 * Names the repository a project will have, and contacts nothing.
 *
 * This is the stand-in until plan 06's GIT-2 lands the Forgejo client, and it is
 * deliberately the *smallest* thing that keeps the control plane honest: the
 * `repositories` row, its `internal_repo_ref` and the default branch are all
 * real and readable through the API from the moment a project exists, so nothing
 * downstream has to special-case a project with no repository record. What is
 * not real yet is the repository on disk — GIT-2 replaces this binding in
 * `src/compose.ts` and nothing else changes.
 *
 * The ref is derived rather than random so it is stable and reproducible: the
 * organization owns the namespace, the project's slug names the repository, and
 * the slug is already unique per organization (`projects_org_slug_idx`).
 * Lowercased because Git hosting treats owner and repository names
 * case-insensitively, and two refs differing only by case would be one
 * repository.
 */
export function createRecordOnlyGitService(): GitServicePort {
  return {
    createRepository(input) {
      return Promise.resolve({
        internalRepoRef: `${input.organizationId.toLowerCase()}/${input.projectSlug}`,
      });
    },
  };
}
