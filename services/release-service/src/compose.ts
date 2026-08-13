import { createHash } from 'node:crypto';

import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import type { Database } from '@zapp/db';
import {
  EvidenceManifestSchema,
  assembleEvidenceManifest,
  type ReleaseEvidenceCandidate,
} from '@zapp/verification-engine';
import { z } from 'zod';

import { createPostgresDeploymentProgress, type DeploymentActionDispatcher } from './deployment-progress.js';
import { createPostgresDomainPort } from './domain-store.js';
import type { DomainDependencies } from './domains/service.js';
import { createPostgresReleaseHistory } from './history.js';
import {
  AnnotationRecordSchema,
  createPostgresProductionProjection,
  type ProductionProjectionPort,
} from './production-history.js';

import { buildApp, type LoggerConfig } from './app.js';
import {
  createReleaseLifecycleService,
  DeploymentResultSchema,
  ForkReleaseResultSchema,
  type ReleaseLifecycleDependencies,
  type DeployReleaseInput,
  type ForkReleaseInput,
  type RollbackReleaseInput,
} from './lifecycle.js';
import {
  createPostgresReleaseContext,
  createPostgresReleaseStore,
  createReleaseRecordService,
  type ReleaseContextPort,
  type Release,
  type ReleaseGitPort,
} from './release/create.js';
import { evaluateReadiness, ReadinessReportSchema } from './release/readiness.js';
import { ProductionHealthResultSchema, selectProductionSafeFlows } from './release/health.js';
import { createRollbackService, type RollbackDependencies } from './rollback/service.js';
import {
  createSyntheticRunner,
  SyntheticRunResultSchema,
  type SyntheticRunnerDependencies,
} from './synthetics/runner.js';
import {
  createSyntheticScheduler,
  ScheduleManagedReleaseInputSchema,
  type SyntheticSchedulerDependencies,
} from './synthetics/scheduler.js';
import { DeployWorkflowInputSchema, DeployWorkflowResultSchema } from './workflows/deploy.js';

export interface ReleaseServiceRuntime {
  readonly database: Database;
  readonly serviceTokens: ServiceTokenConfig;
  readonly git: ReleaseGitPort;
  readonly context?: ReleaseContextPort;
  readonly lifecycle: Omit<ReleaseLifecycleDependencies, 'records'>;
  readonly deploymentActions?: DeploymentActionDispatcher;
  readonly domains?: Pick<DomainDependencies, 'dns' | 'provider'>;
  readonly now?: () => Date;
  readonly logger?: LoggerConfig;
}

const ProductionDeploymentPlanSchema = z
  .object({
    workflow: DeployWorkflowInputSchema,
    synthetics: ScheduleManagedReleaseInputSchema,
  })
  .strict();

const RepairBranchSchema = ForkReleaseResultSchema.pick({
  releaseId: true,
  branchId: true,
  branchName: true,
});
const FixRunSchema = z.object({ runId: ForkReleaseResultSchema.shape.fixRunId.unwrap() }).strict();

/**
 * Raw shipping seams. This deliberately does not accept a prebuilt lifecycle:
 * the composition below binds the DEP-2 evaluator, DEP-6 workflow boundary,
 * VF-15 assembler, DEP-9 rollback state machine, and DEP-11 scheduler/runner.
 */
export interface ReleaseProductionBindings {
  readonly actions: DeploymentActionDispatcher;
  readonly domains: Pick<DomainDependencies, 'dns' | 'provider'>;
  readonly readiness: { load(release: Release): Promise<unknown> };
  readonly deployment: {
    prepare(release: Release, input: DeployReleaseInput): Promise<unknown>;
  };
  readonly temporal: { deploy(input: z.infer<typeof DeployWorkflowInputSchema>): Promise<unknown> };
  readonly evidence: {
    load(release: Release): Promise<ReleaseEvidenceCandidate>;
    redact(value: string): string;
  };
  readonly rollback: RollbackDependencies;
  readonly repair: {
    createBranch(release: Release, input: ForkReleaseInput): Promise<unknown>;
    startFixRun(release: Release, input: ForkReleaseInput): Promise<unknown>;
  };
  readonly synthetics: {
    scheduler: SyntheticSchedulerDependencies;
    runner: SyntheticRunnerDependencies;
  };
  readonly projection: {
    loadHealth(release: Release, deploymentId: string): Promise<unknown>;
    loadAnnotations(release: Release, deploymentId: string): Promise<unknown>;
  };
}

