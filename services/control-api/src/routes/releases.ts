import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { OperationKeySchema } from '../orchestrator/port.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import type { PermissionContext } from '../policy/permissions.js';
import { ReleaseSchema } from '../tenant/view.js';
import { operationOf } from './runs.js';

const ProjectParams = z.object({ projectId: idSchema('proj') }).strict();
const ReleaseParams = z.object({ releaseId: idSchema('rel') }).strict();
const CommitShaSchema = z.string().regex(/^[a-f0-9]{7,64}$/);

const CreateReleaseBody = z
  .object({
    environmentId: idSchema('env'),
    commitSha: CommitShaSchema,
    specificationId: idSchema('spec').nullable(),
  })
  .strict();
const DeploymentTypeSchema = z.enum(['first_deploy', 'redeploy', 'replace_deployment']);
const DeployBody = z
  .object({
    deploymentType: DeploymentTypeSchema,
    dataDisposition: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const RollbackBody = z
  .object({
    toDeploymentId: idSchema('dep').optional(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

const ReleaseRowSchema = z
  .object({
    id: idSchema('rel'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    commitSha: CommitShaSchema,
    specificationId: idSchema('spec').nullable(),
    status: z.string().min(1),
    evidenceManifestArtifactId: idSchema('art').nullable(),
    createdBy: idSchema('user'),
    createdAt: z.date(),
  })
  .strict();
const ReadinessSchema = z
  .object({
    state: z.enum(['ready', 'warnings', 'blocked']),
    findings: z.array(
      z
        .object({
          id: z.string().min(1),
          severity: z.enum(['blocker', 'warning']),
          title: z.string().min(1),
          detail: z.string().min(1),
          action: z.enum(['fix_and_recheck', 'review', 'waive']),
        })
        .strict(),
    ),
  })
  .strict();
const EvidenceSectionSchema = z
  .object({ status: z.enum(['passed', 'failed', 'skipped', 'not_required']) })
  .strict();
const EvidenceManifestSchema = z
  .object({
    release_id: idSchema('rel'),
    commit_sha: CommitShaSchema,
    specification_version: z.number().int().positive(),
    criteria: z.array(z.object({ id: z.string().min(1), status: z.enum(['passed', 'failed']) }).strict()),
    build: EvidenceSectionSchema,
    typecheck: EvidenceSectionSchema,
    tests: EvidenceSectionSchema,
    browser_tests: EvidenceSectionSchema,
    security: EvidenceSectionSchema,
    migration: EvidenceSectionSchema,
    preview: z.object({ url: z.string().url() }).strict(),
    rollback: z.object({ supported: z.boolean() }).strict(),
    known_risks: z.array(z.object({ id: z.string().min(1), detail: z.string().min(1) }).strict()),
  })
  .strict();

const CreateReleaseInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    commitSha: CommitShaSchema,
    specificationId: idSchema('spec').nullable(),
    actorId: idSchema('user'),
    operationKey: OperationKeySchema,
  })
  .strict();
const ReleaseLookupInputSchema = z.object({ organizationId: idSchema('org'), releaseId: idSchema('rel') }).strict();
const ReleaseMutationInputSchema = ReleaseLookupInputSchema.extend({ actorId: idSchema('user'), operationKey: OperationKeySchema }).strict();
const DeployInputSchema = ReleaseMutationInputSchema.extend({
  deploymentType: DeploymentTypeSchema,
  confirmation: z.object({ dataDisposition: z.string().trim().min(1).max(200).nullable() }).strict(),
}).strict();
const RollbackInputSchema = ReleaseMutationInputSchema.extend({
  toDeploymentId: idSchema('dep').nullable(),
  reason: z.string().trim().min(1).max(2_000),
}).strict();

/** Temporary Plan 07 DEP-1 boundary. Implementations commit release state and audit together. */
export interface ReleasePort {
  createReleaseCandidate(input: z.infer<typeof CreateReleaseInputSchema>): Promise<unknown>;
  getRelease(input: z.infer<typeof ReleaseLookupInputSchema>): Promise<unknown>;
  getReadiness(input: z.infer<typeof ReleaseLookupInputSchema>): Promise<unknown>;
  approve(input: z.infer<typeof ReleaseMutationInputSchema>): Promise<unknown>;
  deploy(input: z.infer<typeof DeployInputSchema>): Promise<unknown>;
  rollback(input: z.infer<typeof RollbackInputSchema>): Promise<unknown>;
  getEvidence(input: z.infer<typeof ReleaseLookupInputSchema>): Promise<unknown>;
}

export interface ReleaseRoutesDeps {
  readonly port: ReleasePort;
  readonly permissionContextFor: (organizationId: string) => Promise<PermissionContext>;
}

export function createUnavailableReleasePort(): ReleasePort {
  const unavailable = (): Promise<never> => Promise.reject(new Error('release service unavailable'));
  return { createReleaseCandidate: unavailable, getRelease: unavailable, getReadiness: unavailable, approve: unavailable, deploy: unavailable, rollback: unavailable, getEvidence: unavailable };
}

export function registerReleaseRoutes(app: AppInstance, deps: ReleaseRoutesDeps): void {
  app.post('/v1/projects/:projectId/releases', {
    preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
    schema: { params: ProjectParams, body: CreateReleaseBody, response: { 201: z.object({ release: ReleaseSchema }).strict() } },
  }, async (request, reply) => {
    const ctx = tenantOf(request);
    const project = await ctx.db.projects.getById(request.params.projectId);
    if (project === undefined) throw projectNotFound();
    authorize(ctx, 'edit_code');
    const row = await portResult(() => deps.port.createReleaseCandidate(CreateReleaseInputSchema.parse({ organizationId: ctx.organizationId, projectId: project.id, ...request.body, actorId: actorOf(request), operationKey: operationOf(request) })), ReleaseRowSchema);
    return await reply.status(201).send({ release: releaseView(row) });
  });

  app.get('/v1/releases/:releaseId', {
    preHandler: [app.requireSession, app.requireTenant],
    schema: { params: ReleaseParams, response: { 200: z.object({ release: ReleaseSchema, readiness: ReadinessSchema }).strict() } },
  }, async (request) => {
    const ctx = tenantOf(request);
    const row = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
    authorize(ctx, 'view_project');
    const readiness = await portResult(() => deps.port.getReadiness({ organizationId: ctx.organizationId, releaseId: row.id }), ReadinessSchema);
    return { release: releaseView(row), readiness };
  });

  app.post('/v1/releases/:releaseId/approve', {
    preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
    schema: { params: ReleaseParams, response: { 200: z.object({ release: ReleaseSchema }).strict() } },
  }, async (request) => {
    const ctx = tenantOf(request);
    const row = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
    authorize(ctx, 'approve_production_deploy', await permissionContext(deps, ctx.organizationId));
    const approved = await portResult(() => deps.port.approve({ organizationId: ctx.organizationId, releaseId: row.id, actorId: actorOf(request), operationKey: operationOf(request) }), ReleaseRowSchema);
    return { release: releaseView(approved) };
  });

  app.post('/v1/releases/:releaseId/deploy', {
    preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
    schema: { params: ReleaseParams, body: DeployBody, response: { 200: z.object({ deploymentId: idSchema('dep') }).strict() } },
  }, async (request) => {
    const ctx = tenantOf(request);
    const row = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
    authorize(ctx, 'approve_production_deploy', await permissionContext(deps, ctx.organizationId));
    if (request.body.deploymentType === 'replace_deployment' && request.body.dataDisposition === undefined) throw dataDispositionRequired();
    return await portResult(() => deps.port.deploy(DeployInputSchema.parse({ organizationId: ctx.organizationId, releaseId: row.id, actorId: actorOf(request), operationKey: operationOf(request), deploymentType: request.body.deploymentType, confirmation: { dataDisposition: request.body.dataDisposition ?? null } })), z.object({ deploymentId: idSchema('dep') }).strict());
  });

  app.post('/v1/releases/:releaseId/rollback', {
    preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
    schema: { params: ReleaseParams, body: RollbackBody, response: { 200: z.object({ deploymentId: idSchema('dep') }).strict() } },
  }, async (request) => {
    const ctx = tenantOf(request);
    const row = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
    authorize(ctx, 'approve_production_deploy', await permissionContext(deps, ctx.organizationId));
    return await portResult(() => deps.port.rollback(RollbackInputSchema.parse({ organizationId: ctx.organizationId, releaseId: row.id, actorId: actorOf(request), operationKey: operationOf(request), toDeploymentId: request.body.toDeploymentId ?? null, reason: request.body.reason })), z.object({ deploymentId: idSchema('dep') }).strict());
  });

  app.get('/v1/releases/:releaseId/evidence', {
    preHandler: [app.requireSession, app.requireTenant],
    schema: { params: ReleaseParams, response: { 200: z.object({ evidence: EvidenceManifestSchema }).strict() } },
  }, async (request) => {
    const ctx = tenantOf(request);
    const row = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
    authorize(ctx, 'view_project');
    return { evidence: await portResult(() => deps.port.getEvidence({ organizationId: ctx.organizationId, releaseId: row.id }), EvidenceManifestSchema) };
  });
}

async function releaseFor(port: ReleasePort, organizationId: string, releaseId: string): Promise<z.infer<typeof ReleaseRowSchema>> {
  let raw: unknown;
  try {
    raw = await port.getRelease({ organizationId, releaseId });
  } catch {
    throw releaseServiceFailed();
  }
  if (raw === undefined || raw === null) throw releaseNotFound();
  let result: z.infer<typeof ReleaseRowSchema>;
  try {
    result = ReleaseRowSchema.parse(raw);
  } catch {
    throw releaseServiceFailed();
  }
  if (result.organizationId !== organizationId) throw releaseNotFound();
  return result;
}
async function portResult<T>(work: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  try { return schema.parse(await work()); } catch { throw releaseServiceFailed(); }
}
async function permissionContext(deps: ReleaseRoutesDeps, organizationId: string): Promise<PermissionContext> {
  try { return await deps.permissionContextFor(organizationId); } catch { throw releaseServiceFailed(); }
}
function releaseView(row: z.infer<typeof ReleaseRowSchema>): z.infer<typeof ReleaseSchema> {
  return ReleaseSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}
function projectNotFound(): ApiError { return new ApiError('project_not_found', 404, 'That project does not exist.'); }
function releaseNotFound(): ApiError { return new ApiError('release_not_found', 404, 'That release does not exist.'); }
function dataDispositionRequired(): ApiError { return new ApiError('data_disposition_required', 422, 'Replacing a deployment requires a data disposition.'); }
function releaseServiceFailed(): ApiError { return new ApiError('release_service_unavailable', 502, 'The release service could not complete the request.'); }
