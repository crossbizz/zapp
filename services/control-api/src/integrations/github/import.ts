import {
  CommitShaSchema,
  IdempotencyHeader,
  idSchema,
} from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../../app.js';
import { ApiError } from '../../errors.js';
import { IdempotencyHeadersSchema } from '../../plugins/idempotency.js';
import { authorize, tenantOf } from '../../plugins/tenant.js';
import {
  GitHubImportErrorCodeSchema,
  GitHubImportRequestSchema,
  GitHubImportStatusValueSchema,
  type GitHubImportRow,
} from './schemas.js';

export { GitHubImportErrorCodeSchema, GitHubImportStatusValueSchema } from './schemas.js';

export const GitHubImportStatusSchema = z
  .object({
    projectId: idSchema('proj'),
    status: GitHubImportStatusValueSchema,
    externalRepoRef: z.string().min(1).nullable(),
    branch: z.string().min(1),
    headCommitSha: CommitShaSchema.nullable(),
    scanId: z.string().min(1).nullable(),
    errorCode: GitHubImportErrorCodeSchema.nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const GitHubImportResponseSchema = z
  .object({
    import: z
      .object({
        projectId: idSchema('proj'),
        status: z.literal('queued'),
      })
      .strict(),
  })
  .strict();

const ProjectParamsSchema = z.object({ projectId: idSchema('proj') }).strict();

export type GitHubImportStatus = z.infer<typeof GitHubImportStatusSchema>;
export type GitHubImportErrorCode = z.infer<typeof GitHubImportErrorCodeSchema>;

function notFound(): ApiError {
  return new ApiError('github_import_not_found', 404, 'That GitHub import does not exist.');
}

function toStatus(row: GitHubImportRow): GitHubImportStatus {
  return GitHubImportStatusSchema.parse({
    projectId: row.projectId,
    status: row.status,
    externalRepoRef: row.externalRepoRef,
    branch: row.branch,
    headCommitSha: row.headCommitSha,
    scanId: row.scanId,
    errorCode: row.errorCode,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function registerGitHubImportRoutes(app: AppInstance, now: () => Date): void {
  app.post(
    '/v1/projects/:projectId/import/github',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ProjectParamsSchema,
        headers: IdempotencyHeadersSchema,
        body: GitHubImportRequestSchema,
        response: { 202: GitHubImportResponseSchema },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      authorize(tenant, 'edit_code');
      const headers = IdempotencyHeadersSchema.parse(request.headers);
      const result = await tenant.db.githubImports.accept({
        projectId: request.params.projectId,
        installationId: request.body.installationId,
        repo: request.body.repo,
        branch: request.body.branch,
        operationKey: headers[IdempotencyHeader],
        now: now(),
      });

      if (result === 'operation_conflict') {
        throw new ApiError(
          'github_import_conflict',
          409,
          'This project already has a different GitHub import operation.',
        );
      }
      if (result === 'source_type_required') {
        throw new ApiError(
          'github_import_source_required',
          409,
          'This project was not created for a GitHub import.',
        );
      }
      if (result === 'project_not_found' || result === 'installation_not_found') {
        throw notFound();
      }

      return await reply.status(202).send({
        import: { projectId: result.projectId, status: 'queued' },
      });
    },
  );

  app.get(
    '/v1/projects/:projectId/import/github',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: ProjectParamsSchema, response: { 200: GitHubImportStatusSchema } },
    },
    async (request) => {
      const tenant = tenantOf(request);
      authorize(tenant, 'view_project');
      const row = await tenant.db.githubImports.get(request.params.projectId);
      if (row === undefined) throw notFound();
      return toStatus(row);
    },
  );
}
