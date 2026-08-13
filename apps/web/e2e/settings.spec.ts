import { expect, test, type Page, type Route } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
}

function apiResponse(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    body: JSON.stringify(body), contentType: 'application/json', status,
    headers: { 'access-control-allow-credentials': 'true', 'access-control-allow-origin': appBaseUrl },
  });
}

const project = {
  id: 'proj_01J00000000000000000000000', organizationId: 'org-alpha', name: 'Alpha Settings',
  slug: 'alpha-settings', description: null, sourceType: 'prompt', supportLevel: 'compatible',
  createdBy: 'user-ada', createdAt: '2026-08-12T12:00:00.000Z', archivedAt: null,
};
const environment = {
  id: 'env_01J00000000000000000000000', organizationId: 'org-alpha', projectId: project.id,
  name: 'production', type: 'production', deploymentProvider: null, databaseConnectionId: null,
  createdAt: '2026-08-12T12:00:00.000Z',
};

test('writes a secret once and never renders or receives its value back', async ({ page }) => {
  let metadata: unknown[] = [];
  const secretValue = 'write-only-browser-fixture';
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/${project.id}$`, 'u'), (route) => apiResponse(route, { project, repository: null, branches: [], environments: [environment] }));
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/${project.id}/integrations/github$`, 'u'), (route) => apiResponse(route, { projectId: project.id, externalRepoRef: null, syncPolicy: 'pull_request', branch: null, internalHeadSha: null, externalHeadSha: null, state: null, blockedTaskIds: [], conflictTaskId: null, updatedAt: null }));
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/${project.id}/secrets(?:\\?.*)?$`, 'u'), async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toMatchObject({ name: 'API_TOKEN', value: secretValue });
      metadata = [{ id: 'sec_01J00000000000000000000000', organizationId: 'org-alpha', projectId: project.id, environmentId: null, name: 'API_TOKEN', createdBy: 'user-ada', createdAt: '2026-08-12T12:00:00.000Z', rotatedAt: null, keyVersion: 1 }];
      await apiResponse(route, { secret: metadata[0] }, 201);
      return;
    }
    await apiResponse(route, { items: metadata, nextCursor: null });
  });

  await signIn(page);
  await page.goto(`/projects/${project.id}/settings/secrets`);
  await page.getByLabel('Name').fill('API_TOKEN');
  await page.getByLabel('Secret value').fill(secretValue);
  await page.getByRole('button', { name: 'Add secret' }).click();
  await expect(page.getByText('API_TOKEN', { exact: true })).toBeVisible();
  await expect(page.getByText(secretValue)).toHaveCount(0);
});

test('keeps viewer settings read-only', async ({ page }) => {
  await page.route(`${apiBaseUrl}/v1/me`, (route) => apiResponse(route, {
    user: { id: 'user-viewer', email: 'viewer@example.test', displayName: 'Vera Viewer', avatarUrl: null },
    memberships: [{ allowedModels: [], organization: { id: 'org-viewer', name: 'Viewer Org', slug: 'viewer' }, role: 'viewer', status: 'active' }],
  }));
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/${project.id}$`, 'u'), (route) => apiResponse(route, { project, repository: null, branches: [], environments: [environment] }));
  await signIn(page);
  await page.goto(`/projects/${project.id}/settings/general`);
  await expect(page.getByText('Viewer access is read-only.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive project' })).toHaveCount(0);
});
