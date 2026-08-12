/**
 * What this service's provider layer is, and where its vocabulary comes from
 * (plan 06 GIT-2).
 *
 * The interface itself is in `@zapp/contracts` (`src/git.ts`), not here, and the
 * split is the whole architecture: PRD §19.1 says the internal Git
 * implementation is an engineering decision while "the product contract is
 * provider-neutral", so the contract has to be somewhere the control plane can
 * depend on without depending on Forgejo. What lives *here* is the Forgejo half
 * — the one thing in the system that knows what a Forgejo organization is.
 *
 * Re-exported through this module rather than imported from `@zapp/contracts` at
 * a dozen call sites so the boundary stays visible: everything in
 * `src/provider/` speaks the contract, and a type that is not re-exported here is
 * a type the provider layer has no business with.
 */
export type {
  BranchRef,
  CommitDetail,
  CommitPage,
  CommitSummary,
  CreateRepositoryInput,
  CreatedRepository,
  GitProvider,
} from '@zapp/contracts';

export interface CommitComparison {
  readonly beforeSha: string;
  readonly afterSha: string;
  readonly changedFiles: number;
  readonly files: readonly {
    readonly path: string;
    readonly status: string;
    readonly additions: number;
    readonly deletions: number;
  }[];
  readonly filesTruncated: boolean;
  readonly patch: string;
  readonly patchTruncated: boolean;
}

export interface CommitComparisonProvider {
  compareCommits(ref: string, beforeSha: string, afterSha: string): Promise<CommitComparison | undefined>;
}

/**
 * The provider was asked for something the Git host cannot honour without
 * losing information.
 *
 * Distinct from `ForgejoError`, which means a request failed: this means it
 * *succeeded* and the answer is a conflict we refuse to paper over. There is
 * exactly one shape of it today and it is worth its own class — a release tag
 * that already exists pointing at a different commit. Retagging would silently
 * move a release to different code, and master plan §Global Constraints is
 * explicit that a production release references an exact SHA.
 */
export class GitProviderConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitProviderConflictError';
  }
}
