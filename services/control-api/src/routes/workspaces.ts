import { CheckpointKindSchema, ResourceProfileSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { type SandboxServicePort } from '../sandbox/port.js';
import { WorkspaceSchema, toWorkspace } from '../tenant/view.js';

const ProjectParams = z.object({ projectId: idSchema('proj') });
const WorkspaceParams = z.object({ workspaceId: idSchema('ws') });
const CreateBody = z
  .object({
    branchId: idSchema('br').optional(),
    resourceProfile: ResourceProfileSchema.default('standard'),
  })
  .strict();
const CheckpointBody = z.object({ kind: CheckpointKindSchema }).strict();
const PreviewBody = z
  .object({ port: z.number().int().min(1).max(65_535), ttlSeconds: z.number().int().positive() })
  .strict();

export interface WorkspaceRoutesDeps {
  readonly now: () => Date;
  readonly sandbox: SandboxServicePort;
}

export function registerWorkspaceRoutes(app: AppInstance, deps: WorkspaceRoutesDeps): void {
  app.post(
    '/v1/projects/:projectId/workspaces',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ProjectParams,
        body: CreateBody,
        response: { 201: z.object({ workspace: WorkspaceSchema }) },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'edit_code');
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      if (
        request.body.branchId !== undefined &&
        (await ctx.db.branches.getForProject(project.id, request.body.branchId)) === undefined
      ) {
        throw branchNotFound();
      }
      try {
        const workspace = await ctx.db.workspaces.create({
          projectId: project.id,
          branchId: request.body.branchId ?? null,
          resourceProfile: request.body.resourceProfile,
          now: deps.now(),
          create: async (row) => await deps.sandbox.createWorkspace({ workspace: row }),
          audit: async (tx, row) => {
            await request.audit(tx, {
              organizationId: ctx.organizationId,
              action: 'workspace.created',
              target: { type: 'workspace', id: row.id },
              metadata: { projectId: row.projectId, status: row.status },
            });
          },
        });
        return await reply.status(201).send({ workspace: toWorkspace(workspace) });
      } catch {
        throw sandboxFailed();
      }
    },
  );
  app.get(
    '/v1/workspaces/:workspaceId',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: WorkspaceParams,
        response: { 200: z.object({ workspace: WorkspaceSchema }) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      const workspace = await ctx.db.workspaces.getById(request.params.workspaceId);
      if (workspace === undefined) throw workspaceNotFound();
      return { workspace: toWorkspace(workspace) };
    },
  );
  app.post(
    '/v1/workspaces/:workspaceId/start',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: WorkspaceParams,
        response: { 200: z.object({ workspace: WorkspaceSchema }) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'edit_code');
      const workspace = await mustWorkspace(request);
      try {
        const result = await deps.sandbox.startWorkspace({ workspace });
        const updated = await update(request, 'workspace.started', { status: result.status });
        return { workspace: toWorkspace(updated) };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw sandboxFailed();
      }
    },
  );
  app.post(
    '/v1/workspaces/:workspaceId/checkpoint',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: WorkspaceParams,
        body: CheckpointBody,
        response: { 200: z.object({ workspace: WorkspaceSchema }) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'edit_code');
      const workspace = await mustWorkspace(request);
      try {
        const result = await deps.sandbox.checkpointWorkspace({
          workspace,
          kind: request.body.kind,
        });
        const updated = await update(request, 'workspace.checkpointed', {
          snapshotRef: result.snapshotRef,
        });
        return { workspace: toWorkspace(updated) };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw sandboxFailed();
      }
    },
  );
  app.post(
    '/v1/workspaces/:workspaceId/terminate',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: WorkspaceParams,
        response: { 200: z.object({ workspace: WorkspaceSchema }) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'edit_code');
      const workspace = await mustWorkspace(request);
      try {
        await deps.sandbox.terminateWorkspace({ workspace });
        const updated = await update(request, 'workspace.terminated', {
          status: 'terminated',
          terminatedAt: deps.now(),
        });
        return { workspace: toWorkspace(updated) };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw sandboxFailed();
      }
    },
  );
  app.post(
    '/v1/workspaces/:workspaceId/preview',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: WorkspaceParams,
        body: PreviewBody,
        response: {
          200: z.object({
            preview: z.object({ url: z.string().url(), expiresAt: z.string().datetime() }),
          }),
        },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'edit_code');
      const workspace = await mustWorkspace(request);
      try {
        const preview = await deps.sandbox.previewWorkspace({
          workspace,
          ...request.body,
          userId: actorOf(request),
        });
        await request.auditDetached({
          organizationId: ctx.organizationId,
          action: 'workspace.previewed',
          target: { type: 'workspace', id: workspace.id },
          metadata: { port: request.body.port },
        });
        return { preview };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw sandboxFailed();
      }
    },
  );
  async function mustWorkspace(request: FastifyRequest) {
    const workspaceId = WorkspaceParams.parse(request.params).workspaceId;
    const workspace = await tenantOf(request).db.workspaces.getById(workspaceId);
    if (workspace === undefined) throw workspaceNotFound();
    return workspace;
  }
  async function update(
    request: FastifyRequest,
    action: 'workspace.started' | 'workspace.checkpointed' | 'workspace.terminated',
    patch: {
      status?: import('@zapp/contracts').WorkspaceStatus;
      snapshotRef?: string;
      terminatedAt?: Date;
    },
  ) {
    const ctx = tenantOf(request);
    const updated = await ctx.db.workspaces.update({
      workspaceId: WorkspaceParams.parse(request.params).workspaceId,
      ...patch,
      now: deps.now(),
      audit: async (tx, row) => {
        await request.audit(tx, {
          organizationId: ctx.organizationId,
          action,
          target: { type: 'workspace', id: row.id },
          metadata: { status: row.status },
        });
      },
    });
    if (updated === undefined) throw workspaceNotFound();
    return updated;
  }
}

function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'That project does not exist.');
}
function branchNotFound(): ApiError {
  return new ApiError('branch_not_found', 404, 'That branch does not exist.');
}
function workspaceNotFound(): ApiError {
  return new ApiError('workspace_not_found', 404, 'That workspace does not exist.');
}
function sandboxFailed(): ApiError {
  return new ApiError(
    'sandbox_service_failed',
    502,
    'The sandbox service could not complete that operation.',
  );
}
