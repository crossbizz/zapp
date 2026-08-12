import { createServiceTokenSigner } from '@zapp/config';
import { newId } from '@zapp/contracts';
import {
  assembleEvidenceManifest,
  buildCriteriaCompletionReport,
  GATE_IDS,
} from '@zapp/verification-engine';
import { describe, expect, it } from 'vitest';

import { createReleaseServiceClient } from '../../services/control-api/src/release/client.js';
import { ORGANIZATION_HEADER } from '../../services/control-api/src/plugins/tenant.js';
import {
  buildHarness,
  signIn,
} from '../../services/control-api/test/support/harness.js';
import { InMemoryTenantData } from '../../services/control-api/test/support/tenant-db.js';
import { buildApp as buildReleaseApp } from '../../services/release-service/src/app.js';
import { createReleaseLifecycleService } from '../../services/release-service/src/lifecycle.js';
import type {
  Release,
  ReleaseRecordService,
} from '../../services/release-service/src/release/create.js';

const SERVICE_TOKENS = { secret: 'release-e2e-service-secret-that-is-long-enough' };
const COMMIT_SHA = 'a'.repeat(40);

describe('DEP-12 two-service release transport fixture', () => {
  it('serves candidate content, returns VF-15 evidence, and restores prior content on rollback', async () => {
    const data = new InMemoryTenantData();
    let release: Release | undefined;
    let productionContent = 'previous healthy release';
    let priorContent = productionContent;
    const providerCalls: string[] = [];
    const records: ReleaseRecordService = {
      createReleaseCandidate(input) {
        release ??= {
          id: newId('rel'),
          organizationId: input.organizationId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          commitSha: input.commitSha,
          specificationId: input.specificationId,
          status: 'ready',
          evidenceManifestArtifactId: newId('art'),
          createdBy: input.actorId,
          createdAt: new Date('2026-08-12T19:00:00.000Z'),
        };
        return Promise.resolve(release);
      },
      getRelease(organizationId, releaseId) {
        return Promise.resolve(
          release?.organizationId === organizationId && release.id === releaseId
            ? release
            : undefined,
        );
      },
      transitionStatus(input) {
        if (release === undefined) return Promise.reject(new Error('release missing'));
        release = { ...release, status: input.to };
        return Promise.resolve(release);
      },
      approve() {
        if (release === undefined) return Promise.reject(new Error('release missing'));
        release = { ...release, status: 'approved' };
        return Promise.resolve(release);
      },
      beginDeployment() {
        if (release === undefined) return Promise.reject(new Error('release missing'));
        release = { ...release, status: 'deploying' };
        return Promise.resolve(release);
      },
    };
    const lifecycle = createReleaseLifecycleService({
      records,
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
        deploy(row) {
          providerCalls.push(`deploy:${row.commitSha}`);
          priorContent = productionContent;
          productionContent = 'candidate release';
          return Promise.resolve({ deploymentId: newId('dep') });
        },
        rollback(row) {
          providerCalls.push(`rollback:${row.commitSha}`);
          productionContent = priorContent;
          return Promise.resolve({ deploymentId: newId('dep') });
        },
      },
      evidence: {
        get(row) {
          return Promise.resolve(
            assembleEvidenceManifest(
              {
                releaseId: row.id,
                commitSha: row.commitSha,
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
              { redact: (value) => value },
            ),
          );
        },
      },
      repair: {
        fork(row, input) {
          return Promise.resolve({
            releaseId: row.id,
            branchId: newId('br'),
            branchName: `fix/rel-${row.id}`,
            fixRunId: input.startFixRun ? newId('run') : null,
          });
        },
      },
    });
    const releaseApp = buildReleaseApp({
      logger: false,
      records,
      lifecycle,
      signer: createServiceTokenSigner(SERVICE_TOKENS),
    });
    const clients = createReleaseServiceClient({
      baseUrl: 'http://release-service:4300',
      serviceTokens: SERVICE_TOKENS,
      fetch: async (input, init) => {
        const url = new URL(input);
        const response = await releaseApp.inject({
          method: (init.method ?? 'GET') as 'GET' | 'POST',
          url: `${url.pathname}${url.search}`,
          headers: init.headers as Record<string, string>,
          ...(typeof init.body === 'string' ? { payload: init.body } : {}),
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const control = buildHarness({
      tenantDb: data.factory,
      releasePort: clients.release,
      releaseFork: clients.fork,
    });

    try {
      const owner = await signIn(control, {
        externalId: 'release-e2e-owner',
        email: 'owner@release-e2e.test',
        displayName: 'Release Owner',
      });
      const organizationResponse = await control.app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: owner.headers,
        payload: { name: 'Release E2E' },
      });
      const organizationId = organizationResponse.json<{ organization: { id: string } }>()
        .organization.id;
      const headers = { ...owner.headers, [ORGANIZATION_HEADER]: organizationId };
      const projectResponse = await control.app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers,
        payload: { name: 'Release Target' },
      });
      const project = projectResponse.json<{
        project: { id: string };
        environments: Array<{ id: string; type: string }>;
      }>();
      const environmentId = project.environments.find(({ type }) => type === 'production')?.id;
      expect(environmentId).toBeDefined();
      const specificationId = newId('spec');
      data.specifications.push({
        id: specificationId,
        organizationId,
        projectId: project.project.id,
        version: 1,
        status: 'approved',
        contentJson: {},
        createdBy: owner.userId,
        approvedBy: owner.userId,
        approvedAt: new Date('2026-08-12T18:30:00.000Z'),
      });
      const mutate = (key: string) => ({ ...headers, 'idempotency-key': key });
      const created = await control.app.inject({
        method: 'POST',
        url: `/v1/projects/${project.project.id}/releases`,
        headers: mutate('release-e2e-create'),
        payload: { environmentId, commitSha: COMMIT_SHA, specificationId },
      });
      expect(created.statusCode, created.body).toBe(201);
      const releaseId = created.json<{ release: { id: string } }>().release.id;

      const readiness = await control.app.inject({
        method: 'GET',
        url: `/v1/releases/${releaseId}`,
        headers,
      });
      expect(readiness.statusCode, readiness.body).toBe(200);
      expect(readiness.json()).toMatchObject({ readiness: { state: 'ready' } });
      expect(
        (
          await control.app.inject({
            method: 'POST',
            url: `/v1/releases/${releaseId}/approve`,
            headers: mutate('release-e2e-approve'),
          })
        ).statusCode,
      ).toBe(200);
      const deployed = await control.app.inject({
        method: 'POST',
        url: `/v1/releases/${releaseId}/deploy`,
        headers: mutate('release-e2e-deploy'),
        payload: { deploymentType: 'first_deploy' },
      });
      expect(deployed.statusCode, deployed.body).toBe(200);
      expect(productionContent).toBe('candidate release');
      const evidence = await control.app.inject({
        method: 'GET',
        url: `/v1/releases/${releaseId}/evidence`,
        headers,
      });
      expect(evidence.statusCode, evidence.body).toBe(200);
      expect(evidence.json()).toMatchObject({
        evidence: { release_id: releaseId, commit_sha: COMMIT_SHA },
      });
      const forked = await control.app.inject({
        method: 'POST',
        url: `/v1/releases/${releaseId}/fork`,
        headers: mutate('release-e2e-fork'),
        payload: { startFixRun: true },
      });
      expect(forked.statusCode, forked.body).toBe(201);
      expect(forked.json()).toMatchObject({
        fork: { branchName: `fix/rel-${releaseId}` },
      });
      const rolledBack = await control.app.inject({
        method: 'POST',
        url: `/v1/releases/${releaseId}/rollback`,
        headers: mutate('release-e2e-rollback'),
        payload: { reason: 'Restore the previous healthy content.' },
      });
      expect(rolledBack.statusCode, rolledBack.body).toBe(200);
      expect(productionContent).toBe('previous healthy release');
      expect(providerCalls).toEqual([`deploy:${COMMIT_SHA}`, `rollback:${COMMIT_SHA}`]);
    } finally {
      await control.app.close();
      await releaseApp.close();
    }
  });
});
