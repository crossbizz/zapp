import type { ServiceName } from '@zapp/config';
import {
  BranchRefSchema,
  CommitDetailSchema,
  CommitSummarySchema,
  CreatedRepositorySchema,
  RELEASE_BRANCH_PATTERN,
  idSchema,
  internalRepoRef,
} from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from './app.js';
import { ApiError } from './errors.js';
import { ForgejoError, redactToken } from './forgejo/client.js';
import { GitProviderConflictError, type GitProvider } from './provider/types.js';
import {
  DEFAULT_TOKEN_TTL_SECONDS,
  MAX_TOKEN_TTL_SECONDS,
  TOKEN_ACCESS_LEVELS,
  type TokenService,
} from './tokens.js';
import { serviceOf } from './internal/service-auth.js';

/**
 * `/internal/git/*` — the whole surface of this service (plan 06 GIT-2).
 *
 * **A repository is addressed by its project, never by its ref.** Every route
 * below takes `organizationId` and `projectId` and derives the ref itself with
 * `internalRepoRef` (`@zapp/contracts`). That is a security property rather than
 * a style: a caller that could name a ref could name *any* ref, and this service
 * holds a Forgejo admin token — "read the commits of `org_other/proj_theirs`"
 * would be a complete cross-tenant read, authorized by nothing but a service
 * token any caller already has. Deriving the ref means the worst a caller can do
 * is address a project by id, which is what the control plane's own authorization
 * already governs.
 *
 * It also makes the ref agree with the control plane's `repositories` row by
 * construction: both sides call the same function on the same immutable ids.
 *
 * **Provider text never reaches a caller.** A Forgejo error quotes the request
 * that failed, and that request carries our admin token. Every handler below
 * logs the cause through `redactCause` and answers with a code.
 */

/** Who may call. Everything that legitimately touches a project's repository. */
export const GIT_CALLERS: readonly ServiceName[] = [
  /** Creates a project's repository, inside the transaction that creates the project (CP-6). */
  'control-api',
  /** Clones, commits and pushes on behalf of a run (plan 03). */
  'sandbox-service',
  /** Reads commits and branch heads while driving a run (plan 04). */
  'orchestrator-worker',
  /** Cuts release branches and tags them at exact SHAs (plan 07). */
  'release-service',
];

const ProjectParams = z.object({
  organizationId: idSchema('org'),
  projectId: idSchema('proj'),
});

const CreateRepositoryBody = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    defaultBranch: z.string().trim().min(1).max(255).default('main'),
    description: z.string().trim().max(255).optional(),
    /**
     * Whether to install the `release/*` protection rule as part of creation.
     *
     * Defaults to true, which is the only setting a project should ever be
     * created with (PRD §19.1: protected release branches). It is a parameter at
     * all so a test can create a repository *without* the rule and then prove
     * the rule is what refuses the push — an assertion that would otherwise be
     * indistinguishable from "pushing to release/1 happens not to work".
     */
    protectReleaseBranches: z.boolean().default(true),
  })
  .strict();

const CreateBranchBody = z
  .object({
    name: z.string().trim().min(1).max(255),
    /** A resolved commit, never a ref: a branch cut from a moving target is a race. */
    fromSha: z.string().regex(/^[0-9a-f]{40}$/, 'Invalid commit sha'),
  })
  .strict();

const CreateTagBody = z
  .object({
    tag: z.string().trim().min(1).max(255),
    sha: z.string().regex(/^[0-9a-f]{40}$/, 'Invalid commit sha'),
  })
  .strict();

const BranchQuery = z.object({ name: z.string().trim().min(1).max(255) });

const CommitsQuery = z.object({
  branch: z.string().trim().min(1).max(255),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Keyset: walk history from this commit rather than from the branch head. */
  before: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'Invalid commit sha')
    .optional(),
});

const ShaParams = ProjectParams.extend({
  sha: z.string().regex(/^[0-9a-f]{40}$/, 'Invalid commit sha'),
});

