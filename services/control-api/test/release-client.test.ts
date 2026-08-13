import { createServiceTokenSigner } from '@zapp/config';
import { newId } from '@zapp/contracts';
import { buildApp as buildReleaseApp } from '@zapp/release-service/app';
import type { ReleaseLifecycleService } from '@zapp/release-service/lifecycle';
import type { Release, ReleaseRecordService } from '@zapp/release-service/records';
import type { DeploymentProgressPort } from '@zapp/release-service/deployment-progress';
import type { DomainPort } from '@zapp/release-service/domain-store';
import {
  assembleEvidenceManifest,
  buildCriteriaCompletionReport,
  GATE_IDS,
} from '@zapp/verification-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createReleaseServiceClient,
  loadReleaseServiceUrl,
  resolveReleaseService,
} from '../src/release/client.js';

const SERVICE_TOKENS = { secret: 'release-client-test-secret-that-is-long-enough' };
const ORGANIZATION_ID = newId('org');
const PROJECT_ID = newId('proj');
const ENVIRONMENT_ID = newId('env');
const SPECIFICATION_ID = newId('spec');
const USER_ID = newId('user');
const RELEASE_ID = newId('rel');
const DEPLOYMENT_ID = newId('dep');
const BRANCH_ID = newId('br');
const FIX_RUN_ID = newId('run');
const COMMIT_SHA = 'a'.repeat(40);
const OPERATION_KEY = `op_${'b'.repeat(64)}`;

const release: Release = {
  id: RELEASE_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  commitSha: COMMIT_SHA,
  specificationId: SPECIFICATION_ID,
  status: 'ready',
  evidenceManifestArtifactId: null,
  createdBy: USER_ID,
  createdAt: new Date('2026-08-12T17:00:00.000Z'),
};

