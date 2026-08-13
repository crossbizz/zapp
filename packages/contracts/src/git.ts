import { z } from 'zod';

import { idSchema } from './ids.js';
import { CommitShaSchema } from './primitives.js';

/**
 * The internal Git service, as a contract rather than as a product (plan 06
 * GIT-2).
 *
 * PRD §19.1 lists what the internal Git service must provide — one repository
 * per project, branches, commits, tags, protected release branches,
 * repository-scoped tokens, audit logs, backup and restore — and then says the
 * implementation is an engineering decision while "the product contract is
 * provider-neutral". This file is that sentence, made checkable.
 *
 * It lives in `@zapp/contracts` rather than in `services/git-service` for the
 * reason the service-token primitive lives in `@zapp/config`: more than one
 * package has to agree about it, and the cheapest way to guarantee agreement is
 * for there to be one definition. Specifically {@link internalRepoRef} — the
 * control plane derives a repository's ref when it creates the project row
 * (`services/control-api/src/git/port.ts`), and the git service derives it again
 * every time it is asked to mint a token for that project. Those two derivations
 * agreeing is not a comment anyone has to keep true; it is the same function.
 *
 * Nothing here imports anything but `zod`, which is what keeps it a contract. A
 * Forgejo type, an HTTP client or a database handle in this file would make the
 * "provider-neutral" claim false the moment it was written.
 */

/**
 * Where a project's repository lives, as `owner/name`.
 *
 * **Derived from ids, never from names.** Both halves are immutable TypeIDs, and
 * that is the fix for a defect rather than a preference (plan 02 CP-6 review): a
 * ref derived from the project's *slug* desynchronizes on the first rename, and
 * the freed slug can then be taken by a second project in the same organization
 * — two `repositories` rows with one `internal_repo_ref`, and one project's code
 * landing in another's history.
 *
 * Lowercased because Git hosting treats owner and repository names
 * case-insensitively, so two refs differing only by case would be one repository
 * while being two rows.
 *
 * The shape is plan 06's `org_{orgId}/proj_{projectId}`, which a TypeID already
 * spells: an organization id *is* `org_<ulid>`. The two descriptions agree by
 * construction rather than by coincidence.
 */
export function internalRepoRef(input: {
  readonly organizationId: string;
  readonly projectId: string;
}): string {
  return `${input.organizationId.toLowerCase()}/${input.projectId.toLowerCase()}`;
}

/**
 * A ref, validated as one.
 *
 * Strict about both halves, because this string is interpolated into API paths
 * and into clone URLs: a ref carrying `..` or a slash of its own is a path
 * traversal against the Git host, and a ref carrying a space is a clone URL that
 * means something else. Nothing constructs a ref except {@link internalRepoRef},
 * and this is what refuses one that came from somewhere else.
 */
export const InternalRepoRefSchema = z
  .string()
  .regex(/^org_[0-9a-z]{26}\/proj_[0-9a-z]{26}$/, 'Invalid internal repository ref');

/** The two halves of a ref, for a caller that has to address them separately. */
export interface RepoRefParts {
  readonly owner: string;
  readonly name: string;
}

/**
 * Splits a ref, refusing anything {@link internalRepoRef} did not produce.
 *
 * @throws Error naming the expected shape and never echoing the value — a ref
 * arrives from a request body, and a rejected value in an error message is a
 * rejected value in a log.
 */
export function parseInternalRepoRef(ref: string): RepoRefParts {
  const parsed = InternalRepoRefSchema.safeParse(ref);
  if (!parsed.success) {
    throw new Error('Invalid internal repository ref: expected org_<ulid>/proj_<ulid>');
  }
  const [owner, name] = parsed.data.split('/');
  // Forgejo refs are deliberately lowercased; validate their normalized form
  // through the authoritative TypeID schemas rather than widening the ref regex.
  if (
    owner === undefined ||
    name === undefined ||
    !idSchema('org').safeParse(`org_${owner.slice(4).toUpperCase()}`).success ||
    !idSchema('proj').safeParse(`proj_${name.slice(5).toUpperCase()}`).success
  ) {
    throw new Error('Invalid internal repository ref: expected org_<ulid>/proj_<ulid>');
  }
  // Both are present: the pattern above required them. Named rather than
  // asserted so the types stay honest.
  return { owner, name };
}

/** Where a project's repository is created, and what it starts as. */
export const CreateRepositoryInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    /**
     * The branch the repository's HEAD points at. It has **no commits** until
     * something pushes one: the control plane writes `branches.head_commit_sha`
     * as null at creation (plan 02 CP-6) and the workspace service reports the
     * first commit, so a provider that seeded an initial commit here would put
     * the two out of step on day one.
     */
    defaultBranch: z.string().min(1).max(255).default('main'),
    /**
     * For a human reading the Git host's own UI. Never part of the ref — see
     * {@link internalRepoRef} for what a mutable name in a ref costs.
     */
    description: z.string().max(255).optional(),
  })
  .strict();

