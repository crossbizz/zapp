import { PageSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { GitServiceError, type GitServicePort } from '../git/port.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { DEFAULT_PAGE_SIZE } from '../pagination.js';
import { redactCredentials } from '../secrets/redaction.js';
import { SlugSchema, derivedSlug, randomSuffix } from '../slug.js';
import { SOURCE_TYPES } from '../tenant/vocabulary.js';
import {
  BranchSchema,
  EnvironmentSchema,
  ProjectContractSchema,
  ProjectSchema,
  RepositorySchema,
  RunSchema,
  toBranch,
  toEnvironment,
  toProject,
  toProjectContract,
  toRepository,
  toRun,
} from '../tenant/view.js';

/**
 * PRD §32.1 — the project lifecycle, and the runs of one project.
 *
 * **Convention, enforced by `test/route-isolation.test.ts` and by ESLint:**
 * nothing in `src/routes/` imports `@zapp/db`, a Drizzle table, or `forOrg`. The
 * only database access a handler has is `tenantOf(request).db`, which the tenant
 * plugin has already bound to one organization — so a handler cannot express a
 * cross-tenant query, and "I forgot the `where organization_id =`" is not a
 * mistake this file is able to make.
 *
 * Which is why every miss here is a plain 404: `ctx.db` returns `undefined` for
 * another tenant's project exactly as it does for one that was never created,
 * and the handler cannot tell the difference either.
 *
 * Three rules run through the writes:
 *
 * 1. **A project is created whole or not at all.** The project row, its internal
 *    repository, its `main` branch, its `preview` and `production` environments
 *    and the audit row are one transaction — and the git service is called
 *    *inside* it (`src/tenant/db.ts`), so a repository that cannot be created
 *    leaves no project behind. `test/projects.test.ts` and
 *    `test/integration/projects.test.ts` both prove the rollback.
 * 2. **The slug is unique per organization, and only per organization.** Two
 *    tenants may both own `checkout`; a collision is therefore never an oracle
 *    for what another tenant has, because the query that detects it is scoped to
 *    the caller's own organization.
 * 3. **Every mutation is audited in its own transaction and honours
 *    `Idempotency-Key`.** The second is the idempotency plugin's doing (CP-5) —
 *    it enrols every non-read route — so a retried create returns the first
 *    project rather than making a second one.
 */

const ProjectParams = z.object({ projectId: idSchema('proj') });

const NameSchema = z.string().trim().min(1).max(80);
const DescriptionSchema = z.string().trim().max(2000);

const CreateProjectBody = z
  .object({
    name: NameSchema,
    /** Optional: derived from the name when absent, which is the common path. */
    slug: SlugSchema.optional(),
    description: DescriptionSchema.optional(),
    /**
     * How the project entered zapp (PRD §10.1–10.2, §8.1). `prompt` is the home
     * flow and therefore the default.
     *
     * `supportLevel` is deliberately *not* a field: PRD §7.1's tiers are what the
     * capability scan concludes about a project (plan 05 VF-3), so a client that
     * could declare its own project `verified` would be declaring which
     * verification gates it is exempt from. Every project starts `compatible`.
     */
    sourceType: z.enum(SOURCE_TYPES).default('prompt'),
  })
  /**
   * Strict, and it is the field above that makes it matter: a body carrying
   * `supportLevel: 'verified'` is a client that believes it is setting the
   * project's verification tier, and stripping the field in silence lets it go
   * on believing that. The same goes for a misspelled `sourcetype` quietly
   * defaulting to `prompt`. A 400 naming the unrecognised key is the answer to
   * both (plan 02 CP-6 review).
   */
  .strict();

const UpdateProjectBody = z
  .object({
    name: NameSchema.optional(),
    slug: SlugSchema.optional(),
    /** `null` clears the description; absent leaves it as it is. */
    description: DescriptionSchema.nullable().optional(),
    /** PRD §23.2: archived projects stay readable. Deletion is CP-17's. */
    archived: z.boolean().optional(),
  })
  // A PATCH that changes nothing is a client bug, and answering 200 to it hides
  // the bug behind a success.
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'at least one of name, slug, description or archived is required',
  });

/**
 * A boolean in a query string. Spelled out rather than `z.coerce.boolean()`,
 * which reads the string `"false"` as **true** (`Boolean("false")` is), and a
 * flag that cannot be turned off is worse than one that does not exist.
 */
const BooleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Keyset pagination, as the FND-10 envelope describes it: `cursor` is the opaque
 * `nextCursor` of the previous page, handed back untouched.
 */
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  cursor: idSchema('proj').optional(),
  /** Archived projects are hidden unless asked for — see `UpdateProjectBody.archived`. */
  includeArchived: BooleanQuery.default('false'),
});

/** The project and everything created with it (`src/tenant/db.ts`). */
const ProjectResourcesSchema = z.object({
  project: ProjectSchema,
  /**
   * Nullable on a read, and never null on a create: every project created since
   * CP-6 has a repository, and a project created before it does not. A client
   * that treats null as "not ready yet" is reading it correctly.
   */
  repository: RepositorySchema.nullable(),
  branches: z.array(BranchSchema),
  environments: z.array(EnvironmentSchema),
});

