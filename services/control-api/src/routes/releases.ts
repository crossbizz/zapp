import type { ProductAnalytics } from '@zapp/config';
import { CommitShaSchema, idSchema, RunModeSchema } from '@zapp/contracts';
import { EvidenceManifestSchema } from '@zapp/verification-engine';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { OperationKeySchema } from '../orchestrator/port.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import type { PermissionContext } from '../policy/permissions.js';
import type { DeploymentUsagePort } from '../usage/collectors/git.js';
import { ReleaseSchema } from '../tenant/view.js';
import { operationOf } from './runs.js';

const ProjectParams = z.object({ projectId: idSchema('proj') }).strict();
const ReleaseParams = z.object({ releaseId: idSchema('rel') }).strict();
const CommitCreatedPayloadSchema = z
  .object({
    commitSha: CommitShaSchema,
    message: z.string().min(1).max(10_000),
    diffstat: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4_096),
            additions: z.number().int().nonnegative(),
            deletions: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(10_000),
    mode: RunModeSchema,
  })
  .strict();

const CreateReleaseBody = z
  .object({
    environmentId: idSchema('env'),
    commitSha: CommitShaSchema,
    specificationId: idSchema('spec').nullable(),
  })
  .strict();
const DeploymentTypeSchema = z.enum(['first_deploy', 'redeploy', 'replace_deployment']);
const DataDispositionSchema = z.enum(['preserve', 'transfer', 'reset']);
const DeployBody = z
  .object({
    deploymentType: DeploymentTypeSchema,
    dataDisposition: DataDispositionSchema.optional(),
  })
  .strict();
const RollbackBody = z
  .object({
    toDeploymentId: idSchema('dep').optional(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();
const ForkBody = z.object({ startFixRun: z.boolean().default(false) }).strict();
export const ForkReleaseResultSchema = z
  .object({
    releaseId: idSchema('rel'),
    branchId: idSchema('br'),
    branchName: z.string().trim().min(1).max(255),
    fixRunId: idSchema('run').nullable(),
  })
  .strict();

export const ReleaseRowSchema = z
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
export const ReadinessSchema = z
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
export { EvidenceManifestSchema } from '@zapp/verification-engine';

export const CreateReleaseInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    commitSha: CommitShaSchema,
    specificationId: idSchema('spec').nullable(),
    actorId: idSchema('user'),
    operationKey: OperationKeySchema,
    resolvedFixRunIds: z.array(idSchema('run')).max(100),
  })
  .strict();
export const ReleaseLookupInputSchema = z
  .object({ organizationId: idSchema('org'), releaseId: idSchema('rel') })
  .strict();
export const ReleaseMutationInputSchema = ReleaseLookupInputSchema.extend({
  actorId: idSchema('user'),
  operationKey: OperationKeySchema,
}).strict();
export const DeployInputSchema = ReleaseMutationInputSchema.extend({
  deploymentType: DeploymentTypeSchema,
  confirmation: z.object({ dataDisposition: DataDispositionSchema.nullable() }).strict(),
}).strict();
export const RollbackInputSchema = ReleaseMutationInputSchema.extend({
  toDeploymentId: idSchema('dep').nullable(),
  reason: z.string().trim().min(1).max(2_000),
}).strict();
export const DeploymentResultSchema = z.object({ deploymentId: idSchema('dep') }).strict();

export type ReleaseRow = z.infer<typeof ReleaseRowSchema>;
export type ReadinessReport = z.infer<typeof ReadinessSchema>;
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;
export type CreateReleaseInput = z.infer<typeof CreateReleaseInputSchema>;
export type ReleaseLookupInput = z.infer<typeof ReleaseLookupInputSchema>;
export type ReleaseMutationInput = z.infer<typeof ReleaseMutationInputSchema>;
export type DeployInput = z.infer<typeof DeployInputSchema>;
export type RollbackInput = z.infer<typeof RollbackInputSchema>;
export type DeploymentResult = z.infer<typeof DeploymentResultSchema>;
export type ForkReleaseResult = z.infer<typeof ForkReleaseResultSchema>;
export type CreateReleaseMutationInput = CreateReleaseInput;
export type ApproveReleaseMutationInput = ReleaseMutationInput;
export type DeployReleaseMutationInput = DeployInput;
export type RollbackReleaseMutationInput = RollbackInput;

/** Temporary Plan 07 DEP-1 boundary. Implementations commit release state and audit together. */
export interface ReleasePort {
  createReleaseCandidate(input: CreateReleaseMutationInput): Promise<ReleaseRow>;
  getRelease(input: ReleaseLookupInput): Promise<ReleaseRow | undefined>;
  getReadiness(input: ReleaseLookupInput): Promise<ReadinessReport>;
  approve(input: ApproveReleaseMutationInput): Promise<ReleaseRow>;
  deploy(input: DeployReleaseMutationInput): Promise<DeploymentResult>;
  rollback(input: RollbackReleaseMutationInput): Promise<DeploymentResult>;
  getEvidence(input: ReleaseLookupInput): Promise<EvidenceManifest>;
}

export interface ReleaseForkPort {
  forkRelease(
    input: ReleaseMutationInput & { readonly startFixRun: boolean },
  ): Promise<ForkReleaseResult>;
}

export interface ReleaseRoutesDeps {
  readonly port: ReleasePort;
  readonly fork?: ReleaseForkPort;
  readonly permissionContextFor: (organizationId: string) => Promise<PermissionContext>;
  readonly deploymentUsage?: DeploymentUsagePort;
  readonly productAnalytics?: ProductAnalytics;
  readonly now: () => Date;
}

export function createUnavailableReleasePort(): ReleasePort {
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error('release service unavailable'));
  return {
    createReleaseCandidate: unavailable,
    getRelease: unavailable,
    getReadiness: unavailable,
    approve: unavailable,
    deploy: unavailable,
    rollback: unavailable,
    getEvidence: unavailable,
  };
}

