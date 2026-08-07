import { expect, test, type Page, type Route } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';

type SupportLevel = 'compatible' | 'verified' | 'managed';

interface ProjectListRequest {
  readonly cursor: string | null;
  readonly organizationId: string | undefined;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}

function project(id: string, name: string, organizationId: string, supportLevel: SupportLevel) {
  return {
    archivedAt: null,
    createdAt: '2026-08-07T12:00:00.000Z',
    createdBy: 'user-ada',
    description: null,
    id,
    name,
    organizationId,
    slug: id,
    sourceType: 'prompt',
    supportLevel,
  } as const;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('Ada Lovelace')).toBeVisible();
}

function projectListResponse(route: Route, body: unknown): Promise<void> {
  return route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    headers: {
      'access-control-allow-credentials': 'true',
      'access-control-allow-origin': appBaseUrl,
    },
    status: 200,
  });
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('switches active organizations and renders only API-backed project card fields', async ({
  page,
}) => {
  const requests: ProjectListRequest[] = [];
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      await route.fallback();
      return;
    }
    const organizationId = request.headers()['x-organization-id'];
    const cursor = new URL(request.url()).searchParams.get('cursor');
    requests.push({ cursor, organizationId });
    await projectListResponse(route, {
      items:
        organizationId === 'org-beta'
          ? [project('beta-console', 'Beta Console', 'org-beta', 'managed')]
          : [project('alpha-portal', 'Alpha Portal', 'org-alpha', 'verified')],
      nextCursor: null,
    });
  });

  await signIn(page);
  await page.goto('/projects');

  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Alpha Portal' })).toBeVisible();
  await expect(page.getByText('Verified')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Alpha Portal' })).toHaveAttribute(
    'href',
    '/projects/alpha-portal',
  );
  await expect(page.getByText('Beta Console')).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Organization' }).selectOption('org-beta');

  await expect(page.getByRole('heading', { name: 'Beta Console' })).toBeVisible();
  await expect(page.getByText('Managed')).toBeVisible();
  await expect(page.getByText('Alpha Portal')).toHaveCount(0);
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        return localStorage.getItem('zapp:selected-organization:user-ada');
      });
    })
    .toBe('org-beta');

  expect(requests).toEqual([
    { cursor: null, organizationId: 'org-alpha' },
    { cursor: null, organizationId: 'org-beta' },
  ]);
  await expect(page.getByText(/last activity/iu)).toHaveCount(0);
  await expect(page.getByText('Preview', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Production', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /deploy/iu })).toHaveCount(0);
});

test('replaces the URL override on organization switch and refreshes into the persisted choice', async ({
  page,
}) => {
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), async (route) => {
    const organizationId = route.request().headers()['x-organization-id'];
    await projectListResponse(route, {
      items:
        organizationId === 'org-beta'
          ? [project('beta-console', 'Beta Console', 'org-beta', 'managed')]
          : [project('alpha-portal', 'Alpha Portal', 'org-alpha', 'verified')],
      nextCursor: null,
    });
  });

  await signIn(page);
  await page.goto('/projects?organizationId=org-alpha&view=grid');
  await expect(page.getByRole('heading', { name: 'Alpha Portal' })).toBeVisible();
  const historyLength = await page.evaluate(() => window.history.length);

  await page.getByRole('combobox', { name: 'Organization' }).selectOption('org-beta');

  await expect(page).toHaveURL('/projects?view=grid');
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  await expect(page.getByRole('heading', { name: 'Beta Console' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL('/projects?view=grid');
  await expect(page.getByRole('heading', { name: 'Beta Console' })).toBeVisible();
});

test('loads the next opaque keyset page once when the grid sentinel enters view', async ({
  page,
}) => {
  const cursors: (string | null)[] = [];
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    cursors.push(cursor);
    await projectListResponse(
      route,
      cursor === null
        ? {
            items: [project('alpha-portal', 'Alpha Portal', 'org-alpha', 'verified')],
            nextCursor: 'cursor-after-alpha',
          }
        : {
            items: [project('mercury-shop', 'Mercury Shop', 'org-alpha', 'compatible')],
            nextCursor: null,
          },
    );
  });

  await signIn(page);
  await page.goto('/projects');

  await expect(page.getByRole('heading', { name: 'Alpha Portal' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Mercury Shop' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Mercury Shop' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /load more/iu })).toHaveCount(0);
  await expect.poll(() => cursors).toEqual([null, 'cursor-after-alpha']);
});

