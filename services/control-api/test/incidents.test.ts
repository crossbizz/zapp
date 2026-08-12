import { ApiErrorSchema, newId, type FixRequest } from '@zapp/contracts';
import type { AgentEventRow } from '@zapp/db';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { DispatchNotStartedError } from '../src/orchestrator/port.js';
import {
  createInMemoryNotificationState,
  type NotificationTrigger,
} from '../src/notifications/service.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { createInMemoryIncidentStore, type IncidentStore } from '../src/routes/incidents.js';
import type {
  CreateReleaseMutationInput,
  DeploymentResult,
  EvidenceManifest,
  ReadinessReport,
  ReleaseLookupInput,
  ReleaseMutationInput,
  ReleasePort,
  ReleaseRow,
} from '../src/routes/releases.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const OWNER: AuthIdentity = {
  externalId: 'incident-owner',
  email: 'owner@incidents.test',
  displayName: 'Inez Incident',
};

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

class IncidentReleasePort implements ReleasePort {
  readonly releases = new Map<string, ReleaseRow>();

  async createReleaseCandidate(input: CreateReleaseMutationInput): Promise<ReleaseRow> {
    const row: ReleaseRow = {
      id: newId('rel'),
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      commitSha: input.commitSha,
      specificationId: input.specificationId,
      status: 'ready',
      evidenceManifestArtifactId: null,
      createdBy: input.actorId,
      createdAt: new Date('2026-08-12T18:00:00.000Z'),
    };
    await input.audit(Symbol.for('incident-test-transaction') as never, row);
    this.releases.set(row.id, row);
    return row;
  }

  getRelease(input: ReleaseLookupInput): Promise<ReleaseRow | undefined> {
    const row = this.releases.get(input.releaseId);
    return Promise.resolve(row?.organizationId === input.organizationId ? row : undefined);
  }

  getReadiness(): Promise<ReadinessReport> {
    return Promise.resolve({ state: 'ready', findings: [] });
  }

  approve(input: ReleaseMutationInput): Promise<ReleaseRow> {
    return this.required(input);
  }

  deploy(): Promise<DeploymentResult> {
    return Promise.resolve({ deploymentId: newId('dep') });
  }

  rollback(): Promise<DeploymentResult> {
    return Promise.resolve({ deploymentId: newId('dep') });
  }

  getEvidence(input: ReleaseLookupInput): Promise<EvidenceManifest> {
    return Promise.resolve({
      release_id: input.releaseId,
      commit_sha: 'a'.repeat(40),
      specification_version: 1,
      criteria: [],
      build: { status: 'passed' },
      typecheck: { status: 'passed' },
      tests: { status: 'passed' },
      browser_tests: { status: 'passed' },
      security: { status: 'passed' },
      migration: { status: 'not_required' },
      preview: { url: 'https://preview.incidents.test' },
      rollback: { supported: true },
      known_risks: [],
    });
  }

  seed(row: ReleaseRow): void {
    this.releases.set(row.id, row);
  }

  private required(input: ReleaseLookupInput): Promise<ReleaseRow> {
    const row = this.releases.get(input.releaseId);
    if (row === undefined) return Promise.reject(new Error('release missing'));
    return Promise.resolve(row);
  }
}

class RecordingOrchestrator {
  readonly starts: unknown[] = [];

  startRun(input: unknown): Promise<void> {
    this.starts.push(input);
    return Promise.resolve();
  }

  signalRun(): Promise<{ applied: boolean }> {
    return Promise.reject(new DispatchNotStartedError());
  }
}

interface Wired {
  readonly built: Harness;
  readonly data: InMemoryTenantData;
  readonly incidents: IncidentStore;
  readonly releases: IncidentReleasePort;
  readonly orchestrator: RecordingOrchestrator;
  readonly owner: TestSession;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly release: ReleaseRow;
  readonly notifications: NotificationTrigger[];
  headers(key?: string): Record<string, string>;
}

