import { describe, expect, it } from 'vitest';

import {
  createProductionHealthService,
  type ProductionFlow,
  type ProductionHealthDependencies,
  type ProductionHealthInput,
} from '../src/release/health.js';

const ORGANIZATION_ID = 'org_01J00000000000000000000000';
const PROJECT_ID = 'proj_01J00000000000000000000000';
const ENVIRONMENT_ID = 'env_01J00000000000000000000000';
const RELEASE_ID = 'rel_01J00000000000000000000000';
const DEPLOYMENT_ID = 'dep_01J00000000000000000000000';
const PREVIOUS_DEPLOYMENT_ID = 'dep_01J00000000000000000000001';
const EVIDENCE_ARTIFACT_ID = 'art_01J00000000000000000000000';
const OPERATION_KEY = `op_${'b'.repeat(64)}`;

function flow(input: {
  readonly id: string;
  readonly tags?: readonly string[];
  readonly steps: ProductionFlow['steps'];
}): ProductionFlow {
  return {
    id: input.id,
    title: input.id,
    critical: true,
    tags: [...(input.tags ?? ['@prod-safe'])],
    steps: [...input.steps],
  };
}

function healthInput(overrides: Partial<ProductionHealthInput> = {}): ProductionHealthInput {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    releaseId: RELEASE_ID,
    deploymentId: DEPLOYMENT_ID,
    providerDeploymentId: 'fly-app::machine-candidate',
    previousHealthyDeploymentId: PREVIOUS_DEPLOYMENT_ID,
    productionUrl: 'https://app.example.com',
    healthPath: '/health',
    operationKey: OPERATION_KEY,
    criticalFlows: [
      flow({
        id: 'view-dashboard',
        steps: [
          { kind: 'navigate', value: '/dashboard' },
          { kind: 'assert_visible', value: 'main' },
        ],
      }),
    ],
    ...overrides,
  };
}

