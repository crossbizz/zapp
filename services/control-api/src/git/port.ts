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
  /** Immutable, and therefore what the ref below is derived from. */
  readonly projectId: string;
  /**
   * The project's slug at creation time, for a display name or a description —
   * **never for the ref**. It is mutable (`PATCH /v1/projects/:projectId`), and
   * a ref derived from it desynchronizes on the first rename (plan 02 CP-6
   * review).
   */
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

/**
 * How long an implementation may take before it must give up.
 *
 * Part of the contract rather than a suggestion, because of *where* this call
 * happens: inside the transaction that creates the project
 * (`src/tenant/db.ts`), which means a pooled PostgreSQL connection is held open
 * for its whole duration. An implementation that waits on an unreachable Forgejo
 * until TCP gives up — minutes, by default — holds that connection for minutes,
 * and enough concurrent creates then exhaust the pool and take down every other
 * route in the service, including the ones that have nothing to do with git.
 *
 * Ten seconds: long enough for a repository create against a healthy instance
 * (tens of milliseconds), short enough that the pool survives an unhealthy one.
 * Plan 06's GIT-2 is expected to enforce it with an `AbortSignal` on its HTTP
 * client and to throw {@link GitServiceError} on expiry, which rolls the project
 * back exactly as any other refusal does.
 *
 * The alternative — creating the repository outside the transaction — trades
 * this for orphan rows and half-created projects, which is the failure the
 * transaction exists to prevent. A bounded wait is the cheaper side of that
 * trade; an unbounded one is not a side of it at all.
 */
export const GIT_CREATE_DEADLINE_MS = 10_000;

export interface GitServicePort {
  /**
   * Creates the project's repository with `defaultBranch` as its initial branch.
   *
   * Runs inside the creating transaction: a rejection must leave nothing behind
   * on either side, so an implementation that partially succeeded is expected to
   * clean up after itself before it throws.
   *
   * **Must return or throw within {@link GIT_CREATE_DEADLINE_MS}.** See that
   * constant for why an implementation that waits longer is a service-wide
   * outage rather than a slow project create.
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
 * The ref is derived rather than random so it is stable and reproducible, and it
 * is derived from the **project id** rather than from the slug — which is the
 * fix for a real defect, not a preference (plan 02 CP-6 review):
 *
 *   - `PATCH /v1/projects/:projectId` changes the slug and touches no
 *     repository row, so a slug-derived ref pointed at a repository named after
 *     something the project is no longer called — and every later clone, push
 *     and release would follow a ref the project has outgrown.
 *   - Worse, the freed slug could then be taken by a *second* project in the
 *     same organization, which minted a second `repositories` row with the
 *     **same** `internal_repo_ref`. Two projects, one Git repository, one
 *     project's code landing in the other's history. Nothing refused it.
 *
 * The project id is immutable and unique, so neither is expressible now, and
 * `repositories_org_internal_ref_idx` (`packages/db/drizzle/0007`) refuses a
 * duplicate ref that this function did not derive. Lowercased because Git
 * hosting treats owner and repository names case-insensitively, and two refs
 * differing only by case would be one repository.
 *
 * `provisioned_at` is deliberately left null by everything this stand-in
 * writes: the record exists, the repository on disk does not, and plan 06's
 * GIT-2 is what can tell the difference (`packages/db/src/schema/projects.ts`).
 */
export function createRecordOnlyGitService(): GitServicePort {
  return {
    createRepository(input) {
      return Promise.resolve({
        internalRepoRef: `${input.organizationId.toLowerCase()}/${input.projectId.toLowerCase()}`,
      });
    },
  };
}