export function registerReleaseRoutes(app: AppInstance, deps: ReleaseRoutesDeps): void {
  app.post(
    '/v1/projects/:projectId/releases',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ProjectParams,
        body: CreateReleaseBody,
        response: { 201: z.object({ release: ReleaseSchema }).strict() },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      if (
        (await ctx.db.environments.getForProject(project.id, request.body.environmentId)) ===
        undefined
      )
        throw projectNotFound();
      if (
        request.body.specificationId !== null &&
        (await ctx.db.specifications.getForProject(project.id, request.body.specificationId)) ===
          undefined
      )
        throw projectNotFound();
      authorize(ctx, 'edit_code');
      const commitRunModes = new Set<z.infer<typeof RunModeSchema>>();
      const commitRunIds = new Set<string>();
      for (const run of await ctx.db.runs.byProject(project.id)) {
        for (const event of await ctx.db.events.byRun(run.id)) {
          if (event.type !== 'commit.created') continue;
          const payload = CommitCreatedPayloadSchema.safeParse(event.payloadJson);
          if (payload.success && payload.data.commitSha === request.body.commitSha) {
            commitRunModes.add(run.mode);
            commitRunIds.add(run.id);
          }
        }
      }
      if (commitRunModes.has('prototype') && !commitRunModes.has('build')) {
        throw new ApiError(
          'prototype_not_deployable',
          409,
          'Prototype-only commits must be converted to Build before release creation.',
        );
      }
      const operationKey = operationOf(request);
      const expected = {
        organizationId: ctx.organizationId,
        projectId: project.id,
        environmentId: request.body.environmentId,
        specificationId: request.body.specificationId,
        releaseId: null,
      };
      const row = await releaseMutationResult(
        () =>
          deps.port.createReleaseCandidate(
            CreateReleaseInputSchema.parse({
              organizationId: ctx.organizationId,
              projectId: project.id,
              ...request.body,
              actorId: actorOf(request),
              operationKey,
              resolvedFixRunIds: [...commitRunIds],
            }),
          ),
        expected,
      );
      await captureReleaseLifecycle(
        deps,
        ctx,
        actorOf(request),
        'release_created',
        row.id,
        row.projectId,
      );
      return await reply.status(201).send({ release: releaseView(row) });
    },
  );

  app.get(
    '/v1/releases/:releaseId',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: ReleaseParams,
        response: {
          200: z.object({ release: ReleaseSchema, readiness: ReadinessSchema }).strict(),
        },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const row = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
      authorize(ctx, 'view_project');
      const readiness = await portResult(
        () => deps.port.getReadiness({ organizationId: ctx.organizationId, releaseId: row.id }),
        ReadinessSchema,
      );
      return { release: releaseView(row), readiness };
    },
  );

  app.post(
    '/v1/releases/:releaseId/approve',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ReleaseParams,
        response: { 200: z.object({ release: ReleaseSchema }).strict() },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const row = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
      authorize(
        ctx,
        'approve_production_deploy',
        await permissionContext(deps, ctx.organizationId),
      );
      const operationKey = operationOf(request);
      const expected = {
        organizationId: row.organizationId,
        projectId: row.projectId,
        environmentId: row.environmentId,
        specificationId: row.specificationId,
        releaseId: row.id,
      };
      const approved = await releaseMutationResult(
        () =>
          deps.port.approve({
            organizationId: ctx.organizationId,
            releaseId: row.id,
            actorId: actorOf(request),
            operationKey,
          }),
        expected,
      );
      return { release: releaseView(approved) };
    },
  );

  app.post(
    '/v1/releases/:releaseId/deploy',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ReleaseParams,
        body: DeployBody,
        response: { 200: z.object({ deploymentId: idSchema('dep') }).strict() },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const row = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
      authorize(
        ctx,
        'approve_production_deploy',
        await permissionContext(deps, ctx.organizationId),
      );
      if (
        request.body.deploymentType === 'replace_deployment' &&
        request.body.dataDisposition === undefined
      )
        throw dataDispositionRequired();
      const operationKey = operationOf(request);
      const result = await portResult(
        () =>
          deps.port.deploy(
            DeployInputSchema.parse({
              organizationId: ctx.organizationId,
              releaseId: row.id,
              actorId: actorOf(request),
              operationKey,
              deploymentType: request.body.deploymentType,
              confirmation: { dataDisposition: request.body.dataDisposition ?? null },
            }),
          ),
        DeploymentResultSchema,
      );
      await meterDeployment(deps, ctx, row, result);
      return result;
    },
  );

  app.post(
    '/v1/releases/:releaseId/rollback',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ReleaseParams,
        body: RollbackBody,
        response: { 200: z.object({ deploymentId: idSchema('dep') }).strict() },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const row = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
      authorize(
        ctx,
        'approve_production_deploy',
        await permissionContext(deps, ctx.organizationId),
      );
      const operationKey = operationOf(request);
      const result = await portResult(
        () =>
          deps.port.rollback(
            RollbackInputSchema.parse({
              organizationId: ctx.organizationId,
              releaseId: row.id,
              actorId: actorOf(request),
              operationKey,
              toDeploymentId: request.body.toDeploymentId ?? null,
              reason: request.body.reason,
            }),
          ),
        DeploymentResultSchema,
      );
      await meterDeployment(deps, ctx, row, result);
      await captureReleaseLifecycle(
        deps,
        ctx,
        actorOf(request),
        'rollback_executed',
        result.deploymentId,
        row.projectId,
      );
      return result;
    },
  );

  app.post(
    '/v1/releases/:releaseId/fork',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ReleaseParams,
        body: ForkBody,
        response: { 201: z.object({ fork: ForkReleaseResultSchema }).strict() },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const release = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
      authorize(ctx, 'edit_code');
      if (deps.fork === undefined) throw releaseServiceFailed();
      const forkPort = deps.fork;
      const operationKey = operationOf(request);
      const fork = await portResult(
        () =>
          forkPort.forkRelease({
            organizationId: ctx.organizationId,
            releaseId: release.id,
            actorId: actorOf(request),
            operationKey,
            startFixRun: request.body.startFixRun,
          }),
        ForkReleaseResultSchema,
      );
      if (
        fork.releaseId !== release.id ||
        fork.branchName !== `fix/rel-${release.id}` ||
        (fork.fixRunId === null) === request.body.startFixRun
      ) {
        throw releaseServiceFailed();
      }
      return await reply.status(201).send({ fork });
    },
  );

  app.get(
    '/v1/releases/:releaseId/evidence',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: ReleaseParams,
        response: { 200: z.object({ evidence: EvidenceManifestSchema }).strict() },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const row = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
      authorize(ctx, 'view_project');
      return { evidence: await evidenceFor(deps.port, row) };
    },
  );
}