function harness(
  input: {
    readonly probeStatuses?: readonly number[];
    readonly burstDetected?: boolean;
    readonly failedSmokeFlowIds?: readonly string[];
    readonly supportLevel?: 'compatible' | 'verified' | 'managed';
    readonly autoRollbackOnFailedHealth?: boolean;
  } = {},
) {
  const probeStatuses = [...(input.probeStatuses ?? [200, 200, 200])];
  const waits: number[] = [];
  const smokeFlowIds: string[][] = [];
  const evidence: unknown[] = [];
  const lifecycle: string[] = [];
  let probe = 0;

  const dependencies: ProductionHealthDependencies = {
    health: {
      probe() {
        const statusCode = probeStatuses[probe] ?? 500;
        probe += 1;
        return Promise.resolve({
          statusCode,
          evidenceArtifactId: `art_01J0000000000000000000000${String(probe)}`,
        });
      },
    },
    wait: {
      forMs(milliseconds) {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    },
    logs: {
      inspectFirstWindow() {
        return Promise.resolve({
          burstDetected: input.burstDetected ?? false,
          evidenceArtifactIds: ['art_01J00000000000000000000010'],
        });
      },
    },
    smoke: {
      run(request) {
        smokeFlowIds.push(request.flows.map(({ id }) => id));
        const failed = new Set(input.failedSmokeFlowIds ?? []);
        return Promise.resolve({
          flowResults: request.flows.map(({ id }) => ({
            flowId: id,
            status: failed.has(id) ? ('failed' as const) : ('passed' as const),
          })),
          evidenceArtifactIds: ['art_01J00000000000000000000011'],
        });
      },
    },
    evidence: {
      attachProduction(request) {
        evidence.push(request);
        return Promise.resolve({ evidenceArtifactId: EVIDENCE_ARTIFACT_ID });
      },
    },
    policy: {
      resolve() {
        return Promise.resolve({
          supportLevel: input.supportLevel ?? 'managed',
          ...(input.autoRollbackOnFailedHealth === undefined
            ? {}
            : { autoRollbackOnFailedHealth: input.autoRollbackOnFailedHealth }),
        });
      },
    },
    lifecycle: {
      markFailed(request) {
        lifecycle.push(`failed:${request.idempotencyKey}`);
        return Promise.resolve();
      },
      emitRollbackOffer(request) {
        lifecycle.push(`offer:${request.idempotencyKey}`);
        return Promise.resolve();
      },
      rollback(request) {
        lifecycle.push(`rollback:${request.idempotencyKey}`);
        return Promise.resolve();
      },
    },
  };

  return { dependencies, evidence, lifecycle, smokeFlowIds, waits };
}

describe('DEP-7 production health and smoke', () => {
  it('fails two-of-three health responses, marks failed, and uses Managed auto-rollback', async () => {
    const fixture = harness({ probeStatuses: [200, 503, 200] });
    const service = createProductionHealthService(fixture.dependencies);

    await expect(service.verify(healthInput())).resolves.toMatchObject({
      status: 'failed',
      evidenceArtifactId: EVIDENCE_ARTIFACT_ID,
      automaticRollbackAttempted: true,
    });

    expect(fixture.waits).toEqual([10_000, 10_000]);
    expect(fixture.smokeFlowIds).toEqual([]);
    expect(fixture.lifecycle).toEqual([
      `failed:${OPERATION_KEY}:mark_failed`,
      `offer:${OPERATION_KEY}:rollback_offer`,
      `rollback:${OPERATION_KEY}:auto_rollback`,
    ]);
    expect(fixture.evidence).toHaveLength(1);
    expect(fixture.evidence[0]).toMatchObject({
      production: {
        status: 'failed',
        healthEndpoint: {
          status: 'failed',
          attempts: [{ statusCode: 200 }, { statusCode: 503 }, { statusCode: 200 }],
        },
        errorRate: { status: 'not_run', windowMs: 120_000 },
        smoke: { status: 'not_run', flows: [] },
      },
    });
  });

  it('runs only structurally read-only @prod-safe critical flows against production', async () => {
    const fixture = harness();
    const service = createProductionHealthService(fixture.dependencies);
    const mutating = flow({
      id: 'delete-account',
      steps: [
        { kind: 'navigate', value: '/settings' },
        { kind: 'click', value: 'Delete account' },
        { kind: 'submit', value: 'confirm' },
      ],
    });
    const untaggedReadOnly = flow({
      id: 'view-help',
      tags: [],
      steps: [{ kind: 'navigate', value: '/help' }],
    });
    const offOrigin = flow({
      id: 'external-status',
      steps: [{ kind: 'navigate', value: 'https://status.example.net' }],
    });

    await expect(
      service.verify(
        healthInput({
          criticalFlows: [...healthInput().criticalFlows, mutating, untaggedReadOnly, offOrigin],
        }),
      ),
    ).resolves.toMatchObject({
      status: 'healthy',
      automaticRollbackAttempted: false,
    });

    expect(fixture.smokeFlowIds).toEqual([['view-dashboard']]);
    expect(fixture.lifecycle).toEqual([]);
    expect(fixture.evidence[0]).toMatchObject({
      production: {
        status: 'passed',
        healthEndpoint: { status: 'passed' },
        errorRate: { status: 'passed', windowMs: 120_000, burstDetected: false },
        smoke: {
          status: 'passed',
          flows: [{ flowId: 'view-dashboard', status: 'passed' }],
        },
      },
    });
  });

  it('offers rollback without executing it when policy disables automatic rollback', async () => {
    const fixture = harness({
      failedSmokeFlowIds: ['view-dashboard'],
      autoRollbackOnFailedHealth: false,
    });
    const service = createProductionHealthService(fixture.dependencies);

    await expect(service.verify(healthInput())).resolves.toMatchObject({
      status: 'failed',
      automaticRollbackAttempted: false,
    });

    expect(fixture.lifecycle).toEqual([
      `failed:${OPERATION_KEY}:mark_failed`,
      `offer:${OPERATION_KEY}:rollback_offer`,
    ]);
  });

  it('fails closed on a provider-reported 5xx burst before production smoke', async () => {
    const fixture = harness({ burstDetected: true });
    const service = createProductionHealthService(fixture.dependencies);

    await expect(service.verify(healthInput())).resolves.toMatchObject({ status: 'failed' });

    expect(fixture.smokeFlowIds).toEqual([]);
    expect(fixture.evidence[0]).toMatchObject({
      production: {
        errorRate: { status: 'failed', windowMs: 120_000, burstDetected: true },
        smoke: { status: 'not_run' },
      },
    });
  });
});
