import Fastify from 'fastify';
import { newId } from '@zapp/contracts';
import {
  GATE_IDS,
  assembleEvidenceManifest,
  buildCriteriaCompletionReport,
  type GateResult,
} from '@zapp/verification-engine';
import { describe, expect, it } from 'vitest';

import type { Release, ReleaseRecordService } from '../src/release/create.js';
import { createReleaseLifecycleService } from '../src/lifecycle.js';
import { registerReleaseRoutes } from '../src/routes.js';

const ULID = '01J00000000000000000000000';
const ORGANIZATION_ID = `org_${ULID}`;
const PROJECT_ID = `proj_${ULID}`;
const ENVIRONMENT_ID = `env_${ULID}`;
const SPECIFICATION_ID = `spec_${ULID}`;
const USER_ID = `user_${ULID}`;
const RELEASE_ID = `rel_${ULID}`;
const DEPLOYMENT_ID = `dep_${ULID}`;
const ROLLBACK_DEPLOYMENT_ID = 'dep_01J00000000000000000000001';
const BRANCH_ID = `br_${ULID}`;
const FIX_RUN_ID = `run_${ULID}`;
const COMMIT_SHA = 'a'.repeat(40);
const OPERATION_KEY = `op_${'b'.repeat(64)}`;

const passedGate = (gateId: (typeof GATE_IDS)[number]): GateResult => ({
  status: 'passed',
  evidenceArtifactIds: [`evidence-${gateId}`],
  details: { report: `${gateId} passed` },
});

const EVIDENCE = assembleEvidenceManifest(
  {
    releaseId: RELEASE_ID,
    commitSha: COMMIT_SHA,
    specificationVersion: 1,
    supportLevel: 'managed',
    projectPolicy: { waivers: [] },
    gateResults: GATE_IDS.map((gateId) => ({ gateId, result: passedGate(gateId) })),
    accessibilityResult: passedGate('browser_acceptance'),
    criteriaCompletion: buildCriteriaCompletionReport({
      specificationVersion: 1,
      criteria: [{ criterionId: 'AC-1' }],
      tasks: [{ taskId: 'TASK-1', acceptanceCriteriaIds: ['AC-1'] }],
      testCases: [
        {
          testCaseId: 'case-1',
          name: '[AC-1] serves the healthy release',
          status: 'passed',
          evidenceArtifactIds: ['evidence-browser-acceptance'],
        },
      ],
    }),
    criticalCriterionIds: ['AC-1'],
    policySignals: [],
    knownRisks: [],
  },
  { redact: (text) => text },
);

function release(status: Release['status'] = 'candidate'): Release {
  return {
    id: RELEASE_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    commitSha: COMMIT_SHA,
    specificationId: SPECIFICATION_ID,
    status,
    evidenceManifestArtifactId: newId('art'),
    createdBy: USER_ID,
    createdAt: new Date('2026-08-12T16:00:00.000Z'),
  };
}

