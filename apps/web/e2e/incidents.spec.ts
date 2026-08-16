import { expect, test, type Page, type Request } from '@playwright/test';

import { apiBaseUrl, appBaseUrl } from './support/ports.js';
const projectId = 'project-apollo';
const incidentId = 'aud_01K2AB3CD4EF5GH6JK7MNP8QRS';
const releaseId = 'rel_01K2AB3CD4EF5GH6JK7MNP8QRS';

const projectRead = {
  branches: [
    {
      baseBranchId: null,
      headCommitSha: 'a'.repeat(40),
      id: 'branch-main',
      name: 'main',
      organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
      projectId,
      status: 'active',
    },
  ],
  environments: [],
  project: {
    archivedAt: null,
    createdAt: '2026-08-12T12:00:00.000Z',
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
    description: 'A production checkout.',
    id: projectId,
    name: 'Project Apollo',
    organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
    slug: 'project-apollo',
    sourceType: 'prompt',
    supportLevel: 'managed' as const,
  },
  repository: {
    defaultBranch: 'main',
    externalRepoRef: null,
    id: 'repository-apollo',
    internalRepoRef: 'org_alpha/project_apollo',
    organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
    projectId,
    provider: 'forgejo',
    syncPolicy: 'none',
  },
};

const fixRequest = {
  source: 'error_report' as const,
  summary: 'Checkout times out\n\nPOST /checkout returned 504',
  relevantCommitSha: 'a'.repeat(40),
  reproductionRef: '/checkout',
  evidence: [
    {
      kind: 'incident_record' as const,
      incidentId,
      summary: 'Checkout times out',
    },
  ],
  incidentId,
  releaseId,
  errorPayload: 'POST /checkout returned 504',
};

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('creates an explicit Fix run from the production incident seed', async ({ page }) => {
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify(projectRead),
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
        'content-type': 'application/json',
      },
      status: 200,
    });
  });
  await page.route(
    new RegExp(`${apiBaseUrl}/v1/projects/${projectId}/incidents(?:\\?.*)?$`, 'u'),
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          items: [
            {
              id: incidentId,
              organizationId: 'org_01K2AB3CD4EF5GH6JK7MNP8QRS',
              projectId: 'proj_01K2AB3CD4EF5GH6JK7MNP8QRS',
              releaseId,
              commitSha: 'a'.repeat(40),
              source: 'grafana_faro',
              title: 'Checkout times out',
              errorPayload: 'POST /checkout returned 504',
              traceUrl: 'https://grafana.example.test/explore?trace=checkout',
              logsUrl: null,
              reproductionRoute: '/checkout',
              evidenceArtifactId: null,
              fixRunId: null,
              resolutionReleaseId: null,
              status: 'open',
              createdAt: '2026-08-12T12:00:00.000Z',
              fixRequest,
            },
          ],
          nextCursor: null,
        }),
        headers: {
          'access-control-allow-credentials': 'true',
          'access-control-allow-origin': appBaseUrl,
          'content-type': 'application/json',
        },
        status: 200,
      });
    },
  );
  let runRequest: Request | undefined;
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    runRequest = route.request();
    await route.fulfill({
      body: JSON.stringify({
        run: {
          id: 'run_01K2AB3CD4EF5GH6JK7MNP8QRS',
          organizationId: 'org_01K2AB3CD4EF5GH6JK7MNP8QRS',
          projectId: 'proj_01K2AB3CD4EF5GH6JK7MNP8QRS',
          branchId: null,
          mode: 'fix',
          appType: 'web',
          model: null,
          status: 'queued',
          specificationId: null,
          budget: { maxCredits: 1000 },
          startedBy: 'user_01K2AB3CD4EF5GH6JK7MNP8QRS',
          startedAt: '2026-08-12T12:01:00.000Z',
          completedAt: null,
        },
      }),
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
        'content-type': 'application/json',
      },
      status: 201,
    });
  });

  await signIn(page);
  await page.goto(`/projects/${projectId}?incident=${encodeURIComponent(incidentId)}`);

  await expect(page.getByRole('heading', { name: 'Checkout times out' })).toBeVisible();
  await page.getByRole('button', { name: 'Create Fix run' }).click();
  await expect(page.getByText('Fix run started')).toBeVisible();
  expect(runRequest).toBeDefined();
  expect(runRequest?.headers()['x-organization-id']).toBe('org_01K27Q9C2W85CMN1V9S6Q3D4FD');
  expect(runRequest?.headers()['idempotency-key']).toBeTruthy();
  expect(runRequest?.postDataJSON()).toEqual({
    mode: 'fix',
    prompt: 'Fix production incident: Checkout times out',
    fixRequest,
  });
});
