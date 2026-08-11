import { afterEach, describe, expect, it, vi } from 'vitest';

import { newId, type AgentEvent } from '@zapp/contracts';
import type { AgentEventRow, Deployment, Release } from '@zapp/db';

import type { AuthIdentity } from '../src/auth/port.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import type { ReleasePort } from '../src/routes/releases.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((built) => built.app.close()));
});

const OWNER: AuthIdentity = {
  externalId: 'project-summaries-owner',
  email: 'owner@summaries.test',
  displayName: 'Summary Owner',
};

interface Wired {
  readonly built: Harness;
  readonly data: InMemoryTenantData;
  readonly owner: TestSession;
  readonly organizationId: string;
}

async function wire(releasePort?: ReleasePort): Promise<Wired> {
  const data = new InMemoryTenantData();
  const built = buildHarness({ tenantDb: data.factory, ...(releasePort === undefined ? {} : { releasePort }) });
  harnesses.push(built);
  const owner = await signIn(built, OWNER);
  const organization = await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Summary Organization' },
  });
  expect(organization.statusCode, organization.body).toBe(201);
  return {
    built,
    data,
    owner,
    organizationId: organization.json<{ organization: { id: string } }>().organization.id,
  };
}

function addEvent(
  wired: Wired,
  projectId: string,
  type: AgentEvent['type'],
  payloadJson: unknown,
  occurredAt: string,
  visibility: AgentEventRow['visibility'] = 'user',
): void {
  wired.data.events.push({
    id: newId('evt'),
    organizationId: wired.organizationId,
    projectId,
    runId: newId('run'),
    sequence: wired.data.events.length + 1,
    type,
    payloadJson,
    visibility,
    occurredAt: new Date(occurredAt),
    phaseId: null,
    taskId: null,
    agentId: null,
  });
}

function addProduction(
  wired: Wired,
  projectId: string,
  status: string,
  occurredAt: string,
): Release {
  const environment = wired.data.environments.find(
    (candidate) => candidate.projectId === projectId && candidate.type === 'production',
  );
  if (environment === undefined) throw new Error('production environment missing');
  const release: Release = {
    id: newId('rel'),
    organizationId: wired.organizationId,
    projectId,
    environmentId: environment.id,
    commitSha: 'a'.repeat(40),
    specificationId: null,
    status: 'deployed',
    evidenceManifestArtifactId: null,
    createdBy: wired.owner.userId,
    createdAt: new Date('2026-08-10T18:01:00.000Z'),
  };
  const deployment: Deployment = {
    id: newId('dep'),
    organizationId: wired.organizationId,
    releaseId: release.id,
    provider: 'fly',
    providerDeploymentId: null,
    status,
    url: null,
    startedAt: new Date('2026-08-10T18:02:30.000Z'),
    completedAt: new Date(occurredAt),
    rollbackOfDeploymentId: null,
  };
  wired.data.releases.push(release);
  wired.data.deployments.push(deployment);
  return release;
}

function releasePort(report?: { state: 'ready' | 'warnings' | 'blocked'; findings: unknown[] }): ReleasePort {
  return {
    getReadiness: vi.fn(() => Promise.resolve(report ?? { state: 'ready', findings: [] })),
  } as unknown as ReleasePort;
}

async function createProject(wired: Wired, name: string): Promise<{ id: string }> {
  const response = await wired.built.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { ...wired.owner.headers, [ORGANIZATION_HEADER]: wired.organizationId },
    payload: { name },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ project: { id: string } }>().project;
}

