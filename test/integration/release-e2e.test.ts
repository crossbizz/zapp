import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServiceTokenSigner } from '@zapp/config';
import { newId } from '@zapp/contracts';
import {
  environments,
  memberships,
  organizations,
  projects,
  releases,
  specifications,
  users,
} from '../../packages/db/src/index.js';
import {
  GATE_IDS,
  buildCriteriaCompletionReport,
  type ReleaseEvidenceCandidate,
} from '@zapp/verification-engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createReleaseServiceClient } from '../../services/control-api/src/release/client.js';
import { ORGANIZATION_HEADER } from '../../services/control-api/src/plugins/tenant.js';
import { buildHarness, signIn } from '../../services/control-api/test/support/harness.js';
import { InMemoryTenantData } from '../../services/control-api/test/support/tenant-db.js';
import {
  composeProductionApp,
  createReleaseGitClient,
} from '../../services/release-service/src/compose.js';
import type { Release } from '../../services/release-service/src/release/create.js';
import { executeDeployWorkflow } from '../../services/release-service/src/workflows/deploy.js';
import {
  hasDatabase,
  setUpTestDatabase,
  type TestDatabase,
} from '../../packages/db/test/integration/helpers.js';

const SERVICE_TOKENS = { secret: 'release-e2e-service-secret-that-is-long-enough' };
const COMMIT_SHA = 'a'.repeat(40);
const PREVIOUS_COMMIT_SHA = 'b'.repeat(40);
const PRODUCTION_URL = 'https://release.dep12.test';

async function listenFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
) {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : 'fixture failure');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind');
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

if (!hasDatabase) {
  console.error(
    '[@zapp/release-service] DEP-12 Postgres E2E SKIPPED — not run, not passed: DATABASE_URL is unset',
  );
}

function readinessInput(release: Release) {
  return {
    releaseId: release.id,
    commitSha: release.commitSha,
    supportLevel: 'managed' as const,
    contract: {
      version: 1,
      package_manager: 'pnpm' as const,
      workspace_root: '.',
      install: { command: 'pnpm install --frozen-lockfile' },
      develop: { command: 'pnpm dev', port: 3_000 },
      build: { command: 'pnpm build' },
      start: { command: 'pnpm start' },
      test: { browser: 'pnpm test:browser' },
      health: { path: '/' },
    },
    deploymentPlan: {
      providerId: 'fly',
      rationale: 'Managed Node deployment.',
      requiredEnvVars: [],
    },
    detectedEnvironmentReads: [],
    targetEnvironmentVariableNames: [],
    productionBuild: {
      commitSha: release.commitSha,
      status: 'passed' as const,
      detail: 'Production build passed.',
    },
    productionStart: {
      commitSha: release.commitSha,
      status: 'passed' as const,
      detail: 'Production start passed.',
    },
    lockfileConsistency: {
      commitSha: release.commitSha,
      status: 'passed' as const,
      detail: 'Frozen install passed.',
    },
    database: {
      required: false,
      connectivity: 'not_applicable' as const,
      migrationValidation: 'not_applicable' as const,
      destructiveMigrationApproval: 'not_required' as const,
    },
    providerCompatibility: {
      providerId: 'fly',
      compatible: true,
      reasons: ['The provider accepts the immutable build artifact.'],
    },
    criticalBrowserFlows: {
      commitSha: release.commitSha,
      results: [{ id: 'home', status: 'passed' as const, detail: 'Home flow passed.' }],
    },
    verification: {
      commitSha: release.commitSha,
      decision: 'approved' as const,
      blockingRiskSummaries: [],
      warningRiskSummaries: [],
    },
  };
}

