import { Readable } from 'node:stream';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import {
  newId,
  type SignalRunInput,
  type StartRunInput,
} from '@zapp/contracts';
import { applyPlanDiff, type Plan } from '../../../../packages/planning-engine/src/graph.js';
import type { Workspace } from '../../../../packages/db/src/index.js';

import type { EventActivities, PendingAgentEvent } from '../../../../services/orchestrator-worker/src/activities/events.js';
import type { ApprovalActivities, RunApprovalActivities } from '../../../../services/orchestrator-worker/src/activities/approvals.js';
import type { FeatureFlagActivities } from '../../../../services/orchestrator-worker/src/activities/feature-flags.js';
import type { TaskWorkflowActivities } from '../../../../services/orchestrator-worker/src/activities/merge.js';
import type { AutonomousActivities } from '../../../../services/orchestrator-worker/src/workflows/autonomous.js';
import type { RedirectActivities } from '../../../../services/orchestrator-worker/src/workflows/redirect.js';
import { createTestTemporalOrchestrator } from '../../../../services/orchestrator-worker/src/worker.js';
import type { OrchestratorPort } from '../../../../services/control-api/src/orchestrator/port.js';
import type { PreviewProxyPort } from '../../../../services/control-api/src/routes/preview.js';
import {
  createInMemoryPreviewSessionStore,
  createInMemoryPreviewShareStore,
} from '../../../../services/control-api/src/routes/preview.js';
import type {
  ApproveReleaseMutationInput,
  DeployReleaseMutationInput,
  DeploymentResult,
  EvidenceManifest,
  ReadinessReport,
  ReleaseLookupInput,
  ReleasePort,
  ReleaseRow,
} from '../../../../services/control-api/src/routes/releases.js';
import type { BuilderPreviewSandboxPort } from '../../../../services/control-api/src/sandbox/port.js';
import { EMPTY_WORKSPACE_USAGE, InMemoryTenantData } from '../../../../services/control-api/test/support/tenant-db.js';
import { evaluateReadiness } from '../../../../services/release-service/src/release/readiness.js';
import {
  DEPLOYMENT_STAGES,
  executeDeployWorkflow,
  type DeployWorkflowActivities,
} from '../../../../services/release-service/src/workflows/deploy.js';

export const E1_ORGANIZATION_ID = 'org_01K27Q9C2W85CMN1V9S6Q3D4FD';
export const E1_ORGANIZATION_NAME = 'Alpha Org';

const deployedUrl = 'https://clinic.example.test';
const workflowPath = new URL(
  '../../../../services/orchestrator-worker/src/workflows/run.ts',
  import.meta.url,
).pathname;

function heldEventStream(signal: AbortSignal): AsyncIterable<Uint8Array> {
  const stream = new Readable({
    read() {
      // The provider adapter has no capture events, but keeps the authenticated bridge open.
    },
  });
  signal.addEventListener('abort', () => { stream.push(null); }, { once: true });
  return stream;
}

const previewProxy: PreviewProxyPort = {
  request(input) {
    if (input.path === '/__zapp/events') {
      return Promise.resolve({
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: heldEventStream(input.signal),
      });
    }
    return Promise.resolve({
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Readable.from([Buffer.from('<h1>Authenticated clinic preview</h1>', 'utf8')]),
    });
  },
  openWebSocket(_input, downstream) {
    downstream.close();
    return Promise.resolve();
  },
};

const builderPreviewSandbox: BuilderPreviewSandboxPort = {
  readDevServerLogs() {
    return Promise.resolve({
      entries: [],
      failureId: null,
      nextCursor: 0,
      state: 'ready',
      truncated: false,
    });
  },
  restartDevServer() {
    return Promise.resolve({
      port: 3000,
      pid: 42,
      state: 'ready',
      supervisorId: 'e1-preview-supervisor',
    });
  },
};

function clearArray(value: unknown): void {
  if (Array.isArray(value)) value.length = 0;
}

