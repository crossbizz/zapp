import { createHttpServerTelemetry, type ServiceName, type ServiceTokenSigner } from '@zapp/config';
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
import { serviceAuth } from './internal/service-auth.js';
import { defaultLoggerOptions, type LoggerConfig } from './logging.js';
import type { GitProvider } from './provider/types.js';
import type { CommitComparisonProvider } from './provider/types.js';
import type { GitMirror } from './import/mirror.js';
import type { GitBundleExporter } from './export.js';
import { registerGitRoutes, type ImportBranchPoll } from './routes.js';
import type { TokenService } from './tokens.js';
import type { GitTemplateSeeder } from './template-seeder.js';
import type { TemplateRegistryEntry, PublicTemplate } from '@zapp/config';

const httpServerTelemetry = createHttpServerTelemetry();

/** The instance every route in this service is registered on: Zod in, Zod out. */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface AppDeps {
  /** `false` in tests. Omitted in production, where {@link defaultLoggerOptions} applies. */
  readonly logger?: LoggerConfig;
  /**
   * Forgejo in a deployment, a fake in a unit suite. A port rather than a
   * client, which is what lets the route suite exercise the real authorization
   * and the real envelope with no Git host anywhere near it.
   */
  readonly provider: GitProvider;
  /**
   * Mints and revokes repository-scoped credentials (GIT-3). A port for the same
   * reason the provider is: the route suite proves who may ask and what comes
   * back, and creating an ephemeral Forgejo user to do that would make those
   * assertions need a Git host.
   */
  readonly tokens: TokenService;
  /**
   * Verifies the service tokens every route requires. Not optional: this service
   * has no user-facing surface at all, so a deployment that cannot verify a
   * service token has no surface — and discovering that from a 401 in staging is
   * better than serving one that admits everybody.
   */
  readonly signer: ServiceTokenSigner;
  /** Which services may call. Defaults to {@link GIT_CALLERS}; overridden by tests. */
  readonly callers?: readonly ServiceName[];
  /** Injected in tests so token expiry is asserted rather than waited for. */
  readonly now?: () => Date;
  readonly mirror?: GitMirror;
  readonly importPoll?: ImportBranchPoll;
  readonly bundleExporter?: GitBundleExporter;
  readonly comparison?: CommitComparisonProvider;
  readonly templates?: {
    getApproved(slug: string): TemplateRegistryEntry | undefined;
    getPublic(slug: string): PublicTemplate | undefined;
  };
  readonly templateSeeder?: GitTemplateSeeder;
}

/**
 * Builds the API without binding a port, which is what makes it testable:
 * `inject` drives the full lifecycle — hooks, validation, serialization, error
 * handling — with no socket. `server.ts` is the only place that listens.
 */
export function buildApp(deps: AppDeps): AppInstance {
  const app = Fastify({
    logger: deps.logger ?? defaultLoggerOptions,
    // Fastify's own header lookup would take an inbound id verbatim. Turning it
    // off leaves the framework's generator as the only source, so a caller
    // cannot choose the id its request is filed under.
    requestIdHeader: false,
    /**
     * Never `true`, and never a proxy list either: this service is reachable
     * only over the private network, so `request.ip` is a peer inside the mesh
     * and an `X-Forwarded-For` header on one of these requests is a header
     * somebody wrote by hand.
     */
    trustProxy: false,
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
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // Liveness only, and deliberately outside `/internal`: it is infrastructure,
  // not API, so it carries no envelope, requires no credential and must never
  // depend on Forgejo. A health check that failed when the Git host was slow
  // would take this service out of rotation for something it cannot fix.
  app.get(
    '/healthz',
    { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } },
    () => ({ status: 'ok' }) as const,
  );

  void app.register(serviceAuth, {
    signer: deps.signer,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  // `after` rather than a call here: the routes reference `app.requireService`,
  // and a decorator added by a plugin only exists once that plugin has loaded.
  app.after((error) => {
    // Truthiness rather than `!== null`: avvio hands the first `after` callback
    // `null` and the ones that follow `undefined`, and both mean the plugins
    // before it loaded cleanly.
    if (error) {
      throw error;
    }
    registerGitRoutes(app, {
      provider: deps.provider,
      tokens: deps.tokens,
      ...(deps.callers === undefined ? {} : { callers: deps.callers }),
      ...(deps.mirror === undefined ? {} : { mirror: deps.mirror }),
      ...(deps.importPoll === undefined ? {} : { importPoll: deps.importPoll }),
      ...(deps.bundleExporter === undefined ? {} : { bundleExporter: deps.bundleExporter }),
      ...(deps.comparison === undefined ? {} : { comparison: deps.comparison }),
      ...(deps.templates === undefined ? {} : { templates: deps.templates }),
      ...(deps.templateSeeder === undefined ? {} : { templateSeeder: deps.templateSeeder }),
    });
  });

  return app;
}
