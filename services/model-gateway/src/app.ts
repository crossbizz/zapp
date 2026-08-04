import type { ServiceTokenSigner } from '@zapp/config';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  CompleteRequestSchema,
  GatewayStreamEventSchema,
  type CompleteRequest,
  type GatewayStreamEvent,
} from './schemas.js';

export { ChatMessageSchema, CompleteRequestSchema, NeutralToolSchema } from './schemas.js';
export type { ChatMessage, CompleteRequest, GatewayStreamEvent, NeutralTool } from './schemas.js';

const SERVICE_TOKEN_HEADER = 'x-zapp-service-token';
const MODEL_GATEWAY_AUDIENCE = 'model-gateway';
const MODEL_GATEWAY_CALLER = 'orchestrator-worker';

const SAFE_PROVIDER_ERROR = {
  type: 'error',
  code: 'provider_error',
  message: 'The model provider request failed.',
} as const satisfies GatewayStreamEvent;

const logSerializers = {
  req(request: { id: string; method: string; url: string }) {
    return { requestId: request.id, method: request.method, url: request.url };
  },
  res(reply: { statusCode: number }) {
    return { statusCode: reply.statusCode };
  },
};

const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-zapp-service-token"]',
  'req.body',
  'headers.authorization',
  'headers.cookie',
  'headers["x-zapp-service-token"]',
  'body',
  'token',
  '*.token',
  'messages',
  '*.messages',
  'tools',
  '*.tools',
  'input',
  '*.input',
  'error',
  '*.error',
];

export interface CompletionBackend {
  readonly stream: (
    request: CompleteRequest,
    signal: AbortSignal,
  ) => AsyncIterable<GatewayStreamEvent>;
}

export interface BuildAppOptions {
  readonly serviceTokens: ServiceTokenSigner;
  readonly completion: CompletionBackend;
  readonly logger?: FastifyServerOptions['logger'];
}

function loggerFor(config: BuildAppOptions['logger']): NonNullable<FastifyServerOptions['logger']> {
  if (config === false) return false;
  const supplied = typeof config === 'object' ? config : {};
  return {
    level: 'info',
    ...supplied,
    serializers: logSerializers,
    redact: { paths: REDACTED_LOG_PATHS, remove: true },
  };
}

function carriesUserCredential(headers: Record<string, string | string[] | undefined>): boolean {
  return (headers.authorization ?? '') !== '' || (headers.cookie ?? '') !== '';
}

function waitForDrain(response: NodeJS.WritableStream, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (canContinue: boolean): void => {
      if (settled) return;
      settled = true;
      response.off('drain', onDrain);
      response.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      resolve(canContinue);
    };
    const onDrain = (): void => {
      settle(true);
    };
    const onClose = (): void => {
      settle(false);
    };
    const onAbort = (): void => {
      settle(false);
    };

    response.once('drain', onDrain);
    response.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) settle(false);
  });
}

async function writeSse(
  response: NodeJS.WritableStream,
  event: unknown,
  signal: AbortSignal,
): Promise<boolean> {
  const parsed = GatewayStreamEventSchema.parse(event);
  if (signal.aborted) return false;
  const accepted = response.write(`data: ${JSON.stringify(parsed)}\n\n`);
  return accepted ? true : waitForDrain(response, signal);
}

export function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: loggerFor(options.logger),
    requestIdHeader: false,
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => {
    const fastifyError = error as { readonly statusCode?: number; readonly validation?: unknown };
    if (fastifyError.validation !== undefined) {
      void reply.status(400).send({ code: 'invalid_request', message: 'Request validation failed.' });
      return;
    }
    const statusCode = fastifyError.statusCode ?? 500;
    void reply.status(statusCode).send({
      code: statusCode === 404 ? 'not_found' : 'internal_error',
      message: statusCode === 404 ? 'Not found.' : 'The request could not be completed.',
    });
  });

  app.get(
    '/healthz',
    { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } },
    () => ({ status: 'ok' }) as const,
  );

  app.post(
    '/internal/v1/complete',
    {
      schema: { body: CompleteRequestSchema },
      preHandler: async (request, reply) => {
        if (carriesUserCredential(request.headers)) {
          request.log.warn(
            { errorCode: 'service_unauthenticated', reason: 'user_credential' },
            'service token refused',
          );
          await reply
            .status(401)
            .send({ code: 'service_unauthenticated', message: 'A valid service token is required.' });
          return reply;
        }

        const raw = request.headers[SERVICE_TOKEN_HEADER];
        if (Array.isArray(raw) || raw?.trim() === '' || raw === undefined) {
          request.log.warn(
            { errorCode: 'service_unauthenticated', reason: 'absent' },
            'service token refused',
          );
          await reply
            .status(401)
            .send({ code: 'service_unauthenticated', message: 'A valid service token is required.' });
          return reply;
        }

        const verdict = await options.serviceTokens.verifyServiceToken(raw, MODEL_GATEWAY_AUDIENCE);
        if (!verdict.ok) {
          request.log.warn(
            { errorCode: 'service_unauthenticated', reason: verdict.reason },
            'service token refused',
          );
          await reply
            .status(401)
            .send({ code: 'service_unauthenticated', message: 'A valid service token is required.' });
          return reply;
        }
        if (verdict.claims.service !== MODEL_GATEWAY_CALLER) {
          request.log.warn(
            { errorCode: 'service_not_allowed', service: verdict.claims.service },
            'service not allowed on model completion route',
          );
          await reply
            .status(403)
            .send({ code: 'service_not_allowed', message: 'That service may not call this endpoint.' });
          return reply;
        }
      },
    },
    async (request, reply) => {
      const abortController = new AbortController();
      const abortOnDisconnect = (): void => {
        if (!reply.raw.writableEnded) abortController.abort();
      };
      reply.raw.once('close', abortOnDisconnect);
      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('cache-control', 'no-cache, no-transform');
      reply.raw.setHeader('connection', 'keep-alive');
      reply.raw.setHeader('x-accel-buffering', 'no');
      if ('flushHeaders' in reply.raw) reply.raw.flushHeaders();

      try {
        const stream = options.completion.stream(request.body, abortController.signal);
        for await (const event of stream) {
          if (abortController.signal.aborted || reply.raw.destroyed) return;
          if (!(await writeSse(reply.raw, event, abortController.signal))) return;
        }
        if (!abortController.signal.aborted && !reply.raw.destroyed) {
          if (await writeSse(reply.raw, { type: 'done' }, abortController.signal)) {
            reply.raw.end();
          }
        }
      } catch {
        if (!abortController.signal.aborted && !reply.raw.destroyed) {
          request.log.warn({ errorCode: 'provider_error' }, 'provider completion failed');
          if (await writeSse(reply.raw, SAFE_PROVIDER_ERROR, abortController.signal)) {
            reply.raw.end();
          }
        }
      } finally {
        reply.raw.off('close', abortOnDisconnect);
      }
    },
  );

  return app;
}