export type CreateRepositoryInput = z.infer<typeof CreateRepositoryInputSchema>;

export const CreatedRepositorySchema = z
  .object({
    internalRepoRef: InternalRepoRefSchema,
    /**
     * The URL a workspace clones from, with no credential in it. A caller adds
     * one — a repository-scoped, short-lived token (GIT-3) — at the moment it
     * clones, so a clone URL is never itself a secret and can be stored, logged
     * and shown.
     */
    cloneUrl: z.string().url(),
    /**
     * When the repository actually came into existence, as opposed to when a row
     * describing it was written.
     *
     * This is what `repositories.provisioned_at` records, and the column exists
     * because those two states are genuinely different: plan 02 CP-6 ships a
     * record-only stand-in that names a repository and contacts nothing, so
     * every row it writes leaves the column null. A provider returning a
     * timestamp here is asserting that a `git clone` of `cloneUrl` would now
     * succeed.
     */
    provisionedAt: z.date(),
  })
  .strict();

export type CreatedRepository = z.infer<typeof CreatedRepositorySchema>;

export const BranchRefSchema = z
  .object({
    name: z.string().min(1),
    /** Null on an unborn branch — the default branch of a repository nothing has pushed to. */
    headSha: CommitShaSchema.nullable(),
  })
  .strict();

export type BranchRef = z.infer<typeof BranchRefSchema>;

export const CommitSummarySchema = z
  .object({
    sha: CommitShaSchema,
    message: z.string(),
    authorName: z.string(),
    authorEmail: z.string(),
    committedAt: z.date(),
  })
  .strict();

export type CommitSummary = z.infer<typeof CommitSummarySchema>;

/**
 * A commit and what it changed.
 *
 * The diffstat is counts, never contents: this crosses a service boundary and
 * ends up in events and in release evidence, and a patch body would put a
 * customer's source — and any secret committed into it — somewhere neither
 * belongs.
 */
export const CommitDetailSchema = CommitSummarySchema.extend({
  parents: z.array(CommitShaSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
}).strict();

export type CommitDetail = z.infer<typeof CommitDetailSchema>;

/**
 * The branch pattern every provider must protect (PRD §19.1: "protected release
 * branches").
 *
 * A glob rather than a branch, because release branches are minted per release
 * and a rule that had to be applied to each one is a rule that will be missed on
 * the one that mattered.
 */
export const RELEASE_BRANCH_PATTERN = 'release/*';

/** A page of commits. Keyset by `before`, like every other list in the system. */
export interface CommitPage {
  /** How many to return. Providers cap this; a caller asking for more gets the cap. */
  readonly limit: number;
  /** Walk history starting at this commit rather than at the branch head. */
  readonly before?: string;
}

/**
 * What every internal-Git implementation provides.
 *
 * Every method takes a **ref**, not a project: this interface knows nothing about
 * organizations, projects or tenants, which is what keeps tenancy a property of
 * the caller (and of {@link internalRepoRef}) rather than something a provider
 * could get subtly wrong.
 *
 * Failures are thrown, and an implementation is expected to distinguish "not
 * there" from "could not tell" — the second is not a state to create over.
 */
export interface GitProvider {
  /**
   * Creates the project's repository. Private, empty, with `defaultBranch` as its
   * HEAD, and with the organization's namespace created on demand if it is the
   * tenant's first project.
   *
   * **Idempotent.** A repository that is already there is returned rather than
   * refused: this runs inside the transaction that creates the project row
   * (`services/control-api/src/git/port.ts`), and a retry after a lost response
   * must not be the thing that makes the project uncreatable.
   */
  createRepository(input: CreateRepositoryInput): Promise<CreatedRepository>;

  /**
   * Removes the repository and everything in it. Idempotent: a repository that is
   * already gone is a success, because the caller's goal was that it not exist.
   */
  deleteRepository(ref: string): Promise<void>;

  /** Explicit absence probe used by the verified project-deletion pipeline. */
  repositoryExists(ref: string): Promise<boolean>;

  /** Cuts `name` from `fromSha`. */
  createBranch(ref: string, name: string, fromSha: string): Promise<void>;

  /** `undefined` when the branch does not exist — which an unborn default branch does not. */
  getBranch(ref: string, name: string): Promise<BranchRef | undefined>;

  /**
   * Protects every branch matching `pattern` — no force-push, no deletion, no
   * direct push. Idempotent, so a repository whose rule already exists is left
   * alone rather than having it replaced.
   */
  protectBranch(ref: string, pattern: string): Promise<void>;

  listCommits(ref: string, branch: string, page: CommitPage): Promise<CommitSummary[]>;

  /** `undefined` when the sha is not in this repository. */
  getCommit(ref: string, sha: string): Promise<CommitDetail | undefined>;

  /**
   * Tags `sha`. Release tags are `rel_*` and reference an exact commit — master
   * plan §Global Constraints: a production release never references a branch
   * name, because a branch moves and a release does not.
   */
  createTag(ref: string, tag: string, sha: string): Promise<void>;
}
