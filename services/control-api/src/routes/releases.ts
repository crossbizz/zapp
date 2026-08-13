import type { ProductAnalytics } from '@zapp/config';
import { CommitShaSchema, idSchema, RunModeSchema } from '@zapp/contracts';
import { EvidenceManifestSchema } from '@zapp/verification-engine';
import {
  DeploymentConfirmationSummarySchema,
  RollbackPreviewSchema,
  createDeploymentConfirmationSummary,
} from '@zapp/release-service';
import {
  DeploymentProgressSchema,
  type DeploymentActionInput,
} from '@zapp/release-service/deployment-progress';
import { DomainResultSchema } from '@zapp/release-service/domain-store';
import { ProductionHistorySchema } from '@zapp/release-service/production-history';
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
const ReleaseHistoryQuery = z
  .object({ cursor: idSchema('rel').optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();
const ReleaseParams = z.object({ releaseId: idSchema('rel') }).strict();
const DeploymentParams = z.object({ deploymentId: idSchema('dep') }).strict();
const DomainParams = z.object({ projectId: idSchema('proj'), hostname: z.string().min(1).max(253) }).strict();
const PreviewQuery = z.object({ retarget: z.coerce.boolean().default(false) }).strict();
const RollbackPreviewQuery = z.object({ toDeploymentId: idSchema('dep').optional() }).strict();
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
const ReadinessActionBody = z
  .object({ findingId: z.string().min(1).max(255), action: z.enum(['fix', 'review', 'waive']), reason: z.string().min(1).max(2_000).optional() })
  .strict();
const DeploymentActionBody = z
  .object({ action: z.enum(['retry', 'fix', 'ask']), stage: z.string().min(1).max(100).optional(), prompt: z.string().min(1).max(2_000).optional() })
  .strict();
const DomainBody = z.object({ environmentId: idSchema('env'), hostname: z.string().min(1).max(253) }).strict();
const DomainPollBody = z.object({ environmentId: idSchema('env') }).strict();
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
const DeploymentHistorySchema = z
  .object({
    id: idSchema('dep'), provider: z.string().min(1), providerDeploymentId: z.string().nullable(),
    status: z.string().min(1), url: z.string().url().nullable(), startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(), rollbackOfDeploymentId: idSchema('dep').nullable(),
  })
  .strict();
export const PublicReleaseHistoryPageSchema = z
  .object({
    items: z.array(z.object({
      id: idSchema('rel'), projectId: idSchema('proj'), environmentId: idSchema('env'),
      commitSha: CommitShaSchema, status: z.string().min(1),
      createdBy: idSchema('user'),
      supportLevel: z.enum(['compatible', 'verified', 'managed']),
      activeProduction: z.boolean(), createdAt: z.string().datetime(),
      deployments: z.array(DeploymentHistorySchema).max(100),
      evidence: z.object({ artifactId: idSchema('art'), href: z.string().min(1).max(500) }).strict().nullable(),
    }).strict()).max(50),
    rollbackTargets: z.array(DeploymentHistorySchema.extend({ releaseId: idSchema('rel'), commitSha: CommitShaSchema }).strict()).max(100),
    nextCursor: idSchema('rel').nullable(),
  })
  .strict();
export const ReleaseHistoryInputSchema = z.object({
  organizationId: idSchema('org'), projectId: idSchema('proj'), cursor: idSchema('rel').nullable(),
  limit: z.number().int().min(1).max(50),
}).strict();

export type ReleaseRow = z.infer<typeof ReleaseRowSchema>;
export type ReadinessReport = z.infer<typeof ReadinessSchema>;
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;
export type CreateReleaseInput = z.infer<typeof CreateReleaseInputSchema>;
export type ReleaseLookupInput = z.infer<typeof ReleaseLookupInputSchema>;
export type ReleaseMutationInput = z.infer<typeof ReleaseMutationInputSchema>;
export type DeployInput = z.infer<typeof DeployInputSchema>;
export type RollbackInput = z.infer<typeof RollbackInputSchema>;
export type DeploymentResult = z.infer<typeof DeploymentResultSchema>;
export type PublicReleaseHistoryPage = z.infer<typeof PublicReleaseHistoryPageSchema>;
export type ReleaseHistoryInput = z.infer<typeof ReleaseHistoryInputSchema>;
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
  listProjectHistory?(input: ReleaseHistoryInput): Promise<PublicReleaseHistoryPage>;
  getDeploymentProgress?(input: { organizationId: string; deploymentId: string }): Promise<z.infer<typeof DeploymentProgressSchema> | undefined>;
  act?(input: DeploymentActionInput): Promise<{ status: 'dispatched' }>;
  listDomains?(input: { organizationId: string; projectId: string; environmentId?: string }): Promise<z.infer<typeof DomainResultSchema>[]>;
  configureDomain?(input: { organizationId: string; projectId: string; environmentId: string; hostname: string; operationKey: string }): Promise<z.infer<typeof DomainResultSchema>>;
  pollDomain?(input: { organizationId: string; projectId: string; environmentId: string; hostname: string; operationKey: string }): Promise<z.infer<typeof DomainResultSchema>>;
  getProductionHistory?(input: { organizationId: string; projectId: string }): Promise<z.infer<typeof ProductionHistorySchema>>;
  getRollbackPreview?(input: { organizationId: string; releaseId: string; toDeploymentId?: string }): Promise<z.infer<typeof RollbackPreviewSchema>>;
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
  app.get(
    '/v1/projects/:projectId/releases',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: ProjectParams,
        querystring: ReleaseHistoryQuery,
        response: { 200: PublicReleaseHistoryPageSchema },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      authorize(ctx, 'view_project');
      if (deps.port.listProjectHistory === undefined) throw releaseServiceFailed();
      const page = await portResult(
        () => deps.port.listProjectHistory?.({
          organizationId: ctx.organizationId,
          projectId: project.id,
          cursor: request.query.cursor ?? null,
          limit: request.query.limit,
        }) as Promise<PublicReleaseHistoryPage>,
        PublicReleaseHistoryPageSchema,
      );
      if (page.items.some((item) => item.projectId !== project.id)) throw releaseServiceFailed();
      return page;
    },
  );

  app.get(
    '/v1/releases/:releaseId/deployment-preview',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: ReleaseParams, querystring: PreviewQuery, response: { 200: DeploymentConfirmationSummarySchema } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const release = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
      authorize(ctx, 'view_project');
      const history = deps.port.listProjectHistory === undefined
        ? undefined
        : await deps.port.listProjectHistory({ organizationId: ctx.organizationId, projectId: release.projectId, cursor: null, limit: 50 });
      const prior = history?.items.flatMap((item) => item.environmentId === release.environmentId ? item.deployments : []) ?? [];
      const deploymentType = prior.length === 0 ? 'first_deploy' : request.query.retarget ? 'replace_deployment' : 'redeploy';
      return createDeploymentConfirmationSummary({
        deploymentType,
        dataDisposition: null,
        migration: { count: 0, reversibility: 'reversible' },
        secretChanges: { addedNames: [], changedNames: [], removedNames: [] },
        urlEffect: deploymentType === 'first_deploy' ? 'created' : deploymentType === 'replace_deployment' ? 'changed' : 'preserved',
        activeUserEffect: 'zero_downtime',
      });
    },
  );

  app.get(
    '/v1/projects/:projectId/production',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: ProjectParams, response: { 200: ProductionHistorySchema } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      authorize(ctx, 'view_project');
      if (deps.port.getProductionHistory === undefined) throw releaseServiceFailed();
      return ProductionHistorySchema.parse(await deps.port.getProductionHistory({ organizationId: ctx.organizationId, projectId: project.id }));
    },
  );

  app.get(
    '/v1/releases/:releaseId/rollback-preview',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: ReleaseParams, querystring: RollbackPreviewQuery, response: { 200: RollbackPreviewSchema } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const release = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
      authorize(ctx, 'view_project');
      if (deps.port.getRollbackPreview === undefined) throw releaseServiceFailed();
      return RollbackPreviewSchema.parse(await deps.port.getRollbackPreview({
        organizationId: ctx.organizationId,
        releaseId: release.id,
        ...(request.query.toDeploymentId === undefined ? {} : { toDeploymentId: request.query.toDeploymentId }),
      }));
    },
  );

  app.post(
    '/v1/releases/:releaseId/readiness-actions',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { params: ReleaseParams, body: ReadinessActionBody, response: { 200: z.object({ status: z.literal('dispatched') }).strict() } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const release = await releaseFor(deps.port, ctx.organizationId, request.params.releaseId);
      authorize(ctx, request.body.action === 'waive' ? 'approve_production_deploy' : 'edit_code', await permissionContext(deps, ctx.organizationId));
      if (deps.port.act === undefined) throw releaseServiceFailed();
      return await deps.port.act({
        organizationId: ctx.organizationId,
        resourceType: 'release',
        resourceId: release.id,
        action: request.body.action,
        actor: { id: actorOf(request), organizationId: ctx.organizationId },
        operationKey: operationOf(request),
        payload: { findingId: request.body.findingId, ...(request.body.reason === undefined ? {} : { reason: request.body.reason }) },
      });
    },
  );

  app.get(
    '/v1/deployments/:deploymentId',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: DeploymentParams, response: { 200: DeploymentProgressSchema } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      if (deps.port.getDeploymentProgress === undefined) throw releaseServiceFailed();
      const progress = await deps.port.getDeploymentProgress({ organizationId: ctx.organizationId, deploymentId: request.params.deploymentId });
      if (progress === undefined) throw releaseNotFound();
      return DeploymentProgressSchema.parse(progress);
    },
  );

  app.get(
    '/v1/deployments/:deploymentId/events',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: DeploymentParams },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      if (deps.port.getDeploymentProgress === undefined) throw releaseServiceFailed();
      const progress = await deps.port.getDeploymentProgress({ organizationId: ctx.organizationId, deploymentId: DeploymentParams.parse(request.params).deploymentId });
      if (progress === undefined) throw releaseNotFound();
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
      for (const event of progress.events) reply.raw.write(`id: ${String(event.sequence)}\nevent: deployment.updated\ndata: ${JSON.stringify(event)}\n\n`);
      reply.raw.end();
    },
  );

  app.post(
    '/v1/deployments/:deploymentId/actions',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { params: DeploymentParams, body: DeploymentActionBody, response: { 200: z.object({ status: z.literal('dispatched') }).strict() } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'edit_code');
      if (deps.port.getDeploymentProgress === undefined || deps.port.act === undefined) throw releaseServiceFailed();
      const progress = await deps.port.getDeploymentProgress({ organizationId: ctx.organizationId, deploymentId: request.params.deploymentId });
      if (progress === undefined) throw releaseNotFound();
      return await deps.port.act({
        organizationId: ctx.organizationId,
        resourceType: 'deployment',
        resourceId: progress.deploymentId,
        action: request.body.action,
        actor: { id: actorOf(request), organizationId: ctx.organizationId },
        operationKey: operationOf(request),
        payload: { ...(request.body.stage === undefined ? {} : { stage: request.body.stage }), ...(request.body.prompt === undefined ? {} : { prompt: request.body.prompt }) },
      });
    },
  );

  app.get(
    '/v1/projects/:projectId/domains',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: ProjectParams, response: { 200: z.object({ domains: z.array(DomainResultSchema).max(100) }).strict() } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      authorize(ctx, 'view_project');
      if (deps.port.listDomains === undefined) throw releaseServiceFailed();
      return { domains: await deps.port.listDomains({ organizationId: ctx.organizationId, projectId: project.id }) };
    },
  );

  app.post(
    '/v1/projects/:projectId/domains',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { params: ProjectParams, body: DomainBody, response: { 201: z.object({ domain: DomainResultSchema }).strict() } },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined || await ctx.db.environments.getForProject(project.id, request.body.environmentId) === undefined) throw projectNotFound();
      authorize(ctx, 'manage_organization');
      if (deps.port.configureDomain === undefined) throw releaseServiceFailed();
      const domain = await deps.port.configureDomain({ organizationId: ctx.organizationId, projectId: project.id, ...request.body, operationKey: operationOf(request) });
      return await reply.status(201).send({ domain });
    },
  );

  app.post(
    '/v1/projects/:projectId/domains/:hostname/poll',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { params: DomainParams, body: DomainPollBody, response: { 200: z.object({ domain: DomainResultSchema }).strict() } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined || await ctx.db.environments.getForProject(project.id, request.body.environmentId) === undefined) throw projectNotFound();
      authorize(ctx, 'manage_organization');
      if (deps.port.pollDomain === undefined) throw releaseServiceFailed();
      return { domain: await deps.port.pollDomain({ organizationId: ctx.organizationId, projectId: project.id, environmentId: request.body.environmentId, hostname: request.params.hostname, operationKey: operationOf(request) }) };
    },
  );

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
