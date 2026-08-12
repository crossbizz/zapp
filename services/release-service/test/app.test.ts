import { createServiceTokenSigner } from '@zapp/config';
import { assembleEvidenceManifest, buildCriteriaCompletionReport, GATE_IDS } from '@zapp/verification-engine';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { Release, ReleaseRecordService } from '../src/release/create.js';
import type { ReleaseLifecycleService } from '../src/lifecycle.js';
import type { ReleaseHistoryPort } from '../src/history.js';

const ULID = '01J00000000000000000000000';
const ORGANIZATION_ID = `org_${ULID}`;
const PROJECT_ID = `proj_${ULID}`;
const ENVIRONMENT_ID = `env_${ULID}`;
const SPECIFICATION_ID = `spec_${ULID}`;
const USER_ID = `user_${ULID}`;
const RELEASE_ID = `rel_${ULID}`;
const COMMIT_SHA = 'a'.repeat(40);
const SECRET = 'release-service-test-secret-value-0000000000000000';

const RELEASE: Release = {
  id: RELEASE_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  commitSha: COMMIT_SHA,
  specificationId: SPECIFICATION_ID,
  status: 'ready',
  evidenceManifestArtifactId: null,
  createdBy: USER_ID,
  createdAt: new Date('2026-08-12T16:00:00.000Z'),
};

const records: ReleaseRecordService = {
  createReleaseCandidate: () => Promise.resolve(RELEASE),
  getRelease: (organizationId, releaseId) =>
    Promise.resolve(
      organizationId === ORGANIZATION_ID && releaseId === RELEASE_ID ? RELEASE : undefined,
    ),
  transitionStatus: () => Promise.resolve(RELEASE),
  approve: () => Promise.resolve(RELEASE),
  beginDeployment: () => Promise.resolve({ ...RELEASE, status: 'deploying' }),
};

const evidence = assembleEvidenceManifest(
  {
    releaseId: RELEASE_ID,
    commitSha: COMMIT_SHA,
    specificationVersion: 1,
    supportLevel: 'managed',
    projectPolicy: { waivers: [] },
    gateResults: GATE_IDS.map((gateId) => ({
      gateId,
      result: {
        status: 'passed' as const,
        evidenceArtifactIds: [`evidence-${gateId}`],
        details: {},
      },
    })),
    accessibilityResult: {
      status: 'passed',
      evidenceArtifactIds: ['evidence-accessibility'],
      details: {},
    },
    criteriaCompletion: buildCriteriaCompletionReport({
      specificationVersion: 1,
      criteria: [{ criterionId: 'AC-1' }],
      tasks: [],
      testCases: [],
    }),
    criticalCriterionIds: [],
    policySignals: [],
    knownRisks: [],
  },
  { redact: (text) => text },
);

const lifecycle: ReleaseLifecycleService = {
  getReadiness: () =>
    Promise.resolve({
      releaseId: RELEASE_ID,
      commitSha: COMMIT_SHA,
      state: 'ready',
      findings: [],
      blockers: [],
      primaryAction: null,
    }),
  deploy: () => Promise.reject(new Error('not used')),
  rollback: () => Promise.reject(new Error('not used')),
  getEvidence: () => Promise.resolve(evidence),
  forkRelease: () => Promise.reject(new Error('not used')),
};

const history: ReleaseHistoryPort = {
  list(input) {
    return Promise.resolve({
      items: [{
        id: RELEASE_ID, projectId: input.projectId, environmentId: ENVIRONMENT_ID,
        commitSha: COMMIT_SHA, status: 'healthy', supportLevel: 'managed',
        activeProduction: true, createdAt: RELEASE.createdAt.toISOString(), deployments: [],
        evidenceArtifactId: null,
      }], rollbackTargets: [], nextCursor: null,
    });
  },
};

describe('release-service application', () => {
  it('keeps health public and requires a control-api token for lifecycle reads', async () => {
    const signer = createServiceTokenSigner({ secret: SECRET });
    const app = buildApp({ logger: false, records, lifecycle, history, signer });
    const url = `/internal/releases/${RELEASE_ID}/readiness?organizationId=${ORGANIZATION_ID}`;

    try {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);

      const wrongAudience = await signer.signServiceToken({
        service: 'control-api',
        aud: 'git-service',
      });
      expect(
        (
          await app.inject({
            method: 'GET',
            url,
            headers: { 'x-zapp-service-token': wrongAudience.token },
          })
        ).statusCode,
      ).toBe(401);

      const wrongCaller = await signer.signServiceToken({
        service: 'sandbox-service',
        aud: 'release-service',
      });
      expect(
        (
          await app.inject({
            method: 'GET',
            url,
            headers: { 'x-zapp-service-token': wrongCaller.token },
          })
        ).statusCode,
      ).toBe(403);

      const valid = await signer.signServiceToken({
        service: 'control-api',
        aud: 'release-service',
      });
      const accepted = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-zapp-service-token': valid.token },
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json()).toMatchObject({ readiness: { releaseId: RELEASE_ID } });

      const browserShaped = await signer.signServiceToken({
        service: 'control-api',
        aud: 'release-service',
      });
      expect(
        (
          await app.inject({
            method: 'GET',
            url,
            headers: {
              cookie: 'zapp_session=ambient-browser-credential',
              'x-zapp-service-token': browserShaped.token,
            },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns a bounded tenant-scoped project release history to control-api', async () => {
    const signer = createServiceTokenSigner({ secret: SECRET });
    const app = buildApp({ logger: false, records, lifecycle, history, signer });
    try {
      const valid = await signer.signServiceToken({ service: 'control-api', aud: 'release-service' });
      const response = await app.inject({
        method: 'GET',
        url: `/internal/projects/${PROJECT_ID}/releases?organizationId=${ORGANIZATION_ID}&limit=10`,
        headers: { 'x-zapp-service-token': valid.token },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        page: { items: [{ id: RELEASE_ID, activeProduction: true, supportLevel: 'managed' }], nextCursor: null },
      });
    } finally {
      await app.close();
    }
  });
});
