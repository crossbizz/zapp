import { createHash, createHmac } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { newId } from '@zapp/contracts';
import type { AgentRun, Approval, Branch, Project, Workspace } from '@zapp/db';
import type { ModelCompletionRepository } from '../src/usage/model-completions.js';
import {
  CreditBalanceExhaustedError,
  loadPlanLimitsConfig,
  type CreditBalanceGate,
  type PlanLimitsConfig,
} from '../src/usage/limits.js';
import type { AuthIdentity } from '../src/auth/port.js';
import { DispatchNotStartedError, OrchestratorError } from '../src/orchestrator/port.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import {
  buildHarness,
  signIn,
  TEST_PRICING,
  TEST_RUN_INTENT_HMAC_KEY,
  type Harness,
  type TestSession,
} from './support/harness.js';
import { InMemoryOrganizationStore } from './support/org-store.js';
import { EMPTY_WORKSPACE_USAGE, InMemoryTenantData } from './support/tenant-db.js';

/**
 * The CP-9 public run lifecycle, through the real HTTP stack.
 *
 * The port is intentionally a recording fake: the assertions are about the
 * control plane's public contract (the persisted row and exactly one durable
 * workflow start), not a Temporal emulator's implementation details.
 */

const OWNER: AuthIdentity = {
  externalId: 'runs-test-owner',
  email: 'owner@runs.test',
  displayName: 'Rina Runowner',
};

const harnesses: Harness[] = [];

const TEST_PLAN_LIMITS = loadPlanLimitsConfig({
  trial: { concurrentAutonomousRuns: 1, concurrentSandboxes: 1, maxResourceProfile: 'small', maxRunBudgetCredits: '10.0000', maxPreviewLifetimeHours: 1, artifactRetentionDays: 7, monthlyCredits: '10.0000', seats: 1 },
  builder: { concurrentAutonomousRuns: 3, concurrentSandboxes: 3, maxResourceProfile: 'standard', maxRunBudgetCredits: '100.0000', maxPreviewLifetimeHours: 24, artifactRetentionDays: 30, monthlyCredits: '100.0000', seats: 3 },
  studio: { concurrentAutonomousRuns: 10, concurrentSandboxes: 10, maxResourceProfile: 'large', maxRunBudgetCredits: '1000.0000', maxPreviewLifetimeHours: 168, artifactRetentionDays: 90, monthlyCredits: '1000.0000', seats: 10 },
});

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((built) => built.app.close()));
});

interface StartCall {
  readonly runId: string;
  readonly workflowId: string;
  readonly projectId: string;
  readonly mode: string;
  readonly appType: 'web' | 'mobile';
  readonly model: string | null;
  readonly prompt: string;
  readonly budget?: { readonly maxCredits: number } | null;
  readonly planMaxCredits?: number;
  readonly operationKey?: string;
  readonly fixRequest?: unknown;
}

class FakeOrchestratorPort {
  readonly starts: StartCall[] = [];
  readonly signals: {
    readonly runId: string;
    readonly signal: string;
    readonly operationKey?: string;
    readonly approvalId?: string;
    readonly decision?: string;
    readonly absoluteCeiling?: string;
    readonly reason?: string;
  }[] = [];
  failStarts = 0;
  ambiguousStarts = 0;
  signalResult: unknown = { applied: true };

  startRun(input: StartCall): Promise<void> {
    this.starts.push(input);
    if (this.failStarts > 0) {
      this.failStarts -= 1;
      return Promise.reject(new DispatchNotStartedError());
    }
    if (this.ambiguousStarts > 0) {
      this.ambiguousStarts -= 1;
      return Promise.reject(new OrchestratorError('temporary test failure'));
    }
    return Promise.resolve();
  }

  signalRun(input: {
    readonly runId: string;
    readonly signal: string;
    readonly operationKey?: string;
    readonly approvalId?: string;
    readonly decision?: string;
    readonly absoluteCeiling?: string;
    readonly reason?: string;
  }): Promise<{ applied: boolean }> {
    this.signals.push({
      runId: input.runId,
      signal: input.signal,
      ...(input.operationKey === undefined ? {} : { operationKey: input.operationKey }),
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      ...(input.absoluteCeiling === undefined ? {} : { absoluteCeiling: input.absoluteCeiling }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return Promise.resolve(this.signalResult as { applied: boolean });
  }
}

class FakeModelCompletionRepository implements ModelCompletionRepository {
  readonly increases: Parameters<ModelCompletionRepository['increaseCeiling']>[0][] = [];

  claim(): Promise<never> {
    return Promise.reject(new Error('claim must not run through the approval route'));
  }

  commit(): Promise<never> {
    return Promise.reject(new Error('commit must not run through the approval route'));
  }

  get(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  increaseCeiling(input: Parameters<ModelCompletionRepository['increaseCeiling']>[0]) {
    this.increases.push(input);
    return Promise.resolve({
      used: '100.0000',
      reserved: '0.0000',
      ceiling: input.absoluteCeiling,
      version: 2,
    });
  }
}

class FakeSandboxServicePort {
  readonly calls: string[] = [];
  readonly operationKeys: (string | undefined)[] = [];
  readonly createInputs: unknown[] = [];
  failCreates = 0;
  branchLockedCreates = 0;
  readonly failures = new Set<string>();

  createWorkspace(input: {
    readonly operationKey?: string;
  }): Promise<{ providerWorkspaceId: string; status: string }> {
    this.calls.push('create');
    this.createInputs.push(input);
    this.operationKeys.push(input.operationKey);
    if (this.failCreates > 0) {
      this.failCreates -= 1;
      return Promise.reject(new Error('sandbox unavailable'));
    }
    if (this.branchLockedCreates > 0) {
      this.branchLockedCreates -= 1;
      return Promise.reject(
        Object.assign(new Error('The branch already has an active writer.'), {
          code: 'branch_locked',
        }),
      );
    }
    return Promise.resolve({
      providerWorkspaceId: `sandbox-${String(this.calls.length)}`,
      status: 'provisioning',
    });
  }

  startWorkspace(input: { readonly operationKey?: string }): Promise<{ status: string }> {
    this.calls.push('start');
    this.operationKeys.push(input.operationKey);
    if (this.failures.has('start')) return Promise.reject(new Error('sandbox start rejected'));
    return Promise.resolve({ status: 'started' });
  }

  checkpointWorkspace(input: { readonly operationKey?: string }): Promise<{ snapshotRef: string }> {
    this.calls.push('checkpoint');
    this.operationKeys.push(input.operationKey);
    if (this.failures.has('checkpoint'))
      return Promise.reject(new Error('sandbox checkpoint rejected'));
    return Promise.resolve({ snapshotRef: 'snapshot-01' });
  }

  terminateWorkspace(input: { readonly operationKey?: string }): Promise<void> {
    this.calls.push('terminate');
    this.operationKeys.push(input.operationKey);
    if (this.failures.has('terminate'))
      return Promise.reject(new Error('sandbox terminate rejected'));
    return Promise.resolve();
  }

}

class ReadCountingOrganizationStore extends InMemoryOrganizationStore {
  settingsReads = 0;

  override getSettings(organizationId: string) {
    this.settingsReads += 1;
    return super.getSettings(organizationId);
  }
}

interface Wired {
  readonly built: Harness;
  readonly data: InMemoryTenantData;
  readonly owner: TestSession;
  readonly organizationId: string;
  readonly orchestrator: FakeOrchestratorPort;
  readonly modelCompletions: FakeModelCompletionRepository;
  readonly as: (session: TestSession) => Record<string, string>;
}

function newRunInput(id: string) {
  return {
    id,
    workflowId: id,
    requestFingerprint: 'a'.repeat(64),
    projectId: newId('proj'),
    branchId: null,
    mode: 'build' as const,
    appType: 'web' as const,
    model: null,
    budget: null,
    planMaxCredits: '1000.0000',
    accounting: {
      baseCeiling: '1000.0000',
      pricingVersion: 'm1-test',
      pricingSnapshot: {
        version: 'm1-test',
        defaultRunCreditCeiling: '1000.0000',
        creditsPerUsd: '100.0000',
        models: {
          'anthropic/claude-sonnet-5': {
            inputUsdPerMillion: '3.000000',
            outputUsdPerMillion: '15.000000',
            cacheReadUsdPerMillion: '0.300000',
            cacheWriteUsdPerMillion: '3.750000',
          },
        },
      },
    },
    startedBy: newId('user'),
    now: new Date('2026-08-15T12:00:00.000Z'),
  };
}

async function wire(
  options: {
    sandbox?: FakeSandboxServicePort;
    organizations?: InMemoryOrganizationStore;
    pricing?: typeof TEST_PRICING | null;
    planLimits?: PlanLimitsConfig;
    creditBalance?: CreditBalanceGate;
    modelCompletions?: FakeModelCompletionRepository;
  } = {},
): Promise<Wired> {
  const data = new InMemoryTenantData();
  const orchestrator = new FakeOrchestratorPort();
  const modelCompletions = options.modelCompletions ?? new FakeModelCompletionRepository();
  const built = buildHarness({
    tenantDb: data.factory,
    ...(options.organizations === undefined ? {} : { organizations: options.organizations }),
    // CP-9 will add this injected dependency. Keeping the fake in the test
    // first lets the HTTP assertion demonstrate the missing route today.
    orchestrator,
    modelCompletions,
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
    ...(options.planLimits === undefined ? {} : { planLimits: options.planLimits }),
    ...(options.creditBalance === undefined ? {} : { creditBalance: options.creditBalance }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
  });
  harnesses.push(built);

  const owner = await signIn(built, OWNER);
  const organization = await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Run Factory' },
  });
  expect(organization.statusCode, organization.body).toBe(201);
  const organizationId = organization.json<{ organization: { id: string } }>().organization.id;

  return {
    built,
    data,
    owner,
    organizationId,
    orchestrator,
    modelCompletions,
    as: (session) => ({ ...session.headers, [ORGANIZATION_HEADER]: organizationId }),
  };
}

it('rejects a new autonomous run when the plan concurrency limit is full', async () => {
  const wired = await wire({ planLimits: TEST_PLAN_LIMITS });
  const project = await createProject(wired);
  const first = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/projects/${project.id}/runs`,
    headers: { ...wired.as(wired.owner), 'idempotency-key': 'trial-autonomous-first' },
    payload: { mode: 'autonomous', prompt: 'Start the first autonomous run' },
  });
  expect(first.statusCode, first.body).toBe(201);

  const second = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/projects/${project.id}/runs`,
    headers: { ...wired.as(wired.owner), 'idempotency-key': 'trial-autonomous-second' },
    payload: { mode: 'autonomous', prompt: 'Reject this concurrent autonomous run' },
  });

  expect(second.statusCode, second.body).toBe(429);
  expect(second.json<{ error: { code: string } }>().error.code).toBe('plan_limit_concurrent_runs');
  expect(wired.orchestrator.starts).toHaveLength(1);
});

it('atomically admits one distinct autonomous intent at the trial limit while replay succeeds', async () => {
  const wired = await wire({ planLimits: TEST_PLAN_LIMITS });
  const project = await createProject(wired);
  const request = (key: string) =>
    wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': key },
      payload: { mode: 'autonomous', prompt: 'Atomically admit this autonomous run' },
    });

