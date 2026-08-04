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
import { createInMemoryTokenDenylist, type TokenDenylist } from './auth/denylist.js';
import { createInMemoryDeviceStore, type DeviceStore } from './auth/device.js';
import type { AuthPort } from './auth/port.js';
import { createSessionSigner } from './auth/session.js';
import type { UserStore } from './auth/users.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { defaultLoggerOptions, type LoggerConfig } from './logging.js';
import { createInMemoryInviteStore, type InviteStore } from './orgs/invites.js';
import type { OrganizationStore } from './orgs/store.js';
import { auditLog, createInMemoryAuditSink, type AuditSink } from './plugins/audit.js';
import { sessionAuth } from './plugins/auth.js';
import { genRequestId, requestContext } from './plugins/context.js';
import { tenantContext } from './plugins/tenant.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrgRoutes } from './routes/orgs.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRunRoutes } from './routes/runs.js';
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
   * organization store whether the caller is a member before it scopes anything.
   */
  readonly tenant?: TenantDeps;
}

/**
 * Guards the process-local fallbacks in {@link AppDeps.auth} and {@link AppDeps.orgs}.
 *
 * Each of them is correct for exactly one instance: a logout honoured only by
 * the instance that served it, a device login that completes only when both legs
 * land on the same process, an invite that can be accepted only against the
 * process that issued it, and an audit trail a restart erases. Those are
 * failures a staging deployment would show as flakiness and a production one as
 * a security hole. Supplying an in-memory implementation explicitly stays
 * possible — this refuses only to *default* to one, which is how it would happen
 * by accident. CP-5's persistent implementations remove the question.
 */
function inDevelopmentOnly<T>(name: string, why: string, build: () => T): T {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(`refusing to start: no ${name} was supplied, and ${why}`);
  }
  return build();
}

const SINGLE_INSTANCE =
  'the in-memory fallback is single-instance only (CP-5 supplies the shared one)';

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

  if (deps.auth === undefined && deps.orgs !== undefined) {
    // Half a tenant surface is worse than none: every route in `orgs.ts` starts
    // from `request.auth`, and without the session plugin they would 500 rather
    // than 401.
    throw new Error('refusing to start: orgs routes require auth (AppDeps.auth)');
  }

  if (deps.tenant !== undefined && deps.orgs === undefined) {
    // The tenant plugin's whole job is "is this caller an active member of this
    // organization", and only the organization store can answer it. Without one
    // it would have to either guess or admit everybody.
    throw new Error('refusing to start: tenant routes require orgs (AppDeps.orgs)');
  }

  if (deps.auth !== undefined) {
    const auth = deps.auth;
    const now = auth.now ?? (() => new Date());
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
          'an audit trail a restart erases is not an audit trail (CP-5 writes audit_events)',
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
          registerProjectRoutes(app, { now });
          registerRunRoutes(app);
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
