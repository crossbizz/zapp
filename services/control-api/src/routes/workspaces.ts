import {
  CheckpointKindSchema,
  ResourceProfileSchema,
  WorkspaceStatusSchema,
  idSchema,
} from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import {
  CheckpointWorkspaceInputSchema,
  CheckpointWorkspaceResultSchema,
  CreateWorkspaceInputSchema,
  CreateWorkspaceResultSchema,
  PreviewWorkspaceInputSchema,
  PreviewWorkspaceResultSchema,
  StartWorkspaceInputSchema,
  StartWorkspaceResultSchema,
  TerminateWorkspaceInputSchema,
  type SandboxServicePort,
  type SandboxWorkspace,
} from '../sandbox/port.js';
import { WorkspaceSchema, toWorkspace } from '../tenant/view.js';
import { operationOf, stableId } from './runs.js';

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
type Workspace = Omit<SandboxWorkspace, 'resourceProfile'> & { readonly resourceProfile: string };

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
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      const branch =
        request.body.branchId === undefined
          ? undefined
          : await ctx.db.branches.getForProject(project.id, request.body.branchId);
      if (request.body.branchId !== undefined && branch === undefined) throw branchNotFound();
      authorize(ctx, 'edit_code');
      const operationKey = operationOf(request);
      const workspace = await ctx.db.workspaces.create({
        id: stableId('ws', operationKey),
        projectId: project.id,
        branchId: request.body.branchId ?? null,
        resourceProfile: request.body.resourceProfile,
        now: deps.now(),
        audit: async (tx, row) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'workspace.create_requested',
            target: { type: 'workspace', id: row.id },
            metadata: { operationKey, operationState: 'requested', projectId: row.projectId },
          });
        },
      });
      if (workspace.providerWorkspaceId === null) {
        let result: z.infer<typeof CreateWorkspaceResultSchema>;
        try {
          result = CreateWorkspaceResultSchema.parse(
            await deps.sandbox.createWorkspace(
              CreateWorkspaceInputSchema.parse({
                workspace,
                ...(branch === undefined ? {} : { branchName: branch.name }),
                operationKey,
              }),
            ),
          );
        } catch {
          throw sandboxFailed();
        }
        const completed = await ctx.db.workspaces.completeCreate({
          workspaceId: workspace.id,
          providerWorkspaceId: result.providerWorkspaceId,
          status: result.status,
          audit: async (tx, row) => {
            await request.audit(tx, {
              organizationId: ctx.organizationId,
              action: 'workspace.created',
              target: { type: 'workspace', id: row.id },
              metadata: { operationKey, operationState: 'completed', status: row.status },
            });
          },
        });
        if (completed === undefined) throw sandboxFailed();
        return await reply.status(201).send({ workspace: toWorkspace(completed) });
      }
      return await reply.status(201).send({ workspace: toWorkspace(workspace) });
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
      const workspace = await ctx.db.workspaces.getById(request.params.workspaceId);
      if (workspace === undefined) throw workspaceNotFound();
      authorize(ctx, 'view_project');
      return { workspace: toWorkspace(workspace) };
    },
  );

  action('start', {
    allowed: ['provisioning', 'requested'],
    requested: 'workspace.start_requested',
    completed: 'workspace.started',
    body: undefined,
    apply: async (workspace, operationKey) =>
      StartWorkspaceResultSchema.parse(
        await deps.sandbox.startWorkspace(
          StartWorkspaceInputSchema.parse({ workspace, operationKey }),
        ),
      ),
    patch: (result) => ({ status: StartWorkspaceResultSchema.parse(result).status }),
  });
  action('checkpoint', {
    allowed: ['started', 'ready', 'active', 'idle'],
    requested: 'workspace.checkpoint_requested',
    completed: 'workspace.checkpointed',
    body: CheckpointBody,
    apply: async (workspace, operationKey, body) =>
      CheckpointWorkspaceResultSchema.parse(
        await deps.sandbox.checkpointWorkspace(
          CheckpointWorkspaceInputSchema.parse({
            workspace,
            kind: CheckpointBody.parse(body).kind,
            operationKey,
          }),
        ),
      ),
    patch: (result) => ({ snapshotRef: CheckpointWorkspaceResultSchema.parse(result).snapshotRef }),
  });
  action('terminate', {
    allowed: ['requested', 'provisioning', 'started', 'ready', 'active', 'checkpointing', 'idle'],
    requested: 'workspace.terminate_requested',
    completed: 'workspace.terminated',
    body: undefined,
    apply: async (workspace, operationKey) => {
      const terminated = await deps.sandbox.terminateWorkspace(
        TerminateWorkspaceInputSchema.parse({ workspace, operationKey }),
      );
      z.void().parse(terminated);
      return undefined;
    },
    patch: () => ({ status: 'terminated' as const, terminatedAt: deps.now() }),
  });
  action('preview', {
    allowed: ['started', 'ready', 'active', 'idle'],
    requested: 'workspace.preview_requested',
    completed: 'workspace.previewed',
    body: PreviewBody,
    apply: async (workspace, operationKey, body, userId) =>
      PreviewWorkspaceResultSchema.parse(
        await deps.sandbox.previewWorkspace(
          PreviewWorkspaceInputSchema.parse({
            workspace,
            port: PreviewBody.parse(body).port,
            ttlSeconds: PreviewBody.parse(body).ttlSeconds,
            userId,
            operationKey,
          }),
        ),
      ),
    patch: () => ({}),
  });
  function action(
    name: 'start' | 'checkpoint' | 'terminate' | 'preview',
    config: {
      readonly allowed: readonly z.infer<typeof WorkspaceStatusSchema>[];
      readonly requested:
        | 'workspace.start_requested'
        | 'workspace.checkpoint_requested'
        | 'workspace.terminate_requested'
        | 'workspace.preview_requested';
      readonly completed:
        | 'workspace.started'
        | 'workspace.checkpointed'
        | 'workspace.terminated'
        | 'workspace.previewed';
      readonly body: z.ZodTypeAny | undefined;
      readonly apply: (
        workspace: Workspace,
        operationKey: string,
        body: unknown,
        userId: string,
      ) => Promise<unknown>;
      readonly patch: (result: unknown) => {
        status?: z.infer<typeof WorkspaceStatusSchema>;
        snapshotRef?: string;
        terminatedAt?: Date;
      };
    },
  ): void {
    app.post(
      `/v1/workspaces/:workspaceId/${name}`,
      {
        preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
        schema: {
          params: WorkspaceParams,
          ...(config.body === undefined ? {} : { body: config.body }),
          response: {
            200:
              name === 'preview'
                ? z.object({ preview: PreviewWorkspaceResultSchema })
                : z.object({ workspace: WorkspaceSchema }),
          },
        },
      },
      async (request) => {
        const ctx = tenantOf(request);
        const workspace = await ctx.db.workspaces.getById(request.params.workspaceId);
        if (workspace === undefined) throw workspaceNotFound();
        authorize(ctx, 'edit_code');
        const operationKey = operationOf(request);
        const claim = await ctx.db.workspaces.claimOperation({
          workspaceId: workspace.id,
          operationKey,
          allowedStatuses: config.allowed,
          audit: async (tx, row) => {
            await request.audit(tx, {
              organizationId: ctx.organizationId,
              action: config.requested,
              target: { type: 'workspace', id: row.id },
              metadata: { operationKey, operationState: 'requested', priorStatus: row.status },
            });
          },
        });
        if (claim === undefined) throw workspaceNotFound();
        if (claim.outcome === 'blocked' || claim.outcome === 'rejected')
          throw invalidWorkspaceState();
        if (claim.outcome === 'completed')
          return name === 'preview'
            ? { preview: previewFromMetadata(claim.metadata) }
            : { workspace: toWorkspace(claim.entity) };
        let result: unknown;
        try {
          result = await config.apply(claim.entity, operationKey, request.body, actorOf(request));
        } catch {
          throw sandboxFailed();
        }
        const preview = name === 'preview' ? PreviewWorkspaceResultSchema.parse(result) : undefined;
        const patch = config.patch(result);
        const completed = await ctx.db.workspaces.completeOperation({
          workspaceId: claim.entity.id,
          operationKey,
          expectedStatus: claim.entity.status,
          ...patch,
          now: deps.now(),
          audit: async (tx, row) => {
            await request.audit(tx, {
              organizationId: ctx.organizationId,
              action: config.completed,
              target: { type: 'workspace', id: row.id },
              metadata: {
                operationKey,
                operationState: 'completed',
                ...(preview === undefined
                  ? { status: row.status }
                  : { url: preview.url, expiresAt: preview.expiresAt }),
              },
            });
          },
        });
        if (completed === undefined) throw invalidWorkspaceState();
        return preview === undefined ? { workspace: toWorkspace(completed) } : { preview };
      },
    );
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
function invalidWorkspaceState(): ApiError {
  return new ApiError('invalid_workspace_state', 409, 'That workspace cannot accept this action.');
}
function sandboxFailed(): ApiError {
  return new ApiError(
    'sandbox_service_failed',
    502,
    'The sandbox service could not complete that operation.',
  );
}
function previewFromMetadata(metadata: unknown): z.infer<typeof PreviewWorkspaceResultSchema> {
  const parsed = z
    .object({ url: z.string(), expiresAt: z.string() })
    .passthrough()
    .safeParse(metadata);
  if (!parsed.success) throw invalidWorkspaceState();
  return PreviewWorkspaceResultSchema.parse(parsed.data);
}