export interface ProductionReleaseServiceRuntime extends Omit<ReleaseServiceRuntime, 'lifecycle'> {
  readonly production: ReleaseProductionBindings;
}

export interface ReleaseGitClient extends ReleaseGitPort {
  createBranch(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly name: string;
    readonly fromSha: string;
  }): Promise<void>;
}

export function createReleaseGitClient(options: {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): ReleaseGitClient {
  const baseUrl = z.string().url().parse(options.baseUrl).replace(/\/+$/u, '');
  const signer = createServiceTokenSigner(options.serviceTokens);
  const requestFetch = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const { token } = await signer.signServiceToken({
      service: 'release-service',
      aud: 'git-service',
    });
    return await requestFetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-zapp-service-token': token,
      },
      signal: AbortSignal.timeout(15_000),
    });
  }

  function repositoryPath(input: { organizationId: string; projectId: string }): string {
    return `/internal/git/repositories/${encodeURIComponent(input.organizationId)}/${encodeURIComponent(input.projectId)}`;
  }

  function expectMutation(response: Response, operation: string): void {
    if (response.status === 201) return;
    throw new Error(`git_service_${operation}_refused:${String(response.status)}`);
  }

  return {
    async getCommit(input) {
      const response = await request(
        `${repositoryPath(input)}/commits/${encodeURIComponent(input.sha)}`,
      );
      if (response.status === 404) return false;
      if (!response.ok) {
        throw new Error(`git_service_get_commit_refused:${String(response.status)}`);
      }
      return true;
    },
    async createTag(input) {
      const response = await request(`${repositoryPath(input)}/tags`, {
        method: 'POST',
        body: JSON.stringify({ tag: input.tag, sha: input.sha }),
      });
      expectMutation(response, 'create_tag');
    },
    async createBranch(input) {
      const response = await request(`${repositoryPath(input)}/branches`, {
        method: 'POST',
        body: JSON.stringify({ name: input.name, fromSha: input.fromSha }),
      });
      expectMutation(response, 'create_branch');
    },
  };
}

function derivedOperationKey(operationKey: string, suffix: string): string {
  return `op_${createHash('sha256').update(`${operationKey}:${suffix}`).digest('hex')}`;
}

function assertDeploymentPlanIdentity(
  release: Release,
  input: DeployReleaseInput,
  plan: z.infer<typeof ProductionDeploymentPlanSchema>,
): void {
  const workflow = plan.workflow;
  const synthetics = plan.synthetics;
  if (
    workflow.organizationId !== release.organizationId ||
    workflow.projectId !== release.projectId ||
    workflow.environmentId !== release.environmentId ||
    workflow.releaseId !== release.id ||
    workflow.operationKey !== input.operationKey ||
    synthetics.organizationId !== release.organizationId ||
    synthetics.projectId !== release.projectId ||
    synthetics.environmentId !== release.environmentId ||
    synthetics.releaseId !== release.id ||
    synthetics.operationKey !== input.operationKey
  ) {
    throw new Error('release_production_plan_identity_mismatch');
  }
}

