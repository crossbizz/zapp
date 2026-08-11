import { describe, expect, it } from 'vitest';

import {
  DEPLOYMENT_STAGES,
  executeDeployWorkflow,
  type DeployWorkflowActivities,
  type DeployWorkflowInput,
} from '../../src/workflows/deploy.js';

const ORGANIZATION_ID = 'org_01J00000000000000000000000';
const PROJECT_ID = 'proj_01J00000000000000000000000';
const ENVIRONMENT_ID = 'env_01J00000000000000000000000';
const RELEASE_ID = 'rel_01J00000000000000000000000';
const DEPLOYMENT_ID = 'dep_01J00000000000000000000000';
const MIGRATION_EVIDENCE_ID = 'art_01J00000000000000000000000';
const OPERATION_KEY = `op_${'a'.repeat(64)}`;

function workflowInput(destructive = false): DeployWorkflowInput {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    releaseId: RELEASE_ID,
    deploymentId: DEPLOYMENT_ID,
    operationKey: OPERATION_KEY,
    migrationPlan: {
      planId: 'migration-plan-42',
      validationEvidenceArtifactId: MIGRATION_EVIDENCE_ID,
      destructive,
      approvalRecordId: destructive ? 'approval-42' : null,
    },
  };
}

function createFlyFixtureHarness(
  options: {
    readonly failStage?: (typeof DEPLOYMENT_STAGES)[number];
    readonly failPassedEventStage?: (typeof DEPLOYMENT_STAGES)[number];
    readonly destructiveApprovalVerified?: boolean;
  } = {},
) {
  const stages: string[] = [];
  const stageKeys: string[] = [];
  const events: Array<{
    readonly key: string;
    readonly type: 'deployment.updated';
    readonly stage: string;
    readonly status: string;
    readonly elapsedMs: number;
    readonly summary: string;
    readonly evidenceArtifactId?: string;
  }> = [];
  const statuses: Array<{ readonly from: string; readonly to: string; readonly key: string }> = [];
  const migrationChecks: string[] = [];
  let productionContent = 'previous healthy release';
  let candidateContent = 'candidate release';
  let clock = 1_000;

  const activities: DeployWorkflowActivities = {
    transitionDeploymentStatus(input) {
      statuses.push({ from: input.from, to: input.to, key: input.idempotencyKey });
      return Promise.resolve();
    },
    emitDeploymentUpdated(input) {
      if (
        input.payload.stage === options.failPassedEventStage &&
        input.payload.status === 'passed'
      ) {
        return Promise.reject(new Error('induced event-store failure'));
      }
      events.push({
        key: input.idempotencyKey,
        type: input.type,
        stage: input.payload.stage,
        status: input.payload.status,
        elapsedMs: input.payload.elapsedMs,
        summary: input.payload.summary,
        ...(input.payload.evidenceArtifactId === undefined
          ? {}
          : { evidenceArtifactId: input.payload.evidenceArtifactId }),
      });
      return Promise.resolve();
    },
    verifyMigrationPlan(input) {
      migrationChecks.push(input.idempotencyKey);
      return Promise.resolve({
        planId: input.plan.planId,
        preApproved: true,
        destructive: input.plan.destructive,
        approvalRecordId: input.plan.approvalRecordId,
        destructiveApprovalVerified: options.destructiveApprovalVerified ?? true,
      });
    },
    executeDeploymentStage(input) {
      stages.push(input.stage);
      stageKeys.push(input.idempotencyKey);
      if (input.stage === options.failStage) {
        return Promise.reject(new Error('induced fixture failure'));
      }
      if (input.stage === 'go_live') productionContent = candidateContent;
      return Promise.resolve({
        summary: `${input.stage} passed for the Fly fixture.`,
        evidenceArtifactId:
          input.stage === 'production_health_check' ? 'art_01J00000000000000000000001' : undefined,
      });
    },
  };

  return {
    activities,
    events,
    migrationChecks,
    production: () => productionContent,
    setCandidate: (content: string) => {
      candidateContent = content;
    },
    stages,
    stageKeys,
    statuses,
    nowMs: () => {
      clock += 10;
      return clock;
    },
  };
}

