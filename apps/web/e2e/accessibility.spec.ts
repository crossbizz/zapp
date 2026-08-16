import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { checkA11y, injectAxe } from 'axe-playwright';

import { apiBaseUrl, appBaseUrl } from './support/ports.js';
const projectId = 'project-a11y';
const releaseId = 'rel_01J00000000000000000000000';
const deploymentId = 'dep_01J00000000000000000000000';
const builderFixture = {
  branches: [
    {
      baseBranchId: null,
      headCommitSha: null,
      id: 'branch-main',
      name: 'main',
      organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
      projectId,
      status: 'active',
    },
  ],
  environments: [
    {
      createdAt: '2026-08-12T12:00:00.000Z',
      databaseConnectionId: null,
      deploymentProvider: null,
      id: 'env-preview',
      name: 'preview',
      organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
      projectId,
      type: 'preview',
    },
  ],
  project: {
    archivedAt: null,
    createdAt: '2026-08-12T12:00:00.000Z',
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
    description: null,
    id: projectId,
    name: 'Accessible project',
    organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
    slug: projectId,
    sourceType: 'prompt',
    supportLevel: 'verified',
  },
  repository: {
    defaultBranch: 'main',
    externalRepoRef: null,
    id: 'repo-a11y',
    internalRepoRef: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD/project-a11y',
    organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
    projectId,
    provider: 'forgejo',
    syncPolicy: 'internal',
  },
} as const;

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('textbox', { name: 'Describe your project' })).toBeVisible({
    timeout: 20_000,
  });
}

async function response(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    headers: {
      'access-control-allow-credentials': 'true',
      'access-control-allow-origin': appBaseUrl,
    },
    status,
  });
}

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < 30; presses += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error('Keyboard tab order did not reach the expected control');
}

async function axeClean(page: Page): Promise<void> {
  await injectAxe(page);
  await checkA11y(page, undefined, { detailedReport: true, detailedReportOptions: { html: true } });
}

