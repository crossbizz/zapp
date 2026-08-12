import {
  createHttpServerTelemetry,
  tenantSafePinoOptions,
  type ServiceName,
  type ServiceTokenSigner,
} from '@zapp/config';
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

import { registerVerificationRoutes } from './routes.js';
import type { BrowserRunService } from './runner/playwright.js';

const httpServerTelemetry = createHttpServerTelemetry();

export type VerificationServiceApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface VerificationServiceDependencies {
  readonly signer: ServiceTokenSigner;
  readonly browserRuns: BrowserRunService;
  readonly callers?: readonly ServiceName[];
  readonly logger?: false;
  readonly now?: () => Date;
}

export function buildApp(options: VerificationServiceDependencies): VerificationServiceApp {
  const app = Fastify({
    logger: options.logger ?? tenantSafePinoOptions({ serviceName: 'verification-service' }),
  }).withTypeProvider<ZodTypeProvider>();
  app.addHook('onRequest', (request, _reply, done) => {
    httpServerTelemetry.start(request);
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    httpServerTelemetry.finish(request, {
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      statusCode: reply.statusCode,
    });
    done();
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.get(
    '/healthz',
    { schema: { response: { 200: z.object({ status: z.literal('ok') }).strict() } } },
    () => ({ status: 'ok' as const }),
  );
  registerVerificationRoutes(app, {
    signer: options.signer,
    browserRuns: options.browserRuns,
    callers: options.callers ?? ['orchestrator-worker'],
    now: options.now ?? (() => new Date()),
  });
  return app;
}
