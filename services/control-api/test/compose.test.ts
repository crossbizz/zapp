import { createDb } from '@zapp/db';
import { ApiErrorSchema, newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, type AppDeps, type AppInstance } from '../src/app.js';
import { composeApp } from '../src/compose.js';
import { loadRateLimitSettings } from '../src/config/rate-limits.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import type { RedisCommands } from '../src/redis/client.js';
import { FakeAuthPort } from './support/fake-auth-port.js';
import { InMemoryUserStore, TEST_AUTH_CONFIG, TEST_MASTER_KEY } from './support/harness.js';
import { InMemoryOrganizationStore } from './support/org-store.js';
import { TEST_SERVICE_TOKEN_SECRET } from './support/service-tokens.js';

/**
 * What `server.ts` actually composes.
 *
 * This file exists because of a specific failure: for a whole task the only
 * entrypoint that listens built its app without `tenant`, so `/v1/projects` and
 * `/v1/runs` were absent from the running service while the isolation suite —
 * which built its own app — proved they were isolated. Nothing was wrong with
 * either half; nothing tested the join (plan 02 CP-4 review).
 *
 * So the assertions here are about *wiring*, not behaviour: which routes the
 * composed app serves, and that a request to one of them is refused for the
 * right reason rather than because the path does not exist. A missing route
 * answers `404 route_not_found`; a present one answers `401 unauthenticated`,
 * and those are the two outcomes this file tells apart.
 *
 * No database or Redis is contacted: the postgres.js pool is lazy, and every
 * assertion below is refused before a query or a command is issued.
 */

/** Never connected to. `createDb` opens no socket until something asks it a question. */
const UNUSED_DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';

/** Any use is a bug in the test, so every command says so rather than answering. */
const unusedRedis: RedisCommands = {
  get: () => Promise.reject(new Error('redis reached')),
  set: () => Promise.reject(new Error('redis reached')),
  setIfAbsent: () => Promise.reject(new Error('redis reached')),
  exists: () => Promise.reject(new Error('redis reached')),
  delete: () => Promise.reject(new Error('redis reached')),
  eval: () => Promise.reject(new Error('redis reached')),
};

const apps: AppInstance[] = [];
const handles: { close: () => Promise<void> }[] = [];