describe('DEP-6 staged deploy workflow', () => {
  it('walks all eight stages in order with keyed events and status transitions', async () => {
    const fixture = createFlyFixtureHarness();

    await expect(
      executeDeployWorkflow(workflowInput(), fixture.activities, fixture.nowMs),
    ).resolves.toEqual({ deploymentId: DEPLOYMENT_ID, status: 'healthy' });

    expect(fixture.stages).toEqual(DEPLOYMENT_STAGES);
    expect(fixture.statuses.map(({ from, to }) => `${from}->${to}`)).toEqual([
      'queued->deploying',
      'deploying->healthy',
    ]);
    expect(fixture.events.map(({ stage, status }) => `${stage}:${status}`)).toEqual(
      DEPLOYMENT_STAGES.flatMap((stage) => [`${stage}:running`, `${stage}:passed`]),
    );
    expect(fixture.events.map(({ type }) => type)).toEqual(
      Array.from({ length: DEPLOYMENT_STAGES.length * 2 }, () => 'deployment.updated'),
    );
    expect(fixture.events.every(({ elapsedMs }) => elapsedMs >= 0)).toBe(true);
    expect(
      fixture.events.find(
        ({ stage, status }) => stage === 'production_health_check' && status === 'passed',
      ),
    ).toMatchObject({ evidenceArtifactId: 'art_01J00000000000000000000001' });
    expect(fixture.migrationChecks).toEqual([`${OPERATION_KEY}:apply_migrations:approval`]);
    expect(fixture.stageKeys).toEqual(
      DEPLOYMENT_STAGES.map((stage) => `${OPERATION_KEY}:${stage}:execute`),
    );
    expect(
      new Set([
        ...fixture.stageKeys,
        ...fixture.events.map(({ key }) => key),
        ...fixture.statuses.map(({ key }) => key),
        ...fixture.migrationChecks,
      ]).size,
    ).toBe(27);
    expect(fixture.production()).toBe('candidate release');
  });

  it('marks a health-check failure and leaves the previous Fly deployment serving', async () => {
    const fixture = createFlyFixtureHarness({ failStage: 'production_health_check' });
    fixture.setCandidate('unhealthy candidate');

    await expect(
      executeDeployWorkflow(workflowInput(), fixture.activities, fixture.nowMs),
    ).rejects.toThrow('induced fixture failure');

    expect(fixture.stages).toEqual(DEPLOYMENT_STAGES.slice(0, -1));
    expect(fixture.stages).not.toContain('go_live');
    expect(fixture.production()).toBe('previous healthy release');
    expect(fixture.statuses.map(({ from, to }) => `${from}->${to}`)).toEqual([
      'queued->deploying',
      'deploying->failed',
    ]);
    expect(fixture.events.at(-1)).toMatchObject({
      stage: 'production_health_check',
      status: 'failed',
      summary: 'Production health check failed.',
    });
  });

  it('does not misclassify an event-store outage after go-live as a failed deploy stage', async () => {
    const fixture = createFlyFixtureHarness({ failPassedEventStage: 'go_live' });

    await expect(
      executeDeployWorkflow(workflowInput(), fixture.activities, fixture.nowMs),
    ).rejects.toThrow('induced event-store failure');

    expect(fixture.stages).toEqual(DEPLOYMENT_STAGES);
    expect(fixture.production()).toBe('candidate release');
    expect(fixture.statuses.map(({ from, to }) => `${from}->${to}`)).toEqual(['queued->deploying']);
    expect(fixture.events).not.toContainEqual(
      expect.objectContaining({ stage: 'go_live', status: 'failed' }),
    );
  });

  it('re-verifies destructive approval against the exact plan before migrations run', async () => {
    const fixture = createFlyFixtureHarness({ destructiveApprovalVerified: false });

    await expect(
      executeDeployWorkflow(workflowInput(true), fixture.activities, fixture.nowMs),
    ).rejects.toThrow('destructive_migration_approval_not_verified');

    expect(fixture.migrationChecks).toEqual([`${OPERATION_KEY}:apply_migrations:approval`]);
    expect(fixture.stages).toEqual(DEPLOYMENT_STAGES.slice(0, 3));
    expect(fixture.events.at(-1)).toMatchObject({
      stage: 'apply_migrations',
      status: 'failed',
    });
    expect(fixture.statuses.at(-1)).toMatchObject({ from: 'deploying', to: 'failed' });
    expect(fixture.production()).toBe('previous healthy release');
  });
});
