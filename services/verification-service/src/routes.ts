import type { ServiceName, ServiceTokenSigner } from '@zapp/config';
import { idSchema } from '@zapp/contracts';
import {
  MAX_PUBLIC_TEST_RUNS,
  SignedVerificationArtifactSchema,
  VerificationEvidenceNotFoundError,
  VerificationTestRunSchema,
  type VerificationReadModel,
} from '@zapp/verification-engine';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { VerificationServiceApp } from './app.js';
import {
  BrowserRunInputSchema,
  BrowserRunOutputSchema,
  type BrowserRunService,
} from './runner/playwright.js';

const ErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();
const HeadersSchema = z
  .object({
    'idempotency-key': z.string().min(1).max(256),
  })
  .passthrough();

function error(reply: FastifyReply, status: 400 | 401 | 403 | 404 | 409, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    readonly signer: ServiceTokenSigner;
    readonly callers: ReadonlySet<ServiceName>;
    readonly now: () => Date;
  },
): Promise<void> {
  if ((request.headers.authorization ?? '') !== '' || (request.headers.cookie ?? '') !== '') {
    await error(reply, 401, 'service_unauthenticated', 'A valid service token is required.');
    return;
  }
  const raw = request.headers['x-zapp-service-token'];
  if (Array.isArray(raw) || raw?.trim() === '') {
    await error(reply, 401, 'service_unauthenticated', 'A valid service token is required.');
    return;
  }
  const verdict = await options.signer.verifyServiceToken(
    raw ?? '',
    'verification-service',
    options.now(),
  );
  if (!verdict.ok) {
    await error(reply, 401, 'service_unauthenticated', 'A valid service token is required.');
    return;
  }
  if (!options.callers.has(verdict.claims.service)) {
    await error(reply, 403, 'service_not_allowed', 'That service may not call this endpoint.');
  }
}

export function registerVerificationRoutes(
  app: VerificationServiceApp,
  options: {
    readonly signer: ServiceTokenSigner;
    readonly callers: readonly ServiceName[];
    readonly readCallers: readonly ServiceName[];
    readonly browserRuns: BrowserRunService;
    readonly readModel: VerificationReadModel;
    readonly now: () => Date;
  },
): void {
  const callers = new Set(options.callers);
  const readCallers = new Set(options.readCallers);
  if (callers.size === 0) throw new Error('Verification routes need at least one caller');
  if (readCallers.size === 0) throw new Error('Verification read routes need at least one caller');

  app.post(
    '/internal/verification/browser-run',
    {
      schema: {
        headers: HeadersSchema,
        body: BrowserRunInputSchema,
        response: {
          200: BrowserRunOutputSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
        },
      },
      preHandler: async (request, reply) => {
        await authorize(request, reply, {
          signer: options.signer,
          callers,
          now: options.now,
        });
      },
    },
    async (request, reply) => {
      if (reply.sent) return reply;
      if (request.headers['idempotency-key'] !== request.body.idempotencyKey) {
        return await error(
          reply,
          409,
          'idempotency_key_mismatch',
          'The idempotency header must match the browser run key.',
        );
      }
      return await options.browserRuns.run(request.body);
    },
  );

  const ReadParamsSchema = z.object({
    organizationId: idSchema('org'),
    runId: idSchema('run'),
  }).strict();
  const ArtifactParamsSchema = ReadParamsSchema.extend({
    artifactId: idSchema('art'),
  }).strict();
  const ArtifactQuerySchema = z.object({ taskId: idSchema('task').optional() }).strict();

  app.get(
    '/internal/verification/organizations/:organizationId/runs/:runId/tests',
    {
      schema: {
        params: ReadParamsSchema,
        response: {
          200: z.object({
            runs: z.array(VerificationTestRunSchema).max(MAX_PUBLIC_TEST_RUNS),
          }).strict(),
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
      preHandler: async (request, reply) => {
        await authorize(request, reply, {
          signer: options.signer,
          callers: readCallers,
          now: options.now,
        });
      },
    },
    async (request, reply) => {
      if (reply.sent) return reply;
      return {
        runs: [...await options.readModel.listForRun(request.params)],
      };
    },
  );

  app.get(
    '/internal/verification/organizations/:organizationId/runs/:runId/artifacts/:artifactId',
    {
      schema: {
        params: ArtifactParamsSchema,
        querystring: ArtifactQuerySchema,
        response: {
          200: SignedVerificationArtifactSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
      preHandler: async (request, reply) => {
        await authorize(request, reply, {
          signer: options.signer,
          callers: readCallers,
          now: options.now,
        });
      },
    },
    async (request, reply) => {
      if (reply.sent) return reply;
      try {
        return await options.readModel.signArtifact({
          ...request.params,
          taskId: request.query.taskId ?? null,
        });
      } catch (cause) {
        if (cause instanceof VerificationEvidenceNotFoundError) {
          return await error(
            reply,
            404,
            cause.code,
            'Verification evidence was not found.',
          );
        }
        throw cause;
      }
    },
  );
}
