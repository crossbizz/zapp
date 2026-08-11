import { describe, expect, it } from 'vitest';

import {
  createRollbackService,
  type RollbackDependencies,
  type RollbackRequest,
} from '../../src/rollback/service.js';

const ORGANIZATION_ID = 'org_01J00000000000000000000000';
const PROJECT_ID = 'proj_01J00000000000000000000000';
const ENVIRONMENT_ID = 'env_01J00000000000000000000000';
const CURRENT_RELEASE_ID = 'rel_01J00000000000000000000002';
const TARGET_RELEASE_ID = 'rel_01J00000000000000000000001';
const CURRENT_DEPLOYMENT_ID = 'dep_01J00000000000000000000002';
const TARGET_DEPLOYMENT_ID = 'dep_01J00000000000000000000001';
const ROLLBACK_DEPLOYMENT_ID = 'dep_01J00000000000000000000003';
const CURRENT_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const TARGET_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HEALTH_ARTIFACT_ID = 'art_01J00000000000000000000009';
const COMPENSATION_ARTIFACT_ID = 'art_01J00000000000000000000008';
const OPERATION_KEY = `op_${'9'.repeat(64)}`;

function request(overrides: Partial<RollbackRequest> = {}): RollbackRequest {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    toDeploymentId: TARGET_DEPLOYMENT_ID,
    reason: 'Production regression after release.',
    operationKey: OPERATION_KEY,
    ...overrides,
  };
}

function harness(
  input: {
    readonly reversibility?: 'reversible' | 'compensating' | 'unavailable';
    readonly compensationApproved?: boolean;
    readonly healthStatus?: 'healthy' | 'failed';
    readonly replay?: unknown;
    readonly resolvedTargetDeploymentId?: string;
    readonly generatedDeploymentId?: string;
    readonly createdDeploymentId?: string;
  } = {},
) {
  const operations: string[] = [];
  const providerTargets: string[] = [];
  const persisted: unknown[] = [];
  const environment = {
    activeVersion: 'envcfg-v2',
    names: ['CURRENT_ONLY', 'SHARED'],
  };
  const reversibility = input.reversibility ?? 'reversible';

  const dependencies: RollbackDependencies = {
    context: {
      resolve() {
        return Promise.resolve({
          current: {
            deploymentId: CURRENT_DEPLOYMENT_ID,
            releaseId: CURRENT_RELEASE_ID,
            commitSha: CURRENT_COMMIT,
            providerId: 'fake-provider',
            providerDeploymentId: 'provider-current',
            environmentConfigVersion: 'envcfg-v2',
            permanentUrl: 'https://app.example.test',
          },
          target: {
            deploymentId: input.resolvedTargetDeploymentId ?? TARGET_DEPLOYMENT_ID,
            releaseId: TARGET_RELEASE_ID,
            commitSha: TARGET_COMMIT,
            providerId: 'fake-provider',
            providerDeploymentId: 'provider-target',
            environmentConfigVersion: 'envcfg-v1',
            permanentUrl: 'https://app.example.test',
          },
          migration: {
            reversibility,
            compensatingPlan:
              reversibility === 'compensating'
                ? {
                    planId: 'compensate-orders-v1',
                    approvalRecordId: 'approval-record-1',
                    approved: input.compensationApproved ?? false,
                    evidenceArtifactId: COMPENSATION_ARTIFACT_ID,
                  }
                : null,
          },
        });
      },
    },
    store: {
      getReplay() {
        return Promise.resolve(input.replay);
      },
      createRollback(requestValue) {
        operations.push('create');
        persisted.push(requestValue);
        return Promise.resolve({
          deploymentId: input.createdDeploymentId ?? ROLLBACK_DEPLOYMENT_ID,
        });
      },
      markHealthy(requestValue) {
        operations.push('healthy');
        persisted.push(requestValue);
        return Promise.resolve();
      },
      markFailed(requestValue) {
        operations.push('failed');
        persisted.push(requestValue);
        return Promise.resolve();
      },
      completeReplay(requestValue) {
        operations.push('complete');
        persisted.push(requestValue);
        return Promise.resolve();
      },
    },
    environmentConfig: {
      restore(requestValue) {
        operations.push(`config:${requestValue.version}`);
        environment.activeVersion = requestValue.version;
        environment.names =
          requestValue.version === 'envcfg-v1'
            ? ['LEGACY_NAME', 'SHARED']
            : ['CURRENT_ONLY', 'SHARED'];
        return Promise.resolve({ version: requestValue.version });
      },
    },
    compensation: {
      apply(requestValue) {
        operations.push(`compensate:${requestValue.planId}`);
        return Promise.resolve({
          planId: requestValue.planId,
          approvalRecordId: requestValue.approvalRecordId,
          evidenceArtifactId: requestValue.evidenceArtifactId,
          applied: true,
        });
      },
    },
    provider: {
      rollback(requestValue) {
        operations.push(`provider:${requestValue.toProviderDeploymentId}`);
        providerTargets.push(requestValue.toProviderDeploymentId);
        return Promise.resolve({
          providerId: requestValue.providerId,
          providerDeploymentId:
            requestValue.toProviderDeploymentId === 'provider-current'
              ? 'provider-current-restored'
              : 'provider-target-restored',
          url: 'https://app.example.test',
          state: 'ready',
          createdAt: '2026-08-11T19:30:00.000Z',
        });
      },
    },
    health: {
      verify() {
        operations.push('health');
        const healthStatus = input.healthStatus ?? 'healthy';
        return Promise.resolve({
          status: healthStatus,
          evidenceArtifactId: HEALTH_ARTIFACT_ID,
          automaticRollbackAttempted: false,
          production: {
            status: healthStatus === 'healthy' ? 'passed' : 'failed',
            healthEndpoint: {
              status: healthStatus === 'healthy' ? 'passed' : 'failed',
              path: '/health',
              intervalMs: 10_000,
              attempts: [
                { statusCode: healthStatus === 'healthy' ? 200 : 503 },
                { statusCode: 200 },
                { statusCode: 200 },
              ],
            },
            errorRate: {
              status: healthStatus === 'healthy' ? 'passed' : 'not_run',
              windowMs: 120_000,
              burstDetected: healthStatus === 'healthy' ? false : null,
              evidenceArtifactIds: [],
            },
            smoke: {
              status: healthStatus === 'healthy' ? 'not_applicable' : 'not_run',
              flows: [],
              evidenceArtifactIds: [],
            },
          },
        });
      },
    },
    newDeploymentId: () => input.generatedDeploymentId ?? ROLLBACK_DEPLOYMENT_ID,
  };

  return { dependencies, environment, operations, persisted, providerTargets };
}

