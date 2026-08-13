import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

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
  id: 'proj_01J00000000000000000000000', organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', name: 'Alpha Settings',
  slug: 'alpha-settings', description: null, sourceType: 'prompt', supportLevel: 'compatible',
  createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG', createdAt: '2026-08-12T12:00:00.000Z', archivedAt: null,
};
const environment = {
  id: 'env_01J00000000000000000000000', organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', projectId: project.id,
  name: 'production', type: 'production', deploymentProvider: null, databaseConnectionId: null,
  createdAt: '2026-08-12T12:00:00.000Z',
};

const organizationId = project.organizationId;

function projectResponse(): unknown {
  return { branches: [], environments: [environment], project, repository: null };
}

async function routeProject(page: Page): Promise<void> {
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/projects/${project.id}$`, 'u'),
    (route) => apiResponse(route, projectResponse()),
  );
}

function integrationCard(page: Page, title: string): Locator {
  return page.locator('article').filter({
    has: page.getByRole('heading', { exact: true, name: title }),
  });
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('writes a secret once and never renders or receives its value back', async ({ page }) => {
  let metadata: unknown[] = [];
  const secretValue = 'write-only-browser-fixture';
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/${project.id}$`, 'u'), (route) => apiResponse(route, { project, repository: null, branches: [], environments: [environment] }));
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/${project.id}/integrations/github$`, 'u'), (route) => apiResponse(route, { projectId: project.id, externalRepoRef: null, syncPolicy: 'pull_request', branch: null, internalHeadSha: null, externalHeadSha: null, state: null, blockedTaskIds: [], conflictTaskId: null, updatedAt: null }));
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/${project.id}/secrets(?:\\?.*)?$`, 'u'), async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toMatchObject({ name: 'API_TOKEN', value: secretValue });
      metadata = [{ id: 'sec_01J00000000000000000000000', organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', projectId: project.id, environmentId: null, name: 'API_TOKEN', createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG', createdAt: '2026-08-12T12:00:00.000Z', rotatedAt: null, keyVersion: 1 }];
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
  await expect(page.getByRole('link', { name: 'Members' })).toHaveCount(0);
});

test('renders the exact supported catalog, deep links, and clears failed credentials', async ({
  page,
}) => {
  const secret = 'supabase-browser-secret';
  const consoleMessages: string[] = [];
  const analyticsBodies: string[] = [];
  let recordedResponseBody = '';
  let idempotencyKey = '';
  page.on('console', (message) => {
    consoleMessages.push(message.text());
  });
  page.on('request', (request) => {
    if (/analytics|events|posthog/iu.test(request.url())) {
      analyticsBodies.push(request.postData() ?? '');
    }
  });
  await routeProject(page);
  await page.route(`${apiBaseUrl}/v1/integrations`, (route) => (
    apiResponse(route, { connections: [] })
  ));
  await page.route(`${apiBaseUrl}/v1/integrations/supabase/connect`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      accessToken: secret,
      configuration: { projectRef: 'studio-ref' },
      projectId: project.id,
    });
    idempotencyKey = route.request().headers()['idempotency-key'] ?? '';
    recordedResponseBody = JSON.stringify({
      error: {
        code: 'provider_unavailable',
        message: 'The provider is unavailable.',
        requestId: 'req_settings_failure',
      },
    });
    await apiResponse(route, JSON.parse(recordedResponseBody) as unknown, 503);
  });

  await signIn(page);
  await page.goto(`/projects/${project.id}/settings/integrations`);

  for (const provider of ['GitHub', 'Supabase', 'Neon', 'Stripe', 'Vercel']) {
    await expect(integrationCard(page, provider)).toBeVisible();
  }
  await expect(page.getByText('Not connected', { exact: true })).toHaveCount(5);
  for (const provider of ['ChatGPT', 'Claude', 'Gemini', 'Twilio', 'PayPal', 'Razorpay']) {
    await expect(page.getByText(provider, { exact: true })).toHaveCount(0);
  }
  for (const [section, label] of [
    ['general', 'General'],
    ['secrets', 'Secrets'],
    ['integrations', 'Integrations'],
    ['payments', 'Payments'],
    ['members', 'Members'],
    ['github', 'GitHub'],
  ] as const) {
    await expect(page.getByRole('link', { name: label, exact: true })).toHaveAttribute(
      'href',
      `/projects/${project.id}/settings/${section}`,
    );
  }

  await integrationCard(page, 'Supabase').getByRole('button', { name: 'Connect' }).click();
  const accessToken = page.getByLabel('supabase access token');
  await accessToken.fill(secret);
  await page.getByLabel('supabase project ref').fill('studio-ref');
  await page.getByRole('button', { name: 'Connect Supabase' }).click();

  await expect(page.getByText('The change could not be saved.')).toBeVisible();
  await expect(accessToken).toHaveValue('');
  await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
  expect(idempotencyKey).not.toBe('');
  expect(recordedResponseBody).not.toContain(secret);
  expect(consoleMessages.join('\n')).not.toContain(secret);
  expect(analyticsBodies.join('\n')).not.toContain(secret);
});

