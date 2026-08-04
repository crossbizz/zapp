import { PageSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { OrchestratorError, type OrchestratorPort } from '../orchestrator/port.js';
import { actorOf } from '../plugins/auth.js';
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
const ProjectParams = z.object({ projectId: idSchema('proj') });

const CreateRunBody = z
  .object({
    mode: z.enum(['ask', 'prototype', 'build', 'fix', 'autonomous']),
    prompt: z.string().trim().min(1).max(20_000),
    branchId: idSchema('br').optional(),
    budget: z.unknown().optional(),
  })
  .strict();
const RedirectRunBody = z.object({ prompt: z.string().trim().min(1).max(20_000) }).strict();
const SIGNAL_AUDIT_ACTION = {
  pause: 'run.paused',
  resume: 'run.resumed',
  cancel: 'run.cancelled',
  redirect: 'run.redirected',
} as const;

const EventQuery = z.object({
  /** Resume point: the first sequence to return, inclusive (PRD §14.4). */
  fromSequence: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

export interface RunRoutesDeps {
  readonly now: () => Date;
  readonly orchestrator: OrchestratorPort;
}

export function registerRunRoutes(app: AppInstance, deps: RunRoutesDeps): void {
  app.post(
    '/v1/projects/:projectId/runs',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ProjectParams,
        body: CreateRunBody,
        response: { 201: z.object({ run: RunSchema }) },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'start_run');
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) {
        throw projectNotFound();
      }
      if (
        request.body.branchId !== undefined &&
        (await ctx.db.branches.getForProject(project.id, request.body.branchId)) === undefined
      ) {
        throw branchNotFound();
      }

      try {
        const run = await ctx.db.runs.create({
          projectId: project.id,
          branchId: request.body.branchId ?? null,
          mode: request.body.mode,
          budget: request.body.budget ?? null,
          startedBy: actorOf(request),
          now: deps.now(),
          start: async (created) => {
            await deps.orchestrator.startRun({
              runId: created.id,
              organizationId: created.organizationId,
              projectId: created.projectId,
              branchId: created.branchId,
              mode: created.mode,
              prompt: request.body.prompt,
              budget: request.body.budget ?? null,
              idempotencyKey: created.id,
            });
          },
          audit: async (tx, created) => {
            await request.audit(tx, {
              organizationId: ctx.organizationId,
              action: 'run.created',
              target: { type: 'run', id: created.id },
              metadata: { projectId: created.projectId, mode: created.mode },
            });
          },
        });
        return await reply.status(201).send({ run: toRun(run) });
      } catch (error) {
        if (error instanceof OrchestratorError) {
          throw new ApiError(
            'workflow_start_failed',
            502,
            'The run workflow could not be started. Please try again.',
          );
        }
        throw error;
      }
    },
  );

  const signal = (
    action: 'pause' | 'resume' | 'cancel' | 'redirect',
    status: string,
    body?: typeof RedirectRunBody,
  ): void => {
    app.post(
      `/v1/runs/:runId/${action}`,
      {
        preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
        schema: {
          params: RunParams,
          ...(body === undefined ? {} : { body }),
          response: { 200: z.object({ run: RunSchema }) },
        },
      },
      async (request) => {
        const ctx = tenantOf(request);
        authorize(ctx, 'start_run');
        const run = await ctx.db.runs.getById(request.params.runId);
        if (run === undefined) {
          throw runNotFound();
        }
        if (isTerminal(run.status)) {
          throw invalidRunState();
        }
        const prompt =
          action === 'redirect' ? RedirectRunBody.parse(request.body).prompt : undefined;
        const applied = await deps.orchestrator.signalRun({
          run,
          signal: action,
          ...(prompt === undefined ? {} : { prompt }),
        });
        if (!applied) {
          throw invalidRunState();
        }
        const updated = await ctx.db.runs.updateStatus({
          runId: run.id,
          status,
          completedAt: action === 'cancel' ? deps.now() : null,
          audit: async (tx, changed) => {
            await request.audit(tx, {
              organizationId: ctx.organizationId,
              action: SIGNAL_AUDIT_ACTION[action],
              target: { type: 'run', id: changed.id },
              metadata: { status: changed.status },
            });
          },
        });
        if (updated === undefined) {
          throw runNotFound();
        }
        return { run: toRun(updated) };
      },
    );
  };

  signal('pause', 'paused');
  signal('resume', 'queued');
  signal('cancel', 'cancelled');
  signal('redirect', 'queued', RedirectRunBody);

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

/** A project outside this tenant is indistinguishable from one that does not exist. */
function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'That project does not exist.');
}

/** A branch outside the tenant or project is indistinguishable from an absent branch. */
function branchNotFound(): ApiError {
  return new ApiError('branch_not_found', 404, 'That branch does not exist.');
}

function invalidRunState(): ApiError {
  return new ApiError('invalid_run_state', 409, 'That run cannot accept this action.');
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