function evidenceCandidate(release: Release): ReleaseEvidenceCandidate {
  const gateResult = (gateId: string) => ({
    gateId,
    result: {
      status: 'passed' as const,
      evidenceArtifactIds: [`evidence-${gateId}`],
      details: { report: `${gateId} passed` },
    },
  });
  return {
    releaseId: release.id,
    commitSha: release.commitSha,
    specificationVersion: 1,
    supportLevel: 'managed',
    projectPolicy: { waivers: [] },
    gateResults: GATE_IDS.map(gateResult),
    accessibilityResult: {
      status: 'passed',
      evidenceArtifactIds: ['evidence-accessibility'],
      details: {},
    },
    criteriaCompletion: buildCriteriaCompletionReport({
      specificationVersion: 1,
      criteria: [{ criterionId: 'AC-1' }],
      tasks: [{ taskId: 'TASK-1', acceptanceCriteriaIds: ['AC-1'] }],
      testCases: [
        {
          testCaseId: 'case-1',
          name: '[AC-1] serves the release content',
          status: 'passed',
          evidenceArtifactIds: ['evidence-browser_acceptance'],
        },
      ],
    }),
    criticalCriterionIds: ['AC-1'],
    policySignals: [],
    knownRisks: [],
  };
}

describe.skipIf(!hasDatabase)('DEP-12 production release lifecycle', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await setUpTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.truncateAll();
  });

  it('runs create through rollback over public APIs with Postgres, keyed replay, Git, VF-15, and a passing synthetic', async () => {
    let productionContent = 'previous healthy release';
    let priorContent = productionContent;
    const providerMutations: string[] = [];
    const provider = await listenFixture(async (request, response) => {
      if (request.method === 'GET' && request.url === '/') {
        response.setHeader('content-type', 'text/plain');
        response.end(productionContent);
        return;
      }
      if (request.method === 'POST' && request.url === '/deploy') {
        const body = await jsonBody(request);
        priorContent = productionContent;
        productionContent = String(body['content']);
        providerMutations.push('deploy');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'ready' }));
        return;
      }
      if (request.method === 'POST' && request.url === '/rollback') {
        productionContent = priorContent;
        providerMutations.push('rollback');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'ready' }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const providerUrl = provider.baseUrl;

    const gitCalls: string[] = [];
    const git = await listenFixture(async (request, response) => {
      expect(request.headers['x-zapp-service-token']).toBeTypeOf('string');
      const path = request.url ?? '';
      if (request.method === 'GET' && path.includes('/commits/')) {
        gitCalls.push(`commit:${decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))}`);
        response.setHeader('content-type', 'application/json');
        response.end('{}');
        return;
      }
      if (request.method === 'POST' && path.endsWith('/tags')) {
        const body = await jsonBody(request);
        gitCalls.push(`tag:${String(body['tag'])}:${String(body['sha'])}`);
        response.statusCode = 201;
        response.end('null');
        return;
      }
      if (request.method === 'POST' && path.endsWith('/branches')) {
        const body = await jsonBody(request);
        gitCalls.push(`branch:${String(body['name'])}:${String(body['fromSha'])}`);
        response.statusCode = 201;
        response.end('null');
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const gitUrl = git.baseUrl;
    const gitClient = createReleaseGitClient({ baseUrl: gitUrl, serviceTokens: SERVICE_TOKENS });

    const data = new InMemoryTenantData();
    const deploymentIds = new Map<string, string>();
    const deploymentReplays = new Map<string, unknown>();
    const scheduleClaims = new Map<string, unknown>();
    const syntheticReplays = new Map<string, unknown>();
    const rollbackReplays = new Map<string, unknown>();
    const syntheticStatuses: string[] = [];
    const previousDeploymentId = newId('dep');
    const rollbackDeploymentId = newId('dep');
    const branchId = newId('br');
    const fixRunId = newId('run');
    let activeReleaseId: string | undefined;

    const releaseApp = composeProductionApp({
      logger: false,
      database: database.db,
      serviceTokens: SERVICE_TOKENS,
      git: gitClient,
      production: {
        readiness: { load: (release) => Promise.resolve(readinessInput(release)) },
        deployment: {
          prepare(release, input) {
            let deploymentId = deploymentIds.get(input.operationKey);
            if (deploymentId === undefined) {
              deploymentId = newId('dep');
              deploymentIds.set(input.operationKey, deploymentId);
            }
            return Promise.resolve({
              workflow: {
                organizationId: release.organizationId,
                projectId: release.projectId,
                environmentId: release.environmentId,
                releaseId: release.id,
                deploymentId,
                operationKey: input.operationKey,
                migrationPlan: null,
              },
              synthetics: {
                organizationId: release.organizationId,
                projectId: release.projectId,
                environmentId: release.environmentId,
                releaseId: release.id,
                supportLevel: 'managed',
                productionUrl: PRODUCTION_URL,
                operationKey: input.operationKey,
                criticalFlows: [
                  {
                    id: 'home',
                    title: 'Home page',
                    critical: true,
                    tags: ['@prod-safe'],
                    steps: [
                      { kind: 'navigate', value: '/' },
                      { kind: 'assert_text', value: 'candidate release' },
                    ],
                  },
                ],
              },
            });
          },
        },
        temporal: {
          async deploy(input) {
            const replay = deploymentReplays.get(input.operationKey);
            if (replay !== undefined) return replay;
            const result = await executeDeployWorkflow(input, {
              transitionDeploymentStatus: () => Promise.resolve(),
              emitDeploymentUpdated: () => Promise.resolve(),
              verifyMigrationPlan: () => Promise.reject(new Error('no migration plan expected')),
              async executeDeploymentStage(stage) {
                if (stage.stage === 'go_live') {
                  const response = await fetch(`${providerUrl}/deploy`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ content: 'candidate release' }),
                  });
                  if (!response.ok) throw new Error('provider fixture refused deploy');
                }
                return { summary: `${stage.stage} passed.` };
              },
            });
            deploymentReplays.set(input.operationKey, result);
            return result;
          },
        },
        evidence: {
          load: (release) => Promise.resolve(evidenceCandidate(release)),
          redact: (value) => value,
        },
        rollback: {
          context: {
            resolve: () => {
              if (activeReleaseId === undefined) throw new Error('release was not created');
              const currentDeploymentId = [...deploymentIds.values()][0];
              if (currentDeploymentId === undefined) throw new Error('deployment was not created');
              return Promise.resolve({
                current: {
                  deploymentId: currentDeploymentId,
                  releaseId: activeReleaseId,
                  commitSha: COMMIT_SHA,
                  providerId: 'fly',
                  providerDeploymentId: 'fly-app::candidate',
                  environmentConfigVersion: 'config-current',
                  permanentUrl: PRODUCTION_URL,
                },
                target: {
                  deploymentId: previousDeploymentId,
                  releaseId: newId('rel'),
                  commitSha: PREVIOUS_COMMIT_SHA,
                  providerId: 'fly',
                  providerDeploymentId: 'fly-app::previous',
                  environmentConfigVersion: 'config-previous',
                  permanentUrl: PRODUCTION_URL,
                },
                migration: { reversibility: 'reversible', compensatingPlan: null },
              });
            },
          },
          store: {
            getReplay(input) {
              return Promise.resolve(rollbackReplays.get(input.operationKey));
            },
            createRollback: () => Promise.resolve({ deploymentId: rollbackDeploymentId }),
            markHealthy: () => Promise.resolve(),
            markFailed: () => Promise.resolve(),
            completeReplay(input) {
              rollbackReplays.set(input.operationKey, input.result);
              return Promise.resolve();
            },
          },
          environmentConfig: {
            restore: (input) => Promise.resolve({ version: input.version }),
          },
          compensation: { apply: () => Promise.reject(new Error('not required')) },
          provider: {
            async rollback() {
              const response = await fetch(`${providerUrl}/rollback`, { method: 'POST' });
              if (!response.ok) throw new Error('provider fixture refused rollback');
              return {
                providerId: 'fly',
                providerDeploymentId: 'fly-app::previous',
                url: PRODUCTION_URL,
                state: 'ready',
                createdAt: '2026-08-12T20:00:00.000Z',
              };
            },
          },
          health: {
            async verify() {
              const response = await fetch(providerUrl);
              const healthy = response.ok && (await response.text()) === 'previous healthy release';
              return {
                status: healthy ? 'healthy' : 'failed',
                evidenceArtifactId: newId('art'),
                automaticRollbackAttempted: false,
                production: {
                  status: healthy ? 'passed' : 'failed',
                  healthEndpoint: {
                    status: healthy ? 'passed' : 'failed',
                    path: '/',
                    intervalMs: 10_000,
                    attempts: [
                      { statusCode: response.status },
                      { statusCode: 200 },
                      { statusCode: 200 },
                    ],
                  },
                  errorRate: {
                    status: healthy ? 'passed' : 'not_run',
                    windowMs: 120_000,
                    burstDetected: healthy ? false : null,
                    evidenceArtifactIds: [],
                  },
                  smoke: {
                    status: healthy ? 'not_applicable' : 'not_run',
                    flows: [],
                    evidenceArtifactIds: [],
                  },
                },
              };
            },
          },
          newDeploymentId: () => rollbackDeploymentId,
        },
        repair: {
          async createBranch(release) {
            const branchName = `fix/rel-${release.id}`;
            await gitClient.createBranch({
              organizationId: release.organizationId,
              projectId: release.projectId,
              name: branchName,
              fromSha: release.commitSha,
            });
            return { releaseId: release.id, branchId, branchName };
          },
          startFixRun: () => Promise.resolve({ runId: fixRunId }),
        },
        synthetics: {
          scheduler: {
            store: {
              claim(input) {
                const replay = scheduleClaims.get(input.idempotencyKey);
                if (replay !== undefined) return Promise.resolve(replay);
                const claimed = { row: input.row, binding: input.binding };
                scheduleClaims.set(input.idempotencyKey, claimed);
                return Promise.resolve(claimed);
              },
            },
            temporal: {
              ensureCronSchedule: (input) => Promise.resolve({ scheduleId: input.scheduleId }),
            },
            newSyntheticCheckId: () => newId('syn'),
          },
          runner: {
            context: {
              resolve: (input) =>
                Promise.resolve({
                  status: 'enabled',
                  releaseId: input.releaseId,
                  flowRef: input.flowRef,
                  productionUrl: input.productionUrl,
                }),
            },
            store: {
              getReplay: (input) => Promise.resolve(syntheticReplays.get(input.operationKey)),
              recordResult: () => Promise.resolve(),
              updateHealth(input) {
                syntheticStatuses.push(input.status);
                return Promise.resolve();
              },
              completeReplay(input) {
                syntheticReplays.set(input.operationKey, input.result);
                return Promise.resolve();
              },
            },
            verification: {
              async runProductionSafeFlow() {
                const response = await fetch(providerUrl);
                const passed = response.ok && (await response.text()) === 'candidate release';
                return {
                  status: passed ? 'passed' : 'failed',
                  summary: passed ? 'Candidate content served.' : 'Candidate content missing.',
                  evidenceArtifactIds: [newId('art')],
                };
              },
            },
            incident: { emit: () => Promise.reject(new Error('not expected')) },
            notifications: { send: () => Promise.reject(new Error('not expected')) },
            fixes: { offer: () => Promise.reject(new Error('not expected')) },
            now: () => new Date('2026-08-12T20:00:00.000Z'),
          },
        },
      },
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
        externalId: 'release-production-owner',
        email: 'owner@release-production.test',
        displayName: 'Release Owner',
      });
      const organizationResponse = await control.app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: owner.headers,
        payload: { name: 'Release Production' },
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
        environments: Array<{ id: string; type: string; name: string }>;
      }>();
      const environment = project.environments.find(({ type }) => type === 'production');
      expect(environment).toBeDefined();
      const environmentId = environment?.id ?? newId('env');
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
      await database.db.insert(organizations).values({
        id: organizationId,
        name: 'Release Production',
        slug: `release-${organizationId.slice(-8).toLowerCase()}`,
      });
      await database.db.insert(users).values({
        id: owner.userId,
        email: 'owner@release-production.test',
        displayName: 'Release Owner',
      });
      await database.db.insert(memberships).values({
        organizationId,
        userId: owner.userId,
        role: 'owner',
      });
      await database.db.insert(projects).values({
        id: project.project.id,
        organizationId,
        name: 'Release Target',
        slug: `release-${project.project.id.slice(-8).toLowerCase()}`,
        sourceType: 'prompt',
        supportLevel: 'managed',
        createdBy: owner.userId,
      });
      await database.db.insert(environments).values({
        id: environmentId,
        organizationId,
        projectId: project.project.id,
        name: environment?.name ?? 'Production',
        type: 'production',
        deploymentProvider: 'fly',
      });
      await database.db.insert(specifications).values({
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
        headers: mutate('release-production-create'),
        payload: { environmentId, commitSha: COMMIT_SHA, specificationId },
      });
      expect(created.statusCode, created.body).toBe(201);
      const releaseId = created.json<{ release: { id: string } }>().release.id;
      activeReleaseId = releaseId;
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
            headers: mutate('release-production-approve'),
          })
        ).statusCode,
      ).toBe(200);

      const deploy = () =>
        control.app.inject({
          method: 'POST',
          url: `/v1/releases/${releaseId}/deploy`,
          headers: mutate('release-production-deploy'),
          payload: { deploymentType: 'first_deploy' },
        });
      const firstDeploy = await deploy();
      const replayedDeploy = await deploy();
      expect(firstDeploy.statusCode, firstDeploy.body).toBe(200);
      expect(replayedDeploy.statusCode, replayedDeploy.body).toBe(200);
      expect(replayedDeploy.json()).toEqual(firstDeploy.json());
      expect(await (await fetch(providerUrl)).text()).toBe('candidate release');
      expect(providerMutations).toEqual(['deploy']);
      expect(syntheticStatuses).toEqual(['passing']);

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
        headers: mutate('release-production-fork'),
        payload: { startFixRun: true },
      });
      expect(forked.statusCode, forked.body).toBe(201);
      expect(forked.json()).toMatchObject({
        fork: { branchId, branchName: `fix/rel-${releaseId}`, fixRunId },
      });

      const rollback = () =>
        control.app.inject({
          method: 'POST',
          url: `/v1/releases/${releaseId}/rollback`,
          headers: mutate('release-production-rollback'),
          payload: { toDeploymentId: previousDeploymentId, reason: 'Restore prior content.' },
        });
      const firstRollback = await rollback();
      const replayedRollback = await rollback();
      expect(firstRollback.statusCode, firstRollback.body).toBe(200);
      expect(replayedRollback.statusCode, replayedRollback.body).toBe(200);
      expect(replayedRollback.json()).toEqual(firstRollback.json());
      expect(await (await fetch(providerUrl)).text()).toBe('previous healthy release');
      expect(providerMutations).toEqual(['deploy', 'rollback']);
      expect(gitCalls).toEqual([
        `commit:${COMMIT_SHA}`,
        `tag:${releaseId}:${COMMIT_SHA}`,
        `branch:fix/rel-${releaseId}:${COMMIT_SHA}`,
      ]);
      expect(
        (await database.db.select({ id: releases.id, status: releases.status }).from(releases))
          .filter(({ id }) => id === releaseId)
          .map(({ status }) => ({ status })),
      ).toEqual([{ status: 'healthy' }]);
    } finally {
      await control.app.close();
      await releaseApp.close();
      await git.close();
      await provider.close();
    }
  }, 120_000);
});