test('keeps embedded Manage integration mutations on the public API and clears credentials', async ({
  page,
}) => {
  const secret = 'embedded-supabase-secret';
  let idempotencyKey = '';
  await routeProject(page);
  await page.route(`${apiBaseUrl}/v1/integrations`, (route) => (
    apiResponse(route, { connections: [] })
  ));
  await page.route(`${apiBaseUrl}/v1/integrations/supabase/connect`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      accessToken: secret,
      configuration: { projectRef: 'embedded-ref' },
      projectId: project.id,
    });
    idempotencyKey = route.request().headers()['idempotency-key'] ?? '';
    await apiResponse(route, {
      error: {
        code: 'provider_unavailable',
        message: 'The provider is unavailable.',
        requestId: 'req_embedded_settings_failure',
      },
    }, 503);
  });

  await signIn(page);
  await page.goto(
    `/projects/${project.id}?mode=manage&view=preview&section=integrations&pane=workspace`,
  );
  await expect(page.getByRole('heading', { name: 'Alpha Settings settings' })).toBeVisible();
  await integrationCard(page, 'Supabase').getByRole('button', { name: 'Connect' }).click();
  const accessToken = page.getByLabel('supabase access token');
  await accessToken.fill(secret);
  await page.getByLabel('supabase project ref').fill('embedded-ref');
  await page.getByRole('button', { name: 'Connect Supabase' }).click();

  await expect(page.getByText('The change could not be saved.')).toBeVisible();
  await expect(accessToken).toHaveValue('');
  await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
  await expect(page).toHaveURL(
    new RegExp(`/projects/${project.id}\\?mode=manage&section=integrations&pane=workspace$`, 'u'),
  );
  expect(idempotencyKey).not.toBe('');
});

test('keeps embedded Manage settings read-only for viewers', async ({ page }) => {
  await page.route(`${apiBaseUrl}/v1/me`, (route) => apiResponse(route, {
    user: { id: 'user-viewer', email: 'viewer@example.test', displayName: 'Vera Viewer', avatarUrl: null },
    memberships: [{ allowedModels: [], organization: { id: organizationId, name: 'Viewer Org', slug: 'viewer' }, role: 'viewer', status: 'active' }],
  }));
  await routeProject(page);

  await signIn(page);
  await page.goto(
    `/projects/${project.id}?mode=manage&view=preview&section=general&pane=workspace`,
  );

  await expect(page.getByText('Viewer access is read-only.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive project' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Members', exact: true })).toHaveCount(0);
});

test('connects and disconnects through public integration APIs without retaining credentials', async ({
  page,
}) => {
  const secret = 'vercel-browser-secret';
  const connection = {
    configuration: { projectId: 'vercel-project', projectName: 'alpha-web' },
    id: 'integration_vercel_fixture',
    organizationId,
    projectId: project.id,
    provider: 'vercel',
    status: 'connected',
  } as const;
  let connections: readonly (typeof connection)[] = [];
  let connectKey = '';
  let disconnectKey = '';
  await routeProject(page);
  await page.route(`${apiBaseUrl}/v1/integrations`, (route) => (
    apiResponse(route, { connections })
  ));
  await page.route(`${apiBaseUrl}/v1/integrations/vercel/connect`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      accessToken: secret,
      configuration: { projectId: 'vercel-project', projectName: 'alpha-web' },
      projectId: project.id,
    });
    connectKey = route.request().headers()['idempotency-key'] ?? '';
    connections = [connection];
    await apiResponse(route, { connection: { ...connection, credentialRef: 'vault://redacted' } }, 201);
  });
  await page.route(
    `${apiBaseUrl}/v1/integrations/${connection.id}`,
    async (route) => {
      disconnectKey = route.request().headers()['idempotency-key'] ?? '';
      connections = [];
      await route.fulfill({
        headers: {
          'access-control-allow-credentials': 'true',
          'access-control-allow-origin': appBaseUrl,
        },
        status: 204,
      });
    },
  );

  await signIn(page);
  await page.goto(`/projects/${project.id}/settings/integrations`);
  await integrationCard(page, 'Vercel').getByRole('button', { name: 'Connect' }).click();
  await page.getByLabel('vercel access token').fill(secret);
  await page.getByLabel('vercel project id').fill('vercel-project');
  await page.getByLabel('vercel project name').fill('alpha-web');
  await page.getByRole('button', { name: 'Connect Vercel' }).click();

  await expect(integrationCard(page, 'Vercel').getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.getByText('Vercel connected.', { exact: true })).toBeVisible();
  expect(connectKey).not.toBe('');
  await integrationCard(page, 'Vercel').getByRole('button', { name: 'Disconnect' }).click();
  await expect(integrationCard(page, 'Vercel').getByText('Not connected', { exact: true })).toBeVisible();
  await expect(page.getByText('Vercel disconnected.', { exact: true })).toBeVisible();
  expect(disconnectKey).not.toBe('');

  await integrationCard(page, 'Vercel').getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByLabel('vercel access token')).toHaveValue('');
  await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
});

