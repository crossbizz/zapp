import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';

import {
  AppendDeploymentEventSchema,
  DeploymentActionBodySchema,
  DeploymentProgressSchema,
  type DeploymentProgressPort,
} from './deployment-progress.js';
import {
  DomainListInputSchema,
  type DomainPort,
} from './domain-store.js';
import { DomainRequestSchema, DomainResultSchema } from './domains/service.js';
import { ProductionHistorySchema, type ProductionProjectionPort } from './production-history.js';
import { RollbackPreviewSchema, type RollbackPreview } from './rollback/service.js';

import {
  ReleaseHistoryInputSchema,
  ReleaseHistoryPageSchema,
  type ReleaseHistoryPort,
} from './history.js';

import {
  ActorSchema,
  CreateReleaseCandidateInputSchema,
  type Release,
  ReleaseServiceError,
  type ReleaseRecordService,
} from './release/create.js';
import {
  DeployReleaseInputSchema,
  DeploymentResultSchema,
  EvidenceManifestSchema,
  ForkReleaseInputSchema,
  ForkReleaseResultSchema,
  ReadinessReportSchema,
  ReleaseLookupInputSchema,
  RollbackReleaseInputSchema,
  type ReleaseLifecycleService,
} from './lifecycle.js';

const ReleaseParamsSchema = z.object({ releaseId: z.string().min(1) }).strict();
const OrganizationQuerySchema = z.object({ organizationId: z.string().min(1) }).strict();
const ProjectParamsSchema = z.object({ projectId: z.string().min(1) }).strict();
const DeploymentParamsSchema = z.object({ deploymentId: z.string().min(1) }).strict();
const DomainParamsSchema = z
  .object({ projectId: z.string().min(1), hostname: z.string().min(1) })
  .strict();
const HistoryQuerySchema = z
  .object({
    organizationId: z.string().min(1),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
const ApproveBodySchema = z
  .object({
    actor: ActorSchema,
    operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u),
  })
  .strict();
const AppendEventBodySchema = AppendDeploymentEventSchema.omit({ deploymentId: true }).strict();
const ActionBodySchema = DeploymentActionBodySchema;
const DomainBodySchema = DomainRequestSchema.omit({ projectId: true }).strict();
const DomainListQuerySchema = z
  .object({ organizationId: z.string().min(1), environmentId: z.string().min(1).optional() })
  .strict();
const RollbackPreviewQuerySchema = z
  .object({ organizationId: z.string().min(1), toDeploymentId: z.string().min(1).optional() })
  .strict();

function idempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !/^op_[a-f0-9]{64}$/u.test(value)) {
    throw new ReleaseServiceError(
      'idempotency_conflict',
      400,
      'A valid idempotency-key header is required.',
    );
  }
  return value;
}

function assertHeaderMatchesBody(header: string, body: string): void {
  if (header !== body) {
    throw new ReleaseServiceError(
      'idempotency_conflict',
      400,
      'The idempotency-key header must match the operationKey body field.',
    );
  }
}