async function captureReleaseLifecycle(
  deps: ReleaseRoutesDeps,
  ctx: ReturnType<typeof tenantOf>,
  distinctId: string,
  event: 'release_created' | 'rollback_executed',
  resourceId: string,
  projectId: string,
): Promise<void> {
  if (deps.productAnalytics === undefined) return;
  try {
    const project = await ctx.db.projects.getById(projectId);
    if (project === undefined) return;
    await deps.productAnalytics.capture({
      eventId: `${event}:${resourceId}`,
      distinctId,
      event,
      properties: {
        orgId: ctx.organizationId,
        projectId,
        supportLevel: project.supportLevel,
      },
    });
  } catch {
    // Analytics is observational and can never change a release mutation.
  }
}

async function meterDeployment(
  deps: ReleaseRoutesDeps,
  ctx: ReturnType<typeof tenantOf>,
  release: z.infer<typeof ReleaseRowSchema>,
  result: z.infer<typeof DeploymentResultSchema>,
): Promise<void> {
  if (deps.deploymentUsage === undefined) return;
  const environment = await ctx.db.environments.getForProject(
    release.projectId,
    release.environmentId,
  );
  if (environment?.deploymentProvider === null || environment === undefined) return;
  await deps.deploymentUsage.record({
    organizationId: ctx.organizationId,
    projectId: release.projectId,
    runId: null,
    taskId: null,
    deploymentId: result.deploymentId,
    provider: environment.deploymentProvider,
    occurredAt: deps.now().toISOString(),
  });
}