function productionLifecycle(
  records: ReturnType<typeof createReleaseRecordService>,
  production: ReleaseProductionBindings,
  projection: ProductionProjectionPort,
  now: () => Date,
): Omit<ReleaseLifecycleDependencies, 'records'> {
  const rollback = createRollbackService(production.rollback);
  const scheduler = createSyntheticScheduler(production.synthetics.scheduler);
  const runner = createSyntheticRunner({
    ...production.synthetics.runner,
    store: {
      ...production.synthetics.runner.store,
      async recordResult(input) {
        await production.synthetics.runner.store.recordResult(input);
        await projection.recordSynthetic({
          organizationId: input.organizationId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          releaseId: input.releaseId,
          syntheticCheckId: input.syntheticCheckId,
          status: input.status,
          summary: input.summary,
          evidenceArtifactIds: input.evidenceArtifactIds,
          completedAt: input.completedAt,
          retainUntil: input.retainUntil,
        });
      },
    },
  });

  return {
    readiness: {
      async evaluate(release) {
        const report = ReadinessReportSchema.parse(
          evaluateReadiness(await production.readiness.load(release)),
        );
        if (report.releaseId !== release.id || report.commitSha !== release.commitSha) {
          throw new Error('release_readiness_identity_mismatch');
        }
        if (release.status === 'candidate') {
          await records.transitionStatus({
            organizationId: release.organizationId,
            releaseId: release.id,
            to: 'verifying',
            operationKey: derivedOperationKey(release.id, 'readiness:verifying'),
          });
          await records.transitionStatus({
            organizationId: release.organizationId,
            releaseId: release.id,
            to: report.state,
            operationKey: derivedOperationKey(release.id, `readiness:${report.state}`),
          });
        }
        return report;
      },
    },
    deployments: {
      async deploy(release, input) {
        const plan = ProductionDeploymentPlanSchema.parse(
          await production.deployment.prepare(release, input),
        );
        assertDeploymentPlanIdentity(release, input, plan);
        const result = DeployWorkflowResultSchema.parse(
          await production.temporal.deploy(plan.workflow),
        );
        if (result.deploymentId !== plan.workflow.deploymentId) {
          throw new Error('release_deployment_identity_mismatch');
        }
        const health = ProductionHealthResultSchema.parse(
          await production.projection.loadHealth(release, result.deploymentId),
        );
        await projection.recordHealth({
          organizationId: release.organizationId,
          projectId: release.projectId,
          environmentId: release.environmentId,
          releaseId: release.id,
          deploymentId: result.deploymentId,
          result: health,
          occurredAt: now().toISOString(),
        });
        const annotations = z.array(AnnotationRecordSchema.omit({
          organizationId: true,
          projectId: true,
          releaseId: true,
          deploymentId: true,
        })).max(10).parse(await production.projection.loadAnnotations(release, result.deploymentId));
        for (const annotation of annotations) {
          await projection.recordAnnotation({
            organizationId: release.organizationId,
            projectId: release.projectId,
            releaseId: release.id,
            deploymentId: result.deploymentId,
            ...annotation,
          });
        }

        const scheduled = await scheduler.scheduleManagedRelease(plan.synthetics);
        const flows = selectProductionSafeFlows(plan.synthetics.criticalFlows);
        if (scheduled.length !== flows.length) {
          throw new Error('release_synthetic_schedule_mismatch');
        }
        for (const [index, check] of scheduled.entries()) {
          const flow = flows[index];
          if (flow === undefined || check.name !== flow.title) {
            throw new Error('release_synthetic_flow_mismatch');
          }
          const syntheticResult = SyntheticRunResultSchema.parse(
            await runner.run({
              organizationId: release.organizationId,
              projectId: release.projectId,
              environmentId: release.environmentId,
              releaseId: release.id,
              syntheticCheckId: check.syntheticCheckId,
              flowRef: flow.id,
              productionUrl: plan.synthetics.productionUrl,
              operationKey: `${input.operationKey}:synthetic:${check.syntheticCheckId}`,
            }),
          );
          if (syntheticResult.status !== 'passed') {
            throw new Error('release_initial_synthetic_not_passing');
          }
        }
        if (release.status === 'deploying') {
          await records.transitionStatus({
            organizationId: release.organizationId,
            releaseId: release.id,
            to: 'healthy',
            operationKey: derivedOperationKey(input.operationKey, 'release:healthy'),
          });
        }
        return DeploymentResultSchema.parse({ deploymentId: result.deploymentId });
      },
      async rollback(release, input: RollbackReleaseInput) {
        const result = await rollback.rollback({
          organizationId: release.organizationId,
          projectId: release.projectId,
          environmentId: release.environmentId,
          ...(input.toDeploymentId === null ? {} : { toDeploymentId: input.toDeploymentId }),
          reason: input.reason,
          operationKey: input.operationKey,
        });
        return DeploymentResultSchema.parse({ deploymentId: result.deploymentId });
      },
    },
    evidence: {
      async get(release) {
        return EvidenceManifestSchema.parse(
          assembleEvidenceManifest(await production.evidence.load(release), {
            redact: (value) => production.evidence.redact(value),
          }),
        );
      },
    },
    repair: {
      async fork(release, input) {
        const branch = RepairBranchSchema.parse(
          await production.repair.createBranch(release, input),
        );
        if (branch.releaseId !== release.id || branch.branchName !== `fix/rel-${release.id}`) {
          throw new Error('release_repair_branch_identity_mismatch');
        }
        const fixRunId = input.startFixRun
          ? FixRunSchema.parse(await production.repair.startFixRun(release, input)).runId
          : null;
        return ForkReleaseResultSchema.parse({ ...branch, fixRunId });
      },
    },
  };
}