describe('DEP-12 internal release lifecycle', () => {
  it('refuses deployment until persisted approval and readiness are revalidated', async () => {
    const row = release('candidate');
    let deploymentCalls = 0;
    const records: ReleaseRecordService = {
      createReleaseCandidate: () => Promise.resolve(row),
      getRelease: () => Promise.resolve(row),
      transitionStatus: () => Promise.resolve(row),
      approve: () => Promise.resolve(row),
      beginDeployment: () => Promise.resolve({ ...row, status: 'deploying' }),
    };
    const lifecycle = createReleaseLifecycleService({
      records,
      readiness: {
        evaluate: () =>
          Promise.resolve({
            releaseId: RELEASE_ID,
            commitSha: COMMIT_SHA,
            state: 'ready',
            findings: [],
            blockers: [],
            primaryAction: null,
          }),
      },
      deployments: {
        deploy: () => {
          deploymentCalls += 1;
          return Promise.resolve({ deploymentId: DEPLOYMENT_ID });
        },
        rollback: () => Promise.resolve({ deploymentId: ROLLBACK_DEPLOYMENT_ID }),
      },
      evidence: { get: () => Promise.resolve(EVIDENCE) },
      repair: {
        fork: () =>
          Promise.resolve({
            releaseId: RELEASE_ID,
            branchId: BRANCH_ID,
            branchName: `fix/rel-${RELEASE_ID}`,
            fixRunId: null,
          }),
      },
    });

    await expect(
      lifecycle.deploy({
        organizationId: ORGANIZATION_ID,
        releaseId: RELEASE_ID,
        actorId: USER_ID,
        operationKey: OPERATION_KEY,
        deploymentType: 'first_deploy',
        confirmation: { dataDisposition: null },
      }),
    ).rejects.toMatchObject({ code: 'invalid_release_transition', statusCode: 409 });
    expect(deploymentCalls).toBe(0);
  });

  it('binds every projection and mutation to the tenant release identity', async () => {
    const row = release('approved');
    const calls: string[] = [];
    const records: ReleaseRecordService = {
      createReleaseCandidate: () => Promise.resolve(row),
      getRelease: (organizationId, releaseId) =>
        Promise.resolve(
          organizationId === ORGANIZATION_ID && releaseId === RELEASE_ID ? row : undefined,
        ),
      transitionStatus: () => Promise.resolve(row),
      approve: () => Promise.resolve(row),
      beginDeployment: () => Promise.resolve({ ...row, status: 'deploying' }),
    };
    const lifecycle = createReleaseLifecycleService({
      records,
      readiness: {
        evaluate(releaseValue) {
          calls.push(`readiness:${releaseValue.id}`);
          return Promise.resolve({
            releaseId: releaseValue.id,
            commitSha: releaseValue.commitSha,
            state: 'ready',
            findings: [],
            blockers: [],
            primaryAction: null,
          });
        },
      },
      deployments: {
        deploy(releaseValue) {
          calls.push(`deploy:${releaseValue.id}`);
          return Promise.resolve({ deploymentId: DEPLOYMENT_ID });
        },
        rollback(releaseValue) {
          calls.push(`rollback:${releaseValue.id}`);
          return Promise.resolve({ deploymentId: ROLLBACK_DEPLOYMENT_ID });
        },
      },
      evidence: {
        get(releaseValue) {
          calls.push(`evidence:${releaseValue.id}`);
          return Promise.resolve(EVIDENCE);
        },
      },
      repair: {
        fork(releaseValue) {
          calls.push(`fork:${releaseValue.id}`);
          return Promise.resolve({
            releaseId: releaseValue.id,
            branchId: BRANCH_ID,
            branchName: `fix/rel-${releaseValue.id}`,
            fixRunId: FIX_RUN_ID,
          });
        },
      },
    });

    await lifecycle.getReadiness({ organizationId: ORGANIZATION_ID, releaseId: RELEASE_ID });
    await lifecycle.deploy({
      organizationId: ORGANIZATION_ID,
      releaseId: RELEASE_ID,
      actorId: USER_ID,
      operationKey: OPERATION_KEY,
      deploymentType: 'first_deploy',
      confirmation: { dataDisposition: null },
    });
    await lifecycle.getEvidence({ organizationId: ORGANIZATION_ID, releaseId: RELEASE_ID });
    await lifecycle.rollback({
      organizationId: ORGANIZATION_ID,
      releaseId: RELEASE_ID,
      actorId: USER_ID,
      operationKey: OPERATION_KEY,
      toDeploymentId: DEPLOYMENT_ID,
      reason: 'Restore prior content.',
    });
    await lifecycle.forkRelease({
      organizationId: ORGANIZATION_ID,
      releaseId: RELEASE_ID,
      actorId: USER_ID,
      operationKey: OPERATION_KEY,
      startFixRun: true,
    });
    expect(calls).toEqual([
      `readiness:${RELEASE_ID}`,
      `readiness:${RELEASE_ID}`,
      `deploy:${RELEASE_ID}`,
      `evidence:${RELEASE_ID}`,
      `rollback:${RELEASE_ID}`,
      `fork:${RELEASE_ID}`,
    ]);
    await expect(
      lifecycle.getReadiness({ organizationId: newId('org'), releaseId: RELEASE_ID }),
    ).rejects.toMatchObject({ code: 'release_not_found', statusCode: 404 });
  });

  it('serves every lifecycle operation and the separately keyed repair fork', async () => {
    let row = release();
    const records: ReleaseRecordService = {
      createReleaseCandidate() {
        return Promise.resolve(row);
      },
      getRelease(organizationId, releaseId) {
        return Promise.resolve(
          organizationId === ORGANIZATION_ID && releaseId === RELEASE_ID ? row : undefined,
        );
      },
      transitionStatus(input) {
        row = { ...row, status: input.to };
        return Promise.resolve(row);
      },
      approve() {
        row = { ...row, status: 'approved' };
        return Promise.resolve(row);
      },
      beginDeployment() {
        row = { ...row, status: 'deploying' };
        return Promise.resolve(row);
      },
    };
    let productionContent = 'previous healthy release';
    const lifecycle = {
      getReadiness() {
        return Promise.resolve({
          releaseId: RELEASE_ID,
          commitSha: COMMIT_SHA,
          state: 'ready' as const,
          findings: [],
          blockers: [],
          primaryAction: null,
        });
      },
      deploy() {
        productionContent = 'candidate release';
        return Promise.resolve({ deploymentId: DEPLOYMENT_ID });
      },
      getEvidence() {
        return Promise.resolve(EVIDENCE);
      },
      rollback() {
        productionContent = 'previous healthy release';
        return Promise.resolve({ deploymentId: ROLLBACK_DEPLOYMENT_ID });
      },
      forkRelease() {
        return Promise.resolve({
          releaseId: RELEASE_ID,
          branchId: BRANCH_ID,
          branchName: `fix/rel-${RELEASE_ID}`,
          fixRunId: FIX_RUN_ID,
        });
      },
    };
    let authorizationChecks = 0;
    const app = Fastify();
    registerReleaseRoutes(
      app,
      {
        records,
        lifecycle,
        requireService: () => {
          authorizationChecks += 1;
          return Promise.resolve();
        },
      },
    );

    const mutationHeaders = { 'idempotency-key': OPERATION_KEY };
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/internal/releases',
        headers: mutationHeaders,
        payload: {
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          commitSha: COMMIT_SHA,
          specificationId: SPECIFICATION_ID,
          actorId: USER_ID,
          operationKey: OPERATION_KEY,
        },
      });
      expect(created.statusCode, created.body).toBe(201);

      const readiness = await app.inject({
        method: 'GET',
        url: `/internal/releases/${RELEASE_ID}/readiness?organizationId=${ORGANIZATION_ID}`,
      });
      expect(readiness.statusCode, readiness.body).toBe(200);
      expect(readiness.json()).toMatchObject({ readiness: { state: 'ready', blockers: [] } });

      const approved = await app.inject({
        method: 'POST',
        url: `/internal/releases/${RELEASE_ID}/approve`,
        headers: mutationHeaders,
        payload: {
          actor: { id: USER_ID, organizationId: ORGANIZATION_ID },
          operationKey: OPERATION_KEY,
        },
      });
      expect(approved.statusCode, approved.body).toBe(200);

      const deployed = await app.inject({
        method: 'POST',
        url: `/internal/releases/${RELEASE_ID}/deploy`,
        headers: mutationHeaders,
        payload: {
          organizationId: ORGANIZATION_ID,
          actorId: USER_ID,
          operationKey: OPERATION_KEY,
          deploymentType: 'first_deploy',
          confirmation: { dataDisposition: null },
        },
      });
      expect(deployed.statusCode, deployed.body).toBe(200);
      expect(deployed.json()).toEqual({ deploymentId: DEPLOYMENT_ID });
      expect(productionContent).toBe('candidate release');

      const evidence = await app.inject({
        method: 'GET',
        url: `/internal/releases/${RELEASE_ID}/evidence?organizationId=${ORGANIZATION_ID}`,
      });
      expect(evidence.statusCode, evidence.body).toBe(200);
      expect(evidence.json()).toMatchObject({
        evidence: { release_id: RELEASE_ID, commit_sha: COMMIT_SHA },
      });

      const rolledBack = await app.inject({
        method: 'POST',
        url: `/internal/releases/${RELEASE_ID}/rollback`,
        headers: mutationHeaders,
        payload: {
          organizationId: ORGANIZATION_ID,
          actorId: USER_ID,
          operationKey: OPERATION_KEY,
          toDeploymentId: DEPLOYMENT_ID,
          reason: 'Restore the prior healthy release.',
        },
      });
      expect(rolledBack.statusCode, rolledBack.body).toBe(200);
      expect(rolledBack.json()).toEqual({ deploymentId: ROLLBACK_DEPLOYMENT_ID });
      expect(productionContent).toBe('previous healthy release');

      const forked = await app.inject({
        method: 'POST',
        url: `/internal/releases/${RELEASE_ID}/fork`,
        headers: mutationHeaders,
        payload: {
          organizationId: ORGANIZATION_ID,
          actorId: USER_ID,
          operationKey: OPERATION_KEY,
          startFixRun: true,
        },
      });
      expect(forked.statusCode, forked.body).toBe(201);
      expect(forked.json()).toEqual({
        fork: {
          releaseId: RELEASE_ID,
          branchId: BRANCH_ID,
          branchName: `fix/rel-${RELEASE_ID}`,
          fixRunId: FIX_RUN_ID,
        },
      });
      expect(authorizationChecks).toBe(7);
    } finally {
      await app.close();
    }
  });
});
