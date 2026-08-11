import { describe, expect, it } from 'vitest';

import {
  createSyntheticRunner,
  type SyntheticRunnerDependencies,
  type SyntheticRunInput,
} from '../src/synthetics/runner.js';
import {
  createSyntheticScheduler,
  executeSyntheticCheckWorkflow,
  type SyntheticSchedulerDependencies,
} from '../src/synthetics/scheduler.js';

const ORGANIZATION_ID = 'org_01J00000000000000000000000';
const PROJECT_ID = 'proj_01J00000000000000000000000';
const ENVIRONMENT_ID = 'env_01J00000000000000000000000';
const RELEASE_ID = 'rel_01J00000000000000000000000';
const CHECK_ID = 'syn_01J00000000000000000000000';
const ARTIFACT_ID = 'art_01J00000000000000000000000';
const OPERATION_KEY = `op_${'6'.repeat(64)}`;
const NOW = '2026-08-11T20:00:00.000Z';

function flow(
  input: {
    readonly id?: string;
    readonly title?: string;
    readonly critical?: boolean;
    readonly tags?: readonly string[];
    readonly step?: 'navigate' | 'assert_text' | 'click';
  } = {},
) {
  return {
    id: input.id ?? 'checkout-health',
    title: input.title ?? 'Checkout remains available',
    critical: input.critical ?? true,
    tags: [...(input.tags ?? ['@prod-safe'])],
    steps: [{ kind: input.step ?? 'navigate', value: '/checkout' }],
  };
}

function schedulerHarness() {
  type SchedulerCall =
    | {
        readonly claim: Parameters<SyntheticSchedulerDependencies['store']['claim']>[0];
      }
    | {
        readonly schedule: Parameters<
          SyntheticSchedulerDependencies['temporal']['ensureCronSchedule']
        >[0];
      };
  const calls: SchedulerCall[] = [];
  const dependencies: SyntheticSchedulerDependencies = {
    store: {
      claim(input) {
        calls.push({ claim: input });
        return Promise.resolve({ row: input.row, binding: input.binding });
      },
    },
    temporal: {
      ensureCronSchedule(input) {
        calls.push({ schedule: input });
        return Promise.resolve({ scheduleId: input.scheduleId });
      },
    },
    newSyntheticCheckId: () => CHECK_ID,
  };
  return { calls, dependencies };
}

function scheduleInput(supportLevel: 'compatible' | 'verified' | 'managed' = 'managed') {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    releaseId: RELEASE_ID,
    supportLevel,
    productionUrl: 'https://app.example.com',
    operationKey: OPERATION_KEY,
    criticalFlows: [
      flow(),
      flow({ id: 'noncritical', title: 'Noncritical', critical: false }),
      flow({ id: 'unsafe', title: 'Unsafe mutation', step: 'click' }),
    ],
  };
}

function runInput(): SyntheticRunInput {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    releaseId: RELEASE_ID,
    syntheticCheckId: CHECK_ID,
    flowRef: 'checkout-health',
    productionUrl: 'https://app.example.com',
    operationKey: 'synthetic-run-2026-08-11T20:00:00Z',
  };
}

function runnerHarness(
  input: {
    readonly checkStatus?: 'enabled' | 'disabled';
    readonly verificationStatus?: 'passed' | 'failed';
    readonly evidenceArtifactIds?: readonly string[];
    readonly replay?: unknown;
  } = {},
) {
  const calls: { readonly name: string; readonly input?: unknown }[] = [];
  const dependencies: SyntheticRunnerDependencies = {
    context: {
      resolve(value) {
        calls.push({ name: 'resolve', input: value });
        return Promise.resolve({
          status: input.checkStatus ?? 'enabled',
          releaseId: RELEASE_ID,
          flowRef: 'checkout-health',
          productionUrl: 'https://app.example.com',
        });
      },
    },
    store: {
      getReplay(value) {
        calls.push({ name: 'replay', input: value });
        return Promise.resolve(input.replay);
      },
      recordResult(value) {
        calls.push({ name: 'record', input: value });
        return Promise.resolve();
      },
      updateHealth(value) {
        calls.push({ name: 'health', input: value });
        return Promise.resolve();
      },
      completeReplay(value) {
        calls.push({ name: 'complete', input: value });
        return Promise.resolve();
      },
    },
    verification: {
      runProductionSafeFlow(value) {
        calls.push({ name: 'verify', input: value });
        return Promise.resolve({
          status: input.verificationStatus ?? 'passed',
          summary:
            input.verificationStatus === 'failed'
              ? 'Checkout heading was missing.'
              : 'Checkout flow passed.',
          evidenceArtifactIds: input.evidenceArtifactIds ?? [ARTIFACT_ID],
        });
      },
    },
    incident: {
      emit(value) {
        calls.push({ name: 'incident', input: value });
        return Promise.resolve();
      },
    },
    notifications: {
      send(value) {
        calls.push({ name: 'notification', input: value });
        return Promise.resolve();
      },
    },
    fixes: {
      offer(value) {
        calls.push({ name: 'fix', input: value });
        return Promise.resolve();
      },
    },
    now: () => new Date(NOW),
  };
  return { calls, dependencies };
}

