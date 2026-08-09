import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
  type preHandlerAsyncHookHandler,
} from 'fastify';
import websocket from '@fastify/websocket';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  createGitTokenClient,
  createWorkspaceGitService,
  type GitTokenClientOptions,
  type WorkspaceGitService,
} from './provider/git-bootstrap.js';
import { BranchLockedError } from './provider/volumes.js';
import {
  registerWorkspaceRoutes,
  type WorkspaceAgentProvider,
  type WorkspaceRowBoundary,
} from './routes/workspaces.js';
import type { NetworkPolicyRecorder } from './network/profiles.js';
import { createFetchPreviewTransport, type PreviewTransport } from './preview/transport.js';
import type { ScopedSecretInjector } from './secrets/injector.js';
import { registerPreviewRoutes } from './routes/preview.js';

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

interface BuildAppCommonOptions {
  readonly provider: WorkspaceAgentProvider;
  readonly rows: WorkspaceRowBoundary;
  readonly serviceTokens: SandboxServiceTokenVerifier;
  readonly secrets: ScopedSecretInjector;
  readonly networkPolicies: NetworkPolicyRecorder;
  readonly previewTransport?: PreviewTransport;
  readonly now?: () => Date;
  readonly logger?: FastifyServerOptions['logger'];
}

export type BuildAppOptions = BuildAppCommonOptions &
  (
    | { readonly workspaceGit: WorkspaceGitService; readonly gitService?: never }
    | { readonly workspaceGit?: never; readonly gitService: GitTokenClientOptions }
  );

function authenticationError() {
  return { code: 'service_unauthenticated', message: 'A valid service token is required.' };
}

export function buildApp(options: BuildAppOptions) {
  const now = options.now ?? (() => new Date());
  const workspaceGit =
    options.workspaceGit ??
    createWorkspaceGitService({
      tokens: createGitTokenClient(options.gitService),
      commands: options.provider,
    });
  const app = Fastify({
    logger: options.logger ?? false,
    requestIdHeader: false,
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  void app.register(websocket);
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof BranchLockedError) {
      void reply.status(409).send({ code: error.code, message: error.message });
      return;
    }
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

  registerWorkspaceRoutes(app, {
    provider: options.provider,
    rows: options.rows,
    workspaceGit,
    secrets: options.secrets,
    networkPolicies: options.networkPolicies,
    now,
  });
  const previewTransport =
    options.previewTransport ??
    createFetchPreviewTransport({
      async resolvePreviewTunnel(providerWorkspaceId) {
        if (options.provider.resolvePreviewTunnel === undefined) {
          throw new Error('Workspace provider does not support preview transport');
        }
        return options.provider.resolvePreviewTunnel(providerWorkspaceId);
      },
    });
  void app.register((previewApp, _pluginOptions, done) => {
    registerPreviewRoutes(previewApp, { rows: options.rows, transport: previewTransport });
    done();
  });
  return app;
}
