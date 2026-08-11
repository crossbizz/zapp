import { afterEach, describe, expect, it, vi } from 'vitest';

import { newId, PreviewLifecycleEventSchema, type AgentEvent } from '@zapp/contracts';
import type { AgentEventRow, Deployment, Release } from '@zapp/db';

import type { AuthIdentity } from '../src/auth/port.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import type { ReleasePort } from '../src/routes/releases.js';
import { ProjectDashboardSummarySchema } from '../src/tenant/view.js';
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

function addProducerPreviewEvent(
  wired: Wired,
  projectId: string,
  type: 'preview.starting' | 'preview.ready' | 'preview.failed',
  payload: unknown,
  occurredAt: string,
): void {
  const event = PreviewLifecycleEventSchema.parse({
    eventKey: `summary-contract:${String(wired.data.events.length + 1)}`,
    organizationId: wired.organizationId,
    projectId,
    runId: newId('run'),
    taskId: newId('task'),
    occurredAt,
    type,
    visibility: 'user',
    payload,
  });
  addEvent(wired, projectId, event.type, event.payload, event.occurredAt);
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
          preview: { status: 'not_started', occurredAt: null },
          production: { status: 'not_deployed', occurredAt: null, releaseId: null },
          deployReadiness: null,
        },
        {
          projectId: second.id,
          lastActivityAt: null,
          preview: { status: 'not_started', occurredAt: null },
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
    addProducerPreviewEvent(
      wired,
      projectId,
      'preview.ready',
      {
        workspaceId: newId('ws'),
        action: 'start',
        port: 3_000,
        supervisorId: 'preview-supervisor-1',
      },
      '2026-08-10T18:02:00.000Z',
    );
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

  it('derives preview state from exact sandbox lifecycle event types and real payloads', async () => {
    const wired = await wire();
    const starting = await createProject(wired, 'Starting Preview Project');
    const ready = await createProject(wired, 'Ready Preview Project');
    const failed = await createProject(wired, 'Failed Preview Project');
    const terminalFailure = await createProject(wired, 'Terminal Preview Project');

    addProducerPreviewEvent(
      wired,
      starting.id,
      'preview.starting',
      { workspaceId: newId('ws'), action: 'restart' },
      '2026-08-10T18:01:00.000Z',
    );
    addProducerPreviewEvent(
      wired,
      ready.id,
      'preview.ready',
      {
        workspaceId: newId('ws'),
        action: 'start',
        port: 4_173,
        supervisorId: 'preview-supervisor-ready',
      },
      '2026-08-10T18:02:00.000Z',
    );
    addProducerPreviewEvent(
      wired,
      failed.id,
      'preview.failed',
      {
        workspaceId: newId('ws'),
        action: 'restart',
        code: 'dev_server_operation_failed',
      },
      '2026-08-10T18:03:00.000Z',
    );
    addProducerPreviewEvent(
      wired,
      terminalFailure.id,
      'preview.failed',
      {
        workspaceId: newId('ws'),
        code: 'restart_limit_exceeded',
        monitorLeaseToken: 'preview-monitor-lease-1',
      },
      '2026-08-10T18:04:00.000Z',
    );

    const response = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/summaries?projectId=${starting.id}&projectId=${ready.id}&projectId=${failed.id}&projectId=${terminalFailure.id}`,
      headers: { ...wired.owner.headers, [ORGANIZATION_HEADER]: wired.organizationId },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      summaries: [
        { projectId: starting.id, preview: { status: 'starting', occurredAt: '2026-08-10T18:01:00.000Z' } },
        { projectId: ready.id, preview: { status: 'ready', occurredAt: '2026-08-10T18:02:00.000Z' } },
        { projectId: failed.id, preview: { status: 'failed', occurredAt: '2026-08-10T18:03:00.000Z' } },
        { projectId: terminalFailure.id, preview: { status: 'failed', occurredAt: '2026-08-10T18:04:00.000Z' } },
      ],
    });
  });

  it('uses the latest valid preview, ignores non-user activity, and leaves empty activity null', async () => {
    const wired = await wire();
    const empty = await createProject(wired, 'Empty Summary Project');
    const populated = await createProject(wired, 'Preview Summary Project');
    addEvent(
      wired,
      populated.id,
      'preview.ready',
      {
        workspaceId: newId('ws'),
        action: 'start',
        port: 3_001,
        supervisorId: 'preview-supervisor-valid',
      },
      '2026-08-10T18:02:00.000Z',
    );
    addEvent(
      wired,
      populated.id,
      'preview.failed',
      { workspaceId: newId('ws'), code: 'dev_server_operation_failed' },
      '2026-08-10T18:04:00.000Z',
    );
    addEvent(wired, populated.id, 'run.completed', {}, '2026-08-10T18:05:00.000Z', 'internal');

    const response = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/summaries?projectId=${empty.id}&projectId=${populated.id}`,
      headers: { ...wired.owner.headers, [ORGANIZATION_HEADER]: wired.organizationId },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      summaries: [
        {
          projectId: empty.id,
          lastActivityAt: null,
          preview: { status: 'not_started', occurredAt: null },
        },
        {
          projectId: populated.id,
          lastActivityAt: '2026-08-10T18:04:00.000Z',
          preview: { status: 'ready', occurredAt: '2026-08-10T18:02:00.000Z' },
        },
      ],
    });
  });

  it('rejects unrestricted project and release identifiers in dashboard summary contracts', () => {
    const valid = {
      projectId: newId('proj'),
      lastActivityAt: null,
      preview: { status: 'not_started' as const, occurredAt: null },
      production: { status: 'healthy' as const, occurredAt: null, releaseId: newId('rel') },
      deployReadiness: null,
    };

    expect(ProjectDashboardSummarySchema.safeParse(valid).success).toBe(true);
    expect(
      ProjectDashboardSummarySchema.safeParse({ ...valid, projectId: 'project-unrestricted' }).success,
    ).toBe(false);
    expect(
      ProjectDashboardSummarySchema.safeParse({
        ...valid,
        production: { ...valid.production, releaseId: 'release-unrestricted' },
      }).success,
    ).toBe(false);
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