interface DeploymentEvent {
  readonly stage: (typeof DEPLOYMENT_STAGES)[number];
  readonly status: 'running' | 'passed' | 'failed';
  readonly elapsedMs: number;
  readonly summary: string;
  readonly evidenceArtifactId?: string;
  readonly occurredAt: string;
}

class E1ReleasePort implements ReleasePort {
  readonly deploys: DeployReleaseMutationInput[] = [];
  readonly releases = new Map<string, ReleaseRow>();
  readonly deploymentId = newId('dep');
  readonly deploymentEvents: DeploymentEvent[] = [];
  deploymentStatus: 'queued' | 'deploying' | 'healthy' | 'failed' = 'queued';

  reset(): void {
    this.deploys.length = 0;
    this.releases.clear();
    this.deploymentEvents.length = 0;
    this.deploymentStatus = 'queued';
  }

  seed(row: ReleaseRow): void {
    this.releases.set(row.id, row);
  }

  createReleaseCandidate(): Promise<ReleaseRow> {
    return Promise.reject(new Error('the autonomous workflow creates its release candidate'));
  }

  getRelease(input: ReleaseLookupInput): Promise<ReleaseRow | undefined> {
    const row = this.releases.get(input.releaseId);
    return Promise.resolve(row?.organizationId === input.organizationId ? row : undefined);
  }

  getReadiness(input: ReleaseLookupInput): Promise<ReadinessReport> {
    const release = this.releases.get(input.releaseId);
    if (release === undefined || release.organizationId !== input.organizationId) {
      return Promise.reject(new Error('release missing'));
    }
    const commitSha = release.commitSha;
    const { state, findings } = evaluateReadiness({
      releaseId: release.id,
      commitSha,
      supportLevel: 'compatible',
      contract: {
        version: 1,
        package_manager: 'pnpm',
        workspace_root: '.',
        install: { command: 'pnpm install' },
        develop: { command: 'pnpm dev', port: 3000 },
        build: { command: 'pnpm build' },
        start: { command: 'pnpm start' },
        test: { browser: 'pnpm test:browser' },
        health: { path: '/health' },
      },
      deploymentPlan: {
        providerId: 'fly',
        rationale: 'The provider adapter executes the accepted deployment contract.',
        requiredEnvVars: [],
      },
      detectedEnvironmentReads: [],
      targetEnvironmentVariableNames: [],
      productionBuild: { commitSha, status: 'passed', detail: 'Production build passed.' },
      productionStart: { commitSha, status: 'passed', detail: 'Production start passed.' },
      lockfileConsistency: { commitSha, status: 'passed', detail: 'Frozen install passed.' },
      database: {
        required: false,
        connectivity: 'not_applicable',
        migrationValidation: 'not_applicable',
        destructiveMigrationApproval: 'not_required',
      },
      providerCompatibility: {
        providerId: 'fly',
        compatible: true,
        reasons: ['The fixture uses the real release policy with a fake Fly provider adapter.'],
      },
      criticalBrowserFlows: {
        commitSha,
        results: [{ id: 'appointment-booking', status: 'passed', detail: 'Browser flow passed.' }],
      },
      verification: {
        commitSha,
        decision: 'approved',
        blockingRiskSummaries: [],
        warningRiskSummaries: [],
      },
    });
    if (release.status === 'candidate') {
      this.releases.set(release.id, { ...release, status: 'verifying' });
      this.releases.set(release.id, { ...release, status: state });
    }
    return Promise.resolve({ state, findings });
  }

  approve(input: ApproveReleaseMutationInput): Promise<ReleaseRow> {
    const row = this.releases.get(input.releaseId);
    if (row === undefined || row.organizationId !== input.organizationId) {
      return Promise.reject(new Error('release missing'));
    }
    if (row.status !== 'ready' && row.status !== 'warnings') {
      return Promise.reject(new Error(`release status ${row.status} cannot be approved`));
    }
    const approved = { ...row, status: 'approved' as const };
    this.releases.set(approved.id, approved);
    return Promise.resolve(approved);
  }

