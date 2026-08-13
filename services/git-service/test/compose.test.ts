import type { Database } from '@zapp/db';
import { describe, expect, it } from 'vitest';

import { composeApp } from '../src/compose.js';
import { SERVICE_TOKEN_HEADER } from '../src/internal/service-auth.js';
import { SERVICE_SECRET, newProject, serviceHeaders, serviceToken } from './support/harness.js';
import { loadTemplateRegistry } from '../src/template-registry.js';

const templateRegistry = await loadTemplateRegistry();

/**
 * The composition the deployed service actually runs.
 *
 * This file exists because of what happened in the control plane without it: for
 * a whole task the only entrypoint that listens omitted the tenant plugin, so
 * `/v1/projects` was absent from the running service while the isolation suite —
 * which built its own app — proved it was isolated (plan 02 CP-4 review). Every
 * other suite here calls `buildApp` with a fake provider, which is the same
 * shape of blind spot. So: build it the way `server.ts` does, and check that the
 * surface exists and that it is closed.
 *
 * No Forgejo is contacted. `composeApp` constructs a client rather than using
 * one, and every assertion below is answered before a request would be made.
 */

function deployed() {
  // `composeApp` hands back the app *and* the token service the sweep needs
  // (`src/compose.ts`); this suite is about the app.
  return composeApp({
    logger: false,
    forgejo: {
      // Unreachable on purpose: nothing here should get far enough to dial it,
      // and a test that quietly did would be a test that needs a Git host.
      baseUrl: 'http://127.0.0.1:1',
      adminToken: 'unused-in-this-suite',
      timeoutMs: 100,
    },
    serviceTokens: { secret: SERVICE_SECRET },
    // The composition needs a handle; nothing in this suite reaches a query,
    // because every assertion is answered before a route touches the database.
    database: unusedDatabase(),
    templateRegistry,
  });
}

/**
 * A database handle that would throw if anything used it.
 *
 * `composeApp` binds the audit sink to whatever it is given, and this suite is
 * about wiring rather than about writing rows: a real pool would make a test of
 * "the route is registered and closed" need PostgreSQL.
 */
function unusedDatabase(): Database {
  return new Proxy({} as Database, {
    get() {
      throw new Error('the compose suite must not reach the database');
    },
  });
}

describe('the deployed composition', () => {
  it('serves /healthz without a credential', async () => {
    const { app } = deployed();
    try {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('serves the git surface, and closes it to an unauthenticated caller', async () => {
    const { app } = deployed();
    const project = newProject();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/git/repositories',
        payload: { organizationId: project.organizationId, projectId: project.projectId },
      });

      // 401, not 404: the route is registered (so the deployment serves it) and
      // it requires a service token (so the deployment is not open).
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'service_unauthenticated' } });

      const templateSeed = await app.inject({
        method: 'POST',
        url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/template-seed`,
        headers: { 'idempotency-key': 'compose-seed-001' },
        payload: { templateSlug: 'saas-starter' },
      });
      expect(templateSeed.statusCode).toBe(401);
      expect(templateSeed.json()).toMatchObject({
        error: { code: 'service_unauthenticated' },
      });
    } finally {
      await app.close();
    }
  });

  it('has no user-facing surface at all', async () => {
    const { app } = deployed();
    try {
      for (const url of ['/v1/projects', '/internal/git', '/api/v1/repos']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(404);
        expect(response.json(), url).toMatchObject({ error: { code: 'route_not_found' } });
      }
    } finally {
      await app.close();
    }
  });

  it('verifies tokens against the configured secret and no other', async () => {
    const { app } = deployed();
    const project = newProject();
    try {
      // A well-formed token signed with a different secret: the shape is right
      // and the signature is not, which is the only interesting negative.
      const forged = await serviceToken();
      const { app: wrongSecretApp } = composeApp({
        logger: false,
        forgejo: { baseUrl: 'http://127.0.0.1:1', adminToken: 'x', timeoutMs: 100 },
        serviceTokens: { secret: `${SERVICE_SECRET}-different` },
        database: unusedDatabase(),
        templateRegistry,
      });
      try {
        const response = await wrongSecretApp.inject({
          method: 'POST',
          url: '/internal/git/repositories',
          headers: serviceHeaders(forged),
          payload: { organizationId: project.organizationId, projectId: project.projectId },
        });
        expect(response.statusCode).toBe(401);
      } finally {
        await wrongSecretApp.close();
      }

      // And the same token against the matching secret gets *past* the gate —
      // it fails later, at the unreachable Forgejo, which is what proves the
      // refusal above was the signature and not the wiring.
      const accepted = await app.inject({
        method: 'POST',
        url: '/internal/git/repositories',
        headers: { [SERVICE_TOKEN_HEADER]: forged },
        payload: { organizationId: project.organizationId, projectId: project.projectId },
      });
      expect(accepted.statusCode).toBe(502);
      expect(accepted.json()).toMatchObject({ error: { code: 'git_provider_failed' } });
    } finally {
      await app.close();
    }
  });
});