describe('DEP-11 synthetic scheduler', () => {
  it('creates cron checks only for Managed, critical, structurally prod-safe flows', async () => {
    const fixture = schedulerHarness();
    const scheduler = createSyntheticScheduler(fixture.dependencies);

    await expect(scheduler.scheduleManagedRelease(scheduleInput())).resolves.toEqual([
      {
        syntheticCheckId: CHECK_ID,
        name: 'Checkout remains available',
        schedule: '*/5 * * * *',
        status: 'enabled',
      },
    ]);
    expect(fixture.calls).toHaveLength(2);
    const claimCall = fixture.calls[0];
    if (claimCall === undefined || !('claim' in claimCall)) throw new Error('missing claim');
    expect(claimCall.claim.idempotencyKey).toBe(`${OPERATION_KEY}:check:0`);
    expect(claimCall.claim.fingerprint).toContain('checkout-health');
    expect(claimCall.claim.row).toEqual({
      id: CHECK_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      name: 'Checkout remains available',
      schedule: '*/5 * * * *',
      status: 'enabled',
      lastRunAt: null,
    });
    expect(claimCall.claim.binding).toEqual({
      releaseId: RELEASE_ID,
      flowRef: 'checkout-health',
      productionUrl: 'https://app.example.com/',
    });
    const scheduleCall = fixture.calls[1];
    if (scheduleCall === undefined || !('schedule' in scheduleCall)) {
      throw new Error('missing schedule');
    }
    expect(scheduleCall.schedule).toEqual({
      idempotencyKey: `${OPERATION_KEY}:schedule:${CHECK_ID}`,
      scheduleId: `synthetic:${CHECK_ID}`,
      cron: '*/5 * * * *',
      overlapPolicy: 'skip',
      workflowInput: {
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        releaseId: RELEASE_ID,
        syntheticCheckId: CHECK_ID,
        flowRef: 'checkout-health',
        productionUrl: 'https://app.example.com/',
      },
    });
  });

  it.each(['compatible', 'verified'] as const)(
    'does not create defaults for %s releases',
    async (supportLevel) => {
      const fixture = schedulerHarness();
      const scheduler = createSyntheticScheduler(fixture.dependencies);

      await expect(scheduler.scheduleManagedRelease(scheduleInput(supportLevel))).resolves.toEqual(
        [],
      );
      expect(fixture.calls).toEqual([]);
    },
  );

  it('keeps activity keys bounded for maximum operation and flow identifiers', async () => {
    const fixture = schedulerHarness();
    const scheduler = createSyntheticScheduler(fixture.dependencies);

    await expect(
      scheduler.scheduleManagedRelease({
        ...scheduleInput(),
        operationKey: 'x'.repeat(400),
        criticalFlows: [flow({ id: 'f'.repeat(256) })],
      }),
    ).resolves.toHaveLength(1);
    const claimCall = fixture.calls[0];
    if (claimCall === undefined || !('claim' in claimCall)) throw new Error('missing claim');
    expect(claimCall.claim.idempotencyKey.length).toBeLessThanOrEqual(512);
  });

  it('derives a unique keyed runner activity from the Temporal execution id', async () => {
    const calls: unknown[] = [];
    const result = {
      syntheticCheckId: CHECK_ID,
      status: 'passed' as const,
      incidentCreated: false,
      fixOffered: false,
      evidenceArtifactIds: [ARTIFACT_ID],
      completedAt: NOW,
    };

    await expect(
      executeSyntheticCheckWorkflow(
        {
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          releaseId: RELEASE_ID,
          syntheticCheckId: CHECK_ID,
          flowRef: 'checkout-health',
          productionUrl: 'https://app.example.com',
        },
        {
          runSyntheticCheck(value) {
            calls.push(value);
            return Promise.resolve(result);
          },
        },
        'temporal-run-123',
      ),
    ).resolves.toEqual(result);
    expect(calls).toEqual([
      expect.objectContaining({
        operationKey: `${CHECK_ID}:temporal-run-123`,
        syntheticCheckId: CHECK_ID,
      }),
    ]);
  });
});

