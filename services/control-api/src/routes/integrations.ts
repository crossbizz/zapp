import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { OperationKeySchema } from '../orchestrator/port.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { IntegrationConnectionSchema } from '../tenant/view.js';
import { operationOf } from './runs.js';

const GitHubBody = z.object({ installationId: z.string().trim().min(1).max(200), state: z.string().trim().min(1).max(500), code: z.string().trim().min(1).max(10_000) }).strict();
const SupabaseBody = z.object({ projectId: idSchema('proj'), accessToken: z.string().trim().min(1).max(10_000), configuration: z.object({ projectRef: z.string().trim().min(1).max(200) }).strict() }).strict();
const NeonBody = z.object({ projectId: idSchema('proj'), apiKey: z.string().trim().min(1).max(10_000), configuration: z.object({ projectId: z.string().trim().min(1).max(200) }).strict() }).strict();
const StripeBody = z.object({ projectId: idSchema('proj'), apiKey: z.string().trim().min(1).max(10_000), configuration: z.object({ accountId: z.string().trim().min(1).max(200), mode: z.enum(['test', 'live']) }).strict() }).strict();

const IntegrationInputSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('github'), organizationId: idSchema('org'), projectId: z.null(), actorId: idSchema('user'), operationKey: OperationKeySchema, credential: z.string().min(1), configuration: z.object({ installationId: z.string().min(1) }).strict(), state: z.string().min(1) }).strict(),
  z.object({ provider: z.literal('supabase'), organizationId: idSchema('org'), projectId: idSchema('proj'), actorId: idSchema('user'), operationKey: OperationKeySchema, credential: z.string().min(1), configuration: z.object({ projectRef: z.string().min(1) }).strict() }).strict(),
  z.object({ provider: z.literal('neon'), organizationId: idSchema('org'), projectId: idSchema('proj'), actorId: idSchema('user'), operationKey: OperationKeySchema, credential: z.string().min(1), configuration: z.object({ projectId: z.string().min(1) }).strict() }).strict(),
  z.object({ provider: z.literal('stripe'), organizationId: idSchema('org'), projectId: idSchema('proj'), actorId: idSchema('user'), operationKey: OperationKeySchema, credential: z.string().min(1), configuration: z.object({ accountId: z.string().min(1), mode: z.enum(['test', 'live']) }).strict() }).strict(),
]);
export interface IntegrationPort { connect(input: z.infer<typeof IntegrationInputSchema>): Promise<unknown>; }
export function createUnavailableIntegrationPort(): IntegrationPort { return { connect: () => Promise.reject(new Error('integration service unavailable')) }; }
export interface IntegrationRoutesDeps { readonly port: IntegrationPort; }

export function registerIntegrationRoutes(app: AppInstance, deps: IntegrationRoutesDeps): void {
  app.post('/v1/integrations/github/install', { preHandler: [app.requireSession, app.requireCsrf, app.requireTenant], schema: { body: GitHubBody, response: { 201: z.object({ connection: IntegrationConnectionSchema }).strict() } } }, async (request, reply) => {
    const ctx = tenantOf(request);
    authorize(ctx, 'manage_organization');
    const connection = await connect(deps.port, IntegrationInputSchema.parse({ provider: 'github', organizationId: ctx.organizationId, projectId: null, actorId: actorOf(request), operationKey: operationOf(request), credential: request.body.code, state: request.body.state, configuration: { installationId: request.body.installationId } }));
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
    const connection = await connect(deps.port, IntegrationInputSchema.parse({ provider, organizationId: ctx.organizationId, projectId: project.id, actorId: actorOf(request), operationKey: operationOf(request), credential, configuration: parsed.configuration }));
    return await reply.status(201).send({ connection });
  });
}

async function connect(port: IntegrationPort, input: z.infer<typeof IntegrationInputSchema>): Promise<z.infer<typeof IntegrationConnectionSchema>> {
  try { return IntegrationConnectionSchema.parse(await port.connect(input)); } catch { throw integrationServiceFailed(); }
}
function projectNotFound(): ApiError { return new ApiError('project_not_found', 404, 'That project does not exist.'); }
function integrationServiceFailed(): ApiError { return new ApiError('integration_service_unavailable', 502, 'The integration service could not complete the request.'); }
