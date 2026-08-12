import { CommitShaSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { OperationKeySchema } from '../orchestrator/port.js';
import { actorOf } from '../plugins/auth.js';
import type { AuditHook } from '../plugins/audit.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { IntegrationConnectionSchema } from '../tenant/view.js';
import { operationOf } from './runs.js';
import { GitHubSyncPolicySchema, GitHubSyncRelationSchema } from '../integrations/github/sync.js';

const GitHubBody = z.object({ installationId: z.string().trim().min(1).max(200), state: z.string().trim().min(1).max(500), code: z.string().trim().min(1).max(10_000) }).strict();
const SupabaseBody = z.object({ projectId: idSchema('proj'), accessToken: z.string().trim().min(1).max(10_000), configuration: z.object({ projectRef: z.string().trim().min(1).max(200) }).strict() }).strict();
const NeonBody = z.object({ projectId: idSchema('proj'), apiKey: z.string().trim().min(1).max(10_000), configuration: z.object({ projectId: z.string().trim().min(1).max(200), databaseName: z.string().min(1).max(63).regex(/^[a-z_][a-z0-9_]*$/u) }).strict() }).strict();
const StripeBody = z.object({ projectId: idSchema('proj'), apiKey: z.string().trim().min(1).max(10_000), configuration: z.object({ accountId: z.string().trim().min(1).max(200), mode: z.enum(['test', 'live']) }).strict() }).strict();
const IntegrationStatusSchema = IntegrationConnectionSchema.omit({ credentialRef: true }).strict();

const IntegrationInputSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('github'), organizationId: idSchema('org'), projectId: z.null(), actorId: idSchema('user'), operationKey: OperationKeySchema, credential: z.string().min(1), configuration: z.object({ installationId: z.string().min(1) }).strict(), state: z.string().min(1) }).strict(),
  z.object({ provider: z.literal('supabase'), organizationId: idSchema('org'), projectId: idSchema('proj'), actorId: idSchema('user'), operationKey: OperationKeySchema, credential: z.string().min(1), configuration: z.object({ projectRef: z.string().min(1) }).strict() }).strict(),
  z.object({ provider: z.literal('neon'), organizationId: idSchema('org'), projectId: idSchema('proj'), actorId: idSchema('user'), operationKey: OperationKeySchema, credential: z.string().min(1), configuration: z.object({ projectId: z.string().min(1), databaseName: z.string().min(1).max(63).regex(/^[a-z_][a-z0-9_]*$/u) }).strict() }).strict(),
  z.object({ provider: z.literal('stripe'), organizationId: idSchema('org'), projectId: idSchema('proj'), actorId: idSchema('user'), operationKey: OperationKeySchema, credential: z.string().min(1), configuration: z.object({ accountId: z.string().min(1), mode: z.enum(['test', 'live']) }).strict() }).strict(),
]);
export type IntegrationInput = z.infer<typeof IntegrationInputSchema>;
export type IntegrationMutationInput = IntegrationInput & {
  readonly audit: AuditHook<z.infer<typeof IntegrationConnectionSchema>>;
};
export interface IntegrationPort {
  connect(input: IntegrationMutationInput): Promise<z.infer<typeof IntegrationConnectionSchema>>;
}
export function createUnavailableIntegrationPort(): IntegrationPort { return { connect: () => Promise.reject(new Error('integration service unavailable')) }; }
const GitHubSyncResultSchema = z.object({
  action: z.literal('inbound'),
  state: GitHubSyncRelationSchema,
  internalHeadSha: CommitShaSchema,
  externalHeadSha: CommitShaSchema,
  blockedTaskIds: z.array(idSchema('task')),
  conflictCreated: z.boolean(),
}).strict();
const GitHubExportResultSchema = z.object({
  externalRepoRef: z.string().min(1),
  repositoryUrl: z.string().url(),
  syncPolicy: GitHubSyncPolicySchema,
  internalHeadSha: CommitShaSchema,
  externalHeadSha: CommitShaSchema,
}).strict();
const GitHubSyncStateResponseSchema = z.object({
  projectId: idSchema('proj'),
  externalRepoRef: z.string().nullable(),
  syncPolicy: GitHubSyncPolicySchema,
  branch: z.string().nullable(),
  internalHeadSha: CommitShaSchema.nullable(),
  externalHeadSha: CommitShaSchema.nullable(),
  state: GitHubSyncRelationSchema.nullable(),
  blockedTaskIds: z.array(idSchema('task')),
  conflictTaskId: idSchema('task').nullable(),
  updatedAt: z.string().datetime().nullable(),
}).strict();
export interface GitHubControlsPort {
  refreshProject(input: { organizationId: string; projectId: string; operationKey: string }): Promise<z.infer<typeof GitHubSyncResultSchema>>;
  exportProject(input: { organizationId: string; projectId: string; installationId: string; repositoryName: string; private: boolean; syncPolicy: 'direct_push' | 'pull_request'; operationKey: string }): Promise<z.infer<typeof GitHubExportResultSchema>>;
}
export interface IntegrationRoutesDeps { readonly port: IntegrationPort; readonly githubControls?: GitHubControlsPort; }

