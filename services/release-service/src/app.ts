import { tenantSafePinoOptions, type ServiceTokenSigner } from '@zapp/config';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  createControlApiServiceAuth,
  ServiceAccessError,
} from './internal/service-auth.js';
import type { ReleaseLifecycleService } from './lifecycle.js';
import type { ReleaseHistoryPort } from './history.js';
import type { DeploymentProgressPort } from './deployment-progress.js';
import { DomainServiceError } from './domains/service.js';
import type { DomainPort } from './domain-store.js';
import type { ProductionProjectionPort } from './production-history.js';
import type { RollbackPreview } from './rollback/service.js';
import { ReleaseServiceError, type ReleaseRecordService } from './release/create.js';
import { registerReleaseRoutes } from './routes.js';

export type LoggerConfig = NonNullable<FastifyServerOptions['logger']>;

export interface AppDependencies {
  readonly records: ReleaseRecordService;
  readonly lifecycle: ReleaseLifecycleService;
  readonly history?: ReleaseHistoryPort;
  readonly progress?: DeploymentProgressPort;
  readonly domains?: DomainPort;
  readonly productionHistory?: ProductionProjectionPort;
  readonly rollbackPreview?: { preview(input: { organizationId: string; projectId: string; environmentId: string; toDeploymentId?: string }): Promise<RollbackPreview> };
  readonly signer: ServiceTokenSigner;
  readonly now?: () => Date;
  readonly logger?: LoggerConfig;
}

export function buildApp(dependencies: AppDependencies) {
  const app = Fastify({
    logger:
      dependencies.logger ??
      tenantSafePinoOptions({ serviceName: 'release-service', level: 'info' }),
    requestIdHeader: false,
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, request, reply) => {
    reply.serializer((payload: unknown) => JSON.stringify(payload));
    if (
      error instanceof ServiceAccessError ||
      error instanceof ReleaseServiceError ||
      error instanceof DomainServiceError
    ) {
      void reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id },
      });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({
        error: {
          code: 'invalid_request',
          message: 'The request payload is invalid.',
          requestId: request.id,
        },
      });
      return;
    }
    request.log.error({ errorKind: 'release_service_internal' }, 'release request failed');
    void reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'The release service could not complete the request.',
        requestId: request.id,
      },
    });
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'route_not_found',
        message: 'The requested route does not exist.',
        requestId: request.id,
      },
    });
  });

  app.get(
    '/healthz',
    { schema: { response: { 200: z.object({ status: z.literal('ok') }).strict() } } },
    () => ({ status: 'ok' }) as const,
  );

  registerReleaseRoutes(app, {
    records: dependencies.records,
    lifecycle: dependencies.lifecycle,
    ...(dependencies.history === undefined ? {} : { history: dependencies.history }),
    ...(dependencies.progress === undefined ? {} : { progress: dependencies.progress }),
    ...(dependencies.domains === undefined ? {} : { domains: dependencies.domains }),
    ...(dependencies.productionHistory === undefined ? {} : { productionHistory: dependencies.productionHistory }),
    ...(dependencies.rollbackPreview === undefined ? {} : { rollbackPreview: dependencies.rollbackPreview }),
    requireService: createControlApiServiceAuth({
      signer: dependencies.signer,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    }),
  });

  return app;
}