export function registerReleaseRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly records: ReleaseRecordService;
    readonly lifecycle?: ReleaseLifecycleService;
    readonly history?: ReleaseHistoryPort;
    readonly progress?: DeploymentProgressPort;
    readonly domains?: DomainPort;
    readonly productionHistory?: ProductionProjectionPort;
    readonly rollbackPreview?: { preview(input: { organizationId: string; projectId: string; environmentId: string; toDeploymentId?: string }): Promise<RollbackPreview> };
    readonly requireService: preHandlerAsyncHookHandler;
  },
): void {
  app.post('/internal/releases', { preHandler: dependencies.requireService }, async (request, reply) => {
    try {
      const body = CreateReleaseCandidateInputSchema.parse(request.body);
      assertHeaderMatchesBody(idempotencyKey(request.headers['idempotency-key']), body.operationKey);
      const release = await dependencies.records.createReleaseCandidate(body);
      return await reply.status(201).send({ release });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/internal/releases/:releaseId', { preHandler: dependencies.requireService }, async (request, reply) => {
    try {
      const params = ReleaseParamsSchema.parse(request.params);
      const query = OrganizationQuerySchema.parse(request.query);
      const release = await dependencies.records.getRelease(query.organizationId, params.releaseId);
      if (release === undefined) {
        throw new ReleaseServiceError('release_not_found', 404, 'Release not found.');
      }
      return await reply.send({ release });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(
    '/internal/projects/:projectId/releases',
    { preHandler: dependencies.requireService },
    async (request, reply) => {
      try {
        if (dependencies.history === undefined) throw new Error('release_history_unavailable');
        const params = ProjectParamsSchema.parse(request.params);
        const query = HistoryQuerySchema.parse(request.query);
        const page = await dependencies.history.list(
          ReleaseHistoryInputSchema.parse({
            organizationId: query.organizationId,
            projectId: params.projectId,
            cursor: query.cursor ?? null,
            limit: query.limit,
          }),
        );
        return await reply.send({ page: ReleaseHistoryPageSchema.parse(page) });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  if (dependencies.progress !== undefined) {
    app.get(
      '/internal/deployments/:deploymentId',
      { preHandler: dependencies.requireService },
      async (request, reply) => {
        const params = DeploymentParamsSchema.parse(request.params);
        const query = OrganizationQuerySchema.parse(request.query);
        const progress = await dependencies.progress?.get({
          organizationId: query.organizationId,
          deploymentId: params.deploymentId,
        });
        if (progress === undefined) {
          throw new ReleaseServiceError('release_not_found', 404, 'Deployment not found.');
        }
        return await reply.send({ progress: DeploymentProgressSchema.parse(progress) });
      },
    );
    app.post(
      '/internal/deployments/:deploymentId/events',
      { preHandler: dependencies.requireService },
      async (request, reply) => {
        const params = DeploymentParamsSchema.parse(request.params);
        const progress = await dependencies.progress?.append({
          ...AppendEventBodySchema.parse(request.body),
          deploymentId: params.deploymentId,
        });
        return await reply.status(201).send({ progress: DeploymentProgressSchema.parse(progress) });
      },
    );
    app.post(
      '/internal/deployments/:deploymentId/actions',
      { preHandler: dependencies.requireService },
      async (request, reply) => {
        const params = DeploymentParamsSchema.parse(request.params);
        const body = ActionBodySchema.parse(request.body);
        assertHeaderMatchesBody(idempotencyKey(request.headers['idempotency-key']), body.operationKey);
        const progress = await dependencies.progress?.get({
          organizationId: body.organizationId,
          deploymentId: params.deploymentId,
        });
        if (progress === undefined) throw new ReleaseServiceError('release_not_found', 404, 'Deployment not found.');
        const result = await dependencies.progress?.act({
          ...body,
          resourceType: 'deployment',
          resourceId: params.deploymentId,
        });
        return await reply.send(result);
      },
    );
    app.post(
      '/internal/releases/:releaseId/actions',
      { preHandler: dependencies.requireService },
      async (request, reply) => {
        const params = ReleaseParamsSchema.parse(request.params);
        const body = ActionBodySchema.parse(request.body);
        assertHeaderMatchesBody(idempotencyKey(request.headers['idempotency-key']), body.operationKey);
        await requireRelease(dependencies.records, {
          organizationId: body.organizationId,
          releaseId: params.releaseId,
        });
        const result = await dependencies.progress?.act({
          ...body,
          resourceType: 'release',
          resourceId: params.releaseId,
        });
        return await reply.send(result);
      },
    );
  }

  if (dependencies.domains !== undefined) {
    app.get(
      '/internal/projects/:projectId/domains',
      { preHandler: dependencies.requireService },
      async (request, reply) => {
        const params = ProjectParamsSchema.parse(request.params);
        const query = DomainListQuerySchema.parse(request.query);
        const domains = await dependencies.domains?.list(
          DomainListInputSchema.parse({ ...query, projectId: params.projectId }),
        );
        return await reply.send({ domains: z.array(DomainResultSchema).max(100).parse(domains) });
      },
    );
    app.post(
      '/internal/projects/:projectId/domains',
      { preHandler: dependencies.requireService },
      async (request, reply) => {
        const params = ProjectParamsSchema.parse(request.params);
        const body = DomainBodySchema.parse(request.body);
        assertHeaderMatchesBody(idempotencyKey(request.headers['idempotency-key']), body.operationKey);
        const domain = await dependencies.domains?.configure({ ...body, projectId: params.projectId });
        return await reply.status(201).send({ domain: DomainResultSchema.parse(domain) });
      },
    );
    app.post(
      '/internal/projects/:projectId/domains/:hostname/poll',
      { preHandler: dependencies.requireService },
      async (request, reply) => {
        const params = DomainParamsSchema.parse(request.params);
        const body = DomainBodySchema.omit({ hostname: true }).parse(request.body);
        assertHeaderMatchesBody(idempotencyKey(request.headers['idempotency-key']), body.operationKey);
        const domain = await dependencies.domains?.poll({
          ...body,
          projectId: params.projectId,
          hostname: params.hostname,
        });
        return await reply.send({ domain: DomainResultSchema.parse(domain) });
      },
    );
  }

  if (dependencies.productionHistory !== undefined) {
    app.get(
      '/internal/projects/:projectId/production',
      { preHandler: dependencies.requireService },
      async (request, reply) => {
        const params = ProjectParamsSchema.parse(request.params);
        const query = OrganizationQuerySchema.parse(request.query);
        const history = await dependencies.productionHistory?.get({
          organizationId: query.organizationId,
          projectId: params.projectId,
        });
        return await reply.send({ history: ProductionHistorySchema.parse(history) });
      },
    );
  }

  if (dependencies.rollbackPreview !== undefined) {
    app.get(
      '/internal/releases/:releaseId/rollback-preview',
      { preHandler: dependencies.requireService },
      async (request, reply) => {
        const params = ReleaseParamsSchema.parse(request.params);
        const query = RollbackPreviewQuerySchema.parse(request.query);
        const release = await requireRelease(dependencies.records, {
          organizationId: query.organizationId,
          releaseId: params.releaseId,
        });
        const preview = await dependencies.rollbackPreview?.preview({
          organizationId: query.organizationId,
          projectId: release.projectId,
          environmentId: release.environmentId,
          ...(query.toDeploymentId === undefined ? {} : { toDeploymentId: query.toDeploymentId }),
        });
        return await reply.send({ preview: RollbackPreviewSchema.parse(preview) });
      },
    );
  }

  app.post('/internal/releases/:releaseId/approve', { preHandler: dependencies.requireService }, async (request, reply) => {
    try {
      const params = ReleaseParamsSchema.parse(request.params);
      const body = ApproveBodySchema.parse(request.body);
      assertHeaderMatchesBody(idempotencyKey(request.headers['idempotency-key']), body.operationKey);
      const release = await dependencies.records.approve({
        releaseId: params.releaseId,
        actor: body.actor,
        operationKey: body.operationKey,
      });
      return await reply.send({ release });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  if (dependencies.lifecycle === undefined) return;
  const lifecycle = dependencies.lifecycle;

  app.get(
    '/internal/releases/:releaseId/readiness',
    { preHandler: dependencies.requireService },
    async (request, reply) => {
      try {
        const input = ReleaseLookupInputSchema.parse({
          ...OrganizationQuerySchema.parse(request.query),
          ...ReleaseParamsSchema.parse(request.params),
        });
        const release = await requireRelease(dependencies.records, input);
        const readiness = ReadinessReportSchema.parse(await lifecycle.getReadiness(input));
        assertReleaseProjection(readiness, release);
        return await reply.send({ readiness });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/internal/releases/:releaseId/deploy',
    { preHandler: dependencies.requireService },
    async (request, reply) => {
      try {
        const params = ReleaseParamsSchema.parse(request.params);
        const body = DeployReleaseInputSchema.omit({ releaseId: true }).parse(request.body);
        assertHeaderMatchesBody(idempotencyKey(request.headers['idempotency-key']), body.operationKey);
        await requireRelease(dependencies.records, {
          organizationId: body.organizationId,
          releaseId: params.releaseId,
        });
        return await reply.send(
          DeploymentResultSchema.parse(
            await lifecycle.deploy({ ...body, releaseId: params.releaseId }),
          ),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/internal/releases/:releaseId/rollback',
    { preHandler: dependencies.requireService },
    async (request, reply) => {
      try {
        const params = ReleaseParamsSchema.parse(request.params);
        const body = RollbackReleaseInputSchema.omit({ releaseId: true }).parse(request.body);
        assertHeaderMatchesBody(idempotencyKey(request.headers['idempotency-key']), body.operationKey);
        await requireRelease(dependencies.records, {
          organizationId: body.organizationId,
          releaseId: params.releaseId,
        });
        return await reply.send(
          DeploymentResultSchema.parse(
            await lifecycle.rollback({ ...body, releaseId: params.releaseId }),
          ),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/internal/releases/:releaseId/evidence',
    { preHandler: dependencies.requireService },
    async (request, reply) => {
      try {
        const input = ReleaseLookupInputSchema.parse({
          ...OrganizationQuerySchema.parse(request.query),
          ...ReleaseParamsSchema.parse(request.params),
        });
        const release = await requireRelease(dependencies.records, input);
        const evidence = EvidenceManifestSchema.parse(await lifecycle.getEvidence(input));
        if (evidence.release_id !== release.id || evidence.commit_sha !== release.commitSha) {
          throw new Error('release_evidence_identity_mismatch');
        }
        return await reply.send({ evidence });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/internal/releases/:releaseId/fork',
    { preHandler: dependencies.requireService },
    async (request, reply) => {
      try {
        const params = ReleaseParamsSchema.parse(request.params);
        const body = ForkReleaseInputSchema.omit({ releaseId: true }).parse(request.body);
        assertHeaderMatchesBody(idempotencyKey(request.headers['idempotency-key']), body.operationKey);
        const release = await requireRelease(dependencies.records, {
          organizationId: body.organizationId,
          releaseId: params.releaseId,
        });
        const fork = ForkReleaseResultSchema.parse(
          await lifecycle.forkRelease({ ...body, releaseId: params.releaseId }),
        );
        if (
          fork.releaseId !== release.id ||
          fork.branchName !== `fix/rel-${release.id}` ||
          fork.fixRunId === null !== !body.startFixRun
        ) {
          throw new Error('release_fork_identity_mismatch');
        }
        return await reply.status(201).send({ fork });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

async function requireRelease(
  records: ReleaseRecordService,
  input: { readonly organizationId: string; readonly releaseId: string },
): Promise<Release> {
  const release = await records.getRelease(input.organizationId, input.releaseId);
  if (release === undefined) {
    throw new ReleaseServiceError('release_not_found', 404, 'Release not found.');
  }
  return release;
}

function assertReleaseProjection(
  projection: { readonly releaseId: string; readonly commitSha: string },
  release: Release,
): void {
  if (projection.releaseId !== release.id || projection.commitSha !== release.commitSha) {
    throw new Error('release_projection_identity_mismatch');
  }
}

function sendError(reply: Parameters<FastifyInstance['setErrorHandler']>[0] extends (
  error: Error,
  request: infer _Request,
  reply: infer Reply,
) => unknown
  ? Reply
  : never, error: unknown) {
  if (error instanceof ReleaseServiceError) {
    return reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message },
    });
  }
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: { code: 'invalid_request', message: 'The request payload is invalid.' },
    });
  }
  throw error;
}