  const [first, second] = await Promise.all([request('autonomous-race-a'), request('autonomous-race-b')]);
  expect([first.statusCode, second.statusCode].sort()).toEqual([201, 429]);
  const admitted = first.statusCode === 201 ? first : second;
  const replay = await request(first.statusCode === 201 ? 'autonomous-race-a' : 'autonomous-race-b');
  expect(replay.statusCode, replay.body).toBe(201);
  expect(replay.json<{ run: { id: string } }>().run.id).toBe(admitted.json<{ run: { id: string } }>().run.id);
  expect(wired.orchestrator.starts).toHaveLength(1);
});

it('releases autonomous quota after dispatch failure so a distinct intent can start', async () => {
  const wired = await wire({ planLimits: TEST_PLAN_LIMITS });
  const project = await createProject(wired);
  wired.orchestrator.failStarts = 1;
  const failed = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/projects/${project.id}/runs`,
    headers: { ...wired.as(wired.owner), 'idempotency-key': 'autonomous-dispatch-failed' },
    payload: { mode: 'autonomous', prompt: 'Fail dispatch and release quota' },
  });
  const replacement = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/projects/${project.id}/runs`,
    headers: { ...wired.as(wired.owner), 'idempotency-key': 'autonomous-after-failure' },
    payload: { mode: 'autonomous', prompt: 'Use released quota' },
  });

  expect(failed.statusCode).toBe(502);
  expect(wired.data.runs[0]?.status).toBe('dispatch_failed');
  expect(replacement.statusCode, replacement.body).toBe(201);
  expect(wired.data.runs[1]?.status).toBe('queued');
});

it('retains autonomous quota after ambiguous dispatch and converges on stable-intent retry', async () => {
  const wired = await wire({ planLimits: TEST_PLAN_LIMITS });
  const project = await createProject(wired);
  wired.orchestrator.ambiguousStarts = 1;
  const headers = {
    ...wired.as(wired.owner),
    'idempotency-key': 'autonomous-ambiguous-dispatch',
  };
  const payload = { mode: 'autonomous', prompt: 'Retain quota until dispatch is known' } as const;
  const ambiguous = await wired.built.app.inject({
    method: 'POST', url: `/v1/projects/${project.id}/runs`, headers, payload,
  });
  const competing = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/projects/${project.id}/runs`,
    headers: { ...wired.as(wired.owner), 'idempotency-key': 'autonomous-ambiguous-race' },
    payload: { mode: 'autonomous', prompt: 'Must not exceed trial concurrency' },
  });

  expect(ambiguous.statusCode).toBe(502);
  expect(ambiguous.json<{ error: { code: string } }>().error.code).toBe('workflow_start_failed');
  expect(wired.data.runs[0]?.status).toBe('queued');
  expect(competing.statusCode).toBe(429);

  const retry = await wired.built.app.inject({
    method: 'POST', url: `/v1/projects/${project.id}/runs`, headers, payload,
  });
  expect(retry.statusCode, retry.body).toBe(201);
  expect(retry.json<{ run: { id: string } }>().run.id).toBe(wired.data.runs[0]?.id);
});

it('blocks a new run when its available organization credits are exhausted', async () => {
  const wired = await wire({
    creditBalance: {
      availableCredits: () => Promise.reject(new Error('not reached during run admission')),
      requireRunAdmission: () => Promise.reject(new CreditBalanceExhaustedError()),
    },
  });
  const project = await createProject(wired);

  const response = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/projects/${project.id}/runs`,
    headers: { ...wired.as(wired.owner), 'idempotency-key': 'exhausted-wallet-run' },
    payload: { mode: 'build', prompt: 'Do not start without credits' },
  });

  expect(response.statusCode, response.body).toBe(402);
  expect(response.json<{ error: { code: string } }>().error.code).toBe('credit_balance_exhausted');
  expect(wired.data.runs).toEqual([]);
  expect(wired.orchestrator.starts).toEqual([]);
});