  async deploy(input: DeployReleaseMutationInput): Promise<DeploymentResult> {
    const release = this.releases.get(input.releaseId);
    if (release === undefined || release.organizationId !== input.organizationId) {
      throw new Error('release missing');
    }
    if (release.status !== 'approved') {
      throw new Error(`release status ${release.status} cannot be deployed`);
    }
    this.releases.set(release.id, { ...release, status: 'deploying' });
    this.deploys.push(input);
    let clock = Date.parse('2026-08-12T12:02:00.000Z');
    const activities: DeployWorkflowActivities = {
      transitionDeploymentStatus: (transition) => {
        if (this.deploymentStatus !== transition.from) {
          return Promise.reject(new Error('deployment status transition mismatch'));
        }
        this.deploymentStatus = transition.to;
        return Promise.resolve();
      },
      emitDeploymentUpdated: (update) => {
        this.deploymentEvents.push({
          stage: update.payload.stage,
          status: update.payload.status,
          elapsedMs: update.payload.elapsedMs,
          summary: update.payload.summary,
          ...(update.payload.evidenceArtifactId === undefined
            ? {}
            : { evidenceArtifactId: update.payload.evidenceArtifactId }),
          occurredAt: new Date(clock).toISOString(),
        });
        clock += 10;
        return Promise.resolve();
      },
      verifyMigrationPlan: () => Promise.reject(new Error('no migration plan is declared')),
      executeDeploymentStage: (stage) => Promise.resolve({
        summary: `${stage.stage} passed through the Fly provider adapter.`,
        ...(stage.stage === 'production_health_check'
          ? { evidenceArtifactId: newId('art') }
          : {}),
      }),
    };
    await executeDeployWorkflow(
      {
        organizationId: input.organizationId,
        projectId: release.projectId,
        environmentId: release.environmentId,
        releaseId: release.id,
        deploymentId: this.deploymentId,
        operationKey: input.operationKey,
        migrationPlan: null,
      },
      activities,
      () => clock,
    );
    this.releases.set(release.id, { ...release, status: 'healthy' });
    return { deploymentId: this.deploymentId };
  }

  rollback(): Promise<DeploymentResult> {
    return Promise.reject(new Error('rollback is outside the E1 journey'));
  }

  getEvidence(): Promise<EvidenceManifest> {
    return Promise.reject(new Error('release evidence is outside the E1 journey'));
  }

  listProjectHistory(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly cursor: string | null;
    readonly limit: number;
  }) {
    return Promise.resolve({
      items: [...this.releases.values()]
        .filter((release) =>
          release.organizationId === input.organizationId && release.projectId === input.projectId)
        .slice(0, input.limit)
        .map((release) => ({
          id: release.id,
          projectId: release.projectId,
          environmentId: release.environmentId,
          commitSha: release.commitSha,
          status: release.status,
          createdBy: release.createdBy,
          supportLevel: 'compatible' as const,
          activeProduction: this.deploymentStatus === 'healthy',
          createdAt: release.createdAt.toISOString(),
          deployments: [],
          evidence: { artifactId: newId('art'), href: `/v1/releases/${release.id}/evidence` },
        })),
      rollbackTargets: [],
      nextCursor: null,
    });
  }

  getDeploymentProgress(input: { readonly organizationId: string; readonly deploymentId: string }) {
    const release = [...this.releases.values()].find(
      (candidate) => candidate.organizationId === input.organizationId,
    );
    if (release === undefined || input.deploymentId !== this.deploymentId) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      deploymentId: this.deploymentId,
      releaseId: release.id,
      projectId: release.projectId,
      environmentId: release.environmentId,
      status: this.deploymentStatus,
      url: this.deploymentStatus === 'healthy' ? deployedUrl : null,
      events: this.deploymentEvents.map((entry, sequence) => ({
        sequence,
        stage: entry.stage,
        status: entry.status,
        elapsedMs: entry.elapsedMs,
        summary: entry.summary,
        evidenceArtifactId: entry.evidenceArtifactId ?? null,
        occurredAt: entry.occurredAt,
      })),
      terminalSuccess: this.deploymentStatus === 'healthy'
        ? {
            status: 'succeeded' as const,
            permanentUrl: deployedUrl,
            release: { id: release.id, commitSha: release.commitSha },
            evidence: { statusLink: `/v1/releases/${release.id}/evidence` },
            productionHealth: { status: 'healthy' as const },
            monitoring: {
              grafanaDashboardLinks: [],
              faroAppLink: 'https://grafana.example.test/faro',
              posthogAnnotationLink: 'https://posthog.example.test/release',
            },
            customDomainAction: {
              method: 'POST' as const,
              href: `/v1/projects/${release.projectId}/domains`,
            },
            previousHealthyRelease: null,
            previewChanges: {
              requireRedeploy: true as const,
              note: 'Preview changes require a new release and redeploy before they reach production.' as const,
            },
          }
        : null,
    });
  }
}