/**
 * The wire form of a commit. Dates cross HTTP as ISO strings, so the schemas
 * from `@zapp/contracts` — which describe the *provider* contract, where a date
 * is a `Date` — are reshaped rather than reused verbatim.
 */
const WireCommitSummary = CommitSummarySchema.extend({ committedAt: z.string().datetime() });
const WireCommitDetail = CommitDetailSchema.extend({ committedAt: z.string().datetime() });
const WireCreatedRepository = CreatedRepositorySchema.extend({
  provisionedAt: z.string().datetime(),
});

const MintTokenBody = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    access: z.enum(TOKEN_ACCESS_LEVELS),
    /**
     * Bounded at the schema as well as in `src/tokens.ts`, so an over-long
     * request is a 400 naming the field rather than a 500 from a thrown Error.
     * The ceiling is the same number in both places and the constant is shared —
     * two spellings of a security bound is one spelling too many.
     */
    ttlSec: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_TOKEN_TTL_SECONDS)
      .default(DEFAULT_TOKEN_TTL_SECONDS),
    /**
     * Why this credential is being minted. Required, and long enough to be a
     * sentence rather than a keystroke: the audit row is what an incident is
     * reconstructed from, and "sandbox-service took a write token" answers a
     * different question than "sandbox-service took a write token to push
     * run_01…".
     */
    reason: z.string().trim().min(8).max(500),
    /** Attribution, when the caller has a run or a task to attribute to. */
    runId: idSchema('run').optional(),
    taskId: idSchema('task').optional(),
  })
  .strict();

const RevokeTokensBody = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    reason: z.string().trim().min(8).max(500),
  })
  .strict();

const MintedTokenSchema = z.object({
  /** The credential. The one field in this service's responses that is one. */
  token: z.string(),
  /** The ephemeral user it belongs to — an identifier, worth nothing on its own. */
  username: z.string(),
  cloneUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});

export interface GitRoutesDeps {
  readonly provider: GitProvider;
  /**
   * Mints and revokes repository-scoped credentials (GIT-3). A port rather than
   * a Forgejo client, so the route suite can prove the authorization and the
   * envelope without an ephemeral user being created anywhere.
   */
  readonly tokens: TokenService;
  /** Overridable so a test can prove a caller outside the allowlist is refused. */
  readonly callers?: readonly ServiceName[];
}