async function releaseFor(
  port: ReleasePort,
  organizationId: string,
  releaseId: string,
): Promise<z.infer<typeof ReleaseRowSchema>> {
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
  if (result.organizationId !== organizationId || result.id !== releaseId)
    throw releaseServiceFailed();
  return result;
}
async function evidenceFor(port: ReleasePort, release: ReleaseRow): Promise<EvidenceManifest> {
  return await portResult(async () => {
    const result = EvidenceManifestSchema.parse(
      await port.getEvidence({ organizationId: release.organizationId, releaseId: release.id }),
    );
    if (result.release_id !== release.id || result.commit_sha !== release.commitSha)
      throw new Error('evidence identity mismatch');
    return result;
  }, EvidenceManifestSchema);
}
async function portResult<T>(work: () => Promise<T>, schema: z.ZodType<T>): Promise<T> {
  try {
    return schema.parse(await work());
  } catch {
    throw releaseServiceFailed();
  }
}
type ExpectedReleaseIdentity = Pick<
  ReleaseRow,
  'organizationId' | 'projectId' | 'environmentId' | 'specificationId'
> & { readonly releaseId: string | null };
async function releaseMutationResult(
  work: () => Promise<ReleaseRow>,
  expected: ExpectedReleaseIdentity,
): Promise<ReleaseRow> {
  return await portResult(async () => {
    const result = ReleaseRowSchema.parse(await work());
    assertReleaseIdentity(result, expected);
    return result;
  }, ReleaseRowSchema);
}
function assertReleaseIdentity(result: ReleaseRow, expected: ExpectedReleaseIdentity): void {
  if (
    result.organizationId !== expected.organizationId ||
    result.projectId !== expected.projectId ||
    result.environmentId !== expected.environmentId ||
    result.specificationId !== expected.specificationId ||
    (expected.releaseId !== null && result.id !== expected.releaseId)
  )
    throw new Error('release identity mismatch');
}
async function permissionContext(
  deps: ReleaseRoutesDeps,
  organizationId: string,
): Promise<PermissionContext> {
  try {
    return await deps.permissionContextFor(organizationId);
  } catch {
    throw releaseServiceFailed();
  }
}
function releaseView(row: z.infer<typeof ReleaseRowSchema>): z.infer<typeof ReleaseSchema> {
  return ReleaseSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}
function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'That project does not exist.');
}
function releaseNotFound(): ApiError {
  return new ApiError('release_not_found', 404, 'That release does not exist.');
}
function dataDispositionRequired(): ApiError {
  return new ApiError(
    'data_disposition_required',
    422,
    'Replacing a deployment requires a data disposition.',
  );
}
function releaseServiceFailed(): ApiError {
  return new ApiError(
    'release_service_unavailable',
    502,
    'The release service could not complete the request.',
  );
}
