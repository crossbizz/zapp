import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { checkA11y, injectAxe } from 'axe-playwright';

const apiPort = Number(process.env['ZAPP_WEB_E2E_API_PORT'] ?? 4100);
const appPort = Number(process.env['ZAPP_WEB_E2E_APP_PORT'] ?? 3100);
const apiBaseUrl = `http://127.0.0.1:${String(apiPort)}`;
const appBaseUrl = `http://127.0.0.1:${String(appPort)}`;
const projectId = 'project-a11y';
const builderFixture = {
  branches: [
    {
      baseBranchId: null,
      headCommitSha: null,
      id: 'branch-main',
      name: 'main',
      organizationId: 'org-alpha',
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
      organizationId: 'org-alpha',
      projectId,
      type: 'preview',
    },
  ],
  project: {
    archivedAt: null,
    createdAt: '2026-08-12T12:00:00.000Z',
    createdBy: 'user-ada',
    description: null,
    id: projectId,
    name: 'Accessible project',
    organizationId: 'org-alpha',
    slug: projectId,
    sourceType: 'prompt',
    supportLevel: 'verified',
  },
  repository: {
    defaultBranch: 'main',
    externalRepoRef: null,
    id: 'repo-a11y',
    internalRepoRef: 'org-alpha/project-a11y',
    organizationId: 'org-alpha',
    projectId,
    provider: 'forgejo',
    syncPolicy: 'internal',
  },
} as const;

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
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
          createdBy: 'user-ada',
          description: null,
          id: projectId,
          name: 'Accessible project',
          organizationId: 'org-alpha',
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
          organizationId: 'org-alpha',
          projectId,
          startedAt: '2026-08-12T12:00:01.000Z',
          startedBy: 'user-ada',
          status: 'queued',
        },
      },
      201,
    );
  });
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('keeps home, dashboard, builder, and deploy-readiness entry axe clean', async ({ page }) => {
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

test('creates a project and activates Preview using only keyboard controls', async ({ page }) => {
  await mockBuilder(page);
  await mockCreation(page);
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