export function registerGitRoutes(app: AppInstance, deps: GitRoutesDeps): void {
  const { provider, tokens } = deps;
  const callers = deps.callers ?? GIT_CALLERS;
  const guard = (): ReturnType<AppInstance['requireService']> => app.requireService({ callers });

  /**
   * Turns a provider failure into an answer, having logged the cause.
   *
   * The split is the point. A `GitProviderConflictError` is a refusal the caller
   * can act on and its message is ours, written for that purpose — a tag that
   * already points somewhere else is a bug in the caller. Everything else is
   * either the Git host's problem or ours, and the caller gets a 502 with no
   * detail: a `ForgejoError` message names the request, and Forgejo's own body
   * can quote a URL carrying our credentials.
   */
  function refuse(request: { log: AppInstance['log'] }, error: unknown, operation: string): never {
    if (error instanceof GitProviderConflictError) {
      throw new ApiError('git_conflict', 409, error.message);
    }
    request.log.error(
      {
        errorCode: 'git_provider_failed',
        operation,
        status: error instanceof ForgejoError ? error.status : undefined,
        cause: redactToken(error instanceof Error ? error.message : 'unknown'),
      },
      'the git provider refused',
    );
    throw new ApiError(
      'git_provider_failed',
      502,
      'The git provider could not complete that operation.',
    );
  }

  app.post(
    '/internal/git/repositories',
    {
      preHandler: [guard()],
      schema: { body: CreateRepositoryBody, response: { 201: WireCreatedRepository } },
    },
    async (request, reply) => {
      const { organizationId, projectId, defaultBranch, description, protectReleaseBranches } =
        request.body;
      try {
        const created = await provider.createRepository({
          organizationId,
          projectId,
          defaultBranch,
          ...(description === undefined ? {} : { description }),
        });

        if (protectReleaseBranches) {
          // Inside the create, before the caller is told the repository exists.
          // A repository that is reachable before its release branches are
          // protected has a window in which they are not, and the window would
          // be exactly as long as it takes something to notice a new project.
          await provider.protectBranch(created.internalRepoRef, RELEASE_BRANCH_PATTERN);
        }

        return await reply.status(201).send({
          ...created,
          provisionedAt: created.provisionedAt.toISOString(),
        });
      } catch (error) {
        return refuse(request, error, 'createRepository');
      }
    },
  );

  app.delete(
    '/internal/git/repositories/:organizationId/:projectId',
    { preHandler: [guard()], schema: { params: ProjectParams, response: { 204: z.null() } } },
    async (request, reply) => {
      try {
        await provider.deleteRepository(internalRepoRef(request.params));
        return await reply.status(204).send(null);
      } catch (error) {
        return refuse(request, error, 'deleteRepository');
      }
    },
  );

  app.get(
    '/internal/git/repositories/:organizationId/:projectId/branches',
    {
      preHandler: [guard()],
      schema: {
        params: ProjectParams,
        querystring: BranchQuery,
        response: { 200: BranchRefSchema },
      },
    },
    async (request) => {
      let branch;
      try {
        branch = await provider.getBranch(internalRepoRef(request.params), request.query.name);
      } catch (error) {
        return refuse(request, error, 'getBranch');
      }
      if (branch === undefined) {
        // Which includes the default branch of a repository nothing has pushed
        // to. A caller distinguishes the two by asking the control plane whether
        // the project has a repository at all.
        throw new ApiError('branch_not_found', 404, 'That branch does not exist.');
      }
      return branch;
    },
  );

  app.post(
    '/internal/git/repositories/:organizationId/:projectId/branches',
    {
      preHandler: [guard()],
      schema: { params: ProjectParams, body: CreateBranchBody, response: { 201: z.null() } },
    },
    async (request, reply) => {
      try {
        await provider.createBranch(
          internalRepoRef(request.params),
          request.body.name,
          request.body.fromSha,
        );
        return await reply.status(201).send(null);
      } catch (error) {
        return refuse(request, error, 'createBranch');
      }
    },
  );

  app.get(
    '/internal/git/repositories/:organizationId/:projectId/commits',
    {
      preHandler: [guard()],
      schema: {
        params: ProjectParams,
        querystring: CommitsQuery,
        response: {
          200: z.object({ items: z.array(WireCommitSummary), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (request) => {
      const { branch, limit, before } = request.query;
      let commits;
      try {
        commits = await provider.listCommits(internalRepoRef(request.params), branch, {
          limit: limit + 1,
          ...(before === undefined ? {} : { before }),
        });
      } catch (error) {
        return refuse(request, error, 'listCommits');
      }

      // One extra commit, never returned: its presence is the whole of "there is
      // another page", and asking that way costs one commit rather than a count.
      const items = commits.slice(0, limit);
      return {
        items: items.map((commit) => ({
          ...commit,
          committedAt: commit.committedAt.toISOString(),
        })),
        /**
         * The extra commit — the *first of the next page* — rather than the last
         * one returned.
         *
         * Git history is walked from a commit **inclusively**: asking for
         * commits from sha X returns X first (verified against Forgejo 9.0.3).
         * That is the opposite of the control plane's keyset cursors, which are
         * exclusive `lt(id, cursor)` bounds, and handing back the last returned
         * sha here would repeat one commit at every page boundary — which for a
         * client counting changes is a client counting one of them twice.
         */
        nextCursor: commits.length > limit ? (commits.at(-1)?.sha ?? null) : null,
      };
    },
  );

  app.get(
    '/internal/git/repositories/:organizationId/:projectId/commits/:sha',
    { preHandler: [guard()], schema: { params: ShaParams, response: { 200: WireCommitDetail } } },
    async (request) => {
      const { organizationId, projectId, sha } = request.params;
      let commit;
      try {
        commit = await provider.getCommit(internalRepoRef({ organizationId, projectId }), sha);
      } catch (error) {
        return refuse(request, error, 'getCommit');
      }
      if (commit === undefined) {
        throw new ApiError('commit_not_found', 404, 'That commit does not exist.');
      }
      return { ...commit, committedAt: commit.committedAt.toISOString() };
    },
  );

  app.post(
    '/internal/git/tokens',
    {
      preHandler: [guard()],
      schema: { body: MintTokenBody, response: { 201: MintedTokenSchema } },
    },
    async (request, reply) => {
      const caller = serviceOf(request);
      const { organizationId, projectId, access, ttlSec, reason, runId, taskId } = request.body;

      let minted;
      try {
        minted = await tokens.mint({
          organizationId,
          projectId,
          access,
          ttlSec,
          // From the verified token, never from the body: a caller cannot claim
          // a credential was some other service's doing, which is the property
          // that makes the audit row worth reading.
          requestingService: caller.service,
          reason,
          ...(runId === undefined ? {} : { runId }),
          ...(taskId === undefined ? {} : { taskId }),
        });
      } catch (error) {
        return refuse(request, error, 'mintToken');
      }

      /**
       * The response body is a credential, and this is the one route where that
       * is true. Three consequences, all of them here rather than in a comment
       * somewhere else:
       *
       *   - `no-store`, so nothing between here and the caller keeps a copy.
       *   - the body is never logged (`src/logging.ts` builds its request log
       *     from three fields and redacts a `token` key besides), and
       *   - the username is returned separately so a caller has something it
       *     *can* log.
       */
      void reply.header('cache-control', 'no-store');
      return await reply.status(201).send({
        token: minted.token,
        username: minted.username,
        cloneUrl: minted.cloneUrl,
        expiresAt: minted.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/internal/git/tokens/revoke',
    {
      preHandler: [guard()],
      schema: {
        body: RevokeTokensBody,
        response: { 200: z.object({ revoked: z.number().int().nonnegative() }) },
      },
    },
    async (request) => {
      const caller = serviceOf(request);
      try {
        // Called when a project is deleted: every credential that could still
        // reach the repository goes with it rather than waiting out its TTL.
        const revoked = await tokens.revokeForProject({
          organizationId: request.body.organizationId,
          projectId: request.body.projectId,
          requestingService: caller.service,
          reason: request.body.reason,
        });
        return { revoked };
      } catch (error) {
        return refuse(request, error, 'revokeTokens');
      }
    },
  );

  app.post(
    '/internal/git/tokens/sweep',
    {
      preHandler: [guard()],
      schema: { response: { 200: z.object({ revoked: z.number().int().nonnegative() }) } },
    },
    async (request) => {
      try {
        // What makes "short-lived" true. Forgejo has no expiring token, so a
        // deadline is only a deadline if something enforces it; this is that
        // something, and it is idempotent and cheap enough to run every minute.
        return { revoked: await tokens.sweepExpired() };
      } catch (error) {
        return refuse(request, error, 'sweepTokens');
      }
    },
  );

  app.post(
    '/internal/git/repositories/:organizationId/:projectId/tags',
    {
      preHandler: [guard()],
      schema: { params: ProjectParams, body: CreateTagBody, response: { 201: z.null() } },
    },
    async (request, reply) => {
      try {
        await provider.createTag(
          internalRepoRef(request.params),
          request.body.tag,
          request.body.sha,
        );
        return await reply.status(201).send(null);
      } catch (error) {
        return refuse(request, error, 'createTag');
      }
    },
  );
}