export function registerIntegrationRoutes(app: AppInstance, deps: IntegrationRoutesDeps): void {
  app.get('/v1/projects/:projectId/integrations/github', { preHandler: [app.requireSession, app.requireTenant], schema: { params: z.object({ projectId: idSchema('proj') }), response: { 200: GitHubSyncStateResponseSchema } } }, async (request) => {
    const ctx = tenantOf(request);
    authorize(ctx, 'view_project');
    const repository = await ctx.db.repositories.forProject(request.params.projectId);
    if (repository === undefined) throw projectNotFound();
    const connection = (await ctx.db.integrations.list()).find((candidate) => candidate.provider === 'github' && candidate.projectId === repository.projectId);
    const configuration = connection?.configuration;
    const state = configuration !== undefined && 'state' in configuration ? configuration : undefined;
    return GitHubSyncStateResponseSchema.parse({
      projectId: repository.projectId,
      externalRepoRef: repository.externalRepoRef,
      syncPolicy: GitHubSyncPolicySchema.parse(repository.syncPolicy),
      branch: state?.branch ?? null,
      internalHeadSha: state?.internalHeadSha ?? null,
      externalHeadSha: state?.externalHeadSha ?? null,
      state: state?.state ?? null,
      blockedTaskIds: state?.blockedTaskIds ?? [],
      conflictTaskId: state?.conflictTaskId ?? null,
      updatedAt: state?.updatedAt ?? null,
    });
  });
  app.patch('/v1/projects/:projectId/integrations/github/policy', { preHandler: [app.requireSession, app.requireCsrf, app.requireTenant], schema: { params: z.object({ projectId: idSchema('proj') }), body: z.object({ syncPolicy: GitHubSyncPolicySchema }).strict(), response: { 200: GitHubSyncStateResponseSchema } } }, async (request) => {
    const ctx = tenantOf(request);
    authorize(ctx, 'manage_organization');
    const operationKey = operationOf(request);
    const repository = await ctx.db.repositories.setSyncPolicy({
      projectId: request.params.projectId,
      syncPolicy: request.body.syncPolicy,
      audit: async (tx, updated) => { await request.audit(tx, { organizationId: ctx.organizationId, action: 'integration.github_policy_updated', target: { type: 'project', id: updated.projectId }, metadata: { syncPolicy: updated.syncPolicy, operationKey } }); },
    });
    if (repository === undefined) throw projectNotFound();
    const connection = (await ctx.db.integrations.list()).find((candidate) => candidate.provider === 'github' && candidate.projectId === repository.projectId);
    const configuration = connection?.configuration;
    const state = configuration !== undefined && 'state' in configuration ? configuration : undefined;
    return GitHubSyncStateResponseSchema.parse({ projectId: repository.projectId, externalRepoRef: repository.externalRepoRef, syncPolicy: request.body.syncPolicy, branch: state?.branch ?? null, internalHeadSha: state?.internalHeadSha ?? null, externalHeadSha: state?.externalHeadSha ?? null, state: state?.state ?? null, blockedTaskIds: state?.blockedTaskIds ?? [], conflictTaskId: state?.conflictTaskId ?? null, updatedAt: state?.updatedAt ?? null });
  });
  app.post('/v1/projects/:projectId/integrations/github/sync', { preHandler: [app.requireSession, app.requireCsrf, app.requireTenant], schema: { params: z.object({ projectId: idSchema('proj') }), response: { 200: GitHubSyncResultSchema } } }, async (request) => {
    const ctx = tenantOf(request);
    authorize(ctx, 'edit_code');
    if (await ctx.db.repositories.forProject(request.params.projectId) === undefined) throw projectNotFound();
    if (deps.githubControls === undefined) throw integrationServiceFailed();
    const operationKey = operationOf(request);
    const result = GitHubSyncResultSchema.parse(await deps.githubControls.refreshProject({ organizationId: ctx.organizationId, projectId: request.params.projectId, operationKey }));
    await request.auditDetached({ organizationId: ctx.organizationId, action: 'integration.github_sync_requested', target: { type: 'project', id: request.params.projectId }, metadata: { operationKey, state: result.state, conflictCreated: result.conflictCreated } });
    return result;
  });
  app.post('/v1/projects/:projectId/integrations/github/export', { preHandler: [app.requireSession, app.requireCsrf, app.requireTenant], schema: { params: z.object({ projectId: idSchema('proj') }), body: z.object({ installationId: z.string().min(1).max(200), repositoryName: z.string().regex(/^[A-Za-z0-9._-]+$/u).max(100), private: z.boolean(), syncPolicy: GitHubSyncPolicySchema }).strict(), response: { 201: GitHubExportResultSchema } } }, async (request, reply) => {
    const ctx = tenantOf(request);
    authorize(ctx, 'manage_organization');
    if (await ctx.db.repositories.forProject(request.params.projectId) === undefined) throw projectNotFound();
    if (deps.githubControls === undefined) throw integrationServiceFailed();
    const operationKey = operationOf(request);
    const result = GitHubExportResultSchema.parse(await deps.githubControls.exportProject({ organizationId: ctx.organizationId, projectId: request.params.projectId, operationKey, ...request.body }));
    await request.auditDetached({ organizationId: ctx.organizationId, action: 'integration.github_exported', target: { type: 'project', id: request.params.projectId }, metadata: { operationKey, externalRepoRef: result.externalRepoRef, syncPolicy: result.syncPolicy } });
    return await reply.status(201).send(result);
  });
  app.get('/v1/integrations', { preHandler: [app.requireSession, app.requireTenant], schema: { response: { 200: z.object({ connections: z.array(IntegrationStatusSchema).max(1_000) }).strict() } } }, async (request) => {
    const ctx = tenantOf(request);
    authorize(ctx, 'manage_organization');
    const connections = (await ctx.db.integrations.list()).map((connection) => ({
      id: connection.id,
      organizationId: connection.organizationId,
      projectId: connection.projectId,
      provider: connection.provider,
      status: connection.status,
      configuration: connection.configuration,
    }));
    return { connections };
  });
  app.delete('/v1/integrations/:connectionId', { preHandler: [app.requireSession, app.requireCsrf, app.requireTenant], schema: { params: z.object({ connectionId: idSchema('intc') }), response: { 204: z.void() } } }, async (request, reply) => {
    const ctx = tenantOf(request);
    authorize(ctx, 'manage_organization');
    const operationKey = operationOf(request);
    const disconnected = await ctx.db.integrations.disconnect({
      connectionId: request.params.connectionId,
      audit: async (tx, connection) => {
        await request.audit(tx, {
          organizationId: ctx.organizationId,
          action: 'integration.disconnected',
          target: { type: 'integration_connection', id: connection.id },
          metadata: { provider: connection.provider, projectId: connection.projectId, operationKey },
        });
      },
    });
    if (disconnected === undefined) throw new ApiError('integration_not_found', 404, 'That integration does not exist.');
    return await reply.status(204).send();
  });
  app.post('/v1/integrations/github/install', { preHandler: [app.requireSession, app.requireCsrf, app.requireTenant], schema: { body: GitHubBody, response: { 201: z.object({ connection: IntegrationConnectionSchema }).strict() } } }, async (request, reply) => {
    const ctx = tenantOf(request);
    authorize(ctx, 'manage_organization');
    const operationKey = operationOf(request);
    const input = IntegrationInputSchema.parse({ provider: 'github', organizationId: ctx.organizationId, projectId: null, actorId: actorOf(request), operationKey, credential: request.body.code, state: request.body.state, configuration: { installationId: request.body.installationId } });
    const connection = await connect(deps.port, {
      ...input,
      audit: async (tx, connection) => {
        assertIntegrationIdentity(connection, input);
        await request.audit(tx, {
          organizationId: ctx.organizationId,
          action: 'integration.connected',
          target: { type: 'integration_connection', id: connection.id },
          metadata: { provider: connection.provider, projectId: null, operationKey },
        });
      },
    });
    return await reply.status(201).send({ connection });
  });
  registerProjectConnection(app, deps, 'supabase', SupabaseBody);
  registerProjectConnection(app, deps, 'neon', NeonBody);
  registerProjectConnection(app, deps, 'stripe', StripeBody);
}

