import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { ReadinessSchema, type ReleasePort } from './releases.js';
import {
  ProjectDashboardDeployReadinessSchema,
  ProjectDashboardSummariesResponseSchema,
  toProjectDashboardSummary,
} from '../tenant/view.js';

const ProjectSummariesQuery = z.object({
  // Fastify represents one repeated query key as a scalar and two or more as
  // an array. Normalize both wire forms before applying the batch bounds.
  projectId: z.preprocess(
    (projectIds) => (typeof projectIds === 'string' ? [projectIds] : projectIds),
    z.array(idSchema('proj')).min(1).max(100),
  ),
}).strict();

function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'That project does not exist.');
}

async function readinessFor(
  port: ReleasePort,
  organizationId: string,
  releaseId: string | null,
): Promise<z.infer<typeof ProjectDashboardDeployReadinessSchema> | null> {
  if (releaseId === null) return null;
  try {
    const report = ReadinessSchema.parse(
      await port.getReadiness({ organizationId, releaseId }),
    );
    return ProjectDashboardDeployReadinessSchema.parse({ releaseId, ...report });
  } catch {
    // A summary must never manufacture a deploy-ready state when the release
    // service cannot answer. The dashboard can retry its read independently.
    return null;
  }
}

export interface ProjectSummaryRoutesDeps {
  readonly releasePort: ReleasePort;
}

export function registerProjectSummaryRoutes(
  app: AppInstance,
  deps: ProjectSummaryRoutesDeps,
): void {
  app.get(
    '/v1/projects/summaries',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        querystring: ProjectSummariesQuery,
        response: { 200: ProjectDashboardSummariesResponseSchema },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      const summaries = await ctx.db.projectSummaries.forProjects(request.query.projectId);
      if (summaries === undefined) throw projectNotFound();

      return ProjectDashboardSummariesResponseSchema.parse({
        summaries: await Promise.all(
          summaries.map(async (summary) =>
            toProjectDashboardSummary(
              summary,
              await readinessFor(deps.releasePort, ctx.organizationId, summary.release?.id ?? null),
            ),
          ),
        ),
      });
    },
  );
}
