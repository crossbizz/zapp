import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import { errorHandler, notFoundHandler } from './errors.js';
import { defaultLoggerOptions, type LoggerConfig } from './logging.js';
import { genRequestId, requestContext } from './plugins/context.js';

/** The instance every route in this service is registered on: Zod in, Zod out. */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/**
 * Collaborators handed to the app rather than reached for. Only the logger exists at
 * CP-1; the database, Redis and `AuthPort` join it as their plugins land, and each
 * arrives here so a test can substitute it.
 */
export interface AppDeps {
  /** `false` in tests. Omitted in production, where {@link defaultLoggerOptions} applies. */
  readonly logger?: LoggerConfig;
}

/**
 * Builds the API without binding a port, which is what makes it testable: `inject`
 * drives the full lifecycle — hooks, validation, serialization, error handling — with
 * no socket. `server.ts` is the only place that listens.
 *
 * Routes may be added by the caller after this returns and before `ready()`; they
 * inherit the compilers and handlers set here.
 */
export function buildApp(deps: AppDeps = {}): AppInstance {
  const app = Fastify({
    logger: deps.logger ?? defaultLoggerOptions,
    // Fastify's own header lookup would take an inbound id verbatim, bypassing the
    // validation in `genRequestId`. Turning it off leaves exactly one way in.
    requestIdHeader: false,
    genReqId: genRequestId,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  void app.register(requestContext);

  // Liveness only, and deliberately outside `/v1`: it is infrastructure, not API, so
  // it carries no envelope and must never depend on a database or a downstream.
  app.get(
    '/healthz',
    { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } },
    () => ({ status: 'ok' }) as const,
  );

  return app;
}
