import type { ServiceName, ServiceTokenSigner } from '@zapp/config';
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

function error(reply: FastifyReply, status: 400 | 401 | 403 | 409, code: string, message: string) {
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
    readonly browserRuns: BrowserRunService;
    readonly now: () => Date;
  },
): void {
  const callers = new Set(options.callers);
  if (callers.size === 0) throw new Error('Verification routes need at least one caller');

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
}
