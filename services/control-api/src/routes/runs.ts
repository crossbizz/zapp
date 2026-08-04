import { PageSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { EventSchema, RunSchema, toEvent, toRun } from '../tenant/view.js';

/**
 * PRD §32 agent runs and the events they produced.
 *
 * Same convention as `./projects.ts`, and it matters most here: `agent_events`
 * is the largest table in the system and the one a cross-tenant read would be
 * most valuable against — it carries prompts, tool output and file paths. The
 * only handle these two routes have is `tenantOf(request).db`, so every query
 * below is `organization_id`-scoped before it is written, not after.
 *
 * The live stream (`GET /v1/events`, `Last-Event-ID` resume) is CP-15's, in
 * `src/routes/events.ts`. What is here is the replayable read the stream resumes
 * from.
 */

const RunParams = z.object({ runId: idSchema('run') });

const EventQuery = z.object({
  /** Resume point: the first sequence to return, inclusive (PRD §14.4). */
  fromSequence: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

export function registerRunRoutes(app: AppInstance): void {
  app.get(
    '/v1/runs/:runId',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: RunParams, response: { 200: z.object({ run: RunSchema }) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) {
        throw runNotFound();
      }
      return { run: toRun(run) };
    },
  );

  app.get(
    '/v1/runs/:runId/events',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: RunParams,
        querystring: EventQuery,
        response: { 200: PageSchema(EventSchema) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      // The run is resolved first so another tenant's run answers 404 rather
      // than an empty page: an empty page would say the run exists and is quiet.
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) {
        throw runNotFound();
      }

      const items = await ctx.db.events.byRun(run.id, {
        ...(request.query.fromSequence === undefined
          ? {}
          : { fromSequence: request.query.fromSequence }),
        limit: request.query.limit,
      });
      // `nextCursor` is explicitly null rather than absent (FND-10). CP-15 fills
      // it in when the stream owns pagination.
      return { items: items.map(toEvent), nextCursor: null };
    },
  );
}

/** A run that is not this tenant's is a run that does not exist. */
function runNotFound(): ApiError {
  return new ApiError('run_not_found', 404, 'That run does not exist.');
}
