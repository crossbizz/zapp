import type { ServiceTokenSigner } from '@zapp/config';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  BackendStreamEventSchema,
  CompleteRequestSchema,
  GatewayStreamEventSchema,
  type BackendStreamEvent,
  type CompleteRequest,
  type GatewayStreamEvent,
} from './schemas.js';
import { ModelTerminalError } from './providers/types.js';

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
  ) => AsyncIterable<BackendStreamEvent>;
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

const CLIENT_DISCONNECTED = Symbol('client-disconnected');

function nextWhileConnected<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T> | typeof CLIENT_DISCONNECTED> {
  if (signal.aborted) return Promise.resolve(CLIENT_DISCONNECTED);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    const resolveOnce = (result: IteratorResult<T> | typeof CLIENT_DISCONNECTED): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error('completion iterator failed'));
    };
    const onAbort = (): void => {
      resolveOnce(CLIENT_DISCONNECTED);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve()
      .then(() => iterator.next())
      .then(resolveOnce, rejectOnce);
    if (signal.aborted) onAbort();
  });
}

function closeIterator(iterator: AsyncIterator<unknown>): void {
  try {
    const result = iterator.return?.();
    if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
  } catch {
    return;
  }
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
      const providerAbortController = new AbortController();
      const responseAbortController = new AbortController();
      let iterator: AsyncIterator<BackendStreamEvent> | undefined;
      let iteratorClosed = false;
      const closeBackendIterator = (): void => {
        if (iterator === undefined || iteratorClosed) return;
        iteratorClosed = true;
        closeIterator(iterator);
      };
      const stopProvider = (): void => {
        providerAbortController.abort();
        closeBackendIterator();
      };
      const abortOnDisconnect = (): void => {
        if (reply.raw.writableEnded) return;
        stopProvider();
        responseAbortController.abort();
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
        const stream = options.completion.stream(request.body, providerAbortController.signal);
        iterator = stream[Symbol.asyncIterator]();
        for (;;) {
          const result = await nextWhileConnected(iterator, responseAbortController.signal);
          if (result === CLIENT_DISCONNECTED) {
            stopProvider();
            return;
          }
          if (result.done) break;
          const parsed = BackendStreamEventSchema.parse(result.value);
          if (!(await writeSse(reply.raw, parsed, responseAbortController.signal))) {
            stopProvider();
            return;
          }
        }
        if (!responseAbortController.signal.aborted && !reply.raw.destroyed) {
          if (await writeSse(reply.raw, { type: 'done' }, responseAbortController.signal)) {
            reply.raw.end();
          }
        }
      } catch (error: unknown) {
        stopProvider();
        if (!responseAbortController.signal.aborted && !reply.raw.destroyed) {
          const terminalEvent =
            error instanceof ModelTerminalError
              ? { type: 'error' as const, code: error.code, message: error.message }
              : SAFE_PROVIDER_ERROR;
          request.log.warn({ errorCode: terminalEvent.code }, 'provider completion failed');
          if (await writeSse(reply.raw, terminalEvent, responseAbortController.signal)) {
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