async function wire(): Promise<Wired> {
  const data = new InMemoryTenantData();
  const incidents = createInMemoryIncidentStore();
  const releases = new IncidentReleasePort();
  const orchestrator = new RecordingOrchestrator();
  const notifications: NotificationTrigger[] = [];
  const built = buildHarness({
    tenantDb: data.factory,
    incidentStore: incidents,
    incidentWebhookSecret: 'grafana-alert-secret',
    releasePort: releases,
    orchestrator,
    notificationState: createInMemoryNotificationState(),
    notificationEnqueue: (trigger) => {
      notifications.push(trigger);
      return Promise.resolve();
    },
  });
  harnesses.push(built);
  const owner = await signIn(built, OWNER);
  const organization = await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Incident Response' },
  });
  expect(organization.statusCode, organization.body).toBe(201);
  const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
  const organizationHeaders = { ...owner.headers, [ORGANIZATION_HEADER]: organizationId };
  const projectResponse = await built.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: organizationHeaders,
    payload: { name: 'Production API' },
  });
  expect(projectResponse.statusCode, projectResponse.body).toBe(201);
  const project = projectResponse.json<{
    project: { id: string };
    environments: { id: string; type: string }[];
  }>();
  const environmentId =
    project.environments.find((environment) => environment.type === 'production')?.id ?? '';
  const release: ReleaseRow = {
    id: newId('rel'),
    organizationId,
    projectId: project.project.id,
    environmentId,
    commitSha: 'a'.repeat(40),
    specificationId: null,
    status: 'deployed',
    evidenceManifestArtifactId: null,
    createdBy: [...built.users.users.values()][0]?.id ?? newId('user'),
    createdAt: new Date('2026-08-12T17:00:00.000Z'),
  };
  releases.seed(release);
  return {
    built,
    data,
    incidents,
    releases,
    orchestrator,
    owner,
    organizationId,
    projectId: project.project.id,
    environmentId,
    release,
    notifications,
    headers: (key) => ({
      ...organizationHeaders,
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    }),
  };
}

