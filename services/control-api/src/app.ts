import { randomBytes } from 'node:crypto';

import type { ServiceName } from '@zapp/config';
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

import type { AuthConfig } from './auth/config.js';
import {
  createInMemoryTokenDenylist,
  sessionFamilyKey,
  type TokenDenylist,
} from './auth/denylist.js';
import { createInMemoryDeviceStore, type DeviceStore } from './auth/device.js';
import type { AuthPort } from './auth/port.js';
import { createSessionSigner } from './auth/session.js';
import type { UserStore } from './auth/users.js';
import {
  loadRateLimitSettings,
  trustProxyOption,
  type ProxyTrust,
  type RateLimitConfig,
} from './config/rate-limits.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { registerOpenApi } from './openapi.js';
import type { EventStreamDependencies } from './events/sse.js';
import { createRecordOnlyGitService, type GitServicePort } from './git/port.js';
import { createUnavailableOrchestrator, type OrchestratorPort } from './orchestrator/port.js';
import { createUnavailableSandboxService, type SandboxServicePort } from './sandbox/port.js';
import { registerInternalSecretRoutes } from './internal/secrets.js';
import { registerInternalEventRoutes } from './internal/events.js';
import { serviceAuth, type ServiceTokenVerifier } from './internal/service-auth.js';
import { defaultLoggerOptions, type LoggerConfig } from './logging.js';
import { createInMemoryInviteStore, type InviteStore } from './orgs/invites.js';
import type { OrganizationStore } from './orgs/store.js';
import { auditLog, createInMemoryAuditSink, type AuditSink } from './plugins/audit.js';
import { sessionAuth } from './plugins/auth.js';
import { genRequestId, requestContext } from './plugins/context.js';
import {
  createInMemoryIdempotencyStore,
  idempotency,
  type IdempotencyStore,
} from './plugins/idempotency.js';
import { createInMemoryRateLimiter, rateLimit, type RateLimiter } from './plugins/rate-limit.js';
import { tenantContext } from './plugins/tenant.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerOrgRoutes } from './routes/orgs.js';
import { registerProjectRoutes } from './routes/projects.js';
import {
  createUnavailableReleasePort,
  registerReleaseRoutes,
  type ReleasePort,
} from './routes/releases.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerSecretRoutes } from './routes/secrets.js';
import { registerSpecificationRoutes } from './routes/specifications.js';
import {
  createUnavailableIntegrationPort,
  registerIntegrationRoutes,
  type IntegrationPort,
} from './routes/integrations.js';
import type { MasterKeyPort } from './secrets/crypto.js';
import { createSecretVault } from './secrets/vault.js';
import type { TenantDbFactory } from './tenant/db.js';

/** The instance every route in this service is registered on: Zod in, Zod out. */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/**
 * What the authenticated surface needs (CP-2). Every collaborator that touches a
 * credential arrives here rather than being constructed inside a route, which is
 * what lets the whole session layer be tested against a fake identity provider,
 * an in-memory user store and a clock a test controls.
 */
export interface AuthDeps {
  readonly port: AuthPort;
  readonly users: UserStore;
  readonly config: AuthConfig;
  /** Defaults to the process-local list. CP-5 supplies the Redis-backed one. */
  readonly denylist?: TokenDenylist;
  readonly deviceStore?: DeviceStore;
  /** Injected in tests so expiry is asserted rather than waited for. */
  readonly now?: () => Date;
}

/**
 * What the organization surface needs (CP-3). Same rule as {@link AuthDeps}: the
 * store arrives from outside, so the routes, the RBAC matrix and the invite
 * lifecycle are all testable without PostgreSQL.
 */
export interface OrgDeps {
  readonly organizations: OrganizationStore;
  /** Defaults to the process-local store. CP-5 supplies the persistent one. */
  readonly invites?: InviteStore;
  /** Defaults to the process-local sink. CP-5 supplies the `audit_events` writer. */
  readonly audit?: AuditSink;
}