describe('DEP-9 rollback service', () => {
  it('restores the exact prior deployment, commit, static artifact, and environment config', async () => {
    const fixture = harness();
    const service = createRollbackService(fixture.dependencies);

    await expect(service.rollback(request())).resolves.toEqual({
      deploymentId: ROLLBACK_DEPLOYMENT_ID,
      rollbackOfDeploymentId: CURRENT_DEPLOYMENT_ID,
      releaseId: TARGET_RELEASE_ID,
      commitSha: TARGET_COMMIT,
      environmentConfigVersion: 'envcfg-v1',
      databaseState: 'compatible',
      compensatingPlanApplied: false,
      status: 'healthy',
      healthEvidenceArtifactId: HEALTH_ARTIFACT_ID,
    });

    expect(fixture.operations).toEqual([
      'create',
      'config:envcfg-v1',
      'provider:provider-target',
      'health',
      'healthy',
      'complete',
    ]);
    expect(fixture.environment).toEqual({
      activeVersion: 'envcfg-v1',
      names: ['LEGACY_NAME', 'SHARED'],
    });
    expect(fixture.providerTargets).toEqual(['provider-target']);
    expect(fixture.persisted[0]).toMatchObject({
      deploymentId: ROLLBACK_DEPLOYMENT_ID,
      releaseId: TARGET_RELEASE_ID,
      commitSha: TARGET_COMMIT,
      environmentConfigVersion: 'envcfg-v1',
      rollbackOfDeploymentId: CURRENT_DEPLOYMENT_ID,
      targetProviderDeploymentId: 'provider-target',
    });
  });

  it('blocks unavailable migration rollback as database-incompatible before mutation', async () => {
    const fixture = harness({ reversibility: 'unavailable' });
    const service = createRollbackService(fixture.dependencies);

    await expect(service.rollback(request())).rejects.toMatchObject({
      code: 'database_incompatible',
      statusCode: 422,
      databaseState: 'incompatible',
    });
    expect(fixture.operations).toEqual([]);
  });

  it('requires an approved attached compensating plan before rollback', async () => {
    const fixture = harness({ reversibility: 'compensating', compensationApproved: false });
    const service = createRollbackService(fixture.dependencies);

    await expect(service.rollback(request())).rejects.toMatchObject({
      code: 'compensating_plan_required',
      statusCode: 422,
      databaseState: 'requires_compensation',
    });
    expect(fixture.operations).toEqual([]);
  });

  it('applies the approved attached compensating plan and reports the UI state', async () => {
    const fixture = harness({ reversibility: 'compensating', compensationApproved: true });
    const service = createRollbackService(fixture.dependencies);

    await expect(service.rollback(request())).resolves.toMatchObject({
      databaseState: 'requires_compensation',
      compensatingPlanApplied: true,
      status: 'healthy',
    });
    expect(fixture.operations).toEqual([
      'create',
      'config:envcfg-v1',
      'compensate:compensate-orders-v1',
      'provider:provider-target',
      'health',
      'healthy',
      'complete',
    ]);
  });

  it('rejects a context resolver that substitutes a different explicit target', async () => {
    const fixture = harness({
      resolvedTargetDeploymentId: 'dep_01J00000000000000000000004',
    });
    const service = createRollbackService(fixture.dependencies);

    await expect(service.rollback(request())).rejects.toMatchObject({
      code: 'rollback_context_invalid',
      statusCode: 500,
    });
    expect(fixture.operations).toEqual([]);
  });

  it('fails closed on post-rollback health and restores the formerly healthy deployment', async () => {
    const fixture = harness({ healthStatus: 'failed' });
    const service = createRollbackService(fixture.dependencies);

    await expect(service.rollback(request())).rejects.toMatchObject({
      code: 'rollback_health_failed',
      statusCode: 502,
      databaseState: 'compatible',
    });
    expect(fixture.operations).toEqual([
      'create',
      'config:envcfg-v1',
      'provider:provider-target',
      'health',
      'provider:provider-current',
      'config:envcfg-v2',
      'failed',
    ]);
    expect(fixture.environment.activeVersion).toBe('envcfg-v2');
    expect(fixture.providerTargets).toEqual(['provider-target', 'provider-current']);
  });

  it('returns an authoritative completed replay without repeating mutations', async () => {
    const replay = {
      deploymentId: ROLLBACK_DEPLOYMENT_ID,
      rollbackOfDeploymentId: CURRENT_DEPLOYMENT_ID,
      releaseId: TARGET_RELEASE_ID,
      commitSha: TARGET_COMMIT,
      environmentConfigVersion: 'envcfg-v1',
      databaseState: 'compatible',
      compensatingPlanApplied: false,
      status: 'healthy',
      healthEvidenceArtifactId: HEALTH_ARTIFACT_ID,
    };
    const fixture = harness({ replay });
    const service = createRollbackService(fixture.dependencies);

    await expect(service.rollback(request())).resolves.toEqual(replay);
    expect(fixture.operations).toEqual([]);
  });

  it('continues a keyed in-progress rollback with the store-owned deployment identity', async () => {
    const fixture = harness({
      generatedDeploymentId: 'dep_01J00000000000000000000004',
      createdDeploymentId: ROLLBACK_DEPLOYMENT_ID,
    });
    const service = createRollbackService(fixture.dependencies);

    await expect(service.rollback(request())).resolves.toMatchObject({
      deploymentId: ROLLBACK_DEPLOYMENT_ID,
    });
    expect(fixture.persisted.slice(1)).toEqual(
      expect.arrayContaining([expect.objectContaining({ deploymentId: ROLLBACK_DEPLOYMENT_ID })]),
    );
  });
});