/** Shipping composition: durable records plus the provider/state-machine adapters. */
export function composeApp(runtime: ReleaseServiceRuntime) {
  const records = createReleaseRecordService({
    store: createPostgresReleaseStore(runtime.database),
    context: runtime.context ?? createPostgresReleaseContext(runtime.database),
    git: runtime.git,
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
  });
  const lifecycle = createReleaseLifecycleService({ records, ...runtime.lifecycle });
  const productionHistory = createPostgresProductionProjection(runtime.database);
  return buildApp({
    records,
    lifecycle,
    history: createPostgresReleaseHistory(runtime.database),
    productionHistory,
    ...(runtime.deploymentActions === undefined
      ? {}
      : { progress: createPostgresDeploymentProgress(runtime.database, runtime.deploymentActions) }),
    ...(runtime.domains === undefined
      ? {}
      : { domains: createPostgresDomainPort(runtime.database, runtime.domains) }),
    signer: createServiceTokenSigner(runtime.serviceTokens),
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
    ...(runtime.logger === undefined ? {} : { logger: runtime.logger }),
  });
}

/** DEP-12b production composition: concrete domain implementations, durable records. */
export function composeProductionApp(runtime: ProductionReleaseServiceRuntime) {
  const records = createReleaseRecordService({
    store: createPostgresReleaseStore(runtime.database),
    context: runtime.context ?? createPostgresReleaseContext(runtime.database),
    git: runtime.git,
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
  });
  const now = runtime.now ?? (() => new Date());
  const productionHistory = createPostgresProductionProjection(runtime.database);
  const lifecycle = createReleaseLifecycleService({
    records,
    ...productionLifecycle(records, runtime.production, productionHistory, now),
  });
  return buildApp({
    records,
    lifecycle,
    history: createPostgresReleaseHistory(runtime.database),
    productionHistory,
    rollbackPreview: createRollbackService(runtime.production.rollback),
    progress: createPostgresDeploymentProgress(runtime.database, runtime.production.actions),
    domains: createPostgresDomainPort(runtime.database, runtime.production.domains),
    signer: createServiceTokenSigner(runtime.serviceTokens),
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
    ...(runtime.logger === undefined ? {} : { logger: runtime.logger }),
  });
}