/**
 * What a scan request answers with until plan 05 VF-3 wires the real pipeline.
 *
 * `id` is this request's id — the one already stamped at the edge (CP-1), echoed
 * in the error envelope and carried through the logs — and it is deliberately
 * not a TypeID: a scan has no row of its own in PRD §23, so minting an id that
 * looked like one would be inventing an entity nobody can then look up. VF-3
 * replaces this shape with the durable identity of the workflow it starts, and
 * the contract version it produces is readable at
 * `GET /v1/projects/:projectId/contract` either way.
 */
const ScanSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /**
   * `accepted`, not `queued`: nothing is enqueued, and a status that says
   * otherwise is a client waiting for a worker that does not exist (plan 02 CP-6
   * review). It matches the 202 the route answers with, and VF-3 is free to add
   * `queued` when there is a queue to be in.
   */
  status: z.literal('accepted'),
  requestedAt: z.string().datetime(),
});

/** How many suffixed slugs to try before giving up on a derived one. */
const MAX_SLUG_ATTEMPTS = 5;

export interface ProjectRoutesDeps {
  readonly now: () => Date;
  /** Creates the internal repository, inside the creating transaction (plan 06 GIT-2). */
  readonly git: GitServicePort;
}

export function registerProjectRoutes(app: AppInstance, deps: ProjectRoutesDeps): void {
  const { now, git } = deps;

  app.post(
    '/v1/projects',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        body: CreateProjectBody,
        response: {
          201: ProjectResourcesSchema.extend({ repository: RepositorySchema }),
        },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'create_project');

      const requested = request.body.slug;
      // A name that does not reduce to a valid slug — punctuation, a single
      // character, a script with no Latin form — still needs one, and a random
      // slug is better than a collision-prone constant.
      const base = requested ?? derivedSlug(request.body.name, 'project');

      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
        const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
        const created = await ctx.db.projects.create({
          name: request.body.name,
          slug,
          description: request.body.description ?? null,
          sourceType: request.body.sourceType,
          // Earned, never claimed — see `CreateProjectBody`.
          supportLevel: 'compatible',
          // The session's user, not a field of the request — and the
          // organization is the handle's, which the request cannot name at all.
          createdBy: actorOf(request),
          now: now(),
          /**
           * Called inside the transaction that wrote the project, so a git
           * service that refuses rolls the project back with it. The provider's
           * own message never reaches the client — it quotes the request, and
           * the request carries our service credentials.
           */
          repository: async ({ project, defaultBranch }) => {
            try {
              return await git.createRepository({
                organizationId: ctx.organizationId,
                projectId: project.id,
                // The slug the store actually wrote, not `base`: a collision
                // retry changes it, and the repository has to agree with the row.
                projectSlug: project.slug,
                defaultBranch,
              });
            } catch (error) {
              request.log.warn(
                {
                  errorKind: error instanceof GitServiceError ? 'git_service' : 'unknown',
                  /**
                   * The cause, server-side only, and passed through the
                   * credential redactor first.
                   *
                   * Logging nothing left an operator with `errorKind:
                   * 'git_service'` and no way to tell a bad token from a full
                   * disk (plan 02 CP-6 review). Logging it verbatim is the
                   * reason it was omitted: a git client's error quotes the
                   * request that failed, and that request carries our service
                   * credentials. `redactCredentials` keeps the sentence and
                   * removes the credential-shaped parts of it. It still never
                   * reaches the client — the 502 below says only that the
                   * repository could not be created.
                   */
                  cause: redactCredentials(error instanceof Error ? error.message : 'unknown'),
                },
                'the git service refused the repository',
              );
              throw new ApiError(
                'project_create_failed',
                502,
                'The project repository could not be created. Please try again.',
              );
            }
          },
          // Inside the insert's transaction: the rows and the row that says who
          // created them commit together or not at all.
          audit: (tx, resources) =>
            request.audit(tx, {
              organizationId: ctx.organizationId,
              action: 'project.created',
              target: { type: 'project', id: resources.project.id },
              metadata: {
                slug: resources.project.slug,
                sourceType: resources.project.sourceType,
                repositoryId: resources.repository.id,
                defaultBranch: resources.repository.defaultBranch,
                environments: resources.environments.map((environment) => environment.name),
              },
            }),
        });

        if (created === 'slug_taken') {
          // A slug the client chose is a request we cannot silently rewrite; one
          // we derived is ours to vary.
          if (requested !== undefined) {
            throw slugTaken();
          }
          continue;
        }

        return await reply.status(201).send({
          project: toProject(created.project),
          repository: toRepository(created.repository),
          branches: created.branches.map(toBranch),
          environments: created.environments.map(toEnvironment),
        });
      }
      throw slugTaken();
    },
  );

  app.get(
    '/v1/projects',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { querystring: ListQuery, response: { 200: PageSchema(ProjectSchema) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      // Really paginated, rather than answering `nextCursor: null` to every
      // request whatever the size of the answer: the envelope promises keyset
      // pagination, and a client that reads the promise and pages with the
      // cursor has to get the second page.
      const page = await ctx.db.projects.list({
        limit: request.query.limit,
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        includeArchived: request.query.includeArchived,
      });
      // `nextCursor` is explicitly null rather than absent (FND-10): a client
      // must never read a missing field as "there might be more".
      return { items: page.items.map(toProject), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/v1/projects/:projectId',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: ProjectParams, response: { 200: ProjectResourcesSchema } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) {
        throw projectNotFound();
      }

      // Three scoped reads rather than a join, and each of them carries the
      // organization in its own WHERE clause — a project's rows are never
      // reached *through* the project, because then the scoping would be the
      // parent row's rather than the query's.
      const [repository, projectBranches, projectEnvironments] = await Promise.all([
        ctx.db.repositories.forProject(project.id),
        ctx.db.branches.byProject(project.id),
        ctx.db.environments.byProject(project.id),
      ]);

      return {
        project: toProject(project),
        repository: repository === undefined ? null : toRepository(repository),
        branches: projectBranches.map(toBranch),
        environments: projectEnvironments.map(toEnvironment),
      };
    },
  );

  app.patch(
    '/v1/projects/:projectId',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ProjectParams,
        body: UpdateProjectBody,
        response: { 200: z.object({ project: ProjectSchema }) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'edit_code');

      const patch = {
        ...(request.body.name === undefined ? {} : { name: request.body.name }),
        ...(request.body.slug === undefined ? {} : { slug: request.body.slug }),
        ...(request.body.description === undefined
          ? {}
          : { description: request.body.description }),
        ...(request.body.archived === undefined ? {} : { archived: request.body.archived }),
      };

      const updated = await ctx.db.projects.update({
        projectId: request.params.projectId,
        patch,
        now: now(),
        audit: (tx, project) =>
          request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'project.updated',
            target: { type: 'project', id: project.id },
            // Which fields moved, not what they moved to: the row is the trail,
            // not a second copy of the record. `archived` is the exception,
            // because "who archived this and when" is the question the trail
            // gets asked.
            metadata: {
              fields: Object.keys(patch).sort(),
              ...(request.body.archived === undefined ? {} : { archived: request.body.archived }),
            },
          }),
      });

      if (updated === 'slug_taken') {
        throw slugTaken();
      }
      if (updated === undefined) {
        throw projectNotFound();
      }
      return { project: toProject(updated) };
    },
  );

  app.get(
    '/v1/projects/:projectId/contract',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: ProjectParams,
        response: { 200: z.object({ contract: ProjectContractSchema }) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      // The project is resolved first so another tenant's project answers
      // `project_not_found` rather than `contract_not_found` — the second would
      // say the project exists and has simply never been scanned.
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) {
        throw projectNotFound();
      }

      const contract = await ctx.db.contracts.latestForProject(project.id);
      if (contract === undefined) {
        throw new ApiError(
          'project_contract_not_found',
          404,
          'That project has no execution contract yet. Run a capability scan first.',
        );
      }
      return { contract: toProjectContract(contract) };
    },
  );

  app.post(
    '/v1/projects/:projectId/scan',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { params: ProjectParams, response: { 202: z.object({ scan: ScanSchema }) } },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      // A scan starts work in the project rather than editing it, which is the
      // capability PRD §22.2 calls `start_run`. Owner and Builder hold it;
      // Viewer does not.
      authorize(ctx, 'start_run');
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) {
        throw projectNotFound();
      }

      /**
       * 202, and nothing is enqueued: plan 05's VF-3 owns the capability scan
       * pipeline (detection → `ExecutionContract` → `project_contracts` row →
       * support level), and this route is the surface it attaches to. The
       * acceptance is therefore honest about what has happened — the request was
       * accepted, no contract exists yet — rather than reporting a scan that no
       * worker will run. `GET /v1/projects/:projectId/contract` answers 404
       * until VF-3 lands, which is the same answer it gives for a project whose
       * first scan has not finished.
       */
      const requestedAt = now();
      await request.auditDetached({
        organizationId: ctx.organizationId,
        action: 'project.scan_requested',
        target: { type: 'project', id: project.id },
        metadata: { scanId: request.id },
      });

      return await reply.status(202).send({
        scan: {
          id: request.id,
          projectId: project.id,
          status: 'accepted',
          requestedAt: requestedAt.toISOString(),
        },
      });
    },
  );

  app.get(
    '/v1/projects/:projectId/runs',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: ProjectParams, response: { 200: PageSchema(RunSchema) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      // The project is looked up first so another tenant's project answers 404
      // rather than an empty page — an empty page would say it exists and is
      // idle, which is one bit more than nothing.
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) {
        throw projectNotFound();
      }
      const items = await ctx.db.runs.byProject(project.id);
      return { items: items.map(toRun), nextCursor: null };
    },
  );
}

function slugTaken(): ApiError {
  return new ApiError('project_slug_taken', 409, 'That project slug is already in use.');
}

/**
 * A project that is not this tenant's is a project that does not exist. The same
 * answer as for one that was never created — see the file header.
 */
function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'That project does not exist.');
}