async function report(wired: Wired) {
  const response = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/projects/${wired.projectId}/incidents`,
    headers: wired.headers('report-checkout-timeout'),
    payload: {
      releaseId: wired.release.id,
      title: 'Checkout times out',
      errorPayload: 'POST /checkout returned 504 after 30 seconds',
      traceUrl: 'https://grafana.example.test/explore?trace=abc',
      logsUrl: 'https://grafana.example.test/explore?logs=abc',
      reproductionRoute: '/checkout',
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{
    incident: {
      id: string;
      status: string;
      fixRunId: string | null;
      resolutionReleaseId: string | null;
      fixRequest: FixRequest;
    };
  }>().incident;
}

describe('closed-loop production incidents', () => {
  it('records a user report and returns an AR-19 Fix seed from the authoritative release', async () => {
    const wired = await wire();

    const incident = await report(wired);

    expect(incident.id).toMatch(/^aud_/u);
    expect(incident).toMatchObject({
      status: 'open',
      fixRunId: null,
      resolutionReleaseId: null,
      fixRequest: {
        source: 'user_bug',
        incidentId: incident.id,
        releaseId: wired.release.id,
        relevantCommitSha: wired.release.commitSha,
        errorPayload: 'POST /checkout returned 504 after 30 seconds',
        reproductionRef: '/checkout',
      },
    });
    const list = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}/incidents`,
      headers: wired.headers(),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ items: { id: string }[] }>().items).toEqual([
      expect.objectContaining({ id: incident.id }),
    ]);
    expect(wired.notifications).toContainEqual(
      expect.objectContaining({
        type: 'production_incident',
        context: { incidentId: incident.id },
      }),
    );
  });

  it('keeps a bounded Fix summary when the diagnostic payload is much larger', async () => {
    const wired = await wire();
    const errorPayload = 'x'.repeat(9_000);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/incidents`,
      headers: wired.headers('report-large-diagnostic'),
      payload: {
        releaseId: wired.release.id,
        title: 'Large diagnostic payload',
        errorPayload,
        reproductionRoute: '/diagnostics',
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      incident: {
        errorPayload,
        fixRequest: { summary: 'Large diagnostic payload', errorPayload },
      },
    });
  });

  it('links incident to the explicit Fix run and the release produced by that run', async () => {
    const wired = await wire();
    const incident = await report(wired);

    const fix = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/runs`,
      headers: wired.headers('fix-checkout-timeout'),
      payload: {
        mode: 'fix',
        prompt: 'Restore checkout from the production incident.',
        fixRequest: incident.fixRequest,
      },
    });
    expect(fix.statusCode, fix.body).toBe(201);
    const runId = fix.json<{ run: { id: string } }>().run.id;

    const fixCommit = 'b'.repeat(40);
    const run = wired.data.runs.find((row) => row.id === runId);
    expect(run).toBeDefined();
    const event: AgentEventRow = {
      id: newId('evt'),
      organizationId: wired.organizationId,
      projectId: wired.projectId,
      runId,
      sequence: 1,
      type: 'commit.created',
      payloadJson: { commitSha: fixCommit, message: 'fix checkout', diffstat: [], mode: 'fix' },
      visibility: 'user',
      occurredAt: new Date('2026-08-12T17:30:00.000Z'),
      phaseId: null,
      taskId: null,
      agentId: 'builder',
    };
    wired.data.events.push(event);

    const release = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/releases`,
      headers: wired.headers('release-checkout-fix'),
      payload: { environmentId: wired.environmentId, commitSha: fixCommit, specificationId: null },
    });
    expect(release.statusCode, release.body).toBe(201);
    const resolutionReleaseId = release.json<{ release: { id: string } }>().release.id;

    const list = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}/incidents`,
      headers: wired.headers(),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toContainEqual(
      expect.objectContaining({
        id: incident.id,
        status: 'resolved',
        fixRunId: runId,
        resolutionReleaseId,
      }),
    );
  });

  it('rejects an incomplete incident seed before dispatching a Fix run', async () => {
    const wired = await wire();
    const incident = await report(wired);
    const incompleteFixRequest = { ...incident.fixRequest };
    delete incompleteFixRequest.releaseId;

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/runs`,
      headers: wired.headers('incomplete-incident-seed'),
      payload: {
        mode: 'fix',
        prompt: 'Restore checkout from an incomplete incident seed.',
        fixRequest: incompleteFixRequest,
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('validation_failed');
    expect(wired.orchestrator.starts).toHaveLength(0);
  });

  it('authenticates Grafana alerts and service-authenticated synthetic failures', async () => {
    const wired = await wire();
    const alert = {
      status: 'firing',
      alerts: [
        {
          fingerprint: 'faro-checkout-timeout',
          status: 'firing',
          labels: {
            organization_id: wired.organizationId,
            project_id: wired.projectId,
            release_id: wired.release.id,
            source: 'grafana_faro',
          },
          annotations: {
            summary: 'Browser checkout error',
            error_payload: 'TypeError: request timed out',
            trace_url: 'https://grafana.example.test/explore?trace=faro',
            repro_route: '/checkout',
          },
        },
      ],
    };
    const denied = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/webhooks/grafana',
      payload: alert,
    });
    expect(denied.statusCode).toBe(401);
    const accepted = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/webhooks/grafana',
      headers: { authorization: 'Bearer grafana-alert-secret' },
      payload: alert,
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
    expect(accepted.json()).toEqual({ accepted: 1 });

    const token = await wired.built.serviceTokens.issue('release-service', {
      aud: 'control-api:incidents.ingest',
    });
    const synthetic = await wired.built.app.inject({
      method: 'POST',
      url: '/internal/incidents',
      headers: { 'x-zapp-service-token': token },
      payload: {
        idempotencyKey: 'synthetic:checkout:run-1:incident',
        organizationId: wired.organizationId,
        projectId: wired.projectId,
        releaseId: wired.release.id,
        syntheticCheckId: newId('syn'),
        title: 'Checkout synthetic failed',
        errorPayload: 'Expected 200, received 504',
        evidenceArtifactId: newId('art'),
        reproductionRoute: '/checkout',
      },
    });
    expect(synthetic.statusCode, synthetic.body).toBe(201);
    const syntheticIncident = synthetic.json<{ incident: { id: string; source: string } }>()
      .incident;
    expect(syntheticIncident).toMatchObject({ source: 'synthetic_failure' });
    expect(wired.notifications).toContainEqual(
      expect.objectContaining({
        type: 'production_incident',
        context: { incidentId: syntheticIncident.id },
      }),
    );
  });

  it('returns 404 for a release outside the selected tenant and records nothing', async () => {
    const wired = await wire();
    const foreignRelease = { ...wired.release, id: newId('rel'), organizationId: newId('org') };
    wired.releases.seed(foreignRelease);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/incidents`,
      headers: wired.headers('foreign-release-report'),
      payload: {
        releaseId: foreignRelease.id,
        title: 'Do not leak this release',
        errorPayload: 'cross-tenant probe',
        reproductionRoute: '/private',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('release_not_found');
    expect(
      (
        await wired.incidents.list({
          organizationId: wired.organizationId,
          projectId: wired.projectId,
          limit: 50,
        })
      ).items,
    ).toEqual([]);
  });
});
