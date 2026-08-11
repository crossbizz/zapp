import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';

import {
  ActorSchema,
  CreateReleaseCandidateInputSchema,
  ReleaseServiceError,
  type ReleaseRecordService,
} from './release/create.js';

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
