import { PageSchema, SupportLevelSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { SlugSchema, derivedSlug, randomSuffix } from '../slug.js';
import { ProjectSchema, RunSchema, toProject, toRun } from '../tenant/view.js';

/**
 * PRD §32 projects, and the runs of one.
 *
 * **Convention, enforced by `test/route-isolation.test.ts`:** nothing in
 * `src/routes/` imports `@zapp/db`, a Drizzle table, or `forOrg`. The only
 * database access a handler has is `tenantOf(request).db`, which the tenant
 * plugin has already bound to one organization — so a handler cannot express a
 * cross-tenant query, and "I forgot the `where organization_id =`" is not a
 * mistake this file is able to make.
 *
 * Which is why every miss here is a plain 404: `ctx.db` returns `undefined` for
 * another tenant's project exactly as it does for one that was never created,
 * and the handler cannot tell the difference either.
 *
 * CP-6 owns the rest of the project surface (archive, environments, contracts);
 * what is here is the tenant-scoped read path plus the one write that proves an
 * organization cannot be chosen by a request body.
 */

const ProjectParams = z.object({ projectId: idSchema('proj') });

const NameSchema = z.string().trim().min(1).max(80);

const CreateProjectBody = z.object({
  name: NameSchema,
  /** Optional: derived from the name when absent, which is the common path. */
  slug: SlugSchema.optional(),
  description: z.string().trim().max(2000).optional(),
  /** PRD §10.1–10.2; CP-6 widens the list as import paths land. */
  sourceType: z.enum(['prompt', 'github', 'upload']).default('prompt'),
  supportLevel: SupportLevelSchema.default('compatible'),
});

/** How many suffixed slugs to try before giving up on a derived one. */
const MAX_SLUG_ATTEMPTS = 5;

export interface ProjectRoutesDeps {
  readonly now: () => Date;
}

export function registerProjectRoutes(app: AppInstance, deps: ProjectRoutesDeps): void {
  const { now } = deps;

  app.post(
    '/v1/projects',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        body: CreateProjectBody,
        response: { 201: z.object({ project: ProjectSchema }) },
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
          supportLevel: request.body.supportLevel,
          // The session's user, not a field of the request — and the
          // organization is the handle's, which the request cannot name at all.
          createdBy: actorOf(request),
          now: now(),
          // Inside the insert's transaction: the row and the row that says who
          // created it commit together or not at all.
          audit: (tx, project) =>
            request.audit(tx, {
              organizationId: ctx.organizationId,
              action: 'project.created',
              target: { type: 'project', id: project.id },
              metadata: { slug: project.slug, sourceType: project.sourceType },
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

        return await reply.status(201).send({ project: toProject(created) });
      }
      throw slugTaken();
    },
  );

  app.get(
    '/v1/projects',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { response: { 200: PageSchema(ProjectSchema) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      const items = await ctx.db.projects.list();
      // `nextCursor` is explicitly null rather than absent (FND-10): a client
      // must never read a missing field as "there might be more".
      return { items: items.map(toProject), nextCursor: null };
    },
  );

  app.get(
    '/v1/projects/:projectId',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: ProjectParams,
        response: { 200: z.object({ project: ProjectSchema }) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) {
        throw projectNotFound();
      }
      return { project: toProject(project) };
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