describe('DEP-11 synthetic runner', () => {
  it('does not run a disabled check', async () => {
    const fixture = runnerHarness({ checkStatus: 'disabled' });
    const runner = createSyntheticRunner(fixture.dependencies);

    await expect(runner.run(runInput())).resolves.toEqual({
      syntheticCheckId: CHECK_ID,
      status: 'disabled',
      incidentCreated: false,
      fixOffered: false,
    });
    expect(fixture.calls.map(({ name }) => name)).toEqual(['resolve']);
  });

  it('records a passing production-safe Playwright result for 30-day retention', async () => {
    const fixture = runnerHarness();
    const runner = createSyntheticRunner(fixture.dependencies);

    await expect(runner.run(runInput())).resolves.toEqual({
      syntheticCheckId: CHECK_ID,
      status: 'passed',
      incidentCreated: false,
      fixOffered: false,
      evidenceArtifactIds: [ARTIFACT_ID],
      completedAt: NOW,
    });
    expect(fixture.calls.map(({ name }) => name)).toEqual([
      'resolve',
      'replay',
      'verify',
      'record',
      'health',
      'complete',
    ]);
    expect(fixture.calls.find(({ name }) => name === 'verify')?.input).toEqual({
      idempotencyKey: `${runInput().operationKey}:verify`,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      releaseId: RELEASE_ID,
      syntheticCheckId: CHECK_ID,
      flowRef: 'checkout-health',
      productionUrl: 'https://app.example.com/',
    });
    expect(fixture.calls.find(({ name }) => name === 'record')?.input).toEqual(
      expect.objectContaining({
        status: 'passed',
        completedAt: NOW,
        retainUntil: '2026-09-10T20:00:00.000Z',
      }),
    );
    expect(fixture.calls.find(({ name }) => name === 'health')?.input).toEqual(
      expect.objectContaining({ status: 'passing', lastRunAt: NOW }),
    );
  });

  it('links a failed check to its release, notifies, and offers a Fix run', async () => {
    const fixture = runnerHarness({ verificationStatus: 'failed' });
    const runner = createSyntheticRunner(fixture.dependencies);

    await expect(runner.run(runInput())).resolves.toEqual({
      syntheticCheckId: CHECK_ID,
      status: 'failed',
      incidentCreated: true,
      fixOffered: true,
      evidenceArtifactIds: [ARTIFACT_ID],
      completedAt: NOW,
    });
    expect(fixture.calls.map(({ name }) => name)).toEqual([
      'resolve',
      'replay',
      'verify',
      'record',
      'health',
      'incident',
      'notification',
      'fix',
      'complete',
    ]);
    expect(fixture.calls.find(({ name }) => name === 'incident')?.input).toEqual(
      expect.objectContaining({
        type: 'synthetic_check.failed',
        releaseId: RELEASE_ID,
        syntheticCheckId: CHECK_ID,
        evidenceArtifactIds: [ARTIFACT_ID],
      }),
    );
    expect(fixture.calls.find(({ name }) => name === 'notification')?.input).toEqual(
      expect.objectContaining({ releaseId: RELEASE_ID, syntheticCheckId: CHECK_ID }),
    );
    expect(fixture.calls.find(({ name }) => name === 'fix')?.input).toEqual(
      expect.objectContaining({
        source: 'failed_check',
        releaseId: RELEASE_ID,
        syntheticCheckId: CHECK_ID,
        evidenceArtifactIds: [ARTIFACT_ID],
      }),
    );
  });

  it('fails closed when a failed check has no immutable evidence for the Fix offer', async () => {
    const fixture = runnerHarness({ verificationStatus: 'failed', evidenceArtifactIds: [] });
    const runner = createSyntheticRunner(fixture.dependencies);

    await expect(runner.run(runInput())).rejects.toThrow(
      'failed synthetic checks require immutable evidence',
    );
    expect(fixture.calls.map(({ name }) => name)).toEqual(['resolve', 'replay', 'verify']);
  });

  it('returns an authoritative replay without re-running Playwright or side effects', async () => {
    const replay = {
      syntheticCheckId: CHECK_ID,
      status: 'passed',
      incidentCreated: false,
      fixOffered: false,
      evidenceArtifactIds: [ARTIFACT_ID],
      completedAt: NOW,
    };
    const fixture = runnerHarness({ replay });
    const runner = createSyntheticRunner(fixture.dependencies);

    await expect(runner.run(runInput())).resolves.toEqual(replay);
    expect(fixture.calls.map(({ name }) => name)).toEqual(['resolve', 'replay']);
  });
});