describe('GET /v1/projects/summaries', () => {
  it('returns summaries in exact request order', async () => {
    const wired = await wire();
    const first = await createProject(wired, 'First Summary Project');
    const second = await createProject(wired, 'Second Summary Project');

    const response = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/summaries?projectId=${first.id}&projectId=${second.id}`,
      headers: { ...wired.owner.headers, [ORGANIZATION_HEADER]: wired.organizationId },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      summaries: [
        {
          projectId: first.id,
          lastActivityAt: null,
          preview: null,
          production: { status: 'not_deployed', occurredAt: null, releaseId: null },
          deployReadiness: null,
        },
        {
          projectId: second.id,
          lastActivityAt: null,
          preview: null,
          production: { status: 'not_deployed', occurredAt: null, releaseId: null },
          deployReadiness: null,
        },
      ],
    });
  });

  it('projects durable activity, preview, production, and injected readiness only', async () => {
    const port = releasePort();
    const wired = await wire(port);
    const { id: projectId } = await createProject(wired, 'Durable Summary Project');
    const release = addProduction(wired, projectId, 'healthy', '2026-08-10T18:03:00.000Z');
    addEvent(wired, projectId, 'preview.ready', { status: 'ready' }, '2026-08-10T18:02:00.000Z');
    addEvent(wired, projectId, 'run.completed', {}, '2026-08-10T18:03:00.000Z');

    const response = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/summaries?projectId=${projectId}`,
      headers: { ...wired.owner.headers, [ORGANIZATION_HEADER]: wired.organizationId },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      summaries: [
        {
          projectId,
          lastActivityAt: '2026-08-10T18:03:00.000Z',
          preview: { status: 'ready', occurredAt: '2026-08-10T18:02:00.000Z' },
          production: {
            status: 'healthy',
            occurredAt: '2026-08-10T18:03:00.000Z',
            releaseId: release.id,
          },
          deployReadiness: { releaseId: release.id, state: 'ready', findings: [] },
        },
      ],
    });
  });

  it('returns one tenant-opaque 404 without partial summaries for a mixed batch', async () => {
    const wired = await wire();
    const local = await createProject(wired, 'Local Summary Project');
    const foreignId = newId('proj');
    wired.data.projects.push({
      id: foreignId,
      organizationId: newId('org'),
      name: 'Foreign Summary Project',
      slug: 'foreign-summary-project',
      description: null,
      sourceType: 'prompt',
      supportLevel: 'compatible',
      createdBy: wired.owner.userId,
      createdAt: new Date(),
      archivedAt: null,
    });

    const response = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/summaries?projectId=${local.id}&projectId=${foreignId}`,
      headers: { ...wired.owner.headers, [ORGANIZATION_HEADER]: wired.organizationId },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'project_not_found' } });
  });

  it('uses the latest valid preview, ignores non-user activity, and leaves empty activity null', async () => {
    const wired = await wire();
    const empty = await createProject(wired, 'Empty Summary Project');
    const populated = await createProject(wired, 'Preview Summary Project');
    addEvent(wired, populated.id, 'preview.ready', { status: 'ready' }, '2026-08-10T18:02:00.000Z');
    addEvent(wired, populated.id, 'preview.failed', { status: 'not-a-preview-state' }, '2026-08-10T18:04:00.000Z');
    addEvent(wired, populated.id, 'run.completed', {}, '2026-08-10T18:05:00.000Z', 'internal');

    const response = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/summaries?projectId=${empty.id}&projectId=${populated.id}`,
      headers: { ...wired.owner.headers, [ORGANIZATION_HEADER]: wired.organizationId },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      summaries: [
        { projectId: empty.id, lastActivityAt: null, preview: null },
        {
          projectId: populated.id,
          lastActivityAt: '2026-08-10T18:04:00.000Z',
          preview: { status: 'ready', occurredAt: '2026-08-10T18:02:00.000Z' },
        },
      ],
    });
  });

  it('returns null when readiness is unavailable and preserves blocked reports verbatim', async () => {
    const unavailable: ReleasePort = {
      getReadiness: vi.fn(async () => Promise.reject(new Error('unavailable'))),
    } as unknown as ReleasePort;
    const wired = await wire(unavailable);
    const project = await createProject(wired, 'Unavailable Readiness Project');
    addProduction(wired, project.id, 'healthy', '2026-08-10T18:03:00.000Z');

    const unavailableResponse = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/summaries?projectId=${project.id}`,
      headers: { ...wired.owner.headers, [ORGANIZATION_HEADER]: wired.organizationId },
    });
    expect(unavailableResponse.json()).toMatchObject({
      summaries: [{ deployReadiness: null }],
    });

    const blocked = releasePort({
      state: 'blocked',
      findings: [
        {
          id: 'missing-evidence',
          severity: 'blocker',
          title: 'Evidence missing',
          detail: 'Run verification first.',
          action: 'fix_and_recheck',
        },
      ],
    });
    const blockedWired = await wire(blocked);
    const blockedProject = await createProject(blockedWired, 'Blocked Readiness Project');
    const blockedRelease = addProduction(
      blockedWired,
      blockedProject.id,
      'healthy',
      '2026-08-10T18:03:00.000Z',
    );
    const response = await blockedWired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/summaries?projectId=${blockedProject.id}`,
      headers: {
        ...blockedWired.owner.headers,
        [ORGANIZATION_HEADER]: blockedWired.organizationId,
      },
    });
    expect(response.json()).toMatchObject({
      summaries: [
        {
          deployReadiness: {
            releaseId: blockedRelease.id,
            state: 'blocked',
            findings: [expect.objectContaining({ id: 'missing-evidence', severity: 'blocker' })],
          },
        },
      ],
    });
  });
});