const specificationContent = {
  problem: 'Patients need warm appointment booking.',
  targetUsers: ['Patients'],
  goals: ['Book appointments'],
  nonGoals: ['Do not replace clinical records.'],
  journeys: ['Book appointment'],
  pagesRoutes: ['/'],
  rolesPermissions: ['Patients can book appointments.'],
  dataModel: ['Appointment'],
  integrations: ['No external integrations in the first release.'],
  functionalRequirements: ['Patients can choose and confirm an appointment.'],
  nonfunctionalRequirements: ['The booking flow is keyboard accessible.'],
  acceptanceCriteria: [{
    id: 'AC-1',
    text: 'A patient can confirm an appointment.',
    priority: 'critical' as const,
    criticalFlow: true,
  }],
  assumptions: ['Clinic availability is supplied by the provider adapter.'],
  risks: ['Availability can change before confirmation.'],
  definitionOfDone: ['AC-1 passes in the browser.'],
};

export async function createE1Composition(options: { readonly appBaseUrl: URL }) {
  const data = new InMemoryTenantData();
  const releasePort = new E1ReleasePort();
  const starts: StartRunInput[] = [];
  const signals: SignalRunInput[] = [];
  const eventErrors: string[] = [];
  const taskPrompts = new Map<string, string>();
  const previewShares = createInMemoryPreviewShareStore();
  const previewSessions = createInMemoryPreviewSessionStore();
  const environment = await TestWorkflowEnvironment.createLocal();
  const taskQueue = `e1-journey-${Date.now().toString(36)}`;
  const phaseId = newId('phase');
  const firstTaskId = newId('task');
  const iterationTaskId = newId('task');
  const specificationVersionId = newId('spec');
  let planArtifactId = newId('art');
  const releaseId = newId('rel');
  const evidenceArtifactId = newId('art');
  const finalCommitSha = 'c'.repeat(40);
  const eventKeys = new Set<string>();
  const approvalKeys = new Map<string, string>();
  const workflowOutcomes: unknown[] = [];
  let releaseFirstTask: (() => void) | undefined;
  let firstTaskBlocked = false;

  const plan: Plan = {
    phases: [{
      id: phaseId,
      sequence: 1,
      title: 'Build appointment booking',
      acceptanceCriteria: ['AC-1'],
      approvalAfter: false,
      optional: false,
    }],
    tasks: [
      {
        id: firstTaskId,
        phaseId,
        title: 'Build the appointment booking interface',
        dependsOn: [],
        riskLevel: 'medium',
        requiredTools: ['read_file', 'apply_patch'],
        expectedFiles: ['src/app.tsx', 'src/app.css'],
        acceptanceCriteriaIds: ['AC-1'],
        requiredTests: ['src/app.test.tsx'],
        estimate: { credits: 5, wallClockMinutes: 10 },
      },
      {
        id: iterationTaskId,
        phaseId,
        title: 'Polish the appointment confirmation',
        dependsOn: [firstTaskId],
        riskLevel: 'low',
        requiredTools: ['read_file', 'apply_patch'],
        expectedFiles: ['src/app.tsx'],
        acceptanceCriteriaIds: ['AC-1'],
        requiredTests: ['src/app.test.tsx'],
        estimate: { credits: 5, wallClockMinutes: 10 },
      },
    ],
    budget: { credits: 10, wallClockHours: 1 },
  };

  function appendEvents(events: readonly PendingAgentEvent[]): void {
    for (const pending of events) {
      if (eventKeys.has(pending.eventKey)) continue;
      eventKeys.add(pending.eventKey);
      const sequence = data.events.filter(({ runId }) => runId === pending.runId).length + 1;
      data.events.push({
        id: newId('evt'),
        organizationId: pending.organizationId,
        projectId: pending.projectId,
        runId: pending.runId,
        sequence,
        type: pending.type,
        visibility: pending.visibility,
        occurredAt: new Date(pending.occurredAt),
        phaseId: pending.phaseId ?? null,
        taskId: pending.taskId ?? null,
        agentId: pending.agentId ?? null,
        payloadJson: pending.payload,
      });
    }
  }

  const eventActivities: EventActivities = {
    emitEvents(input) {
      appendEvents(input.events);
      return Promise.resolve();
    },
    transitionRunStatus(input) {
      const run = data.runs.find(({ id }) => id === input.runId);
      if (run === undefined) return Promise.reject(new Error('run status target missing'));
      run.status = input.status;
      if (input.status === 'completed') run.completedAt = new Date();
      return Promise.resolve();
    },
    storeAssistantContent() {
      return Promise.reject(new Error('the E1 journey stores only structured conversation cards'));
    },
  };

  const runApprovalActivities: RunApprovalActivities = {
    requestRunApproval(input) {
      const existing = approvalKeys.get(input.idempotencyKey);
      const approvalId = existing ?? newId('appr');
      approvalKeys.set(input.idempotencyKey, approvalId);
      if (!data.approvals.some(({ id }) => id === approvalId)) {
        data.approvals.push({
          id: approvalId,
          organizationId: input.organizationId,
          runId: input.runId,
          taskId: null,
          type: input.kind,
          status: 'pending',
          requestJson: {
            artifactId: input.artifactId,
            artifactVersion: input.artifactVersion,
          },
          responseJson: null,
          requestedAt: new Date(),
          resolvedAt: null,
          resolvedBy: null,
        });
      }
      return Promise.resolve({ approvalId });
    },
  };

  const approvalActivities: ApprovalActivities = {
    estimateRunCost: () => Promise.resolve({ estimatedCredits: '10.0000' }),
    requestBudgetIncrease: () => Promise.reject(new Error('E1 does not exhaust its budget')),
    checkpointBudgetStop: () => Promise.reject(new Error('E1 does not stop for budget')),
  };

  const featureFlagActivities: FeatureFlagActivities = {
    evaluateFeatureFlag: () => Promise.resolve({ enabled: true }),
  };

  const autonomousActivities: AutonomousActivities = {
    conductInterview: () => Promise.resolve({
      interviewArtifactId: newId('art'),
      status: 'executable',
    }),
    createSpecificationDraft(input) {
      const run = data.runs.find(({ id }) => id === input.runId);
      if (run === undefined) return Promise.reject(new Error('specification run missing'));
      if (!data.specifications.some(({ id }) => id === specificationVersionId)) {
        data.specifications.push({
          id: specificationVersionId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          version: 1,
          status: 'draft',
          contentJson: specificationContent,
          createdBy: run.startedBy,
          approvedBy: null,
          approvedAt: null,
        });
      }
      return Promise.resolve({
        specificationVersionId,
        version: 1,
        contentEtag: `sha256:${'d'.repeat(64)}`,
      });
    },
    approveSpecification(input) {
      const specification = data.specifications.find(({ id }) => id === input.specificationVersionId);
      const run = data.runs.find(({ id }) => id === input.runId);
      if (specification === undefined || run === undefined) {
        return Promise.reject(new Error('approved specification missing'));
      }
      specification.status = 'approved';
      specification.approvedBy = run.startedBy;
      specification.approvedAt = new Date();
      return Promise.resolve({
        specificationVersionId: input.specificationVersionId,
        version: input.version,
        status: 'approved',
      });
    },
    producePlan: () => Promise.resolve({ planArtifactId, plan }),
    approvePlan(input) {
      if (data.phases.length === 0) {
        data.phases.push({
          id: phaseId,
          organizationId: input.organizationId,
          runId: input.runId,
          sequence: 1,
          title: plan.phases[0]?.title ?? 'Build appointment booking',
          status: 'queued',
          acceptanceCriteriaJson: ['AC-1'],
        });
        for (const task of plan.tasks) {
          data.tasks.push({
            id: task.id,
            organizationId: input.organizationId,
            phaseId: task.phaseId,
            parentTaskId: null,
            title: task.title,
            status: 'queued',
            riskLevel: task.riskLevel,
            baseCommitSha: null,
            outputCommitSha: null,
            acceptanceCriteriaJson: task.acceptanceCriteriaIds,
            dependenciesJson: task.dependsOn,
            assignedAgentRole: 'builder',
          });
        }
      }
      return Promise.resolve({ planArtifactId: input.planArtifactId, status: 'approved' });
    },
    resolveIntegrationHead: () => Promise.resolve({ commitSha: finalCommitSha }),
    repairPhase: () => Promise.reject(new Error('E1 phase verification passes')),
    transitionPhaseTasks(input) {
      const selected = new Set(input.taskIds);
      for (const task of data.tasks) {
        if (selected.has(task.id)) task.status = input.status;
      }
      return Promise.resolve();
    },
    checkpointPhase(input) {
      const phase = data.phases.find(({ id }) => id === input.phaseId);
      if (phase !== undefined) phase.status = 'completed';
      return Promise.resolve({ checkpointRef: `checkpoint:${input.phaseId}:${input.commitSha}` });
    },
    createFinalEvidence(input) {
      const run = data.runs.find(({ id }) => id === input.runId);
      const production = data.environments.find(
        ({ projectId, type }) => projectId === input.projectId && type === 'production',
      );
      if (run === undefined || production === undefined) {
        return Promise.reject(new Error('release identity missing'));
      }
      releasePort.seed({
        id: releaseId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: production.id,
        commitSha: input.commitSha,
        specificationId: specificationVersionId,
        status: 'candidate',
        evidenceManifestArtifactId: evidenceArtifactId,
        createdBy: run.startedBy,
        createdAt: new Date(),
      });
      return Promise.resolve({
        releaseId,
        evidenceArtifactId,
        commitSha: input.commitSha,
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        specificationVersionId: input.specificationVersionId,
        planArtifactId: input.planArtifactId,
      });
    },
  };

  const taskActivities: TaskWorkflowActivities = {
    recordBaseCommit: () => Promise.resolve({ baseCommitSha: '0'.repeat(40) }),
    createTaskWorkspace(input) {
      const existing = data.workspaces.find(({ taskId }) => taskId === input.taskId);
      if (existing !== undefined) {
        return Promise.resolve({ workspaceId: existing.id, workspacePath: `/tmp/${existing.id}` });
      }
      const run = data.runs.find(({ id }) => id === input.runId);
      if (run === undefined) return Promise.reject(new Error('workspace run missing'));
      const workspace: Workspace = {
        id: newId('ws'),
        organizationId: input.organizationId,
        projectId: input.projectId,
        branchId: run.branchId,
        provider: 'modal',
        providerWorkspaceId: `provider-${input.taskId}`,
        status: 'active',
        resourceProfile: 'standard',
        runId: input.runId,
        taskId: input.taskId,
        purpose: 'builder',
        environment: 'zapp-dev',
        imageTag: 'e1-fixture',
        previewMonitorEnabled: false,
        previewMonitorOwnerId: null,
        previewMonitorLeaseExpiresAt: null,
        snapshotRef: null,
        ...EMPTY_WORKSPACE_USAGE,
        createdAt: new Date(),
        lastActiveAt: new Date(),
        terminatedAt: null,
      };
      data.workspaces.push(workspace);
      return Promise.resolve({ workspaceId: workspace.id, workspacePath: `/tmp/${workspace.id}` });
    },
    transitionTaskState(input) {
      const task = data.tasks.find(({ id }) => id === input.taskId);
      if (task !== undefined) task.status = input.status;
      return Promise.resolve();
    },
    async runTaskBuilderSession(input) {
      taskPrompts.set(input.taskId, input.prompt);
      if (input.taskId === firstTaskId) {
        const workspace = data.workspaces.find(({ id }) => id === input.workspaceId);
        appendEvents([
          {
            eventKey: `${input.runId}:${input.taskId}:provider-tool`,
            organizationId: input.organizationId,
            projectId: input.projectId,
            runId: input.runId,
            phaseId,
            taskId: input.taskId,
            agentId: 'builder',
            occurredAt: new Date().toISOString(),
            type: 'tool.completed',
            visibility: 'user',
            payload: { tool: 'write_file', userSummary: 'Built appointment booking' },
          },
          {
            eventKey: `${input.runId}:${input.taskId}:preview-ready`,
            organizationId: input.organizationId,
            projectId: input.projectId,
            runId: input.runId,
            phaseId,
            taskId: input.taskId,
            agentId: 'builder',
            occurredAt: new Date().toISOString(),
            type: 'preview.ready',
            visibility: 'user',
            payload: { workspaceId: workspace?.id ?? input.workspaceId },
          },
        ]);
        firstTaskBlocked = true;
        await new Promise<void>((resolve) => { releaseFirstTask = resolve; });
        firstTaskBlocked = false;
      }
      return { status: 'completed' };
    },
    commitAndPushTask(input) {
      return Promise.resolve({ commitSha: input.taskId === firstTaskId ? 'a'.repeat(40) : 'b'.repeat(40) });
    },
    mergeTask: () => Promise.resolve({ outcome: 'merged' }),
    createConflictTask: () => Promise.reject(new Error('E1 has no merge conflict')),
    emitTaskBlocked: () => Promise.reject(new Error('E1 has no blocked task')),
  };

  const redirectActivities: RedirectActivities = {
    pauseRedirectTasks(input) {
      return Promise.resolve({ pausedTaskIds: input.affectedTaskIds });
    },
    resumeRedirectTasks(input) {
      return Promise.resolve({ resumedTaskIds: input.taskIds });
    },
    produceRedirectPlanDiff(input) {
      const target = input.currentPlan.tasks.find(({ id }) => id === iterationTaskId);
      if (target === undefined) return Promise.reject(new Error('iteration task missing'));
      return Promise.resolve({
        planDiffArtifactId: newId('art'),
        planDiff: {
          addedTasks: [],
          removedTaskIds: [],
          modifiedTasks: [{ ...target, title: input.instruction }],
          supersededTaskIds: [],
          impact: { scope: false, costDelta: false, archChange: false, dataChange: false },
        },
      });
    },
    applyRedirectPlanDiff(input) {
      const next = applyPlanDiff(input.currentPlan, input.planDiff);
      const changed = next.tasks.find(({ id }) => id === iterationTaskId);
      const row = data.tasks.find(({ id }) => id === iterationTaskId);
      if (changed !== undefined && row !== undefined) row.title = changed.title;
      planArtifactId = newId('art');
      return Promise.resolve({ planArtifactId, plan: next, supersededTasks: [] });
    },
    revalidateRedirectedTasks: () => Promise.reject(new Error('no completed task is redirected')),
    checkpointRedirect(input) {
      return Promise.resolve({ checkpointRef: `redirect:${input.planDiffArtifactId}` });
    },
  };

  const mainWorker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath: workflowPath,
    activities: {
      ...eventActivities,
      ...runApprovalActivities,
      ...approvalActivities,
      ...featureFlagActivities,
      ...autonomousActivities,
      ...taskActivities,
      ...redirectActivities,
    },
  });
  const verificationWorker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: 'verification',
    workflowsPath: workflowPath,
    activities: {
      verifyPhase: () => Promise.resolve({
        verificationResultId: newId('vr'),
        decision: 'approved',
        criteriaResults: [{}],
        risks: [],
      }),
    },
  });
  const workerRuns = [mainWorker.run(), verificationWorker.run()];
  const temporal = createTestTemporalOrchestrator({ client: environment.client, taskQueue });

  const orchestrator: OrchestratorPort = {
    async startRun(input) {
      starts.push(input);
      const project = data.projects.find(({ id }) => id === input.projectId);
      const run = data.runs.find(({ id }) => id === input.runId);
      if (project === undefined || run === undefined) {
        throw new Error('run dispatch preceded durable project state');
      }
      await temporal.startRun(input);
      void environment.client.workflow.getHandle(input.workflowId).result().then(
        (result) => { workflowOutcomes.push(result); },
        (error: unknown) => {
          eventErrors.push(error instanceof Error ? error.message : String(error));
        },
      );
    },
    async signalRun(input) {
      signals.push(input);
      const result = await temporal.signalRun(input);
      if (input.signal === 'redirect' && firstTaskBlocked) releaseFirstTask?.();
      return result;
    },
  };

  return {
    data,
    orchestrator,
    releasePort,
    builderPreviewSandbox,
    builderPreviewProxy: previewProxy,
    preview: {
      shares: previewShares,
      sessions: previewSessions,
      proxy: previewProxy,
      signingKey: Buffer.alloc(32, 0x42),
      keyVersion: 1,
      appBaseUrl: options.appBaseUrl,
      previewBaseDomain: 'preview.e1.test',
    },
    reset(): void {
      for (const value of Object.values(data)) clearArray(value);
      data.runAccounting.clear();
      data.specificationLocks.clear();
      data.runCreateLocks.clear();
      data.capabilityScanLocks.clear();
      data.githubConnectLocks.clear();
      data.githubImportLocks.clear();
      data.specificationOperations.clear();
      data.operations.clear();
      data.ciphertexts.clear();
      previewShares.rows.length = 0;
      releasePort.reset();
      starts.length = 0;
      signals.length = 0;
      eventErrors.length = 0;
      workflowOutcomes.length = 0;
      taskPrompts.clear();
      eventKeys.clear();
      approvalKeys.clear();
    },
    recordEventError(error: Error): void {
      eventErrors.push(error.message);
    },
    status() {
      return {
        starts: starts.map(({ mode, prompt }) => ({ mode, prompt })),
        signals: signals.map(({ signal }) => ({ signal })),
        deploys: releasePort.deploys.map(({ releaseId: deployedReleaseId }) => ({ releaseId: deployedReleaseId })),
        deploymentStages: releasePort.deploymentEvents
          .filter(({ status }) => status === 'passed')
          .map(({ stage }) => stage),
        taskPrompts: [...taskPrompts].map(([taskId, prompt]) => ({ taskId, prompt })),
        workflowOutcomes,
        eventErrors,
      };
    },
    async close(): Promise<void> {
      mainWorker.shutdown();
      verificationWorker.shutdown();
      await Promise.all(workerRuns);
      await environment.teardown();
    },
  };
}
