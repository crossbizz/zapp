/**
 * The value vocabularies plan 02 owns for PRD §23.2's project-state columns.
 *
 * `packages/db` leaves `source_type`, `sync_policy`, environment `type` and
 * branch `status` as plain `text` and says why: the PRD does not fix those sets,
 * plan 02 (CP-6) does, and a CHECK constraint invented in the schema would make
 * this task's first migration a rewrite. This file is that decision, in one
 * place — so a route, the tenant handle and a test all spell each value once.
 *
 * Deliberately separate from `./db.ts`: a route module may not import the tenant
 * handle (`test/route-isolation.test.ts`), and a vocabulary is not a handle. Both
 * halves of the service can name these values without either of them reaching a
 * database.
 */

/**
 * How a project entered zapp (PRD §10.1–10.2, §8.1 templates): the home prompt,
 * an empty project, a template remix, or a GitHub import.
 *
 * CP-4's placeholder set spelled the import `github` and carried an `upload` that
 * no flow in the PRD produces; both are gone rather than kept as aliases, because
 * a column with two spellings of one thing is a column every later query has to
 * know that about — and plan 06's import task (GIT-4) writes `github_import`.
 */
export const SOURCE_TYPES = ['prompt', 'blank', 'template', 'github_import'] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/** The default branch every project starts with (PRD §19.1). */
export const DEFAULT_BRANCH = 'main';

/**
 * The environments every project starts with, in creation order (PRD §26A.3).
 * `staging` is in the vocabulary but is not created up front: plan 07 owns adding
 * environments, and one nobody asked for is one nobody deploys to.
 */
export const DEFAULT_ENVIRONMENTS = ['preview', 'production'] as const;

/**
 * `branches.status` for a branch that exists and has been neither merged nor
 * abandoned.
 */
export const BRANCH_ACTIVE = 'active';

/** `repositories.provider` for the internal Forgejo instance (PRD §19.1). */
export const INTERNAL_PROVIDER = 'internal';

/**
 * `repositories.sync_policy` for a repository with no GitHub peer — which is
 * every repository a project is created with, since `external_repo_ref` is null
 * until an import or a link happens. Plan 06 moves it to `manual_push`,
 * `direct_push` or `pull_request` at that point (GIT-4, GIT-6); claiming one of
 * those now would describe a synchronization with nothing on the other end.
 */
export const NO_SYNC = 'none';
