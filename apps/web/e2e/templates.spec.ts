import { expect, test, type Page, type Route } from '@playwright/test';

import { apiBaseUrl, appBaseUrl } from './support/ports.js';
const template = {
  slug: 'next-starter',
  name: 'Next.js Starter',
  description: 'A clean starter for product apps.',
  pagesIncluded: ['Home', 'Dashboard'],
  highlights: ['Auth pre-built', 'AI included'],
  demoUrl: 'https://templates.zapp.build/next-starter/a57bb2926674/',
  stack: ['Next.js', 'TypeScript'],
} as const;
const project = {
  branches: [{ baseBranchId: null, headCommitSha: null, id: 'branch-template', name: 'main', organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', projectId: 'proj-template', status: 'active' }],
  environments: [],
  project: { archivedAt: null, createdAt: '2026-08-12T12:00:00.000Z', createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG', description: null, id: 'proj-template', name: 'Next.js Starter Remix', organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', slug: 'next-js-starter-remix', sourceType: 'template', supportLevel: 'compatible' },
  repository: { defaultBranch: 'main', externalRepoRef: null, id: 'repo-template', internalRepoRef: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD/proj-template', organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', projectId: 'proj-template', provider: 'forgejo', syncPolicy: 'internal' },
} as const;

function respond(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    headers: { 'access-control-allow-credentials': 'true', 'access-control-allow-origin': appBaseUrl },
    status,
  });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
  await page.route(`${apiBaseUrl}/v1/templates`, async (route) => { await respond(route, { templates: [template] }); });
  await page.route(`${apiBaseUrl}/v1/templates/${template.slug}`, async (route) => { await respond(route, { template }); });
  await page.route(template.demoUrl, async (route) => { await route.fulfill({ body: '<h1>Demo</h1>', contentType: 'text/html' }); });
});

test('renders the public gallery and template detail preview', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/templates');
  await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible();
  await expect(
    page.getByText('Start with a proven foundation, then remix it into your own product.'),
  ).toBeVisible();
  const templateLink = page.getByRole('link', { name: /Next\.js Starter/u });
  await expect(templateLink).toBeVisible({ timeout: 60_000 });
  await templateLink.click();
  await expect(page.getByText('Auth pre-built')).toBeVisible();
  await expect(page.getByText('Dashboard')).toBeVisible();
  await expect(page.getByTitle('Next.js Starter live demo')).toHaveAttribute('src', template.demoUrl);
});

test('remixes by public slug only and seeds the first builder message', async ({ page }) => {
  let requestBody: unknown;
  await page.route(`${apiBaseUrl}/v1/projects`, async (route) => {
    requestBody = route.request().postDataJSON();
    await respond(route, project, 201);
  });
  await page.route(`${apiBaseUrl}/v1/projects/proj-template`, async (route) => { await respond(route, project); });
  await page.route(`${apiBaseUrl}/v1/projects/proj-template/runs`, async (route) => { await respond(route, { items: [], nextCursor: null }); });

  await signIn(page);
  await page.goto(`/templates/${template.slug}`);
  await page.getByRole('button', { name: 'Remix this template' }).click();

  await expect(page).toHaveURL('/projects/proj-template');
  expect(requestBody).toEqual({ name: 'Next.js Starter Remix', sourceType: 'template', templateSlug: 'next-starter' });
  expect(JSON.stringify(requestBody)).not.toContain('repoRef');
  await expect(page.getByText("I'm starting from the Next.js Starter template")).toBeVisible();
});