it('clamps a workspace resource profile to the organization plan before sandbox dispatch', async () => {
  const sandbox = new FakeSandboxServicePort();
  const wired = await wire({ planLimits: TEST_PLAN_LIMITS, sandbox });
  const project = await createProject(wired);

  const response = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/projects/${project.id}/workspaces`,
    headers: { ...wired.as(wired.owner), 'idempotency-key': 'trial-workspace-profile' },
    payload: { resourceProfile: 'large' },
  });

  expect(response.statusCode, response.body).toBe(201);
  expect(response.json<{ workspace: { resourceProfile: string } }>().workspace.resourceProfile).toBe('small');
  expect(sandbox.createInputs[0]).toMatchObject({ workspace: { resourceProfile: 'small' } });
});

async function createProject(wired: Wired): Promise<{ id: string }> {
  const response = await wired.built.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: wired.as(wired.owner),
    payload: { name: 'Run Target' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ project: { id: string } }>().project;
}

async function joinViewer(wired: Wired): Promise<TestSession> {
  const invited = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/organizations/${wired.organizationId}/invites`,
    headers: wired.owner.headers,
    payload: { email: 'viewer@runs.test', role: 'viewer' },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  const viewer = await signIn(wired.built, {
    externalId: 'runs-test-viewer',
    email: 'viewer@runs.test',
    displayName: 'Vera Viewer',
  });
  const accepted = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/invites/${invited.json<{ token: string }>().token}/accept`,
    headers: viewer.headers,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return viewer;
}

async function joinBuilder(wired: Wired): Promise<TestSession> {
  const invited = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/organizations/${wired.organizationId}/invites`,
    headers: wired.owner.headers,
    payload: { email: 'builder@runs.test', role: 'builder' },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  const builder = await signIn(wired.built, {
    externalId: 'runs-test-builder',
    email: 'builder@runs.test',
    displayName: 'Bea Builder',
  });
  const accepted = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/invites/${invited.json<{ token: string }>().token}/accept`,
    headers: builder.headers,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return builder;
}

describe('POST /v1/projects/:projectId/runs', () => {
  it('validates and dispatches captured Fix evidence through the public API', async () => {
    const wired = await wire();
    const project = await createProject(wired);
    const fixRequest = {
      source: 'error_report',
      summary: 'Addition returns the wrong result.',
      relevantCommitSha: 'a'.repeat(40),
      reproductionRef: 'test/repro.mjs',
      evidence: [
        {
          kind: 'preview_console',
          artifactId: 'art_01J00000000000000000000000',
          summary: 'Captured assertion failure.',
        },
        {
          kind: 'grafana_loki',
          url: 'https://grafana.example.test/explore?query=addition',
          summary: 'Release error logs.',
        },
      ],
    } as const;

    const missingEvidence = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'fix-missing-evidence-01' },
      payload: { mode: 'fix', prompt: 'Fix the arithmetic bug.' },
    });
    expect(missingEvidence.statusCode, missingEvidence.body).toBe(400);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'fix-with-evidence-01' },
      payload: { mode: 'fix', prompt: 'Fix the arithmetic bug.', fixRequest },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(wired.orchestrator.starts).toContainEqual(
      expect.objectContaining({
        mode: 'fix',
        prompt: 'Fix the arithmetic bug.',
        fixRequest,
      }),
    );
  });

  it('defaults omitted intent durably before starting one workflow', async () => {
    const organizations = new ReadCountingOrganizationStore();
    const wired = await wire({ organizations });
    const project = await createProject(wired);
    organizations.settings.set(wired.organizationId, {
      builderCanDeploy: false,
      defaultModelPolicy: { allowedModels: 'malformed' },
    });

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'start-run-01' },
      payload: { mode: 'build', prompt: 'Add a billing page' },
    });

    expect(response.statusCode, response.body).toBe(201);
    const run = response.json<{
      run: {
        id: string;
        status: string;
        projectId: string;
        appType: string;
        model: string | null;
      };
    }>().run;
    expect(run).toMatchObject({
      projectId: project.id,
      status: 'queued',
      appType: 'web',
      model: null,
    });
    expect(wired.data.runs).toHaveLength(1);
    expect(wired.data.runs[0]).toMatchObject({ appType: 'web', model: null });
    expect(wired.orchestrator.starts).toEqual([
      expect.objectContaining({
        runId: run.id,
        workflowId: run.id,
        projectId: project.id,
        mode: 'build',
        appType: 'web',
        model: null,
        prompt: 'Add a billing page',
      }),
    ]);
    expect(organizations.settingsReads).toBe(0);
    const audit = wired.built.audit.events.find(
      (event) => event.action === 'run.created' && event.targetId === run.id,
    );
    expect(audit?.metadata).toMatchObject({ appType: 'web', model: null });
  });

  it('persists, reads, audits, and dispatches an allowed explicit intent unchanged', async () => {
    const organizations = new ReadCountingOrganizationStore();
    const wired = await wire({ organizations });
    const project = await createProject(wired);
    organizations.settings.set(wired.organizationId, {
      builderCanDeploy: false,
      defaultModelPolicy: {
        allowedModels: ['anthropic/claude-sonnet-5', 'openai/gpt-5'],
      },
    });

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'explicit-run-intent-01' },
      payload: {
        mode: 'build',
        prompt: 'Build the mobile billing flow',
        appType: 'mobile',
        model: 'anthropic/claude-sonnet-5',
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<{
      run: { id: string; appType: string; model: string | null };
    }>().run;
    expect(created).toMatchObject({
      appType: 'mobile',
      model: 'anthropic/claude-sonnet-5',
    });
    expect(wired.data.runs).toContainEqual(
      expect.objectContaining({
        id: created.id,
        appType: 'mobile',
        model: 'anthropic/claude-sonnet-5',
      }),
    );
    expect(wired.orchestrator.starts).toContainEqual(
      expect.objectContaining({
        runId: created.id,
        appType: 'mobile',
        model: 'anthropic/claude-sonnet-5',
      }),
    );
    const audit = wired.built.audit.events.find(
      (event) => event.action === 'run.created' && event.targetId === created.id,
    );
    expect(audit?.metadata).toMatchObject({
      appType: 'mobile',
      model: 'anthropic/claude-sonnet-5',
    });
    expect(organizations.settingsReads).toBe(1);

    const read = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/runs/${created.id}`,
      headers: wired.as(wired.owner),
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<{ run: { appType: string; model: string | null } }>().run).toMatchObject({
      appType: 'mobile',
      model: 'anthropic/claude-sonnet-5',
    });
  });

  it('resolves an omitted budget from the pricing snapshot before workflow dispatch', async () => {
    const wired = await wire();
    const project = await createProject(wired);
    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'default-budget-01' },
      payload: { mode: 'build', prompt: 'Use the configured budget' },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(wired.data.runs).toHaveLength(1);
    expect(wired.data.runs[0]?.budgetJson).toEqual({ maxCredits: 1_000 });
    expect(wired.data.runAccounting.get(wired.data.runs[0]?.id ?? '')).toMatchObject({
      baseCeiling: '1000.0000',
      pricingVersion: 'm1-test',
      pricingSnapshot: { defaultRunCreditCeiling: '1000.0000' },
    });
    expect(wired.orchestrator.starts).toHaveLength(1);
    expect(wired.orchestrator.starts[0]?.budget).toEqual({ maxCredits: 1_000 });
  });

  it('fails before persistence or dispatch when the pricing configuration is absent', async () => {
    const wired = await wire({ pricing: null });
    const project = await createProject(wired);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'missing-pricing-01' },
      payload: { mode: 'build', prompt: 'Do not start without pricing' },
    });

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'pricing_configuration_invalid',
    );
    expect(wired.data.runs).toEqual([]);
    expect(wired.data.runAccounting.size).toBe(0);
    expect(wired.orchestrator.starts).toEqual([]);
  });

  it('fails before persistence or dispatch when the selected model has no rate', async () => {
    const openaiPricing = TEST_PRICING.models['openai/gpt-5'];
    if (openaiPricing === undefined) throw new Error('test pricing is missing openai/gpt-5');
    const wired = await wire({
      pricing: {
        ...TEST_PRICING,
        models: { 'openai/gpt-5': openaiPricing },
      },
    });
    const project = await createProject(wired);
    wired.built.organizations.settings.set(wired.organizationId, {
      builderCanDeploy: false,
      defaultModelPolicy: { allowedModels: ['anthropic/claude-sonnet-5'] },
    });

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'missing-model-rate-01' },
      payload: {
        mode: 'build',
        prompt: 'Do not start without a model rate',
        model: 'anthropic/claude-sonnet-5',
      },
    });

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'pricing_configuration_invalid',
    );
    expect(wired.data.runs).toEqual([]);
    expect(wired.data.runAccounting.size).toBe(0);
    expect(wired.orchestrator.starts).toEqual([]);
  });

  it('rejects an explicit model absent from the selected organization policy', async () => {
    const wired = await wire();
    const project = await createProject(wired);
    wired.built.organizations.settings.set(wired.organizationId, {
      builderCanDeploy: false,
      defaultModelPolicy: ['openai/gpt-5'],
    });

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'denied-run-model-01' },
      payload: {
        mode: 'build',
        prompt: 'Do not dispatch this model',
        model: 'anthropic/claude-sonnet-5',
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('model_not_allowed');
    expect(wired.data.runs).toEqual([]);
    expect(wired.orchestrator.starts).toEqual([]);
  });

  it('returns invalid_run_state for a completed run without signalling it', async () => {
    const wired = await wire();
    const project = await createProject(wired);
    const completed: AgentRun = {
      id: newId('run'),
      organizationId: wired.organizationId,
      projectId: project.id,
      branchId: null,
      mode: 'build',
      appType: 'web',
      model: null,
      requestFingerprint: 'seed:completed-run',
      status: 'completed',
      specificationId: null,
      temporalWorkflowId: 'workflow-completed',
      startedBy: wired.owner.userId,
      budgetJson: null,
      planMaxCredits: '1000.0000',
      startedAt: wired.built.now(),
      completedAt: wired.built.now(),
    };
    wired.data.runs.push(completed);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/runs/${completed.id}/pause`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'completed-pause-01' },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_run_state');
    expect(wired.orchestrator.signals).toEqual([]);
  });

  it('rejects a resume that has no legal prior paused state without signalling it', async () => {
    const wired = await wire();
    const project = await createProject(wired);
    const created = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'illegal-resume-create-01' },
      payload: { mode: 'build', prompt: 'A queued run cannot resume' },
    });
    const runId = created.json<{ run: { id: string } }>().run.id;

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/resume`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'illegal-resume-01' },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_run_state');
    expect(wired.orchestrator.signals).toEqual([]);
  });

  it('does not let a Viewer start a run', async () => {
    const wired = await wire();
    const project = await createProject(wired);
    const viewer = await joinViewer(wired);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: wired.as(viewer),
      payload: { mode: 'ask', prompt: 'What is in this project?' },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(wired.data.runs).toEqual([]);
    expect(wired.orchestrator.starts).toEqual([]);
  });

  it('replays a run creation without starting a second workflow', async () => {
    const wired = await wire();
    const project = await createProject(wired);
    wired.built.organizations.settings.set(wired.organizationId, {
      builderCanDeploy: false,
      defaultModelPolicy: ['anthropic/claude-sonnet-5'],
    });
    const headers = { ...wired.as(wired.owner), 'idempotency-key': 'run-replay-01' };
    const payload = {
      mode: 'build',
      prompt: 'Implement the landing page',
      appType: 'mobile',
      model: 'anthropic/claude-sonnet-5',
    } as const;

    const first = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers,
      payload,
    });
    const replay = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers,
      payload,
    });
    const conflict = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers,
      payload: { ...payload, appType: 'web' },
    });

    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(conflict.statusCode, conflict.body).toBe(422);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe(
      'idempotency_conflict',
    );
    expect(wired.data.runs).toHaveLength(1);
    expect(wired.orchestrator.starts).toHaveLength(1);
    expect(wired.orchestrator.starts[0]).toMatchObject({
      appType: 'mobile',
      model: 'anthropic/claude-sonnet-5',
    });
  });

  it('retries a persisted explicit intent after policy changes without reauthorizing it', async () => {
    const organizations = new ReadCountingOrganizationStore();
    const wired = await wire({ organizations, planLimits: TEST_PLAN_LIMITS });
    const project = await createProject(wired);
    organizations.settings.set(wired.organizationId, {
      builderCanDeploy: false,
      defaultModelPolicy: ['anthropic/claude-sonnet-5'],
    });
    wired.orchestrator.failStarts = 1;
    const headers = { ...wired.as(wired.owner), 'idempotency-key': 'durable-run-retry-01' };
    const payload = {
      mode: 'build',
      prompt: 'Retry this durable mobile run',
      appType: 'mobile',
      model: 'anthropic/claude-sonnet-5',
    } as const;

    const first = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers,
      payload,
    });

    expect(first.statusCode, first.body).toBe(502);
    expect(wired.data.runs).toHaveLength(1);
    const runId = wired.data.runs[0]?.id;
    expect(runId).toBeDefined();
    expect(wired.data.runs[0]).toMatchObject({
      appType: 'mobile',
      model: 'anthropic/claude-sonnet-5',
      status: 'dispatch_failed',
      planMaxCredits: '10.0000',
    });
    const canonicalBody =
      '{"appType":"mobile","mode":"build","model":"anthropic/claude-sonnet-5","prompt":"Retry this durable mobile run"}';
    const rawFingerprint = createHash('sha256')
      .update(`POST\n/v1/projects/${project.id}/runs\n${canonicalBody}`)
      .digest('hex');
    const expectedDurableFingerprint = createHmac('sha256', TEST_RUN_INTENT_HMAC_KEY)
      .update(rawFingerprint)
      .digest('hex');
    expect(wired.data.runs[0]?.requestFingerprint).not.toBe(rawFingerprint);
    expect(wired.data.runs[0]?.requestFingerprint).toBe(expectedDurableFingerprint);

    const changed = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers,
      payload: { ...payload, appType: 'web' },
    });

    expect(changed.statusCode, changed.body).toBe(422);
    expect(changed.json<{ error: { code: string } }>().error.code).toBe(
      'idempotency_conflict',
    );
    expect(wired.data.runs).toHaveLength(1);
    expect(wired.orchestrator.starts).toHaveLength(1);
    expect(
      wired.built.audit.events.filter(
        (event) => event.action === 'run.created' && event.targetId === runId,
      ),
    ).toHaveLength(1);

    organizations.settings.delete(wired.organizationId);
    const organization = organizations.organizations.get(wired.organizationId);
    if (organization === undefined) throw new Error('test organization disappeared');
    organizations.organizations.set(wired.organizationId, { ...organization, plan: 'studio' });

    const retry = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers,
      payload,
    });

    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.json<{ run: { planMaxCredits: string } }>().run.planMaxCredits).toBe('10.0000');
    expect(wired.data.runs).toHaveLength(1);
    expect(wired.data.runs[0]).toMatchObject({ status: 'queued', planMaxCredits: '10.0000' });
    expect(
      wired.built.audit.events.filter(
        (event) => event.action === 'run.created' && event.targetId === runId,
      ),
    ).toHaveLength(1);
    expect(wired.orchestrator.starts).toEqual([
      expect.objectContaining({
        runId,
        appType: 'mobile',
        model: 'anthropic/claude-sonnet-5',
        planMaxCredits: 10,
      }),
      expect.objectContaining({
        runId,
        appType: 'mobile',
        model: 'anthropic/claude-sonnet-5',
        planMaxCredits: 10,
      }),
    ]);
    expect(organizations.settingsReads).toBe(1);
  });

  it('preserves a persisted studio cap when the plan downgrades before dispatch retry', async () => {
    const wired = await wire({ planLimits: TEST_PLAN_LIMITS });
    const project = await createProject(wired);
    const organization = wired.built.organizations.organizations.get(wired.organizationId);
    if (organization === undefined) throw new Error('test organization disappeared');
    wired.built.organizations.organizations.set(wired.organizationId, {
      ...organization,
      plan: 'studio',
    });
    wired.orchestrator.failStarts = 1;
    const headers = {
      ...wired.as(wired.owner),
      'idempotency-key': 'studio-cap-downgrade-retry',
    };
    const payload = { mode: 'build', prompt: 'Keep the admitted studio cap' } as const;

    const first = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers,
      payload,
    });
    expect(first.statusCode, first.body).toBe(502);
    expect(wired.data.runs[0]).toMatchObject({
      status: 'dispatch_failed',
      planMaxCredits: '1000.0000',
    });

    wired.built.organizations.organizations.set(wired.organizationId, {
      ...organization,
      plan: 'trial',
    });
    const retry = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers,
      payload,
    });

    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.json<{ run: { planMaxCredits: string } }>().run.planMaxCredits).toBe(
      '1000.0000',
    );
    expect(wired.orchestrator.starts).toHaveLength(2);
    expect(wired.orchestrator.starts.every((start) => start.planMaxCredits === 1000)).toBe(true);
  });

  it('signals each applicable lifecycle action and records its matching audit action', async () => {
    const wired = await wire();
    const project = await createProject(wired);

    for (const [action, payload, auditAction, acknowledgedStatus] of [
      ['pause', undefined, 'run.pause_requested', 'queued'],
      ['resume', undefined, 'run.resume_requested', 'paused'],
      ['cancel', undefined, 'run.cancel_requested', 'queued'],
      [
        'redirect',
        { prompt: 'Use a different implementation approach' },
        'run.redirected',
        'queued',
      ],
    ] as const) {
      const created = await wired.built.app.inject({
        method: 'POST',
        url: `/v1/projects/${project.id}/runs`,
        headers: { ...wired.as(wired.owner), 'idempotency-key': `signal-${action}` },
        payload: { mode: 'build', prompt: `Run for ${action}` },
      });
      const runId = created.json<{ run: { id: string } }>().run.id;
      if (action === 'resume') {
        const queued = wired.data.runs.find((run) => run.id === runId);
        if (queued === undefined) throw new Error('created run missing from test store');
        queued.status = 'paused';
      }
      const response = await wired.built.app.inject({
        method: 'POST',
        url: `/v1/runs/${runId}/${action}`,
        headers: { ...wired.as(wired.owner), 'idempotency-key': `signal-${action}-request` },
        ...(payload === undefined ? {} : { payload }),
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ run: { status: string } }>().run.status).toBe(acknowledgedStatus);
      expect(wired.orchestrator.signals).toContainEqual(
        expect.objectContaining({ runId, signal: action }),
      );
      expect(wired.built.audit.events).toContainEqual(
        expect.objectContaining({ action: auditAction, targetId: runId }),
      );
    }
  });

  it('records a keyed signal intent before a rejected downstream signal and leaves the run unsucceeded', async () => {
    const wired = await wire();
    const project = await createProject(wired);
    const created = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'rejected-signal-create-01' },
      payload: { mode: 'build', prompt: 'Reject this pause' },
    });
    const runId = created.json<{ run: { id: string } }>().run.id;
    wired.orchestrator.signalResult = { applied: false };

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/pause`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'rejected-signal-01' },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(wired.data.runs.find((run) => run.id === runId)?.status).toBe('queued');
    expect(wired.built.audit.events).toContainEqual(
      expect.objectContaining({ action: 'run.pause_requested', targetId: runId }),
    );
    expect(wired.orchestrator.signals[0]?.operationKey).toMatch(/^op_/);
  });

  it('treats another tenant’s run, workspace and branch ids as not found', async () => {
    const sandbox = new FakeSandboxServicePort();
    const wired = await wire({ sandbox });
    const project = await createProject(wired);
    const foreignOrganizationId = newId('org');
    const foreignProjectId = newId('proj');
    const foreignBranch: Branch = {
      id: newId('br'),
      organizationId: foreignOrganizationId,
      projectId: foreignProjectId,
      name: 'main',
      headCommitSha: null,
      baseBranchId: null,
      status: 'active',
    };
    const foreignRun: AgentRun = {
      id: newId('run'),
      organizationId: foreignOrganizationId,
      projectId: foreignProjectId,
      branchId: foreignBranch.id,
      mode: 'build',
      appType: 'web',
      model: null,
      requestFingerprint: 'seed:foreign-run',
      status: 'running',
      specificationId: null,
      temporalWorkflowId: `workflow-${foreignOrganizationId}`,
      startedBy: wired.owner.userId,
      budgetJson: null,
      planMaxCredits: '1000.0000',
      startedAt: wired.built.now(),
      completedAt: null,
    };
    const foreignWorkspace: Workspace = {
      id: newId('ws'),
      organizationId: foreignOrganizationId,
      projectId: foreignProjectId,
      branchId: foreignBranch.id,
      provider: 'modal',
      providerWorkspaceId: 'foreign-provider-workspace',
      status: 'active',
      resourceProfile: 'standard',
      runId: null,
      taskId: null,
      purpose: null,
      environment: null,
      imageTag: null,
      previewMonitorEnabled: false,
      previewMonitorOwnerId: null,
      previewMonitorLeaseExpiresAt: null,
      snapshotRef: null,
      ...EMPTY_WORKSPACE_USAGE,
      createdAt: wired.built.now(),
      lastActiveAt: wired.built.now(),
      terminatedAt: null,
    };
    wired.data.branches.push(foreignBranch);
    wired.data.runs.push(foreignRun);
    wired.data.workspaces.push(foreignWorkspace);

    const foreignRunRead = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/runs/${foreignRun.id}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'sandbox-create-failure-01' },
    });
    const foreignRunSignal = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/runs/${foreignRun.id}/pause`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'workspace-start-01' },
    });
    const foreignWorkspaceRead = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${foreignWorkspace.id}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'workspace-checkpoint-01' },
    });
    const foreignWorkspaceStart = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${foreignWorkspace.id}/start`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'workspace-preview-01' },
    });
    const runWithForeignBranch = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'foreign-run-branch' },
      payload: { mode: 'build', prompt: 'Do not cross tenants', branchId: foreignBranch.id },
    });
    const workspaceWithForeignBranch = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'foreign-workspace-branch' },
      payload: { branchId: foreignBranch.id },
    });

    for (const response of [
      foreignRunRead,
      foreignRunSignal,
      foreignWorkspaceRead,
      foreignWorkspaceStart,
    ]) {
      expect(response.statusCode, response.body).toBe(404);
    }
    for (const response of [runWithForeignBranch, workspaceWithForeignBranch]) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('branch_not_found');
    }
    expect(wired.orchestrator.starts).toEqual([]);
    expect(wired.orchestrator.signals).toEqual([]);
    expect(sandbox.calls).toEqual([]);
  });

  it('returns 404 for a foreign run before denying a Viewer permission', async () => {
    const wired = await wire();
    const viewer = await joinViewer(wired);
    const foreignRun: AgentRun = {
      id: newId('run'),
      organizationId: newId('org'),
      projectId: newId('proj'),
      branchId: null,
      mode: 'build',
      appType: 'web',
      model: null,
      requestFingerprint: 'seed:foreign-run-permission',
      status: 'running',
      specificationId: null,
      temporalWorkflowId: 'foreign-workflow',
      startedBy: wired.owner.userId,
      budgetJson: null,
      planMaxCredits: '1000.0000',
      startedAt: wired.built.now(),
      completedAt: null,
    };
    wired.data.runs.push(foreignRun);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/runs/${foreignRun.id}/pause`,
      headers: wired.as(viewer),
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('run_not_found');
  });

  it('returns 404 for a foreign project before denying a Viewer run creation permission', async () => {
    const wired = await wire();
    const viewer = await joinViewer(wired);
    const foreignProjectId = newId('proj');

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${foreignProjectId}/runs`,
      headers: { ...wired.as(viewer), 'idempotency-key': 'foreign-project-run-01' },
      payload: { mode: 'build', prompt: 'No tenant oracle' },
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('project_not_found');
  });

  it('rejects an unstructured run budget before it becomes durable state', async () => {
    const wired = await wire();
    const project = await createProject(wired);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'invalid-budget-01' },
      payload: { mode: 'build', prompt: 'Reject arbitrary JSON', budget: { unrestricted: true } },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(wired.data.runs).toEqual([]);
    expect(wired.orchestrator.starts).toEqual([]);
  });
});

describe('the in-memory run-create queue', () => {
  it('releases an authorize rejection so the next caller creates and the third recovers', async () => {
    const data = new InMemoryTenantData();
    const id = newId('run');
    const repository = data.factory(newId('org')).runs;
    let authorizationAttempts = 0;
    let audits = 0;
    const create = () =>
      repository.create({
        ...newRunInput(id),
        authorize: () => {
          authorizationAttempts += 1;
          if (authorizationAttempts === 1) throw new Error('authorize rejected');
        },
        audit: () => {
          audits += 1;
          return Promise.resolve();
        },
      });

    const settled = await Promise.allSettled([create(), create(), create()]);

    expect(settled.map((result) => result.status)).toEqual([
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    expect(
      settled.slice(1).map((result) =>
        result.status === 'fulfilled' ? result.value.outcome : 'rejected',
      ),
    ).toEqual(['created', 'recovered']);
    expect(data.runs).toHaveLength(1);
    expect(audits).toBe(1);
    expect(data.runCreateLocks.size).toBe(0);
  });

  it('releases an audit rejection so the next caller creates and the third recovers', async () => {
    const data = new InMemoryTenantData();
    const id = newId('run');
    const repository = data.factory(newId('org')).runs;
    let auditAttempts = 0;
    let completedAudits = 0;
    const create = () =>
      repository.create({
        ...newRunInput(id),
        authorize: () => undefined,
        audit: () => {
          auditAttempts += 1;
          if (auditAttempts === 1) return Promise.reject(new Error('audit rejected'));
          completedAudits += 1;
          return Promise.resolve();
        },
      });

    const settled = await Promise.allSettled([create(), create(), create()]);

    expect(settled.map((result) => result.status)).toEqual([
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    expect(
      settled.slice(1).map((result) =>
        result.status === 'fulfilled' ? result.value.outcome : 'rejected',
      ),
    ).toEqual(['created', 'recovered']);
    expect(data.runs).toHaveLength(1);
    expect(completedAudits).toBe(1);
    expect(data.runCreateLocks.size).toBe(0);
  });
});

describe('workspace passthrough routes', () => {
  it('creates, reads, starts, checkpoints and terminates a tenant workspace', async () => {
    const sandbox = new FakeSandboxServicePort();
    const wired = await wire({ sandbox });
    const project = await createProject(wired);
    const branch = wired.data.branches.find((branch) => branch.projectId === project.id);
    expect(branch).toBeDefined();

    const created = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'workspace-01' },
      payload: { branchId: branch?.id, resourceProfile: 'standard' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspace = created.json<{ workspace: { id: string; status: string } }>().workspace;
    expect(workspace.status).toBe('provisioning');
    expect(sandbox.createInputs[0]).toMatchObject({
      workspace: { branchId: branch?.id },
      branchName: branch?.name,
    });

    const read = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspace.id}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'workspace-terminate-01' },
    });
    expect(read.statusCode, read.body).toBe(200);

    const started = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/start`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'workspace-start-01' },
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json<{ workspace: { status: string } }>().workspace.status).toBe('started');

    const checkpoint = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/checkpoint`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'workspace-checkpoint-01' },
      payload: { kind: 'active' },
    });
    expect(checkpoint.statusCode, checkpoint.body).toBe(200);
    expect(checkpoint.json<{ workspace: { snapshotRef: string } }>().workspace.snapshotRef).toBe(
      'snapshot-01',
    );

    const terminated = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/terminate`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'workspace-terminate-01' },
    });
    expect(terminated.statusCode, terminated.body).toBe(200);
    expect(terminated.json<{ workspace: { status: string } }>().workspace.status).toBe(
      'terminated',
    );
    expect(sandbox.calls).toEqual(['create', 'start', 'checkpoint', 'terminate']);
  });

  it('returns a tenant-safe 404, denies Viewers, replays creation, and never exposes raw fs or command routes', async () => {
    const sandbox = new FakeSandboxServicePort();
    const wired = await wire({ sandbox });
    const project = await createProject(wired);
    const branchId = wired.data.branches.find((branch) => branch.projectId === project.id)?.id;
    const viewer = await joinViewer(wired);
    const headers = { ...wired.as(wired.owner), 'idempotency-key': 'workspace-replay-01' };

    const first = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers,
      payload: { branchId },
    });
    const replay = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers,
      payload: { branchId },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    const workspaceId = first.json<{ workspace: { id: string } }>().workspace.id;
    const forbidden = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/start`,
      headers: { ...wired.as(viewer), 'idempotency-key': 'workspace-viewer-start-01' },
    });
    const missing = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${newId('ws')}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'sandbox-create-failure-01' },
    });

    expect(replay.json()).toEqual(first.json());
    expect(forbidden.statusCode, forbidden.body).toBe(403);
    expect(missing.statusCode, missing.body).toBe(404);
    expect(sandbox.calls).toEqual(['create']);
    expect(
      wired.built.app.hasRoute({ method: 'GET', url: '/v1/workspaces/:workspaceId/files' }),
    ).toBe(false);
    expect(
      wired.built.app.hasRoute({ method: 'POST', url: '/v1/workspaces/:workspaceId/exec' }),
    ).toBe(false);
  });

  it('propagates a sandbox creation failure without returning a workspace success', async () => {
    const sandbox = new FakeSandboxServicePort();
    sandbox.failCreates = 1;
    const wired = await wire({ sandbox });
    const project = await createProject(wired);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'sandbox-create-failure-01' },
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(502);
    expect(wired.data.workspaces).toHaveLength(1);
    expect(wired.data.workspaces[0]).toMatchObject({
      status: 'requested',
      providerWorkspaceId: null,
    });
  });

  it('returns the typed public 409 when the sandbox service reports an active branch writer', async () => {
    const sandbox = new FakeSandboxServicePort();
    sandbox.branchLockedCreates = 1;
    const wired = await wire({ sandbox });
    const project = await createProject(wired);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'branch-locked-create-01' },
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'branch_locked',
      message: 'The branch already has an active writer.',
    });
  });

  it('durably records one workspace intent before dispatch and retries its stable workspace identity', async () => {
    const sandbox = new FakeSandboxServicePort();
    sandbox.failCreates = 1;
    const wired = await wire({ sandbox });
    const project = await createProject(wired);
    const headers = { ...wired.as(wired.owner), 'idempotency-key': 'durable-workspace-retry-01' };

    const first = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers,
      payload: {},
    });

    expect(first.statusCode, first.body).toBe(502);
    expect(wired.data.workspaces).toHaveLength(1);
    const workspaceId = wired.data.workspaces[0]?.id;
    expect(workspaceId).toBeDefined();
    expect(wired.built.audit.events).toContainEqual(
      expect.objectContaining({ action: 'workspace.create_requested', targetId: workspaceId }),
    );

    const retry = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers,
      payload: {},
    });

    expect(retry.statusCode, retry.body).toBe(201);
    expect(wired.data.workspaces).toHaveLength(1);
    expect(sandbox.calls).toEqual(['create', 'create']);
  });

  it('permits a Builder on every run and workspace mutation route', async () => {
    const sandbox = new FakeSandboxServicePort();
    const wired = await wire({ sandbox });
    const project = await createProject(wired);
    const builder = await joinBuilder(wired);

    const runCreated = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(builder), 'idempotency-key': 'builder-run-create-01' },
      payload: { mode: 'build', prompt: 'Builder starts a run' },
    });
    expect(runCreated.statusCode, runCreated.body).toBe(201);

    for (const [action, status, payload] of [
      ['pause', 'queued', undefined],
      ['resume', 'paused', undefined],
      ['cancel', 'queued', undefined],
      ['redirect', 'queued', { prompt: 'Builder redirects' }],
    ] as const) {
      const created = await wired.built.app.inject({
        method: 'POST',
        url: `/v1/projects/${project.id}/runs`,
        headers: { ...wired.as(wired.owner), 'idempotency-key': `builder-${action}-seed` },
        payload: { mode: 'build', prompt: `Seed ${action}` },
      });
      const runId = created.json<{ run: { id: string } }>().run.id;
      const run = wired.data.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) throw new Error('seed run missing');
      run.status = status;
      const response = await wired.built.app.inject({
        method: 'POST',
        url: `/v1/runs/${runId}/${action}`,
        headers: { ...wired.as(builder), 'idempotency-key': `builder-${action}-01` },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    const workspaceCreated = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/workspaces`,
      headers: { ...wired.as(builder), 'idempotency-key': 'builder-workspace-create-01' },
      payload: {},
    });
    expect(workspaceCreated.statusCode, workspaceCreated.body).toBe(201);

    for (const [action, status, payload] of [
      ['start', 'provisioning', undefined],
      ['checkpoint', 'started', { kind: 'active' }],
      ['terminate', 'provisioning', undefined],
    ] as const) {
      const created = await wired.built.app.inject({
        method: 'POST',
        url: `/v1/projects/${project.id}/workspaces`,
        headers: { ...wired.as(wired.owner), 'idempotency-key': `builder-workspace-${action}-seed` },
        payload: {},
      });
      const workspaceId = created.json<{ workspace: { id: string } }>().workspace.id;
      const workspace = wired.data.workspaces.find((candidate) => candidate.id === workspaceId);
      if (workspace === undefined) throw new Error('seed workspace missing');
      workspace.status = status;
      const callsBefore = sandbox.calls.length;
      const response = await wired.built.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/${action}`,
        headers: { ...wired.as(builder), 'idempotency-key': `builder-workspace-${action}-01` },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(sandbox.calls.slice(callsBefore)).toContain(action);
    }
  });

  it('denies a Viewer on every run and workspace mutation route without dispatching', async () => {
    const sandbox = new FakeSandboxServicePort();
    const wired = await wire({ sandbox });
    const project = await createProject(wired);
    const viewer = await joinViewer(wired);

    const runCreate = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: wired.as(viewer),
      payload: { mode: 'build', prompt: 'Viewer must not start' },
    });
    expect(runCreate.statusCode, runCreate.body).toBe(403);

    for (const [action, status, payload] of [
      ['pause', 'queued', undefined],
      ['resume', 'paused', undefined],
      ['cancel', 'queued', undefined],
      ['redirect', 'queued', { prompt: 'No redirect' }],
    ] as const) {
      const seeded: AgentRun = {
        id: newId('run'), organizationId: wired.organizationId, projectId: project.id, branchId: null,
        mode: 'build', appType: 'web', model: null, requestFingerprint: `seed:viewer-${action}`, status, specificationId: null, temporalWorkflowId: `viewer-${action}`,
        startedBy: wired.owner.userId, budgetJson: null, planMaxCredits: '1000.0000', startedAt: wired.built.now(), completedAt: null,
      };
      wired.data.runs.push(seeded);
      const callsBefore = wired.orchestrator.signals.length;
      const response = await wired.built.app.inject({
        method: 'POST', url: `/v1/runs/${seeded.id}/${action}`, headers: wired.as(viewer),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(wired.orchestrator.signals).toHaveLength(callsBefore);
    }

    const workspaceCreate = await wired.built.app.inject({
      method: 'POST', url: `/v1/projects/${project.id}/workspaces`, headers: wired.as(viewer), payload: {},
    });
    expect(workspaceCreate.statusCode, workspaceCreate.body).toBe(403);

    for (const [action, status, payload] of [
      ['start', 'provisioning', undefined],
      ['checkpoint', 'started', { kind: 'active' }],
      ['terminate', 'provisioning', undefined],
    ] as const) {
      const seeded: Workspace = {
        id: newId('ws'), organizationId: wired.organizationId, projectId: project.id, branchId: null,
        provider: 'modal', providerWorkspaceId: `viewer-${action}`, status, resourceProfile: 'standard',
        runId: null, taskId: null, purpose: null, environment: null, imageTag: null,
        previewMonitorEnabled: false, previewMonitorOwnerId: null, previewMonitorLeaseExpiresAt: null,
        snapshotRef: null, createdAt: wired.built.now(), lastActiveAt: null, terminatedAt: null,
        ...EMPTY_WORKSPACE_USAGE,
      };
      wired.data.workspaces.push(seeded);
      const callsBefore = sandbox.calls.length;
      const response = await wired.built.app.inject({
        method: 'POST', url: `/v1/workspaces/${seeded.id}/${action}`, headers: wired.as(viewer),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(sandbox.calls).toHaveLength(callsBefore);
    }
  });

  it('returns 404 for foreign project and resource mutations before denying a Viewer', async () => {
    const sandbox = new FakeSandboxServicePort();
    const wired = await wire({ sandbox });
    const viewer = await joinViewer(wired);
    const foreignOrganizationId = newId('org');
    const foreignProjectId = newId('proj');
    const foreignProject: Project = {
      id: foreignProjectId,
      organizationId: foreignOrganizationId,
      name: 'Foreign Project',
      slug: 'foreign-project',
      description: null,
      sourceType: 'blank',
      supportLevel: 'compatible',
      createdBy: wired.owner.userId,
      createdAt: wired.built.now(),
      archivedAt: null,
    };
    const foreignRun: AgentRun = {
      id: newId('run'), organizationId: foreignOrganizationId, projectId: foreignProjectId, branchId: null,
      mode: 'build', appType: 'web', model: null, requestFingerprint: 'seed:foreign-resource-run', status: 'running', specificationId: null, temporalWorkflowId: 'foreign-run',
      startedBy: wired.owner.userId, budgetJson: null, planMaxCredits: '1000.0000', startedAt: wired.built.now(), completedAt: null,
    };
    const foreignWorkspace: Workspace = {
      id: newId('ws'), organizationId: foreignOrganizationId, projectId: foreignProjectId, branchId: null,
      provider: 'modal', providerWorkspaceId: 'foreign-workspace', status: 'active', resourceProfile: 'standard',
      runId: null, taskId: null, purpose: null, environment: null, imageTag: null,
      previewMonitorEnabled: false, previewMonitorOwnerId: null, previewMonitorLeaseExpiresAt: null,
      snapshotRef: null, createdAt: wired.built.now(), lastActiveAt: null, terminatedAt: null,
      ...EMPTY_WORKSPACE_USAGE,
    };
    wired.data.projects.push(foreignProject);
    expect(
      await wired.data.factory(foreignOrganizationId).projects.getById(foreignProject.id),
    ).toEqual(foreignProject);
    wired.data.runs.push(foreignRun);
    wired.data.workspaces.push(foreignWorkspace);

    for (const [kind, payload] of [
      ['runs', { mode: 'build', prompt: 'Foreign project' }],
      ['workspaces', {}],
    ] as const) {
      const response = await wired.built.app.inject({
        method: 'POST', url: `/v1/projects/${foreignProjectId}/${kind}`, headers: wired.as(viewer), payload,
      });
      expect(response.statusCode, response.body).toBe(404);
    }
    for (const [action, payload] of [
      ['pause', undefined], ['resume', undefined], ['cancel', undefined], ['redirect', { prompt: 'No oracle' }],
    ] as const) {
      const response = await wired.built.app.inject({
        method: 'POST', url: `/v1/runs/${foreignRun.id}/${action}`, headers: wired.as(viewer),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, response.body).toBe(404);
    }
    for (const [action, payload] of [
      ['start', undefined], ['checkpoint', { kind: 'active' }], ['terminate', undefined], ['preview', { port: 3000, ttlSeconds: 60 }],
    ] as const) {
      const response = await wired.built.app.inject({
        method: 'POST', url: `/v1/workspaces/${foreignWorkspace.id}/${action}`, headers: wired.as(viewer),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, response.body).toBe(404);
    }
    expect(wired.orchestrator.starts).toEqual([]);
    expect(wired.orchestrator.signals).toEqual([]);
    expect(sandbox.calls).toEqual([]);
  });

  it.each(['approved', 'rejected'] as const)(
    'resolves a tenant-scoped budget approval as %s and signals the durable workflow once',
    async (decision) => {
      const wired = await wire();
      const project = await createProject(wired);
      const created = await wired.built.app.inject({
        method: 'POST',
        url: `/v1/projects/${project.id}/runs`,
        headers: { ...wired.as(wired.owner), 'idempotency-key': `approval-run-${decision}` },
        payload: { mode: 'build', prompt: 'Reach the budget boundary', budget: { maxCredits: 100 } },
      });
      expect(created.statusCode, created.body).toBe(201);
      const runId = created.json<{ run: { id: string } }>().run.id;
      const run = wired.data.runs.find((row) => row.id === runId);
      if (run === undefined) throw new Error('seeded run disappeared');
      wired.data.runs.splice(wired.data.runs.indexOf(run), 1, {
        ...run,
        status: 'waiting_for_approval',
      });
      const approvalId = newId('appr');
      const approval: Approval = {
        id: approvalId,
        organizationId: wired.organizationId,
        runId,
        taskId: null,
        type: 'budget_increase',
        status: 'pending',
        requestJson: {
          currentCeiling: '100.0000',
          absoluteCeiling: '200.0000',
          workspaceId: 'workspace-ar14',
          reason: 'run_budget_exhausted',
        },
        responseJson: null,
        requestedAt: wired.built.now(),
        resolvedAt: null,
        resolvedBy: null,
      };
      wired.data.approvals.push(approval);

      const response = await wired.built.app.inject({
        method: 'POST',
        url: `/v1/runs/${runId}/approvals/${approvalId}`,
        headers: {
          ...wired.as(wired.owner),
          'idempotency-key': `resolve-budget-${decision}`,
        },
        payload: { decision, reason: `${decision} by owner` },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        approval: {
          approvalId,
          status: decision,
          absoluteCeiling: '200.0000',
        },
      });
      expect(wired.modelCompletions.increases).toHaveLength(decision === 'approved' ? 1 : 0);
      expect(wired.orchestrator.signals.at(-1)).toMatchObject({
        runId,
        signal: 'budget_approval',
        approvalId,
        decision,
        ...(decision === 'approved' ? { absoluteCeiling: '200.0000' } : {}),
        reason: 'run_budget_exhausted',
      });
      expect(wired.data.approvals.find((row) => row.id === approvalId)).toMatchObject({
        status: decision,
        resolvedBy: wired.owner.userId,
      });
    },
  );

  it('does not approve a budget increase above the immutable trial plan maximum', async () => {
    const wired = await wire({ planLimits: TEST_PLAN_LIMITS });
    const project = await createProject(wired);
    const created = await wired.built.app.inject({
      method: 'POST', url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'trial-plan-cap-run' },
      payload: { mode: 'build', prompt: 'Reach plan maximum' },
    });
    const runId = created.json<{ run: { id: string } }>().run.id;
    const organization = wired.built.organizations.organizations.get(wired.organizationId);
    if (organization === undefined) throw new Error('test organization disappeared');
    wired.built.organizations.organizations.set(wired.organizationId, {
      ...organization,
      plan: 'studio',
    });
    const approvalId = newId('appr');
    wired.data.approvals.push({
      id: approvalId, organizationId: wired.organizationId, runId, taskId: null,
      type: 'budget_increase', status: 'pending',
      requestJson: { currentCeiling: '10.0000', absoluteCeiling: '20.0000', workspaceId: 'workspace-cap', reason: 'run_budget_exhausted' },
      responseJson: null, requestedAt: wired.built.now(), resolvedAt: null, resolvedBy: null,
    });
    const response = await wired.built.app.inject({
      method: 'POST', url: `/v1/runs/${runId}/approvals/${approvalId}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'trial-plan-cap-approval' },
      payload: { decision: 'approved' },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('plan_budget_exceeded');
    expect(wired.data.approvals.find((approval) => approval.id === approvalId)?.status).toBe('pending');
    expect(wired.modelCompletions.increases).toEqual([]);
  });

  it('approves an organization-credit override at the immutable plan ceiling without mutating it', async () => {
    const wired = await wire({ planLimits: TEST_PLAN_LIMITS });
    const project = await createProject(wired);
    const created = await wired.built.app.inject({
      method: 'POST', url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'credit-override-run' },
      payload: { mode: 'build', prompt: 'Wait at the organization credit boundary' },
    });
    const runId = created.json<{ run: { id: string } }>().run.id;
    const approvalId = newId('appr');
    wired.data.approvals.push({
      id: approvalId, organizationId: wired.organizationId, runId, taskId: null,
      type: 'budget_increase', status: 'pending',
      requestJson: {
        currentCeiling: '10.0000', absoluteCeiling: '10.0000', workspaceId: 'workspace-credit',
        reason: 'organization_credit_exhausted',
      },
      responseJson: null, requestedAt: wired.built.now(), resolvedAt: null, resolvedBy: null,
    });

    const response = await wired.built.app.inject({
      method: 'POST', url: `/v1/runs/${runId}/approvals/${approvalId}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'resolve-credit-override' },
      payload: { decision: 'approved' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(wired.modelCompletions.increases).toEqual([]);
    expect(wired.orchestrator.signals.at(-1)).toMatchObject({
      signal: 'budget_approval', approvalId, decision: 'approved',
      absoluteCeiling: '10.0000', reason: 'organization_credit_exhausted',
    });
  });

  it('does not resolve or audit a non-budget approval through the budget endpoint', async () => {
    const wired = await wire();
    const project = await createProject(wired);
    const created = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/runs`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'approval-type-scope-run' },
      payload: { mode: 'build', prompt: 'Reach a different approval gate' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const runId = created.json<{ run: { id: string } }>().run.id;
    const approvalId = newId('appr');
    wired.data.approvals.push({
      id: approvalId,
      organizationId: wired.organizationId,
      runId,
      taskId: null,
      type: 'production_deploy',
      status: 'pending',
      requestJson: { releaseId: 'rel_01J00000000000000000000000' },
      responseJson: null,
      requestedAt: wired.built.now(),
      resolvedAt: null,
      resolvedBy: null,
    });
    const auditCount = wired.built.audit.events.length;

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/approvals/${approvalId}`,
      headers: {
        ...wired.as(wired.owner),
        'idempotency-key': 'approval-type-scope-resolution',
      },
      payload: { decision: 'approved' },
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(wired.data.approvals.find((row) => row.id === approvalId)).toMatchObject({
      status: 'pending',
      resolvedAt: null,
      resolvedBy: null,
    });
    expect(wired.built.audit.events).toHaveLength(auditCount);
    expect(wired.orchestrator.signals).toEqual([]);
    expect(wired.modelCompletions.increases).toEqual([]);
  });
});
