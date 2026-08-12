import { expect, test, type Page, type Route } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';
const organizationId = 'org_01J00000000000000000000000';
const projectId = 'proj_01J0000000000000000000000';
const runId = 'run_01J00000000000000000000000';
const workspaceId = 'ws_01J000000000000000000000000';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
}

function apiResponse(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    headers: {
      'access-control-allow-credentials': 'true',
      'access-control-allow-origin': appBaseUrl,
    },
    status,
  });
}

function overview() {
  return {
    organization: { id: organizationId, name: 'Acme Labs', slug: 'acme', plan: 'studio' },
    projects: [
      {
        id: projectId,
        name: 'Customer Portal',
        slug: 'customer-portal',
        supportLevel: 'managed',
        archivedAt: null,
        lastActivityAt: '2026-08-12T08:00:00.000Z',
        releaseStatus: 'ready',
        deploymentStatus: 'healthy',
        runs: [
          {
            id: runId,
            projectId,
            mode: 'build',
            status: 'running',
            startedAt: '2026-08-12T08:00:00.000Z',
            completedAt: null,
          },
        ],
        workspaces: [
          {
            id: workspaceId,
            projectId,
            runId,
            provider: 'modal',
            status: 'active',
            resourceProfile: 'standard',
            createdAt: '2026-08-12T08:00:00.000Z',
            lastActiveAt: '2026-08-12T08:05:00.000Z',
            terminatedAt: null,
          },
        ],
      },
    ],
    usage: {
      byCategory: [{ category: 'model_tokens', quantity: '42.0000' }],
      byProject: [{ projectId, quantity: '42.0000' }],
      byRun: [{ runId, quantity: '42.0000' }],
    },
  } as const;
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('requires an explicit reason and renders audited tenant diagnostics without source access', async ({
  page,
}) => {
  let started = 0;
  await page.route(`${apiBaseUrl}/v1/admin/support-sessions`, async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as { organizationId?: string; reason?: string };
    expect(body).toEqual({ organizationId, reason: 'Investigate failed customer deployment' });
    expect(request.headers()['idempotency-key']).toBeTruthy();
    expect(request.headers()['x-zapp-csrf']).toBeTruthy();
    started += 1;
    await apiResponse(
      route,
      {
        id: 'support_0123456789abcdef0123456789abcdef',
        token: 'signed-support-session',
        organizationId,
        expiresAt: '2026-08-12T08:30:00.000Z',
      },
      201,
    );
  });
  await page.route(
    new RegExp(`${apiBaseUrl}/v1/admin/organizations/${organizationId}/overview\\?.*`, 'u'),
    async (route) => {
      expect(route.request().headers()['x-zapp-support-session']).toBe('signed-support-session');
      await apiResponse(route, overview());
    },
  );
  await page.route(
    `${apiBaseUrl}/v1/admin/organizations/${organizationId}/runs/${runId}/diagnostics`,
    async (route) => {
      expect(route.request().headers()['x-zapp-support-session']).toBe('signed-support-session');
      await apiResponse(route, {
        run: overview().projects[0].runs[0],
        events: [
          {
            id: 'evt_01J00000000000000000000000',
            sequence: 7,
            type: 'tool.failed',
            occurredAt: '2026-08-12T08:10:00.000Z',
            phaseId: null,
            taskId: null,
            agentId: null,
            payload: { tool: 'deploy', summary: 'Provider timeout' },
          },
        ],
        artifacts: [
          {
            id: 'art_01J00000000000000000000000',
            type: 'test_report',
            contentHash: 'a'.repeat(64),
            createdAt: '2026-08-12T08:11:00.000Z',
          },
        ],
        sourceInspection: { allowed: false, requiresCustomerGrant: true },
      });
    },
  );

  await signIn(page);
  await page.goto('/admin');
  await expect(page.getByRole('button', { name: 'Start support session' })).toBeDisabled();
  await page.getByLabel('Customer organization ID').fill(organizationId);
  await page.getByLabel('Support reason').fill('Investigate failed customer deployment');
  await page.getByRole('button', { name: 'Start support session' }).click();

  await expect(page.getByRole('heading', { name: 'Acme Labs' })).toBeVisible();
  await expect(page.getByText('Customer Portal')).toBeVisible();
  await expect(page.getByText('model_tokens: 42.0000')).toBeVisible();
  await expect(page.getByText('Source inspection is unavailable without a customer grant.')).toBeVisible();
  await page.getByRole('button', { name: `Inspect ${runId}` }).click();
  await expect(page.getByText('tool.failed')).toBeVisible();
  await expect(page.getByText('test_report')).toBeVisible();
  await expect(page.getByText('Provider timeout')).toBeVisible();
  await expect(page.getByText(/storageRef|secret|source code/iu)).toHaveCount(0);
  expect(started).toBe(1);
});

test('terminates runs and workspaces through exact-key support actions', async ({ page }) => {
  const mutations: Array<{ headers: Record<string, string>; path: string }> = [];
  await page.route(`${apiBaseUrl}/v1/admin/support-sessions`, (route) =>
    apiResponse(
      route,
      {
        id: 'support_0123456789abcdef0123456789abcdef',
        token: 'signed-support-session',
        organizationId,
        expiresAt: '2026-08-12T08:30:00.000Z',
      },
      201,
    ),
  );
  await page.route(
    new RegExp(`${apiBaseUrl}/v1/admin/organizations/${organizationId}/overview\\?.*`, 'u'),
    (route) => apiResponse(route, overview()),
  );
  await page.route(
    new RegExp(`${apiBaseUrl}/v1/admin/organizations/${organizationId}/(?:runs|workspaces)/.*?/terminate`, 'u'),
    async (route) => {
      const request = route.request();
      mutations.push({ headers: request.headers(), path: new URL(request.url()).pathname });
      if (request.url().includes('/runs/')) {
        await apiResponse(route, { run: { ...overview().projects[0].runs[0], status: 'running' } }, 202);
      } else {
        await apiResponse(route, {
          workspace: { ...overview().projects[0].workspaces[0], status: 'terminated' },
        });
      }
    },
  );
  await page.route(
    `${apiBaseUrl}/v1/admin/organizations/${organizationId}/terminate-all`,
    async (route) => {
      const request = route.request();
      mutations.push({ headers: request.headers(), path: new URL(request.url()).pathname });
      await apiResponse(route, { terminated: 3 });
    },
  );

  await signIn(page);
  await page.goto('/admin');
  await page.getByLabel('Customer organization ID').fill(organizationId);
  await page.getByLabel('Support reason').fill('Customer requested resource termination');
  await page.getByRole('button', { name: 'Start support session' }).click();
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: `Terminate ${runId}` }).click();
  await page.getByRole('button', { name: `Terminate ${workspaceId}` }).click();
  await page.getByRole('button', { name: 'Terminate all sandboxes' }).click();

  await expect.poll(() => mutations.length).toBe(3);
  for (const mutation of mutations) {
    expect(mutation.headers['x-zapp-support-session']).toBe('signed-support-session');
    expect(mutation.headers['x-zapp-csrf']).toBeTruthy();
    expect(mutation.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
  }
  expect(new Set(mutations.map((mutation) => mutation.headers['idempotency-key'])).size).toBe(3);
});
