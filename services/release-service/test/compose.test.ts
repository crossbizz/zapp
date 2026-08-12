import { createServiceTokenSigner } from '@zapp/config';
import type { Database } from '@zapp/db';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { composeApp, type ProductionReleaseServiceRuntime } from '../src/compose.js';
import type { Release } from '../src/release/create.js';
import { startReleaseServer } from '../src/server.js';

const ULID = '01J00000000000000000000000';
const ORGANIZATION_ID = `org_${ULID}`;
const PROJECT_ID = `proj_${ULID}`;
const ENVIRONMENT_ID = `env_${ULID}`;
const SPECIFICATION_ID = `spec_${ULID}`;
const USER_ID = `user_${ULID}`;
const RELEASE_ID = `rel_${ULID}`;
const COMMIT_SHA = 'a'.repeat(40);
const SERVICE_TOKENS = { secret: 'release-compose-test-secret-that-is-long-enough' };

const release: Release = {
  id: RELEASE_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  commitSha: COMMIT_SHA,
  specificationId: SPECIFICATION_ID,
  status: 'ready',
  evidenceManifestArtifactId: null,
  createdBy: USER_ID,
  createdAt: new Date('2026-08-12T18:00:00.000Z'),
};

function releaseReadDatabase(): Database {
  const query = {
    from: () => query,
    where: () => query,
    limit: () => Promise.resolve([release]),
  };
  return { select: () => query } as unknown as Database;
}

describe('release-service production composition', () => {
  it('makes the listening entrypoint require raw production bindings', () => {
    expectTypeOf<
      Parameters<typeof startReleaseServer>[0]
    >().toEqualTypeOf<ProductionReleaseServiceRuntime>();
  });

  it('binds the postgres record store and lifecycle coordinator into the listening app', async () => {
    const app = composeApp({
      logger: false,
      database: releaseReadDatabase(),
      serviceTokens: SERVICE_TOKENS,
      git: {
        getCommit: () => Promise.resolve(true),
        createTag: () => Promise.resolve(),
      },
      lifecycle: {
        readiness: {
          evaluate: (row) =>
            Promise.resolve({
              releaseId: row.id,
              commitSha: row.commitSha,
              state: 'ready',
              findings: [],
              blockers: [],
              primaryAction: null,
            }),
        },
        deployments: {
          deploy: () => Promise.reject(new Error('not used')),
          rollback: () => Promise.reject(new Error('not used')),
        },
        evidence: { get: () => Promise.reject(new Error('not used')) },
        repair: { fork: () => Promise.reject(new Error('not used')) },
      },
    });
    const token = await createServiceTokenSigner(SERVICE_TOKENS).signServiceToken({
      service: 'control-api',
      aud: 'release-service',
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/internal/releases/${RELEASE_ID}/readiness?organizationId=${ORGANIZATION_ID}`,
        headers: { 'x-zapp-service-token': token.token },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ readiness: { releaseId: RELEASE_ID } });
    } finally {
      await app.close();
    }
  });
});
