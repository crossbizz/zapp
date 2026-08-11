import { describe, expect, it, vi } from 'vitest';

import {
  createFaroSourceMapUploadHook,
  createGrafanaReleaseAnnotationService,
  type GrafanaAnnotationDependencies,
} from '../src/annotations/grafana.js';
import {
  createPostHogReleaseAnnotationService,
  type PostHogAnnotationDependencies,
} from '../src/annotations/posthog.js';
import { assembleDeploymentSuccess } from '../src/release/success.js';

const ORGANIZATION_ID = 'org_01J00000000000000000000000';
const PROJECT_ID = 'proj_01J00000000000000000000000';
const RELEASE_ID = 'rel_01J00000000000000000000000';
const PREVIOUS_RELEASE_ID = 'rel_01J00000000000000000000001';
const PREVIOUS_DEPLOYMENT_ID = 'dep_01J00000000000000000000001';
const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const DEPLOYED_AT = '2026-08-11T18:30:00.000Z';
const OPERATION_KEY = `op_${'8'.repeat(64)}`;

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(value: string | URL | Request): string {
  if (typeof value === 'string') return value;
  return value instanceof URL ? value.toString() : value.url;
}

function requestBody(value: BodyInit | null | undefined): string {
  if (typeof value !== 'string') throw new Error('Expected a string request body.');
  return value;
}