/**
 * What the tenant-scoped surface needs (CP-4): one function that binds the
 * database to an organization.
 *
 * A factory rather than a `Database`, and for the reason the whole task exists:
 * nothing downstream of this line ever holds an unscoped handle. `buildApp`
 * passes it to the tenant plugin, the plugin calls it only with an organization
 * it has already verified an active membership for, and the result is the only
 * database access a route module has.
 */
export interface TenantDeps {
  readonly tenantDb: TenantDbFactory;
  /** Shared 32-byte key for durable run-request fingerprints. */
  readonly runIntentHmacKey?: Buffer;
  /**
   * Creates a project's internal repository, inside the transaction that creates
   * the project (CP-6). Defaults to the record-only stand-in, which names the
   * repository and contacts nothing — plan 06's GIT-2 binds the Forgejo client
   * in `src/compose.ts`, and a test binds one that fails on demand.
   */
  readonly git?: GitServicePort;
  /** CP-9's durable-workflow boundary. Omitted only where mutations must fail closed. */
  readonly orchestrator?: OrchestratorPort;
  readonly sandbox?: SandboxServicePort;
  /** CP-11's temporary Plan 07 boundary. Plan 07 replaces the unavailable port. */
  readonly releasePort?: ReleasePort;
  /** CP-11's temporary Plan 06 boundary. Plan 06 replaces the unavailable port. */
  readonly integrationPort?: IntegrationPort;
  /** CP-15's Redis wakeup port; PostgreSQL remains the replay source of truth. */
  readonly eventStream?: EventStreamDependencies;
}

/**
 * What the rate-limit and idempotency plugins need (CP-5). Both are always
 * registered — a route that could be added without a limit or without replay
 * protection is one that will be — so what arrives here is only *which*
 * implementation backs them.
 */
export interface LimitDeps {
  /** Defaults to `config/rate-limits.json`. */
  readonly config?: RateLimitConfig;
  /**
   * How far `request.ip` may follow `X-Forwarded-For`. Defaults to the same
   * file, which defaults to trusting nothing — see {@link ProxyTrust}.
   */
  readonly proxy?: ProxyTrust;
  /** Defaults to the process-local bucket. Production supplies the Redis one. */
  readonly limiter?: RateLimiter;
  readonly idempotency?: IdempotencyStore;
}

/**
 * What the secrets vault needs (CP-7). Both are ports, and both are required
 * together: the surface is registered only when the service can actually
 * encrypt, so a deployment missing `SECRETS_MASTER_KEY` has no secrets routes
 * rather than routes that fail at the first write — and no internal decrypt
 * route that might answer before it can decrypt anything.
 */
export interface SecretsDeps {
  /**
   * Wraps and unwraps per-secret data keys. `loadMasterKey` builds the
   * environment-backed one (`src/env.ts`); a KMS implementation satisfies the
   * same port.
   */
  readonly masterKey: MasterKeyPort;
  /**
   * Verifies the service tokens `/internal/*` requires (CP-8).
   * `createServiceTokenVerifier` is the shipping one, bound in `composeApp`; it
   * arrives here as a port so a suite can exercise the gate without a secret
   * and so a KMS-signed variant could replace it without a route changing.
   */
  readonly serviceTokens: ServiceTokenVerifier;
  /** Which services may decrypt. Defaults to PRD §18.12's two; overridden by tests. */
  readonly decryptCallers?: readonly ServiceName[];
}

/**
 * Collaborators handed to the app rather than reached for. Only the logger exists at
 * CP-1; the database, Redis and `AuthPort` join it as their plugins land, and each
 * arrives here so a test can substitute it.
 */
