import { expect, test, type Page } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const organizationId = 'org_01K27Q9C2W85CMN1V9S6Q3D4FD';

interface E1Status {
  readonly deploymentStages: readonly string[];
  readonly deploys: readonly { readonly releaseId: string }[];
  readonly eventErrors: readonly string[];
  readonly requests: readonly {
    readonly body?: unknown;
    readonly method: string;
    readonly path: string;
    readonly organizationId: string | null;
  }[];
  readonly signals: readonly { readonly signal: string }[];
  readonly starts: readonly { readonly mode: string; readonly prompt: string }[];
  readonly taskPrompts: readonly { readonly taskId: string; readonly prompt: string }[];
  readonly workflowOutcomes: readonly unknown[];
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('Ada Lovelace')).toBeVisible();
}

test('takes one signed-in user through the real public API from prompt to deployed app', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const initialPrompt = 'Build a friendly appointment scheduler for neighborhood clinics.';
  const iteration = 'Make the booking confirmation warmer and easier to scan.';
  const previewRequests: Array<{ method: string; path: string }> = [];
  let previewSessionCookie: string | undefined;

  await page.request.get(`${apiBaseUrl}/__reset`);
  await page.route('https://app.e1.test/**', async (route) => {
    const publicUrl = new URL(route.request().url());
    const response = await route.fetch({
      url: `http://127.0.0.1:3100${publicUrl.pathname}${publicUrl.search}`,
    });
    await route.fulfill({ response });
  });
  await page.route(`${apiBaseUrl}/**`, async (route) => {
    if (!route.request().frame().url().startsWith('https://app.e1.test/')) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await page.route('https://*.preview.e1.test/**', async (route) => {
    const publicUrl = new URL(route.request().url());
    previewRequests.push({ method: route.request().method(), path: publicUrl.pathname });
    const response = await route.fetch({
      url: `${apiBaseUrl}${publicUrl.pathname}${publicUrl.search}`,
      headers: {
        ...route.request().headers(),
        host: publicUrl.host,
        ...(previewSessionCookie === undefined ? {} : { cookie: previewSessionCookie }),
      },
    });
    const headers = response.headers();
    const setCookie = response.headersArray().find(
      ({ name }) => name.toLowerCase() === 'set-cookie',
    )?.value;
    if (setCookie !== undefined) {
      const [credential] = setCookie.split(';', 1);
      const separator = credential?.indexOf('=') ?? -1;
      if (credential !== undefined && separator > 0) {
        previewSessionCookie = credential;
        await page.context().addCookies([{
          name: credential.slice(0, separator),
          value: credential.slice(separator + 1),
          url: publicUrl.origin,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        }]);
      }
    }
    delete headers['content-encoding'];
    delete headers['content-length'];
    await route.fulfill({
      status: response.status(),
      headers,
      body: await response.body(),
    });
  });

  await signIn(page);
  const sessionCookies = (await page.context().cookies()).filter(({ name }) =>
    name === 'zapp_session' || name === 'zapp_csrf');
  await page.context().addCookies(sessionCookies.flatMap((cookie) => [
    {
      name: cookie.name,
      value: cookie.value,
      domain: 'app.e1.test',
      path: '/',
      httpOnly: cookie.httpOnly,
      secure: true,
      sameSite: 'None' as const,
    },
    {
      name: cookie.name,
      value: cookie.value,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: cookie.httpOnly,
      secure: true,
      sameSite: 'None' as const,
    },
  ]));
  await page.goto(`/?organizationId=${organizationId}`);
  await expect(page.getByText('Selected organization: Alpha Org', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add attachment or controls' }).click();
  await page.getByRole('button', { name: 'Auto ▸' }).click();
  await page.getByRole('radio', { name: 'Autonomous' }).check();
  await page.getByLabel('Describe your project').fill(initialPrompt);
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page).toHaveURL(/\/projects\/proj_[0-9A-HJKMNP-TV-Z]{26}$/u);
  const builderUrl = page.url();
  await expect(page.getByText(initialPrompt)).toBeVisible();

  let answeredCards = 0;
  for (;;) {
    const startBuilding = page.getByRole('button', { name: 'Start building' });
    if (await startBuilding.isVisible()) break;
    const form = page.getByLabel('Agent questions').nth(answeredCards);
    await expect(form).toBeVisible();
    const fieldsets = form.locator('fieldset');
    for (let index = 0; index < await fieldsets.count(); index += 1) {
      await fieldsets.nth(index).getByRole('radio').first().check();
    }
    await form.getByRole('button', { name: 'Submit answers' }).click();
    await expect(form.getByText('Answers submitted.')).toBeVisible();
    answeredCards += 1;
    await expect.poll(async () =>
      await startBuilding.isVisible() ||
      await page.getByLabel('Agent questions').count() > answeredCards,
    ).toBe(true);
  }
  await page.getByRole('button', { name: 'Start building' }).click();
  await page.getByRole('button', { name: 'Approve plan' }).click();

  await expect.poll(async () => {
    const response = await page.request.get(`${apiBaseUrl}/__e1`);
    const raw: unknown = await response.json();
    return {
      eventErrors: (raw as E1Status).eventErrors,
      iframeCount: await page.locator('iframe').count(),
      previewLoaded: previewRequests.some(
        ({ method, path }) => method === 'GET' && path === '/',
      ),
    };
  }, { timeout: 15_000 }).toEqual({ eventErrors: [], iframeCount: 1, previewLoaded: true });
  await expect(
    page.frameLocator('iframe').getByRole('heading', { name: 'Authenticated clinic preview' }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Mission Control' }).click();
  await page.getByLabel('Redirect instructions').fill(iteration);
  await page.getByRole('button', { name: 'Redirect', exact: true }).click();
  await expect(page.getByText('Redirect applied.')).toBeVisible();

  await expect.poll(async () => {
    const response = await page.request.get(`${apiBaseUrl}/__e1`);
    const raw: unknown = await response.json();
    const status = raw as E1Status;
    return {
      changedTaskRan: status.taskPrompts.some(({ prompt }) => prompt.includes(iteration)),
      eventErrors: status.eventErrors,
      workflowOutcomes: status.workflowOutcomes.length,
    };
  }).toEqual({ changedTaskRan: true, eventErrors: [], workflowOutcomes: 1 });

  await expect(page.getByRole('button', { name: 'Deploy' })).toBeEnabled();
  await page.getByRole('button', { name: 'Deploy' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to deploy' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Confirm deployment' }).click();
  await expect(page.getByRole('heading', { name: 'Deployment succeeded' })).toBeVisible();

  expect(page.url()).toBe(builderUrl);
  await expect(page.getByText(/terminal/iu)).toHaveCount(0);

  const statusResponse = await page.request.get(`${apiBaseUrl}/__e1`);
  const rawStatus: unknown = await statusResponse.json();
  const status = rawStatus as E1Status;
  expect(status.starts).toEqual([
    expect.objectContaining({ mode: 'autonomous', prompt: initialPrompt }),
  ]);
  expect(status.signals.filter(({ signal }) => signal === 'conversation_card_response')).toHaveLength(
    answeredCards,
  );
  expect(status.signals.map(({ signal }) => signal)).toEqual(
    expect.arrayContaining(['approval_decision', 'redirect']),
  );
  expect(status.deploys).toHaveLength(1);
  const approvalRequestIndex = status.requests.findIndex(({ method, path }) =>
    method === 'POST' && /^\/v1\/releases\/rel_[^/]+\/approve$/u.test(path));
  const deployRequestIndex = status.requests.findIndex(({ method, path }) =>
    method === 'POST' && /^\/v1\/releases\/rel_[^/]+\/deploy$/u.test(path));
  expect(approvalRequestIndex).toBeGreaterThanOrEqual(0);
  expect(deployRequestIndex).toBeGreaterThan(approvalRequestIndex);
  expect(status.deploymentStages).toEqual([
    'readiness_check',
    'build_artifact',
    'configure_secrets',
    'apply_migrations',
    'provision_runtime',
    'start_services',
    'production_health_check',
    'go_live',
  ]);
  expect(previewRequests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: 'POST', path: '/v1/preview/session' }),
      expect.objectContaining({ method: 'GET', path: '/' }),
    ]),
  );
  expect(
    status.requests.find(({ path }) =>
      /^\/v1\/organizations\/org_[^/]+\/preview-shares\/[^/]+\/sessions$/u.test(path)),
  ).toMatchObject({ method: 'POST' });
  expect(status.requests.find(({ method, path }) => method === 'POST' && path === '/v1/projects')).toMatchObject({
    body: {
      name: 'Friendly Appointment Scheduler',
      sourceType: 'prompt',
    },
    method: 'POST',
    organizationId,
  });
  expect(
    status.requests.find(({ path }) => /^\/v1\/projects\/proj_[^/]+\/runs$/u.test(path)),
  ).toMatchObject({
    body: expect.objectContaining({ mode: 'autonomous', prompt: initialPrompt }),
    method: 'POST',
    organizationId,
  });
});