test('separates application Stripe from zapp.build account billing', async ({ page }) => {
  await routeProject(page);
  await page.route(`${apiBaseUrl}/v1/integrations`, (route) => (
    apiResponse(route, { connections: [] })
  ));

  await signIn(page);
  await page.goto(`/projects/${project.id}/settings/payments`);

  await expect(page.getByRole('heading', { name: 'Application payments' })).toBeVisible();
  await expect(integrationCard(page, 'Stripe')).toBeVisible();
  await expect(page.getByText(
    'Connect Stripe to payments inside this generated application.',
  )).toBeVisible();
  await expect(page.getByRole('heading', { name: 'zapp.build account billing' })).toBeVisible();
  await expect(page.getByText('Manage your zapp.build plan, seats, credits, and invoices separately.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open account Billing' })).toHaveAttribute(
    'href',
    '/org/billing',
  );
  await expect(integrationCard(page, 'GitHub')).toHaveCount(0);
});

test('shows owner members and builder project controls at their exact permission boundaries', async ({
  page,
}) => {
  await routeProject(page);
  await page.route(`${apiBaseUrl}/v1/organizations/${organizationId}/members`, (route) => (
    apiResponse(route, {
      members: [{
        role: 'owner',
        status: 'active',
        user: {
          avatarUrl: null,
          displayName: 'Owner One',
          email: 'owner@example.test',
          id: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
        },
      }],
      pendingInvites: [],
    })
  ));
  await page.route(`${apiBaseUrl}/v1/organizations/${organizationId}/settings`, (route) => (
    apiResponse(route, { settings: { builderCanDeploy: true } })
  ));
  await signIn(page);
  await page.goto(`/projects/${project.id}/settings/members`);
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
  await expect(page.getByText('Owner One')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Invite email' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Builders can deploy' })).toBeChecked();

  await page.unrouteAll({ behavior: 'wait' });
  await page.route(`${apiBaseUrl}/v1/me`, (route) => apiResponse(route, {
    memberships: [{
      allowedModels: [],
      organization: { id: organizationId, name: 'Alpha Org', slug: 'alpha' },
      role: 'builder',
      status: 'active',
    }],
    user: {
      avatarUrl: null,
      displayName: 'Bill Builder',
      email: 'builder@example.test',
      id: 'user_01K27Q9C2W85CMN1V9S6Q3D4FH',
    },
  }));
  await routeProject(page);
  await page.reload();
  await page.goto(`/projects/${project.id}/settings/general`);

  await expect(page.getByRole('button', { name: 'Archive project' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete project' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Members', exact: true })).toHaveCount(0);
});