describe('DEP-8 Grafana release annotations and Faro sourcemaps', () => {
  it('adds a keyed release annotation to every project dashboard', async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const executions: Array<{ readonly key: string; readonly fingerprint: string }> = [];
    let annotationId = 40;
    const dependencies: GrafanaAnnotationDependencies = {
      connection: {
        resolve() {
          return Promise.resolve({
            status: 'connected',
            apiBaseUrl: 'https://grafana.example.test',
            credentialRef: 'vault://grafana/annotations',
            dashboards: [
              { uid: 'overview', url: 'https://grafana.example.test/d/overview' },
              { uid: 'reliability', url: 'https://grafana.example.test/d/reliability' },
            ],
            faro: {
              appId: 'faro-app-1',
              appUrl: 'https://grafana.example.test/a/frontend-observability/faro-app-1',
              apiBaseUrl: 'https://faro-api.example.test',
              stackId: '123456',
              credentialRef: 'vault://grafana/sourcemaps',
            },
          });
        },
      },
      vault: {
        resolveCredential({ credentialRef }) {
          return Promise.resolve({
            token:
              credentialRef === 'vault://grafana/annotations'
                ? 'grafana-annotation-secret'
                : 'grafana-sourcemap-secret',
          });
        },
      },
      mutations: {
        runOnce(input, mutation) {
          executions.push(input);
          return mutation();
        },
      },
      fetch: vi.fn((url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: requestUrl(url), init });
        annotationId += 1;
        return Promise.resolve(response(200, { message: 'Annotation added', id: annotationId }));
      }),
    };

    const result = await createGrafanaReleaseAnnotationService(dependencies).annotate({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      releaseId: RELEASE_ID,
      commitSha: COMMIT_SHA,
      deployedAt: DEPLOYED_AT,
      operationKey: OPERATION_KEY,
    });

    expect(result).toEqual({
      dashboardLinks: [
        'https://grafana.example.test/d/overview',
        'https://grafana.example.test/d/reliability',
      ],
      faroAppLink: 'https://grafana.example.test/a/frontend-observability/faro-app-1',
      annotationIds: [41, 42],
    });
    expect(executions.map(({ key }) => key)).toEqual([
      `${OPERATION_KEY}:grafana:overview`,
      `${OPERATION_KEY}:grafana:reliability`,
    ]);
    expect(new Set(executions.map(({ fingerprint }) => fingerprint)).size).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: 'https://grafana.example.test/api/annotations',
      init: {
        method: 'POST',
        headers: {
          authorization: 'Bearer grafana-annotation-secret',
          'content-type': 'application/json',
        },
      },
    });
    expect(JSON.parse(requestBody(requests[0]?.init?.body))).toEqual({
      dashboardUID: 'overview',
      time: Date.parse(DEPLOYED_AT),
      tags: [`release:${RELEASE_ID}`, COMMIT_SHA],
      text: `release ${RELEASE_ID}`,
    });
  });

  it('exposes a keyed Faro sourcemap hook without leaking the upload token', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    let uploadShouldFail = false;
    const dependencies: GrafanaAnnotationDependencies = {
      connection: {
        resolve() {
          return Promise.resolve({
            status: 'connected',
            apiBaseUrl: 'https://grafana.example.test/',
            credentialRef: 'vault://grafana/annotations',
            dashboards: [],
            faro: {
              appId: 'faro-app-1',
              appUrl: 'https://grafana.example.test/a/frontend-observability/faro-app-1',
              apiBaseUrl: 'https://faro-api.example.test/',
              stackId: '123456',
              credentialRef: 'vault://grafana/sourcemaps',
            },
          });
        },
      },
      vault: {
        resolveCredential() {
          return Promise.resolve({ token: 'do-not-leak-this-token' });
        },
      },
      mutations: {
        runOnce(_input, mutation) {
          return mutation();
        },
      },
      fetch: vi.fn((url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: requestUrl(url), init });
        return Promise.resolve(
          uploadShouldFail
            ? response(500, { token: 'do-not-leak-this-token' })
            : new Response(null, { status: 204 }),
        );
      }),
    };

    await expect(
      createFaroSourceMapUploadHook(dependencies).upload({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        releaseId: RELEASE_ID,
        bundleId: `app-${COMMIT_SHA}.js`,
        sourceMap: JSON.stringify({ version: 3, sources: ['src/main.ts'], mappings: '' }),
        operationKey: OPERATION_KEY,
      }),
    ).resolves.toEqual({
      appLink: 'https://grafana.example.test/a/frontend-observability/faro-app-1',
      bundleId: `app-${COMMIT_SHA}.js`,
    });

    expect(calls[0]).toEqual({
      url: `https://faro-api.example.test/faro/api/v1/app/faro-app-1/sourcemaps/app-${COMMIT_SHA}.js`,
      init: {
        method: 'POST',
        headers: {
          authorization: 'Bearer 123456:do-not-leak-this-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ version: 3, sources: ['src/main.ts'], mappings: '' }),
      },
    });

    uploadShouldFail = true;
    await expect(
      createFaroSourceMapUploadHook(dependencies).upload({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        releaseId: RELEASE_ID,
        bundleId: 'failed.js',
        sourceMap: '{"version":3}',
        operationKey: `${OPERATION_KEY}:failure`,
      }),
    ).rejects.not.toThrow(/do-not-leak-this-token/u);
  });
});

