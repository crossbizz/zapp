import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';

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
const ApproveBodySchema = z
  .object({
    actor: ActorSchema,
    operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u),
  })
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