function registerProjectConnection(app: AppInstance, deps: IntegrationRoutesDeps, provider: 'supabase' | 'neon' | 'stripe', body: z.ZodTypeAny): void {
  app.post(`/v1/integrations/${provider}/connect`, { preHandler: [app.requireSession, app.requireCsrf, app.requireTenant], schema: { body, response: { 201: z.object({ connection: IntegrationConnectionSchema }).strict() } } }, async (request, reply) => {
    const ctx = tenantOf(request);
    const parsed = body.parse(request.body) as z.infer<typeof SupabaseBody> | z.infer<typeof NeonBody> | z.infer<typeof StripeBody>;
    const project = await ctx.db.projects.getById(parsed.projectId);
    if (project === undefined) throw projectNotFound();
    authorize(ctx, 'edit_code');
    const credential = 'accessToken' in parsed ? parsed.accessToken : parsed.apiKey;
    const operationKey = operationOf(request);
    const input = IntegrationInputSchema.parse({ provider, organizationId: ctx.organizationId, projectId: project.id, actorId: actorOf(request), operationKey, credential, configuration: parsed.configuration });
    const connection = await connect(deps.port, {
      ...input,
      audit: async (tx, connection) => {
        assertIntegrationIdentity(connection, input);
        await request.audit(tx, {
          organizationId: ctx.organizationId,
          action: 'integration.connected',
          target: { type: 'integration_connection', id: connection.id },
          metadata: { provider: connection.provider, projectId: connection.projectId, operationKey, ...(provider === 'stripe' ? { credentialScope: 'generated_app' } : {}) },
        });
      },
    });
    return await reply.status(201).send({ connection });
  });
}

async function connect(port: IntegrationPort, input: IntegrationMutationInput): Promise<z.infer<typeof IntegrationConnectionSchema>> {
  try {
    const result = IntegrationConnectionSchema.parse(await port.connect(input));
    assertIntegrationIdentity(result, input);
    return result;
  } catch { throw integrationServiceFailed(); }
}
function assertIntegrationIdentity(
  result: z.infer<typeof IntegrationConnectionSchema>,
  expected: Pick<IntegrationInput, 'organizationId' | 'projectId' | 'provider'>,
): void {
  if (
    result.organizationId !== expected.organizationId ||
    result.projectId !== expected.projectId ||
    result.provider !== expected.provider
  )
    throw new Error('integration identity mismatch');
}
function projectNotFound(): ApiError { return new ApiError('project_not_found', 404, 'That project does not exist.'); }
function integrationServiceFailed(): ApiError { return new ApiError('integration_service_unavailable', 502, 'The integration service could not complete the request.'); }