describe('DEP-8 PostHog release annotation', () => {
  it('creates a keyed project-scoped deployment annotation', async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const executions: string[] = [];
    const dependencies: PostHogAnnotationDependencies = {
      connection: {
        resolve() {
          return Promise.resolve({
            status: 'connected',
            apiBaseUrl: 'https://us.posthog.example.test',
            projectId: 17,
            credentialRef: 'vault://posthog/personal-key',
          });
        },
      },
      vault: {
        resolveCredential() {
          return Promise.resolve({ token: 'posthog-secret' });
        },
      },
      mutations: {
        runOnce(input, mutation) {
          executions.push(input.key);
          return mutation();
        },
      },
      fetch: vi.fn((url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: requestUrl(url), init });
        return Promise.resolve(
          response(201, {
            id: 52,
            content: `release ${RELEASE_ID}`,
            date_marker: DEPLOYED_AT,
            scope: 'project',
            created_at: DEPLOYED_AT,
            updated_at: DEPLOYED_AT,
            created_by: { id: 1 },
            dashboard_name: null,
            insight_derived_name: null,
            insight_name: null,
            insight_short_id: null,
          }),
        );
      }),
    };

    await expect(
      createPostHogReleaseAnnotationService(dependencies).annotate({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        releaseId: RELEASE_ID,
        commitSha: COMMIT_SHA,
        deployedAt: DEPLOYED_AT,
        operationKey: OPERATION_KEY,
      }),
    ).resolves.toEqual({
      annotationId: 52,
      annotationLink: 'https://us.posthog.example.test/api/projects/17/annotations/52/',
    });

    expect(executions).toEqual([`${OPERATION_KEY}:posthog`]);
    expect(requests[0]).toMatchObject({
      url: 'https://us.posthog.example.test/api/projects/17/annotations/',
      init: {
        method: 'POST',
        headers: {
          authorization: 'Bearer posthog-secret',
          'content-type': 'application/json',
        },
      },
    });
    expect(JSON.parse(requestBody(requests[0]?.init?.body))).toEqual({
      content: `release ${RELEASE_ID}`,
      date_marker: DEPLOYED_AT,
      scope: 'project',
      creation_type: 'GIT',
    });
  });
});

describe('DEP-8 deployment success contract', () => {
  it('assembles every release, monitoring, domain, evidence, rollback, and redeploy link', () => {
    expect(
      assembleDeploymentSuccess({
        projectId: PROJECT_ID,
        releaseId: RELEASE_ID,
        commitSha: COMMIT_SHA,
        permanentUrl: 'https://app.example.test',
        productionHealthStatus: 'healthy',
        monitoring: {
          grafanaDashboardLinks: ['https://grafana.example.test/d/overview'],
          faroAppLink: 'https://grafana.example.test/a/frontend-observability/faro-app-1',
          posthogAnnotationLink: 'https://us.posthog.example.test/api/projects/17/annotations/52/',
        },
        previousHealthyRelease: {
          releaseId: PREVIOUS_RELEASE_ID,
          deploymentId: PREVIOUS_DEPLOYMENT_ID,
          commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
        },
      }),
    ).toEqual({
      status: 'succeeded',
      permanentUrl: 'https://app.example.test',
      customDomainAction: {
        method: 'POST',
        href: `/v1/projects/${PROJECT_ID}/domains`,
      },
      release: { id: RELEASE_ID, commitSha: COMMIT_SHA },
      evidence: { statusLink: `/v1/releases/${RELEASE_ID}/evidence` },
      productionHealth: { status: 'healthy' },
      monitoring: {
        grafanaDashboardLinks: ['https://grafana.example.test/d/overview'],
        faroAppLink: 'https://grafana.example.test/a/frontend-observability/faro-app-1',
        posthogAnnotationLink: 'https://us.posthog.example.test/api/projects/17/annotations/52/',
      },
      previousHealthyRelease: {
        releaseId: PREVIOUS_RELEASE_ID,
        deploymentId: PREVIOUS_DEPLOYMENT_ID,
        commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
        rollbackAction: {
          method: 'POST',
          href: `/v1/releases/${RELEASE_ID}/rollback`,
          body: { toDeploymentId: PREVIOUS_DEPLOYMENT_ID },
        },
      },
      previewChanges: {
        requireRedeploy: true,
        note: 'Preview changes require a new release and redeploy before they reach production.',
      },
    });
  });

  it('rejects a success payload unless exact commit and healthy production are proven', () => {
    expect(() =>
      assembleDeploymentSuccess({
        projectId: PROJECT_ID,
        releaseId: RELEASE_ID,
        commitSha: 'main',
        permanentUrl: 'https://app.example.test',
        productionHealthStatus: 'failed',
        monitoring: {
          grafanaDashboardLinks: [],
          faroAppLink: 'https://grafana.example.test/a/faro',
          posthogAnnotationLink: 'https://posthog.example.test/annotation/1',
        },
        previousHealthyRelease: null,
      }),
    ).toThrow();
  });
});