test('ignores stale Alpha pagination across an Alpha to Beta to Alpha switch', async ({ page }) => {
  const staleStarted = deferred();
  const releaseStale = deferred();
  const staleSettled = deferred();
  const freshStarted = deferred();
  const releaseFresh = deferred();
  const requests: ProjectListRequest[] = [];
  let alphaFirstPage = 0;

  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      await route.fallback();
      return;
    }
    const organizationId = request.headers()['x-organization-id'];
    const cursor = new URL(request.url()).searchParams.get('cursor');
    requests.push({ cursor, organizationId });

    if (organizationId === 'org-beta') {
      await projectListResponse(route, {
        items: [project('beta-console', 'Beta Console', 'org-beta', 'managed')],
        nextCursor: null,
      });
      return;
    }
    if (cursor === null) {
      alphaFirstPage += 1;
      await projectListResponse(
        route,
        alphaFirstPage === 1
          ? {
              items: [project('alpha-initial', 'Alpha Initial', 'org-alpha', 'verified')],
              nextCursor: 'alpha-old-cursor',
            }
          : {
              items: [project('alpha-fresh-one', 'Alpha Fresh One', 'org-alpha', 'verified')],
              nextCursor: 'alpha-fresh-cursor',
            },
      );
      return;
    }
    if (cursor === 'alpha-old-cursor') {
      staleStarted.resolve();
      await releaseStale.promise;
      await projectListResponse(route, {
        items: [project('alpha-stale', 'Alpha Stale Page', 'org-alpha', 'compatible')],
        nextCursor: 'alpha-stale-next',
      });
      staleSettled.resolve();
      return;
    }
    if (cursor === 'alpha-fresh-cursor') {
      freshStarted.resolve();
      await releaseFresh.promise;
      await projectListResponse(route, {
        items: [project('alpha-fresh-two', 'Alpha Fresh Two', 'org-alpha', 'compatible')],
        nextCursor: null,
      });
      return;
    }
    if (cursor === 'alpha-stale-next') {
      await projectListResponse(route, {
        items: [project('alpha-skipped', 'Alpha Skipped Page', 'org-alpha', 'compatible')],
        nextCursor: null,
      });
      return;
    }
    throw new Error(`Unexpected project cursor: ${cursor}`);
  });

  await signIn(page);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Alpha Initial' })).toBeVisible();
  await staleStarted.promise;

  const organization = page.getByRole('combobox', { name: 'Organization' });
  await organization.selectOption('org-beta');
  await expect(page.getByRole('heading', { name: 'Beta Console' })).toBeVisible();
  await organization.selectOption('org-alpha');
  await expect(page.getByRole('heading', { name: 'Alpha Fresh One' })).toBeVisible();
  await freshStarted.promise;

  releaseStale.resolve();
  await staleSettled.promise;
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  });
  releaseFresh.resolve();

  await expect(page.getByRole('heading', { name: 'Alpha Fresh Two' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Alpha Stale Page' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Alpha Skipped Page' })).toHaveCount(0);
  expect(requests).toEqual([
    { cursor: null, organizationId: 'org-alpha' },
    { cursor: 'alpha-old-cursor', organizationId: 'org-alpha' },
    { cursor: null, organizationId: 'org-beta' },
    { cursor: null, organizationId: 'org-alpha' },
    { cursor: 'alpha-fresh-cursor', organizationId: 'org-alpha' },
  ]);
});

test('shows a truthful empty state and reuses the WEB-3 composer in the new-project dialog', async ({
  page,
}) => {
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await projectListResponse(route, { items: [], nextCursor: null });
  });

  await signIn(page);
  await page.goto('/projects');

  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Create a new project' });
  await expect(dialog).toBeVisible();
  const composer = dialog.getByRole('textbox', { name: 'Describe your project' });
  const submit = dialog.getByRole('button', { name: 'Create project' });
  await expect(submit).toBeDisabled();
  await composer.fill('Build an agency client portal');
  await expect(submit).toBeEnabled();
  await dialog.getByRole('button', { name: 'Add attachment or controls' }).click();
  await expect(dialog.getByRole('link', { name: 'Import from GitHub' })).toHaveCount(0);
});

test('announces organization-switch loading as polite status', async ({ page }) => {
  const betaStarted = deferred();
  const releaseBeta = deferred();
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), async (route) => {
    const organizationId = route.request().headers()['x-organization-id'];
    if (organizationId === 'org-beta') {
      betaStarted.resolve();
      await releaseBeta.promise;
    }
    await projectListResponse(route, {
      items:
        organizationId === 'org-beta'
          ? [project('beta-console', 'Beta Console', 'org-beta', 'managed')]
          : [project('alpha-portal', 'Alpha Portal', 'org-alpha', 'verified')],
      nextCursor: null,
    });
  });

  await signIn(page);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Alpha Portal' })).toBeVisible();

  await page.getByRole('combobox', { name: 'Organization' }).selectOption('org-beta');
  await betaStarted.promise;
  const status = page.getByRole('status');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveText('Loading projects…');
  releaseBeta.resolve();
  await expect(page.getByRole('heading', { name: 'Beta Console' })).toBeVisible();
});

test('offers only a working Retry when the project list cannot load', async ({ page }) => {
  let attempts = 0;
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    attempts += 1;
    if (attempts > 1) {
      await projectListResponse(route, {
        items: [project('alpha-recovered', 'Alpha Recovered', 'org-alpha', 'verified')],
        nextCursor: null,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        error: {
          code: 'fixture_failure',
          message: 'Fixture failure',
          requestId: 'req-project-list-failure',
        },
      }),
      contentType: 'application/json',
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
      },
      status: 500,
    });
  });

  await signIn(page);
  await page.goto('/projects');

  await expect(page.getByRole('heading', { name: 'We could not load projects.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  for (const unsupportedAction of ['Fix automatically', 'Inspect details', 'Ask the agent']) {
    await expect(page.getByRole('button', { name: unsupportedAction })).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Alpha Recovered' })).toBeVisible();
  expect(attempts).toBe(2);
});