async function mockDashboard(page: Page): Promise<void> {
  const fulfillProjects = async (route: Route): Promise<void> => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await response(route, {
      items: [
        {
          archivedAt: null,
          createdAt: '2026-08-12T12:00:00.000Z',
          createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
          description: null,
          id: projectId,
          name: 'Accessible project',
          organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
          slug: projectId,
          sourceType: 'prompt',
          supportLevel: 'verified',
        },
      ],
      nextCursor: null,
    });
  };
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), fulfillProjects);
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/projects/summaries(?:\\?.*)?$`, 'u'),
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await response(route, {
        summaries: [
          {
            deployReadiness: { findings: [], releaseId: 'release-ready', state: 'ready' },
            lastActivityAt: '2026-08-12T12:00:00.000Z',
            preview: { occurredAt: '2026-08-12T12:00:00.000Z', status: 'ready' },
            production: { occurredAt: null, releaseId: null, status: 'not_deployed' },
            projectId,
          },
        ],
      });
    },
  );
}

async function mockBuilder(page: Page): Promise<void> {
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await response(route, builderFixture);
  });
}

async function mockBilling(page: Page): Promise<void> {
  await page.route(`${apiBaseUrl}/v1/billing/status`, async (route) => {
    await response(route, {
      billing: {
        customerId: 'cus_a11y',
        dunning: { state: 'current' },
        planId: 'studio',
        seats: 4,
        subscriptionId: 'sub_a11y',
        subscriptionStatus: 'active',
      },
    });
  });
  await page.route(`${apiBaseUrl}/v1/billing/topups`, async (route) => {
    await response(route, {
      packs: [{ amountUsd: '25.00', credits: '100.0000', id: 'starter' }],
    });
  });
}

async function mockCreation(page: Page): Promise<void> {
  await page.route(`${apiBaseUrl}/v1/projects`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await response(route, builderFixture, 201);
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await response(
      route,
      {
        run: {
          appType: 'web',
          branchId: 'branch-main',
          completedAt: null,
          id: 'run-a11y',
          mode: 'build',
          model: null,
          organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
          projectId,
          startedAt: '2026-08-12T12:00:01.000Z',
          startedBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
          status: 'queued',
        },
      },
      201,
    );
  });
}

async function mockDeployment(page: Page): Promise<void> {
  const release = {
    commitSha: 'a'.repeat(40),
    createdAt: '2026-08-12T12:03:00.000Z',
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
    environmentId: 'env-preview',
    evidenceManifestArtifactId: null,
    id: releaseId,
    organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
    projectId,
    specificationId: null,
    status: 'approved',
  } as const;
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/projects/${projectId}/releases(?:\\?.*)?$`, 'u'),
    async (route) => {
      await response(route, {
        items: [
          {
            ...release,
            activeProduction: false,
            deployments: [],
            evidence: null,
            supportLevel: 'verified',
          },
        ],
        nextCursor: null,
        rollbackTargets: [],
      });
    },
  );
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}`, async (route) => {
    await response(route, { release, readiness: { findings: [], state: 'ready' } });
  });
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/evidence`, async (route) => {
    const block = (gateId: string) => ({
      gates: [{ class: 'support_level_policy', evidenceArtifactIds: [], gateId, status: 'passed' }],
      status: 'passed',
    });
    await response(route, {
      evidence: {
        browser_tests: block('browser_smoke'),
        build: block('production_build'),
        commit_sha: release.commitSha,
        criteria: [],
        known_risks: [],
        migration: block('migration_validation'),
        preview: block('preview_health'),
        release_id: releaseId,
        rollback: block('rollback_readiness'),
        security: block('secret_scan'),
        specification_version: 1,
        tests: block('unit_tests'),
        typecheck: block('typecheck'),
      },
    });
  });
  await page.route(
    `${apiBaseUrl}/v1/releases/${releaseId}/deployment-preview?retarget=false`,
    async (route) => {
      await response(route, {
        deploymentType: 'first_deploy',
        effects: {
          activeUsers: 'No users affected',
          productionData: 'Created',
          secrets: 'Applied',
          url: 'Created',
        },
        requiresExplicitDataDisposition: false,
        title: 'First deploy',
      });
    },
  );
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/deploy`, async (route) => {
    await response(route, { deploymentId });
  });
  await page.route(`${apiBaseUrl}/v1/deployments/${deploymentId}`, async (route) => {
    await response(route, {
      deploymentId,
      environmentId: release.environmentId,
      events: [],
      projectId,
      releaseId,
      status: 'healthy',
      terminalSuccess: {
        customDomainAction: { href: `/v1/projects/${projectId}/domains`, method: 'POST' },
        evidence: { statusLink: `/v1/releases/${releaseId}/evidence` },
        monitoring: {
          faroAppLink: 'https://grafana.example.test/faro',
          grafanaDashboardLinks: [],
          posthogAnnotationLink: 'https://posthog.example.test/release',
        },
        permanentUrl: 'https://accessible.example.test',
        previewChanges: { note: 'Preview changes require a new release.', requireRedeploy: true },
        previousHealthyRelease: null,
        productionHealth: { status: 'healthy' },
        release: { commitSha: release.commitSha, id: releaseId },
        status: 'succeeded',
      },
      url: 'https://accessible.example.test',
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('keeps home, dashboard, builder, and deploy-readiness entry axe clean', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in to zapp.build' })).toBeVisible();
  await axeClean(page);

  await signIn(page);
  await expect(page.getByRole('textbox', { name: 'Describe your project' })).toBeVisible();
  await axeClean(page);

  await mockDashboard(page);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await axeClean(page);
  const deployEntry = page.getByRole('link', { name: 'Deploy Accessible project' });
  await expect(deployEntry).toHaveAttribute('href', `/projects/${projectId}/releases`);

  await mockBuilder(page);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Accessible project' })).toBeVisible();
  await axeClean(page);
});

test('keeps Manage, Billing, and mobile builder navigation axe clean and contained', async ({
  page,
}) => {
  await mockBuilder(page);
  await mockBilling(page);
  await signIn(page);

  await page.setViewportSize({ height: 950, width: 1440 });
  await page.goto(`/projects/${projectId}`);
  const openPreview = page.getByRole('button', { name: 'Open in new tab' });
  await expect(openPreview).toBeVisible();
  await expect
    .poll(async () => (await openPreview.boundingBox())?.height ?? Number.POSITIVE_INFINITY)
    .toBeLessThanOrEqual(48);
  await page.getByRole('button', { name: 'Manage' }).click();
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  await axeClean(page);

  await page.goto('/org/billing');
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
  await axeClean(page);

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Conversation' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await axeClean(page);

  const workspacePane = page.getByRole('button', { name: 'Workspace', exact: true });
  await workspacePane.click();
  await page.mouse.move(0, 0);
  await expect(page.getByRole('region', { name: 'Workspace' })).toBeVisible();
  await expect(workspacePane).toHaveCSS('background-color', 'rgb(37, 99, 235)');
  for (const name of ['Open in new tab', 'Refresh', 'Share link']) {
    const control = page.getByRole('button', { name });
    const bounds = await control.boundingBox();
    expect(bounds, `${name} should be rendered`).not.toBeNull();
    expect(bounds?.x ?? -1, `${name} should start inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(
      (bounds?.x ?? Number.POSITIVE_INFINITY) + (bounds?.width ?? Number.POSITIVE_INFINITY),
      `${name} should end inside the viewport`,
    ).toBeLessThanOrEqual(390);
  }
  await axeClean(page);
});

