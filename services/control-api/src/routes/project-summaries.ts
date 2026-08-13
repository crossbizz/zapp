import { createHash } from 'node:crypto';

import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { ReadinessSchema, type ReleasePort } from './releases.js';
import {
  MAX_PUBLIC_RUN_ARTIFACT_BYTES,
  type RunArtifactReaderPort,
} from './run-artifacts.js';
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

const ProjectThumbnailParams = z.object({
  projectId: idSchema('proj'),
  artifactId: idSchema('art'),
}).strict();

const ProjectThumbnailResponse = z.object({
  thumbnail: z.object({
    contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    encoding: z.literal('base64'),
    content: z.string().max(100_000),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict(),
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
  readonly artifactReader: RunArtifactReaderPort;
}

export function registerProjectSummaryRoutes(
  app: AppInstance,
  deps: ProjectSummaryRoutesDeps,
): void {
  app.get(
    '/v1/projects/:projectId/preview-thumbnail/:artifactId',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: ProjectThumbnailParams,
        response: { 200: ProjectThumbnailResponse },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      const artifact = await ctx.db.projectSummaries.getPreviewThumbnail(
        request.params.projectId,
        request.params.artifactId,
      );
      if (artifact === undefined) throw projectNotFound();

      const object = await deps.artifactReader.read({
        key: artifact.storageRef,
        maxBytes: MAX_PUBLIC_RUN_ARTIFACT_BYTES,
      });
      if (object === undefined) throw projectNotFound();
      if (object === 'too_large') {
        throw new ApiError(
          'run_artifact_too_large',
          413,
          'That run artifact exceeds the public inline-read limit.',
        );
      }
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(object.contentType) ||
        createHash('sha256').update(object.body).digest('hex') !== artifact.contentHash
      ) {
        throw new ApiError(
          'preview_thumbnail_content_invalid',
          409,
          'That preview thumbnail failed integrity verification.',
        );
      }

      return ProjectThumbnailResponse.parse({
        thumbnail: {
          contentType: object.contentType,
          encoding: 'base64',
          content: object.body.toString('base64'),
          contentHash: artifact.contentHash,
        },
      });
    },
  );

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