export interface AppDeps {
  /** `false` in tests. Omitted in production, where {@link defaultLoggerOptions} applies. */
  readonly logger?: LoggerConfig;
  /**
   * Omitted only by tests that have no business with sessions: without it the
   * `/v1/auth/*` and `/v1/me` routes are not registered at all, so an
   * unconfigured deployment cannot serve half an authentication flow.
   */
  readonly auth?: AuthDeps;
  /** CP-3. Requires {@link AppDeps.auth} — every organization route needs a session. */
  readonly orgs?: OrgDeps;
  /**
   * CP-4. Requires {@link AppDeps.orgs} — tenant resolution asks the
   * organization store whether the caller is a member before it scopes
   * anything — and, outside development, is required *by* it: see
   * {@link buildApp}.
   */
  readonly tenant?: TenantDeps;
  /**
   * CP-7. Requires {@link AppDeps.tenant} — the vault reads through the same
   * organization-bound handle every other tenant-scoped route does.
   */
  readonly secrets?: SecretsDeps;
  /** CP-5. Optional everywhere; the fallbacks are refused outside development. */
  readonly limits?: LimitDeps;
  /** Injected in tests so expiry and refill are asserted rather than waited for. */
  readonly now?: () => Date;
}

/**
 * Whether this process is one a mistake is allowed to be cheap in.
 *
 * `production` is not the only value that means production: `src/env.ts` treats
 * an *unset* `NODE_ENV` as production deliberately, because every switch that
 * reads it is safer in its production position and an unset variable must never
 * be what turns a relaxation on. This asks the same question the same way — a
 * container that forgot the variable gets the guards, not the fallbacks. Vitest
 * sets `NODE_ENV=test`, so the suites are unaffected.
 */
function isDevelopment(): boolean {
  const environment = process.env['NODE_ENV'];
  return environment === 'development' || environment === 'test';
}

/**
 * Guards the process-local fallbacks.
 *
 * Each of them is correct for exactly one instance: a logout honoured only by
 * the instance that served it, a device login that completes only when both legs
 * land on the same process, an invite that can be accepted only against the
 * process that issued it, an audit trail a restart erases, a rate limit
 * multiplied by the number of replicas, and an idempotency key the next
 * instance has never heard of. Those are failures a staging deployment would
 * show as flakiness and a production one as a security hole. Supplying an
 * in-memory implementation explicitly stays possible — this refuses only to
 * *default* to one, which is how it would happen by accident.
 */
function inDevelopmentOnly<T>(name: string, why: string, build: () => T): T {
  if (!isDevelopment()) {
    throw new Error(`refusing to start: no ${name} was supplied, and ${why}`);
  }
  return build();
}

function resolvedRunIntentHmacKey(key: Buffer | undefined): Buffer {
  if (key === undefined) {
    throw new Error('run-intent fingerprint HMAC key resolution failed');
  }
  return key;
}

const SINGLE_INSTANCE = 'the in-memory fallback is single-instance only';

/**
 * Builds the API without binding a port, which is what makes it testable: `inject`
 * drives the full lifecycle — hooks, validation, serialization, error handling — with
 * no socket. `server.ts` is the only place that listens.
 *
 * Routes may be added by the caller after this returns and before `ready()`; they
 * inherit the compilers and handlers set here.
 */