function composed(): AppInstance {
  const database = createDb(UNUSED_DATABASE_URL);
  handles.push(database);
  const app = composeApp({
    logger: false,
    database: database.db,
    redis: unusedRedis,
    auth: {
      databaseUrl: UNUSED_DATABASE_URL,
      config: TEST_AUTH_CONFIG,
      stytch: {
        projectId: 'project-test-00000000-0000-0000-0000-000000000000',
        secret: 'secret-test-not-a-real-key',
        publicToken: 'public-token-test-abc',
      },
    },
    masterKey: TEST_MASTER_KEY,
    serviceTokens: { secret: TEST_SERVICE_TOKEN_SECRET },
    rateLimits: loadRateLimitSettings(),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

/** Every route PRD §32 gives this service today, and the method it answers to. */
const ROUTES: readonly (readonly [string, string])[] = [
  ['GET', '/healthz'],
  ['GET', '/v1/auth/login'],
  ['GET', '/v1/auth/callback'],
  ['POST', '/v1/auth/logout'],
  ['POST', '/v1/auth/refresh'],
  ['GET', '/v1/auth/device'],
  ['POST', '/v1/auth/device/approve'],
  ['POST', '/v1/auth/device/deny'],
  ['POST', '/v1/auth/device/token'],
  ['GET', '/v1/me'],
  ['POST', '/v1/organizations'],
  ['GET', '/v1/organizations'],
  ['PATCH', '/v1/organizations/:orgId'],
  ['POST', '/v1/organizations/:orgId/invites'],
  ['POST', '/v1/invites/:token/accept'],
  ['PATCH', '/v1/organizations/:orgId/members/:userId'],
  ['DELETE', '/v1/organizations/:orgId/members/:userId'],
  ['GET', '/v1/organizations/:orgId/audit-events'],
  ['GET', '/v1/organizations/:orgId/settings'],
  ['PATCH', '/v1/organizations/:orgId/settings'],
  // CP-4's tenant surface — the six that were missing from the running service.
  ['POST', '/v1/projects'],
  ['GET', '/v1/projects'],
  ['GET', '/v1/projects/:projectId'],
  ['GET', '/v1/projects/:projectId/runs'],
  ['GET', '/v1/runs/:runId'],
  ['GET', '/v1/runs/:runId/events'],
  // CP-6's additions to it (PRD §32.1).
  ['PATCH', '/v1/projects/:projectId'],
  ['GET', '/v1/projects/:projectId/contract'],
  ['POST', '/v1/projects/:projectId/scan'],
  // CP-7's vault (PRD §32.5), including the internal decrypt — deployed with a
  // deny-all verifier until CP-8, which is a route that admits nobody rather
  // than a route that does not exist.
  ['POST', '/v1/projects/:projectId/secrets'],
  ['GET', '/v1/projects/:projectId/secrets'],
  ['POST', '/v1/projects/:projectId/secrets/:secretId/rotate'],
  ['DELETE', '/v1/projects/:projectId/secrets/:secretId'],
  ['POST', '/internal/secrets/decrypt'],
];

describe('the composition server.ts performs', () => {
  it('serves every route the service claims, tenant-scoped ones included', async () => {
    const app = composed();
    await app.ready();

    for (const [method, url] of ROUTES) {
      expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
  });

  it('refuses a tenant-scoped request as unauthenticated, not as an unknown path', async () => {
    const app = composed();

    const urls = [
      `/v1/organizations/${newId('org')}/audit-events`,
      `/v1/organizations/${newId('org')}/settings`,
      '/v1/projects',
      `/v1/projects/${newId('proj')}`,
      `/v1/projects/${newId('proj')}/contract`,
      `/v1/projects/${newId('proj')}/runs`,
      `/v1/runs/${newId('run')}`,
      `/v1/runs/${newId('run')}/events`,
    ];
    for (const url of urls) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { [ORGANIZATION_HEADER]: newId('org') },
      });

      // 404 here would mean the tenant plugin and its routes were never
      // registered — which is exactly what shipped before this file existed.
      expect(response.statusCode, url).toBe(401);
      expect(ApiErrorSchema.parse(response.json()).error.code).toBe('unauthenticated');
    }
  });

  it('answers the liveness probe without touching a dependency', async () => {
    const response = await composed().inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('the startup guards', () => {
  /** Runs `build` with `NODE_ENV` set to `value`, and puts it back afterwards. */
  function withNodeEnv(value: string | undefined, build: () => void): () => void {
    return () => {
      const previous = process.env['NODE_ENV'];
      if (value === undefined) {
        delete process.env['NODE_ENV'];
      } else {
        process.env['NODE_ENV'] = value;
      }
      try {
        build();
      } finally {
        if (previous === undefined) {
          delete process.env['NODE_ENV'];
        } else {
          process.env['NODE_ENV'] = previous;
        }
      }
    };
  }

  /** The auth surface, wired to doubles — the parts this block is not about. */
  function build(extra: Omit<AppDeps, 'logger' | 'auth'>): void {
    const app = buildApp({
      logger: false,
      auth: { port: new FakeAuthPort(), users: new InMemoryUserStore(), config: TEST_AUTH_CONFIG },
      ...extra,
    });
    apps.push(app);
  }

  const orgs = { organizations: new InMemoryOrganizationStore() };
  const tenant = { tenantDb: (() => ({})) as never };

  it('refuses an organization surface with no tenant-scoped routes', () => {
    // The mirror of "tenant routes require orgs". Without it, omitting `tenant`
    // is silent — which is how six routes went missing from the only
    // entrypoint that listens.
    expect(
      withNodeEnv('production', () => {
        build({ orgs });
      }),
    ).toThrow(/tenantDb/);
  });

  it('refuses a secrets surface with no tenant handle to scope it', () => {
    // The vault reads and writes through the tenant handle, and the internal
    // decrypt route turns an organization id into one (plan 02 CP-7). Without
    // the factory there is nothing for either to be scoped against, and a
    // secrets route that improvised its own scope is the one thing this service
    // must never ship.
    expect(
      withNodeEnv('development', () => {
        build({
          orgs,
          secrets: {
            masterKey: TEST_MASTER_KEY,
            serviceTokens: { verify: () => Promise.resolve({ ok: false, reason: 'malformed' }) },
          },
        });
      }),
    ).toThrow(/secrets routes require tenant/);
  });

  it('refuses to boot with process-local stores outside development', () => {
    // The in-memory rate limiter, idempotency store, denylist, device store,
    // invite store and audit sink are each correct for exactly one instance.
    // Defaulting to one in a deployment is the accident this prevents.
    expect(
      withNodeEnv('production', () => {
        build({ orgs, tenant });
      }),
    ).toThrow(/refusing to start: no rate limiter/);

    // …and an *unset* NODE_ENV is production too, exactly as `src/env.ts` reads
    // it. A container that forgot the variable gets the guards, not the
    // fallbacks.
    expect(
      withNodeEnv(undefined, () => {
        build({ orgs, tenant });
      }),
    ).toThrow(/refusing to start/);
  });

  it('lets a development run default to them', () => {
    expect(
      withNodeEnv('development', () => {
        build({ orgs, tenant });
      }),
    ).not.toThrow();
  });
});