test('runs prompt to Preview to successful deploy using only keyboard controls', async ({
  page,
}) => {
  await mockBuilder(page);
  await mockCreation(page);
  await mockDashboard(page);
  await mockDeployment(page);
  await signIn(page);
  const prompt = page.getByRole('textbox', { name: 'Describe your project' });
  await tabTo(page, prompt);
  await page.keyboard.type('Build an accessible customer portal');
  const create = page.getByRole('button', { name: 'Create project' });
  await tabTo(page, create);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Accessible project' })).toBeVisible();

  const preview = page.getByRole('button', { name: 'Preview' });
  await tabTo(page, preview);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');

  const projects = page.getByRole('link', { name: 'Projects' });
  await tabTo(page, projects);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/projects');

  const deployEntry = page.getByRole('link', { name: 'Deploy Accessible project' });
  await tabTo(page, deployEntry);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/projects/${projectId}/releases`);

  const releaseEntry = page.getByRole('link', { name: releaseId });
  await tabTo(page, releaseEntry);
  await expect(releaseEntry).toBeFocused();
  await releaseEntry.press('Enter');
  await expect(page).toHaveURL(`/projects/${projectId}/releases/${releaseId}`);

  for (const name of ['Deploy', 'Continue', 'Confirm deployment']) {
    const button = page.getByRole('button', { name });
    await tabTo(page, button);
    await page.keyboard.press('Enter');
  }
  await expect(page.getByRole('heading', { name: 'Deployment succeeded' })).toBeVisible();
});

test('reaches and activates the deploy-readiness entry using only keyboard controls', async ({
  page,
}) => {
  await mockDashboard(page);
  await signIn(page);
  const controls = page.getByRole('button', { name: 'Add attachment or controls' });
  await tabTo(page, controls);
  await page.keyboard.press('Enter');
  const importLink = page.getByRole('link', { name: 'Import from GitHub' });
  await tabTo(page, importLink);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Import from GitHub' })).toBeVisible();
  await page.keyboard.press('Escape');

  const deployEntry = page.getByRole('link', { name: 'Deploy Accessible project' });
  await tabTo(page, deployEntry);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/projects/${projectId}/releases`);
});