export function buildApp(deps: AppDeps = {}): AppInstance {
  const runIntentHmacKey =
    deps.tenant === undefined
      ? undefined
      : (deps.tenant.runIntentHmacKey ??
        inDevelopmentOnly(
          'run-intent fingerprint HMAC key',
          'a process-local key cannot recover a retry on another instance',
          () => randomBytes(32),
        ));
  // Read (and cached) only where a caller did not supply one, so a test that
  // states both never depends on the file at all.
  const proxy = deps.limits?.proxy ?? loadRateLimitSettings().proxy;

  const app = Fastify({
    logger: deps.logger ?? defaultLoggerOptions,
    // Fastify's own header lookup would take an inbound id verbatim, bypassing the
    // validation in `genRequestId`. Turning it off leaves exactly one way in.
    requestIdHeader: false,
    genReqId: genRequestId,
    /**
     * How far `request.ip` follows `X-Forwarded-For`, and never `true`.
     *
     * Every address-scoped rate limit reads `request.ip`. Behind a proxy the
     * socket peer is the proxy, so without this the whole `auth` class is one
     * global bucket; with `true` the header is client-controlled, so it is a
     * complete bypass instead. The only safe answer is a stated one, and it is
     * stated in `config/rate-limits.json` next to the limits that depend on it.
     * Absent, it trusts nothing — wrong behind a proxy, never exploitable, and
     * the rate-limit plugin logs it at boot.
     */
    trustProxy: trustProxyOption(proxy),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  void app.register(requestContext);
  registerOpenApi(app);

  // Liveness only, and deliberately outside `/v1`: it is infrastructure, not API, so
  // it carries no envelope and must never depend on a database or a downstream.
  app.get(
    '/healthz',
    { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } },
    () => ({ status: 'ok' }) as const,
  );

  if (deps.auth === undefined && deps.orgs !== undefined) {
    // Half a tenant surface is worse than none: every route in `orgs.ts` starts
    // from `request.auth`, and without the session plugin they would 500 rather
    // than 401.
    throw new Error('refusing to start: orgs routes require auth (AppDeps.auth)');
  }

  if (deps.secrets !== undefined && deps.tenant === undefined) {
    // The vault reads and writes through the tenant handle, and the internal
    // decrypt route turns an organization id into one. Without the factory
    // there is nothing to scope either against.
    throw new Error('refusing to start: secrets routes require tenant (AppDeps.tenant)');
  }

  if (deps.tenant !== undefined && deps.orgs === undefined) {
    // The tenant plugin's whole job is "is this caller an active member of this
    // organization", and only the organization store can answer it. Without one
    // it would have to either guess or admit everybody.
    throw new Error('refusing to start: tenant routes require orgs (AppDeps.orgs)');
  }

  if (deps.orgs !== undefined && deps.tenant === undefined) {
    // The mirror of the guard above, and the reason it is here: for a whole
    // task nothing refused this combination, so `server.ts` shipped an app with
    // organizations but no tenant plugin — every `/v1/projects` and `/v1/runs`
    // route silently absent from the only entrypoint that listens, and M0's
    // headline exit criterion demonstrated solely against a test's own wiring
    // (plan 02 CP-4 review). Fail-closed, so it was never a hole; it was worse
    // than a hole, because nothing said so.
    //
    // Development-only rather than absolute: a unit suite that exercises the
    // organization surface has no database to bind a tenant handle to, and
    // requiring one there would buy nothing.
    inDevelopmentOnly(
      'tenantDb (AppDeps.tenant)',
      'an organization surface with no tenant-scoped routes is half a control plane',
      () => undefined,
    );
  }

  const now = deps.now ?? deps.auth?.now ?? (() => new Date());

  // Registered here — after `/healthz`, before every other route — so the two
  // route-enrolling plugins see everything that follows and nothing that came
  // before. A liveness probe a cache outage can fail is not a liveness probe.
  void app.register(rateLimit, {
    config: deps.limits?.config ?? loadRateLimitSettings().classes,
    proxy,
    limiter:
      deps.limits?.limiter ??
      inDevelopmentOnly('rate limiter', SINGLE_INSTANCE, () => createInMemoryRateLimiter(now)),
  });
  void app.register(idempotency, {
    store:
      deps.limits?.idempotency ??
      inDevelopmentOnly('idempotency store', SINGLE_INSTANCE, () =>
        createInMemoryIdempotencyStore(now),
      ),
  });

  if (deps.auth !== undefined) {
    const auth = deps.auth;
    const signer = createSessionSigner({
      secret: auth.config.sessionSecret,
      ...(auth.config.previousSecret === undefined
        ? {}
        : { previousSecret: auth.config.previousSecret }),
    });
    const denylist =
      auth.denylist ??
      inDevelopmentOnly('denylist', SINGLE_INSTANCE, () => createInMemoryTokenDenylist(now));
    const deviceStore =
      auth.deviceStore ??
      inDevelopmentOnly('deviceStore', SINGLE_INSTANCE, () => createInMemoryDeviceStore(now));

    void app.register(sessionAuth, { signer, denylist, now });

    const orgs = deps.orgs;
    if (orgs !== undefined) {
      const invites =
        orgs.invites ??
        inDevelopmentOnly('inviteStore', SINGLE_INSTANCE, () => createInMemoryInviteStore(now));
      const sink =
        orgs.audit ??
        inDevelopmentOnly(
          'audit sink',
          'an audit trail a restart erases is not an audit trail',
          createInMemoryAuditSink,
        );
      void app.register(auditLog, { sink, now });

      const tenant = deps.tenant;
      if (tenant !== undefined) {
        void app.register(tenantContext, {
          memberships: orgs.organizations,
          tenantDb: tenant.tenantDb,
        });
      }

      const secrets = deps.secrets;
      if (secrets !== undefined) {
        void app.register(serviceAuth, { verifier: secrets.serviceTokens });
      }

      app.after((error) => {
        // Truthiness rather than `!== null`: avvio hands the first `after`
        // callback `null` and the ones that follow `undefined`, and both mean
        // the plugins before it loaded cleanly. Only a real error is rethrown.
        if (error) {
          throw error;
        }
        registerOrgRoutes(app, {
          organizations: orgs.organizations,
          invites,
          users: auth.users,
          port: auth.port,
          now,
        });
        // Registered only with a tenant handle to give them: a projects route
        // that could not scope itself would be the one thing this service must
        // never ship.
        if (tenant !== undefined) {
          registerAuditRoutes(app, { organizations: orgs.organizations });
          registerProjectRoutes(app, { now, git: tenant.git ?? createRecordOnlyGitService() });
          registerSpecificationRoutes(app, { now });
          registerRunRoutes(app, {
            now,
            runIntentHmacKey: resolvedRunIntentHmacKey(runIntentHmacKey),
            orchestrator: tenant.orchestrator ?? createUnavailableOrchestrator(),
            organizations: orgs.organizations,
            eventStream:
              tenant.eventStream ??
              inDevelopmentOnly('event stream wakeups', SINGLE_INSTANCE, () => ({
                wakeups: {
                  subscribe: () => Promise.reject(new Error('Redis subscription unavailable')),
                },
              })),
            revalidateEventStream: async (context) => {
              if (context.expiresAt.getTime() <= now().getTime()) return false;
              if (await denylist.isDenied(context.jti, sessionFamilyKey(context.sessionId))) {
                return false;
              }
              const membership = await orgs.organizations.membership(
                context.organizationId,
                context.userId,
              );
              return membership?.status === 'active';
            },
          });
          registerWorkspaceRoutes(app, {
            now,
            sandbox: tenant.sandbox ?? createUnavailableSandboxService(),
          });
          registerReleaseRoutes(app, {
            port: tenant.releasePort ?? createUnavailableReleasePort(),
            permissionContextFor: async (organizationId) =>
              (await orgs.organizations.getSettings(organizationId)) ?? {},
          });
          registerIntegrationRoutes(app, {
            port: tenant.integrationPort ?? createUnavailableIntegrationPort(),
          });

          if (secrets !== undefined) {
            registerInternalEventRoutes(app, { tenantDb: tenant.tenantDb });
            // One vault for both surfaces, so the key that encrypted a value on
            // the way in is by construction the key that unwraps it on the way
            // out — two constructions could disagree, and would do so silently
            // until the first decrypt.
            const vault = createSecretVault({
              tenantDb: tenant.tenantDb,
              masterKey: secrets.masterKey,
            });
            registerSecretRoutes(app, { now, vault });
            registerInternalSecretRoutes(app, {
              vault,
              ...(secrets.decryptCallers === undefined ? {} : { callers: secrets.decryptCallers }),
            });
          }
        }
      });
    }

    // `after` rather than a call here: the routes reference `app.requireSession`,
    // and a decorator added by a plugin only exists once that plugin has loaded.
    app.after((error) => {
      if (error) {
        throw error;
      }
      registerAuthRoutes(app, {
        port: auth.port,
        users: auth.users,
        config: auth.config,
        signer,
        denylist,
        deviceStore,
        now,
      });
    });
  }

  return app;
}
