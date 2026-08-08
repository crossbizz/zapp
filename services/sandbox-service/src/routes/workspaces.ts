import {
  CreateWorkspaceInputSchema,
  EnvVarsSchema,
  NetworkProfileSchema,
  ResourceProfileSchema,
  WorkspacePurposeSchema,
  WorkspaceHandleSchema,
  WorkspaceStatusSchema,
  idSchema,
  type CreateWorkspaceInput,
  type WorkspaceHandle,
  type WorkspacePurpose,
  type WorkspaceStatus,
} from '@zapp/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { SandboxServiceApp } from '../app.js';

const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);

export const WorkspaceLifecycleRowSchema = z
  .object({
    id: idSchema('ws'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    branchId: idSchema('br').nullable(),
    provider: z.literal('modal'),
    providerWorkspaceId: z.string().min(1).nullable(),
    status: WorkspaceStatusSchema,
    resourceProfile: ResourceProfileSchema,
    snapshotRef: z.string().nullable(),
    createdAt: z.coerce.date(),
    lastActiveAt: z.coerce.date().nullable(),
    terminatedAt: z.coerce.date().nullable(),
  })
  .strict();
export type WorkspaceLifecycleRow = z.infer<typeof WorkspaceLifecycleRowSchema>;

const RequestedWorkspaceRowSchema = WorkspaceLifecycleRowSchema.extend({
  branchId: idSchema('br'),
  providerWorkspaceId: z.null(),
  status: z.literal('requested'),
  snapshotRef: z.null(),
  lastActiveAt: z.null(),
  terminatedAt: z.null(),
}).strict();

export const WorkspaceRowIdempotencyKeySchema = z
  .object({
    runId: idSchema('run'),
    taskId: idSchema('task'),
    purpose: WorkspacePurposeSchema,
  })
  .strict();
export type WorkspaceRowIdempotencyKey = z.infer<typeof WorkspaceRowIdempotencyKeySchema>;

export interface WorkspaceRowClaim {
  readonly created: boolean;
  /** On a replay, the boundary waits until the original row has a provider identity. */
  readonly row: WorkspaceLifecycleRow;
}

/** Durable row operations are injected so CP-9's tenant repository remains the row owner. */
export interface WorkspaceRowBoundary {
  claimCreate(
    row: WorkspaceLifecycleRow,
    key: WorkspaceRowIdempotencyKey,
  ): Promise<WorkspaceRowClaim>;
  get(workspaceId: string): Promise<WorkspaceLifecycleRow | undefined>;
  transition(
    workspaceId: string,
    status: WorkspaceStatus,
    patch?: { readonly providerWorkspaceId?: string; readonly terminatedAt?: Date },
  ): Promise<WorkspaceLifecycleRow>;
}

export interface WorkspaceLifecycleProvider {
  readonly lockedImageTag: string;
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceHandle>;
  terminateWorkspace(providerWorkspaceId: string): Promise<void>;
  getStatus(providerWorkspaceId: string): Promise<WorkspaceStatus>;
}

const CreateWorkspaceBodySchema = z
  .object({
    workspace: RequestedWorkspaceRowSchema,
    runId: idSchema('run'),
    taskId: idSchema('task'),
    purpose: WorkspacePurposeSchema,
    env: EnvVarsSchema,
    networkProfile: NetworkProfileSchema,
    operationKey: OperationKeySchema,
  })
  .strict();
const WorkspaceParamsSchema = z.object({ workspaceId: idSchema('ws') }).strict();
const TerminateBodySchema = z.object({ operationKey: OperationKeySchema }).strict();
const WorkspaceResponseSchema = z.object({ workspace: WorkspaceLifecycleRowSchema }).strict();
const StatusResponseSchema = z
  .object({ workspace: WorkspaceLifecycleRowSchema, providerStatus: WorkspaceStatusSchema })
  .strict();

function requireIdempotencyKey(header: string | string[] | undefined, operationKey: string): void {
  if (typeof header !== 'string' || !OperationKeySchema.safeParse(header).success) {
    throw Object.assign(new Error('A valid idempotency key is required.'), { statusCode: 400 });
  }
  if (header !== operationKey) {
    throw Object.assign(new Error('Idempotency key does not match the request.'), {
      statusCode: 400,
    });
  }
}

function createInputFor(
  row: WorkspaceLifecycleRow,
  body: z.infer<typeof CreateWorkspaceBodySchema>,
  lockedImageTag: string,
): CreateWorkspaceInput {
  return CreateWorkspaceInputSchema.parse({
    organizationId: row.organizationId,
    projectId: row.projectId,
    branchId: RequestedWorkspaceRowSchema.parse(row).branchId,
    runId: body.runId,
    taskId: body.taskId,
    purpose: body.purpose,
    resourceProfile: row.resourceProfile,
    imageTag: lockedImageTag,
    env: body.env,
    networkProfile: body.networkProfile,
  });
}

export function registerWorkspaceRoutes(
  app: SandboxServiceApp,
  deps: {
    readonly provider: WorkspaceLifecycleProvider;
    readonly rows: WorkspaceRowBoundary;
    readonly now: () => Date;
  },
): void {
  app.post(
    '/internal/workspaces',
    {
      preHandler: app.requireService,
      schema: {
        body: CreateWorkspaceBodySchema,
        response: { 200: WorkspaceResponseSchema, 201: WorkspaceResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CreateWorkspaceBodySchema.parse(request.body);
      requireIdempotencyKey(request.headers['idempotency-key'], body.operationKey);
      const key = WorkspaceRowIdempotencyKeySchema.parse({
        runId: body.runId,
        taskId: body.taskId,
        purpose: body.purpose,
      });
      const input = createInputFor(body.workspace, body, deps.provider.lockedImageTag);
      const claim = await deps.rows.claimCreate(body.workspace, key);
      if (!claim.created) {
        if (claim.row.providerWorkspaceId === null) {
          throw Object.assign(new Error('Original workspace creation did not resolve.'), {
            statusCode: 502,
          });
        }
        return await reply.status(200).send({ workspace: claim.row });
      }

      await deps.rows.transition(claim.row.id, 'provisioning');
      const untrustedHandle = await deps.provider.createWorkspace(input);
      const providerWorkspaceId = z
        .object({ providerWorkspaceId: z.string().min(1) })
        .passthrough()
        .parse(untrustedHandle).providerWorkspaceId;
      try {
        const handle = WorkspaceHandleSchema.strict().parse(untrustedHandle);
        if (
          handle.status !== 'ready' ||
          handle.imageTag !== deps.provider.lockedImageTag ||
          handle.resourceProfile !== claim.row.resourceProfile
        ) {
          throw new Error('Workspace provider returned a mismatched handle.');
        }
        await deps.rows.transition(claim.row.id, 'started', {
          providerWorkspaceId: handle.providerWorkspaceId,
        });
        const providerStatus = await deps.provider.getStatus(handle.providerWorkspaceId);
        if (providerStatus !== 'ready') {
          throw new Error('Workspace provider did not become ready.');
        }
        const ready = await deps.rows.transition(claim.row.id, 'ready');
        return await reply.status(201).send({ workspace: ready });
      } catch (error) {
        await deps.provider.terminateWorkspace(providerWorkspaceId);
        if ((await deps.provider.getStatus(providerWorkspaceId)) !== 'terminated') {
          throw Object.assign(new Error('Workspace create compensation was not confirmed.'), {
            statusCode: 502,
            cause: error,
          });
        }
        await deps.rows.transition(claim.row.id, 'terminated', {
          providerWorkspaceId,
          terminatedAt: deps.now(),
        });
        throw Object.assign(new Error('Workspace creation did not persist safely.'), {
          statusCode: 502,
          cause: error,
        });
      }
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId',
    {
      preHandler: app.requireService,
      schema: {
        params: WorkspaceParamsSchema,
        response: { 200: StatusResponseSchema },
      },
    },
    async (request: FastifyRequest) => {
      const params = WorkspaceParamsSchema.parse(request.params);
      const row = await deps.rows.get(params.workspaceId);
      if (row === undefined) {
        throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
      }
      const providerStatus =
        row.providerWorkspaceId === null
          ? row.status
          : await deps.provider.getStatus(row.providerWorkspaceId);
      return { workspace: row, providerStatus };
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/terminate',
    {
      preHandler: app.requireService,
      schema: {
        params: WorkspaceParamsSchema,
        body: TerminateBodySchema,
        response: { 200: WorkspaceResponseSchema },
      },
    },
    async (request: FastifyRequest) => {
      const params = WorkspaceParamsSchema.parse(request.params);
      const body = TerminateBodySchema.parse(request.body);
      requireIdempotencyKey(request.headers['idempotency-key'], body.operationKey);
      const row = await deps.rows.get(params.workspaceId);
      if (row === undefined) {
        throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
      }
      if (row.status === 'terminated') return { workspace: row };
      if (row.providerWorkspaceId !== null) {
        await deps.provider.terminateWorkspace(row.providerWorkspaceId);
        if ((await deps.provider.getStatus(row.providerWorkspaceId)) !== 'terminated') {
          throw Object.assign(new Error('Workspace provider termination was not confirmed.'), {
            statusCode: 502,
          });
        }
      }
      const terminated = await deps.rows.transition(row.id, 'terminated', {
        terminatedAt: deps.now(),
      });
      return { workspace: terminated };
    },
  );
}

export type { WorkspacePurpose };