const evidence = assembleEvidenceManifest(
  {
    releaseId: RELEASE_ID,
    commitSha: COMMIT_SHA,
    specificationVersion: 1,
    supportLevel: 'managed',
    projectPolicy: { waivers: [] },
    gateResults: GATE_IDS.map((gateId) => ({
      gateId,
      result: { status: 'passed' as const, evidenceArtifactIds: [`evidence-${gateId}`], details: {} },
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
);

function harness() {
  const calls: string[] = [];
  const records: ReleaseRecordService = {
    createReleaseCandidate: (input) => {
      calls.push(`create:${input.resolvedFixRunIds.join(',')}`);
      return Promise.resolve(release);
    },
    getRelease: (organizationId, releaseId) => {
      calls.push('get');
      return Promise.resolve(
        organizationId === ORGANIZATION_ID && releaseId === RELEASE_ID ? release : undefined,
      );
    },
    transitionStatus: () => Promise.resolve(release),
    approve: () => {
      calls.push('approve');
      return Promise.resolve({ ...release, status: 'approved' });
    },
    beginDeployment: () => Promise.resolve({ ...release, status: 'deploying' }),
  };
  const lifecycle: ReleaseLifecycleService = {
    getReadiness: () => {
      calls.push('readiness');
      return Promise.resolve({
        releaseId: RELEASE_ID,
        commitSha: COMMIT_SHA,
        state: 'ready',
        findings: [],
        blockers: [],
        primaryAction: null,
      });
    },
    deploy: () => {
      calls.push('deploy');
      return Promise.resolve({ deploymentId: DEPLOYMENT_ID });
    },
    rollback: () => {
      calls.push('rollback');
      return Promise.resolve({ deploymentId: DEPLOYMENT_ID });
    },
    getEvidence: () => {
      calls.push('evidence');
      return Promise.resolve(evidence);
    },
    forkRelease: () => {
      calls.push('fork');
      return Promise.resolve({
        releaseId: RELEASE_ID,
        branchId: BRANCH_ID,
        branchName: `fix/rel-${RELEASE_ID}`,
        fixRunId: FIX_RUN_ID,
      });
    },
  };
  const progress: DeploymentProgressPort = {
    append: () => Promise.reject(new Error('not used')),
    get: () =>
      Promise.resolve({
        deploymentId: DEPLOYMENT_ID,
        releaseId: RELEASE_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        status: 'healthy',
        url: 'https://app.example.test',
        events: [],
        terminalSuccess: null,
      }),
    act: (input) => {
      calls.push(`action:${input.action}`);
      return Promise.resolve({ status: 'dispatched' });
    },
  };
  const domain = {
    hostname: 'app.example.com',
    environmentId: ENVIRONMENT_ID,
    status: 'active' as const,
    dnsInstructions: [],
    routing: {
      kind: 'subdomain' as const,
      apexHostname: 'example.com',
      wwwHostname: 'www.example.com',
      recommendation: 'Use this hostname.',
    },
    ssl: { managed: true as const, status: 'active' as const },
  };
  const domains: DomainPort = {
    configure: () => {
      calls.push('domain:configure');
      return Promise.resolve(domain);
    },
    poll: () => {
      calls.push('domain:poll');
      return Promise.resolve(domain);
    },
    list: () => Promise.resolve([domain]),
  };
  const app = buildReleaseApp({
    logger: false,
    records,
    lifecycle,
    progress,
    domains,
    signer: createServiceTokenSigner(SERVICE_TOKENS),
  });
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const injected = await app.inject({
      method: (init.method ?? 'GET') as 'GET' | 'POST',
      url: `${url.pathname}${url.search}`,
      headers: init.headers as Record<string, string>,
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(injected.body, {
      status: injected.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { app, calls, fetch };
}

afterEach(() => vi.unstubAllEnvs());

describe('release service client', () => {
  it('crosses authenticated HTTP for the complete lifecycle and repair fork', async () => {
    const built = harness();
    const resolvedFixRunId = newId('run');
    const clients = createReleaseServiceClient({
      baseUrl: 'http://release-service:4300',
      serviceTokens: SERVICE_TOKENS,
      fetch: built.fetch,
    });

    try {
      await clients.release.createReleaseCandidate({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        commitSha: COMMIT_SHA,
        specificationId: SPECIFICATION_ID,
        actorId: USER_ID,
        operationKey: OPERATION_KEY,
        resolvedFixRunIds: [resolvedFixRunId],
      });
      await clients.release.getRelease({ organizationId: ORGANIZATION_ID, releaseId: RELEASE_ID });
      await clients.release.getReadiness({ organizationId: ORGANIZATION_ID, releaseId: RELEASE_ID });
      await clients.release.approve({
        organizationId: ORGANIZATION_ID,
        releaseId: RELEASE_ID,
        actorId: USER_ID,
        operationKey: OPERATION_KEY,
      });
      await clients.release.deploy({
        organizationId: ORGANIZATION_ID,
        releaseId: RELEASE_ID,
        actorId: USER_ID,
        operationKey: OPERATION_KEY,
        deploymentType: 'first_deploy',
        confirmation: { dataDisposition: null },
      });
      await clients.release.getEvidence({ organizationId: ORGANIZATION_ID, releaseId: RELEASE_ID });
      await clients.release.rollback({
        organizationId: ORGANIZATION_ID,
        releaseId: RELEASE_ID,
        actorId: USER_ID,
        operationKey: OPERATION_KEY,
        toDeploymentId: null,
        reason: 'Restore prior healthy content.',
      });
      await clients.release.getDeploymentProgress?.({
        organizationId: ORGANIZATION_ID,
        deploymentId: DEPLOYMENT_ID,
      });
      await clients.release.act?.({
        organizationId: ORGANIZATION_ID,
        resourceType: 'deployment',
        resourceId: DEPLOYMENT_ID,
        action: 'retry',
        actor: { id: USER_ID, organizationId: ORGANIZATION_ID },
        operationKey: OPERATION_KEY,
        payload: { stage: 'go_live' },
      });
      await clients.release.listDomains?.({ organizationId: ORGANIZATION_ID, projectId: PROJECT_ID });
      await clients.release.configureDomain?.({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        hostname: 'app.example.com',
        operationKey: OPERATION_KEY,
      });
      await clients.release.pollDomain?.({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        hostname: 'app.example.com',
        operationKey: OPERATION_KEY,
      });
      const fork = await clients.fork.forkRelease({
        organizationId: ORGANIZATION_ID,
        releaseId: RELEASE_ID,
        actorId: USER_ID,
        operationKey: OPERATION_KEY,
        startFixRun: true,
      });

      expect(fork).toMatchObject({ branchName: `fix/rel-${RELEASE_ID}`, fixRunId: FIX_RUN_ID });
      expect(built.calls).toEqual([
        `create:${resolvedFixRunId}`,
        'get',
        'get', 'readiness',
        'approve',
        'get', 'deploy',
        'get', 'evidence',
        'get', 'rollback',
        'action:retry',
        'domain:configure',
        'domain:poll',
        'get', 'fork',
      ]);
    } finally {
      await built.app.close();
    }
  });

  it('loads an HTTP URL and refuses a production fallback', () => {
    expect(loadReleaseServiceUrl({ RELEASE_SERVICE_URL: 'http://release-service:4300/' })).toBe(
      'http://release-service:4300',
    );
    expect(loadReleaseServiceUrl({})).toBeUndefined();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() =>
      resolveReleaseService({ baseUrl: undefined, serviceTokens: SERVICE_TOKENS }),
    ).toThrow(/no RELEASE_SERVICE_URL/);
  });
});
