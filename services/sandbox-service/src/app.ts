import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
  type preHandlerAsyncHookHandler,
} from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  registerWorkspaceRoutes,
  type WorkspaceAgentProvider,
  type WorkspaceRowBoundary,
} from './routes/workspaces.js';

const SERVICE_TOKEN_HEADER = 'x-zapp-service-token';

export interface SandboxServiceTokenVerifier {
  verifyServiceToken(
    token: string,
    audience: 'sandbox-service',
    now?: Date,
  ): Promise<
    | {
        readonly ok: true;
        readonly claims: { readonly service: string; readonly audience: string };
      }
    | { readonly ok: false; readonly reason: string }
  >;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireService: preHandlerAsyncHookHandler;
  }
}

export type SandboxServiceApp = FastifyInstance;

export interface BuildAppOptions {
  readonly provider: WorkspaceAgentProvider;
  readonly rows: WorkspaceRowBoundary;
  readonly serviceTokens: SandboxServiceTokenVerifier;
  readonly now?: () => Date;
  readonly logger?: FastifyServerOptions['logger'];
}

function authenticationError() {
  return { code: 'service_unauthenticated', message: 'A valid service token is required.' };
}

export function buildApp(options: BuildAppOptions) {
  const now = options.now ?? (() => new Date());
  const app = Fastify({
    logger: options.logger ?? false,
    requestIdHeader: false,
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.setErrorHandler((error, _request, reply) => {
    if ((error as { readonly code?: unknown }).code === 'atomic_write_conflict') {
      void reply.status(409).send({
        code: 'atomic_write_conflict',
        message: 'Atomic file changed before commit.',
      });
      return;
    }
    const fastifyError = error as { readonly statusCode?: number; readonly validation?: unknown };
    if (fastifyError.validation !== undefined || error instanceof z.ZodError) {
      void reply
        .status(400)
        .send({ code: 'invalid_request', message: 'Request validation failed.' });
      return;
    }
    const statusCode = fastifyError.statusCode ?? 500;
    void reply.status(statusCode).send({
      code: statusCode === 404 ? 'workspace_not_found' : 'sandbox_operation_failed',
      message:
        statusCode >= 500
          ? 'The sandbox operation failed.'
          : error instanceof Error
            ? error.message
            : 'The request failed.',
    });
  });

  app.decorate('requireService', async (request, reply) => {
    if (request.headers.authorization !== undefined || request.headers.cookie !== undefined) {
      await reply.status(401).send(authenticationError());
      return;
    }
    const raw = request.headers[SERVICE_TOKEN_HEADER];
    if (typeof raw !== 'string' || raw === '') {
      await reply.status(401).send(authenticationError());
      return;
    }
    const verdict = await options.serviceTokens.verifyServiceToken(raw, 'sandbox-service', now());
    if (
      !verdict.ok ||
      verdict.claims.audience !== 'sandbox-service' ||
      !['control-api', 'orchestrator-worker'].includes(verdict.claims.service)
    ) {
      await reply.status(401).send(authenticationError());
    }
  });

  registerWorkspaceRoutes(app, { provider: options.provider, rows: options.rows, now });
  return app;
}
