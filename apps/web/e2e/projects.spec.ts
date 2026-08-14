import { expect, test, type Page, type Route } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';

type SupportLevel = 'compatible' | 'verified' | 'managed';

interface ProjectListRequest {
  readonly cursor: string | null;
  readonly organizationId: string | undefined;
}

interface ProjectSummaryRequest {
  readonly organizationId: string | undefined;
  readonly projectIds: readonly string[];
}

interface ObservedMutation {
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly url: string;
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
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
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
  const projectListPattern = new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u');
  let homeListHandled = false;
  const handleHomeList = async (route: Route): Promise<void> => {
    if (route.request().method() !== 'GET' || homeListHandled) {
      await route.fallback();
      return;
    }
    homeListHandled = true;
    await projectListResponse(route, { items: [], nextCursor: null });
  };
  await page.route(projectListPattern, handleHomeList);
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('Ada Lovelace')).toBeVisible();
  await expect.poll(() => homeListHandled).toBe(true);
  await page.unroute(projectListPattern, handleHomeList);
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

function summary(
  projectId: string,
  input: {
    readonly deployReadiness: null | {
      readonly findings: readonly {
        readonly action: 'fix_and_recheck' | 'review' | 'waive';
        readonly detail: string;
        readonly id: string;
        readonly severity: 'blocker' | 'warning';
        readonly title: string;
      }[];
      readonly releaseId: string;
      readonly state: 'blocked' | 'ready' | 'warnings';
    };
    readonly lastActivityAt: string | null;
    readonly preview: {
      readonly occurredAt: string | null;
      readonly status: 'failed' | 'not_started' | 'ready' | 'starting';
    };
    readonly previewThumbnail?: null | {
      readonly alt: string;
      readonly artifactId: string;
      readonly capturedAt: string;
      readonly contentHash: string;
    };
    readonly production: {
      readonly occurredAt: string | null;
      readonly releaseId: string | null;
      readonly status: 'deploying' | 'failed' | 'healthy' | 'not_deployed';
    };
  },
) {
  return { projectId, ...input, previewThumbnail: input.previewThumbnail ?? null };
}

function mutation(route: Route): ObservedMutation {
  const request = route.request();
  return {
    body: request.postDataJSON(),
    headers: request.headers(),
    url: request.url(),
  };
}

function importedProjectFixture(projectId = 'proj-import') {
  return {
    branches: [
      {
        baseBranchId: null,
        headCommitSha: null,
        id: `branch-${projectId}`,
        name: 'main',
        organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
        projectId,
        status: 'active',
      },
    ],
    environments: [],
    project: {
      archivedAt: null,
      createdAt: '2026-08-10T20:00:00.000Z',
      createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
      description: null,
      id: projectId,
      name: 'ada/portal',
      organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
      slug: projectId,
      sourceType: 'github_import',
      supportLevel: 'compatible',
    },
    repository: {
      defaultBranch: 'main',
      externalRepoRef: null,
      id: `repo-${projectId}`,
      internalRepoRef: `org_01K27Q9C2W85CMN1V9S6Q3D4FD/${projectId}`,
      organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
      projectId,
      provider: 'forgejo',
      syncPolicy: 'internal',
    },
  } as const;
}

async function emptyProjects(page: Page): Promise<void> {
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await projectListResponse(route, { items: [], nextCursor: null });
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
        organizationId === 'org_01K27Q9C2W85CMN1V9S6Q3D4FE'
          ? [project('beta-console', 'Beta Console', 'org_01K27Q9C2W85CMN1V9S6Q3D4FE', 'managed')]
          : [project('alpha-portal', 'Alpha Portal', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'verified')],
      nextCursor: null,
    });
  });

  await signIn(page);
  await page.goto('/projects');

  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Projects' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'New project' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import from GitHub' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse templates' })).toHaveAttribute(
    'href',
    '/templates',
  );
  await expect(page.getByRole('heading', { name: 'Alpha Portal' })).toBeVisible();
  await expect(page.getByLabel('Preview unavailable for Alpha Portal')).toBeVisible();
  await expect(page.getByText('Verified')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Alpha Portal' })).toHaveAttribute(
    'href',
    '/projects/alpha-portal',
  );
  await expect(page.getByText('Beta Console')).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Organization' }).selectOption('org_01K27Q9C2W85CMN1V9S6Q3D4FE');

  await expect(page.getByRole('heading', { name: 'Beta Console' })).toBeVisible();
  await expect(page.getByText('Managed')).toBeVisible();
  await expect(page.getByText('Alpha Portal')).toHaveCount(0);
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        return localStorage.getItem('zapp:selected-organization:user_01K27Q9C2W85CMN1V9S6Q3D4FG');
      });
    })
    .toBe('org_01K27Q9C2W85CMN1V9S6Q3D4FE');

  expect(requests).toEqual([
    { cursor: null, organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD' },
    { cursor: null, organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FE' },
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
        organizationId === 'org_01K27Q9C2W85CMN1V9S6Q3D4FE'
          ? [project('beta-console', 'Beta Console', 'org_01K27Q9C2W85CMN1V9S6Q3D4FE', 'managed')]
          : [project('alpha-portal', 'Alpha Portal', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'verified')],
      nextCursor: null,
    });
  });

  await signIn(page);
  await page.goto('/projects?organizationId=org_01K27Q9C2W85CMN1V9S6Q3D4FD&view=grid');
  await expect(page.getByRole('heading', { name: 'Alpha Portal' })).toBeVisible();
  const historyLength = await page.evaluate(() => window.history.length);

  await page.getByRole('combobox', { name: 'Organization' }).selectOption('org_01K27Q9C2W85CMN1V9S6Q3D4FE');

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
            items: [project('alpha-portal', 'Alpha Portal', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'verified')],
            nextCursor: 'cursor-after-alpha',
          }
        : {
            items: [project('mercury-shop', 'Mercury Shop', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'compatible')],
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

    if (organizationId === 'org_01K27Q9C2W85CMN1V9S6Q3D4FE') {
      await projectListResponse(route, {
        items: [project('beta-console', 'Beta Console', 'org_01K27Q9C2W85CMN1V9S6Q3D4FE', 'managed')],
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
              items: [project('alpha-initial', 'Alpha Initial', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'verified')],
              nextCursor: 'alpha-old-cursor',
            }
          : {
              items: [project('alpha-fresh-one', 'Alpha Fresh One', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'verified')],
              nextCursor: 'alpha-fresh-cursor',
            },
      );
      return;
    }
    if (cursor === 'alpha-old-cursor') {
      staleStarted.resolve();
      await releaseStale.promise;
      await projectListResponse(route, {
        items: [project('alpha-stale', 'Alpha Stale Page', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'compatible')],
        nextCursor: 'alpha-stale-next',
      });
      staleSettled.resolve();
      return;
    }
    if (cursor === 'alpha-fresh-cursor') {
      freshStarted.resolve();
      await releaseFresh.promise;
      await projectListResponse(route, {
        items: [project('alpha-fresh-two', 'Alpha Fresh Two', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'compatible')],
        nextCursor: null,
      });
      return;
    }
    if (cursor === 'alpha-stale-next') {
      await projectListResponse(route, {
        items: [project('alpha-skipped', 'Alpha Skipped Page', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'compatible')],
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
  await organization.selectOption('org_01K27Q9C2W85CMN1V9S6Q3D4FE');
  await expect(page.getByRole('heading', { name: 'Beta Console' })).toBeVisible();
  await organization.selectOption('org_01K27Q9C2W85CMN1V9S6Q3D4FD');
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
    { cursor: null, organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD' },
    { cursor: 'alpha-old-cursor', organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD' },
    { cursor: null, organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FE' },
    { cursor: null, organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD' },
    { cursor: 'alpha-fresh-cursor', organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD' },
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
  await expect(dialog.getByRole('link', { name: 'Import from GitHub' })).toHaveAttribute(
    'href',
    '/projects?import=github',
  );
});

test('announces organization-switch loading as polite status', async ({ page }) => {
  const betaStarted = deferred();
  const releaseBeta = deferred();
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), async (route) => {
    const organizationId = route.request().headers()['x-organization-id'];
    if (organizationId === 'org_01K27Q9C2W85CMN1V9S6Q3D4FE') {
      betaStarted.resolve();
      await releaseBeta.promise;
    }
    await projectListResponse(route, {
      items:
        organizationId === 'org_01K27Q9C2W85CMN1V9S6Q3D4FE'
          ? [project('beta-console', 'Beta Console', 'org_01K27Q9C2W85CMN1V9S6Q3D4FE', 'managed')]
          : [project('alpha-portal', 'Alpha Portal', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'verified')],
      nextCursor: null,
    });
  });

  await signIn(page);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Alpha Portal' })).toBeVisible();

  await page.getByRole('combobox', { name: 'Organization' }).selectOption('org_01K27Q9C2W85CMN1V9S6Q3D4FE');
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
        items: [project('alpha-recovered', 'Alpha Recovered', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'verified')],
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

test('renders batch-backed activity and accessible environment states with Deploy only when ready', async ({
  page,
}) => {
  const summaryRequests: ProjectSummaryRequest[] = [];
  const projects = [
    project('alpha-ready', 'Alpha Ready', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'verified'),
    project('alpha-starting', 'Alpha Starting', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'compatible'),
    project('alpha-failed', 'Alpha Failed', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'managed'),
    project('alpha-blocked', 'Alpha Blocked', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'verified'),
  ];
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await projectListResponse(route, { items: projects, nextCursor: null });
  });
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/projects/summaries(?:\\?.*)?$`, 'u'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      summaryRequests.push({
        organizationId: request.headers()['x-organization-id'],
        projectIds: url.searchParams.getAll('projectId'),
      });
      await apiResponse(route, {
        summaries: [
          summary('alpha-ready', {
            deployReadiness: { findings: [], releaseId: 'release-ready', state: 'ready' },
            lastActivityAt: '2026-08-10T19:30:00.000Z',
            preview: { occurredAt: '2026-08-10T19:20:00.000Z', status: 'ready' },
            previewThumbnail: {
              alt: 'Preview of Alpha Ready',
              artifactId: 'art-alpha-ready',
              capturedAt: '2026-08-10T19:29:00.000Z',
              contentHash: 'b'.repeat(64),
            },
            production: {
              occurredAt: '2026-08-10T19:25:00.000Z',
              releaseId: 'release-ready',
              status: 'healthy',
            },
          }),
          summary('alpha-starting', {
            deployReadiness: null,
            lastActivityAt: null,
            preview: { occurredAt: '2026-08-10T19:21:00.000Z', status: 'starting' },
            production: { occurredAt: null, releaseId: null, status: 'not_deployed' },
          }),
          summary('alpha-failed', {
            deployReadiness: {
              findings: [
                {
                  action: 'review',
                  detail: 'Review the failed preview.',
                  id: 'finding-warning',
                  severity: 'warning',
                  title: 'Preview needs review',
                },
              ],
              releaseId: 'release-warning',
              state: 'warnings',
            },
            lastActivityAt: '2026-08-10T19:22:00.000Z',
            preview: { occurredAt: '2026-08-10T19:22:00.000Z', status: 'failed' },
            production: {
              occurredAt: '2026-08-10T19:23:00.000Z',
              releaseId: 'release-warning',
              status: 'failed',
            },
          }),
          summary('alpha-blocked', {
            deployReadiness: {
              findings: [
                {
                  action: 'fix_and_recheck',
                  detail: 'Resolve the blocker.',
                  id: 'finding-blocker',
                  severity: 'blocker',
                  title: 'Release blocked',
                },
              ],
              releaseId: 'release-blocked',
              state: 'blocked',
            },
            lastActivityAt: '2026-08-10T19:24:00.000Z',
            preview: { occurredAt: null, status: 'not_started' },
            production: {
              occurredAt: '2026-08-10T19:24:00.000Z',
              releaseId: 'release-blocked',
              status: 'deploying',
            },
          }),
        ],
      });
    },
  );
  await page.route(
    `${apiBaseUrl}/v1/projects/alpha-ready/preview-thumbnail/art-alpha-ready`,
    async (route) => {
      await apiResponse(route, {
        thumbnail: {
          content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+P8LHAAAAAElFTkSuQmCC',
          contentHash: 'b'.repeat(64),
          contentType: 'image/png',
          encoding: 'base64',
        },
      });
    },
  );

  await signIn(page);
  await page.goto('/projects');

  const ready = page.getByRole('article').filter({ hasText: 'Alpha Ready' });
  await expect(ready.getByRole('img', { name: 'Preview of Alpha Ready' })).toBeVisible();
  await expect(ready.getByText('Preview: Ready', { exact: true })).toBeVisible();
  await expect(ready.getByText('Production: Healthy', { exact: true })).toBeVisible();
  await expect(ready.locator('time')).toHaveAttribute('datetime', '2026-08-10T19:30:00.000Z');
  await expect(ready.getByRole('link', { name: 'Deploy Alpha Ready' })).toHaveAttribute(
    'href',
    '/projects/alpha-ready/releases',
  );

  const starting = page.getByRole('article').filter({ hasText: 'Alpha Starting' });
  await expect(starting.getByText('No activity yet')).toBeVisible();
  await expect(starting.getByText('Preview: Starting', { exact: true })).toBeVisible();
  await expect(starting.getByText('Production: Not deployed', { exact: true })).toBeVisible();
  await expect(starting.getByRole('link', { name: /deploy/iu })).toHaveCount(0);

  const failed = page.getByRole('article').filter({ hasText: 'Alpha Failed' });
  await expect(failed.getByText('Preview: Failed', { exact: true })).toBeVisible();
  await expect(failed.getByText('Production: Failed', { exact: true })).toBeVisible();
  await expect(failed.getByRole('link', { name: /deploy/iu })).toHaveCount(0);

  const blocked = page.getByRole('article').filter({ hasText: 'Alpha Blocked' });
  await expect(blocked.getByText('Preview: Not started', { exact: true })).toBeVisible();
  await expect(blocked.getByText('Production: Deploying', { exact: true })).toBeVisible();
  await expect(blocked.getByRole('link', { name: /deploy/iu })).toHaveCount(0);
  await expect(ready.locator('[data-status-icon="true"]')).toHaveCount(2);
  expect(summaryRequests).toEqual([
    {
      organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
      projectIds: ['alpha-ready', 'alpha-starting', 'alpha-failed', 'alpha-blocked'],
    },
  ]);
});

test('preserves base cards when summaries fail and retries only the failed summary batch', async ({
  page,
}) => {
  let projectRequests = 0;
  let summaryRequests = 0;
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    projectRequests += 1;
    await projectListResponse(route, {
      items: [project('alpha-retry', 'Alpha Retry', 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', 'verified')],
      nextCursor: null,
    });
  });
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/projects/summaries(?:\\?.*)?$`, 'u'),
    async (route) => {
      summaryRequests += 1;
      if (summaryRequests === 1) {
        await apiResponse(
          route,
          {
            error: {
              code: 'fixture_summary_failure',
              message: 'Fixture summary failure',
              requestId: 'req-summary-failure',
            },
          },
          500,
        );
        return;
      }
      await apiResponse(route, {
        summaries: [
          summary('alpha-retry', {
            deployReadiness: null,
            lastActivityAt: null,
            preview: { occurredAt: null, status: 'not_started' },
            production: { occurredAt: null, releaseId: null, status: 'not_deployed' },
          }),
        ],
      });
    },
  );

  await signIn(page);
  await page.goto('/projects');

  const card = page.getByRole('article').filter({ hasText: 'Alpha Retry' });
  await expect(card.getByText('Verified')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Open Alpha Retry' })).toBeVisible();
  await expect(card.getByRole('alert')).toContainText('Project details could not load.');
  await card.getByRole('button', { name: 'Retry project details' }).click();
  await expect(card.getByText('No activity yet')).toBeVisible();
  await expect(card.getByText('Preview: Not started', { exact: true })).toBeVisible();
  expect(projectRequests).toBe(1);
  expect(summaryRequests).toBe(2);
});

test('rejects an old Alpha summary after an Alpha to Beta to Alpha switch', async ({ page }) => {
  const staleStarted = deferred();
  const releaseStale = deferred();
  let alphaProjectPage = 0;
  let alphaSummaryPage = 0;
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects(?:\\?.*)?$`, 'u'), async (route) => {
    const organizationId = route.request().headers()['x-organization-id'];
    if (organizationId === 'org_01K27Q9C2W85CMN1V9S6Q3D4FE') {
      await projectListResponse(route, {
        items: [project('beta-summary', 'Beta Summary', 'org_01K27Q9C2W85CMN1V9S6Q3D4FE', 'managed')],
        nextCursor: null,
      });
      return;
    }
    alphaProjectPage += 1;
    await projectListResponse(route, {
      items: [
        project(
          alphaProjectPage === 1 ? 'alpha-old-summary' : 'alpha-fresh-summary',
          alphaProjectPage === 1 ? 'Alpha Old Summary' : 'Alpha Fresh Summary',
          'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
          'verified',
        ),
      ],
      nextCursor: null,
    });
  });
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/projects/summaries(?:\\?.*)?$`, 'u'),
    async (route) => {
      const organizationId = route.request().headers()['x-organization-id'];
      if (organizationId === 'org_01K27Q9C2W85CMN1V9S6Q3D4FE') {
        await apiResponse(route, {
          summaries: [
            summary('beta-summary', {
              deployReadiness: null,
              lastActivityAt: null,
              preview: { occurredAt: null, status: 'not_started' },
              production: { occurredAt: null, releaseId: null, status: 'not_deployed' },
            }),
          ],
        });
        return;
      }
      alphaSummaryPage += 1;
      if (alphaSummaryPage === 1) {
        staleStarted.resolve();
        await releaseStale.promise;
        await apiResponse(route, {
          summaries: [
            summary('alpha-old-summary', {
              deployReadiness: { findings: [], releaseId: 'old-release', state: 'ready' },
              lastActivityAt: '2026-08-01T00:00:00.000Z',
              preview: { occurredAt: '2026-08-01T00:00:00.000Z', status: 'ready' },
              production: { occurredAt: null, releaseId: null, status: 'not_deployed' },
            }),
          ],
        });
        return;
      }
      await apiResponse(route, {
        summaries: [
          summary('alpha-fresh-summary', {
            deployReadiness: null,
            lastActivityAt: null,
            preview: { occurredAt: '2026-08-10T00:00:00.000Z', status: 'starting' },
            production: { occurredAt: null, releaseId: null, status: 'not_deployed' },
          }),
        ],
      });
    },
  );

  await signIn(page);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Alpha Old Summary' })).toBeVisible();
  await staleStarted.promise;

  const organization = page.getByRole('combobox', { name: 'Organization' });
  await organization.selectOption('org_01K27Q9C2W85CMN1V9S6Q3D4FE');
  await expect(page.getByRole('heading', { name: 'Beta Summary' })).toBeVisible();
  await organization.selectOption('org_01K27Q9C2W85CMN1V9S6Q3D4FD');
  await expect(page.getByRole('heading', { name: 'Alpha Fresh Summary' })).toBeVisible();
  await expect(page.getByText('Preview: Starting', { exact: true })).toBeVisible();

  releaseStale.resolve();
  await expect(page.getByRole('link', { name: 'Deploy Alpha Old Summary' })).toHaveCount(0);
  await expect(page.getByText('Preview: Starting', { exact: true })).toBeVisible();
});

test('paginates GitHub repositories and branches by keyboard, then resumes durable polling after reopen', async ({
  page,
}) => {
  const callbackCode = 'github-callback-code-must-not-render';
  const callbackState = 'github-state-must-not-render';
  const repositoryQueries: string[] = [];
  const branchQueries: string[] = [];
  const authorizeRequests: ObservedMutation[] = [];
  const projectRequests: ObservedMutation[] = [];
  const importRequests: ObservedMutation[] = [];
  const progressStates = ['queued', 'mirroring', 'scan_pending', 'scan_accepted'] as const;
  let progressRequest = 0;
  await emptyProjects(page);

  await page.route(`${apiBaseUrl}/v1/integrations/github/install/authorize`, async (route) => {
    authorizeRequests.push(mutation(route));
    await apiResponse(route, {
      url: `${appBaseUrl}/projects?import=github&installation_id=41122&state=${callbackState}&code=${callbackCode}`,
    });
  });
  await page.route(`${apiBaseUrl}/v1/integrations/github/install`, async (route) => {
    expect(mutation(route).body).toEqual({
      code: callbackCode,
      installationId: '41122',
      state: callbackState,
    });
    await apiResponse(
      route,
      {
        connection: {
          configuration: { installationId: '41122' },
          credentialRef: null,
          id: 'int-github',
          organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
          projectId: null,
          provider: 'github',
          status: 'connected',
        },
      },
      201,
    );
  });
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/integrations/github/repositories(?:\\?.*)?$`, 'u'),
    async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('installationId')).toBe('41122');
      const cursor = url.searchParams.get('cursor');
      repositoryQueries.push(cursor ?? 'first');
      await apiResponse(
        route,
        cursor === null
          ? {
              items: [
                {
                  defaultBranch: 'main',
                  fullName: 'ada/first-page',
                  id: 'repo-first',
                  private: true,
                },
              ],
              nextCursor: 'opaque-repository-page-2',
            }
          : {
              items: [
                {
                  defaultBranch: 'main',
                  fullName: 'ada/portal',
                  id: 'repo-portal',
                  private: false,
                },
              ],
              nextCursor: null,
            },
      );
    },
  );
  await page.route(
    new RegExp(
      `^${apiBaseUrl}/v1/integrations/github/repositories/repo-portal/branches(?:\\?.*)?$`,
      'u',
    ),
    async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('installationId')).toBe('41122');
      const cursor = url.searchParams.get('cursor');
      branchQueries.push(cursor ?? 'first');
      await apiResponse(
        route,
        cursor === null
          ? {
              items: [{ headCommitSha: 'a'.repeat(40), name: 'main' }],
              nextCursor: 'opaque-branch-page-2',
            }
          : {
              items: [{ headCommitSha: 'b'.repeat(40), name: 'develop' }],
              nextCursor: null,
            },
      );
    },
  );
  await page.route(`${apiBaseUrl}/v1/projects`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    projectRequests.push(mutation(route));
    await apiResponse(route, importedProjectFixture(), 201);
  });
  await page.route(`${apiBaseUrl}/v1/projects/proj-import/import/github`, async (route) => {
    if (route.request().method() === 'POST') {
      importRequests.push(mutation(route));
      await apiResponse(route, { import: { projectId: 'proj-import', status: 'queued' } }, 202);
      return;
    }
    const status = progressStates[Math.min(progressRequest, progressStates.length - 1)];
    progressRequest += 1;
    await apiResponse(route, {
      branch: 'develop',
      errorCode: null,
      externalRepoRef: status === 'queued' ? null : 'ada/portal',
      headCommitSha: status === 'queued' ? null : 'b'.repeat(40),
      projectId: 'proj-import',
      scanId: status === 'scan_accepted' ? 'scan-import' : null,
      status,
      updatedAt: '2026-08-10T20:00:00.000Z',
    });
  });

  await signIn(page);
  await page.goto('/projects');
  const importButton = page.getByRole('button', { name: 'Import from GitHub' });
  await importButton.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Connect GitHub' })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL('/projects');
  await expect(dialog.getByRole('combobox', { name: 'Repository' })).toBeVisible();
  await expect(page.getByText(callbackCode)).toHaveCount(0);
  await expect(page.getByText(callbackState)).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(callbackCode);

  const loadMoreRepositories = dialog.getByRole('button', { name: 'Load more repositories' });
  await loadMoreRepositories.focus();
  await page.keyboard.press('Enter');
  const repository = dialog.getByRole('combobox', { name: 'Repository' });
  await repository.selectOption('repo-portal');
  const branch = dialog.getByRole('combobox', { name: 'Branch' });
  await expect(branch).toBeVisible();
  const loadMoreBranches = dialog.getByRole('button', { name: 'Load more branches' });
  await loadMoreBranches.focus();
  await page.keyboard.press('Enter');
  await expect(branch.getByRole('option', { name: 'develop' })).toHaveCount(1);
  await expect(branch).toBeEnabled();
  await branch.focus();
  await page.keyboard.press('d');
  await expect(branch).toHaveValue('develop');
  const confirm = dialog.getByRole('button', { name: 'Import repository' });
  await confirm.focus();
  await page.keyboard.press('Enter');

  await expect(dialog.getByRole('status')).toContainText('Queued');
  await expect(confirm).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await importButton.focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('status')).toContainText('Queued');
  await expect(dialog.getByRole('status')).toContainText('Mirroring', { timeout: 4_000 });
  await expect(dialog.getByRole('status')).toContainText('Scan pending', { timeout: 4_000 });
  await expect(page).toHaveURL('/projects/proj-import', { timeout: 5_000 });

  expect(repositoryQueries).toEqual(['first', 'opaque-repository-page-2']);
  expect(branchQueries).toEqual(['first', 'opaque-branch-page-2']);
  expect(authorizeRequests).toHaveLength(1);
  expect(authorizeRequests[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
  expect(projectRequests).toHaveLength(1);
  expect(projectRequests[0]?.body).toEqual({ name: 'ada/portal', sourceType: 'github_import' });
  expect(projectRequests[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
  expect(importRequests).toHaveLength(1);
  expect(importRequests[0]?.body).toEqual({
    branch: 'develop',
    installationId: '41122',
    repo: 'ada/portal',
  });
  expect(importRequests[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
  expect(JSON.stringify(projectRequests) + JSON.stringify(importRequests)).not.toContain(
    callbackCode,
  );
});

test('retries a failed durable import with the exact project-create and import operation keys', async ({
  page,
}) => {
  const projectRequests: ObservedMutation[] = [];
  const importRequests: ObservedMutation[] = [];
  let retryProgressRequest = 0;
  await emptyProjects(page);
  await page.route(`${apiBaseUrl}/v1/integrations/github/install`, async (route) => {
    await apiResponse(
      route,
      {
        connection: {
          configuration: { installationId: '41122' },
          credentialRef: null,
          id: 'int-github',
          organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
          projectId: null,
          provider: 'github',
          status: 'connected',
        },
      },
      201,
    );
  });
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/integrations/github/repositories(?:\\?.*)?$`, 'u'),
    async (route) => {
      await apiResponse(route, {
        items: [
          { defaultBranch: 'main', fullName: 'ada/portal', id: 'repo-portal', private: false },
        ],
        nextCursor: null,
      });
    },
  );
  await page.route(
    new RegExp(
      `^${apiBaseUrl}/v1/integrations/github/repositories/repo-portal/branches(?:\\?.*)?$`,
      'u',
    ),
    async (route) => {
      await apiResponse(route, {
        items: [{ headCommitSha: 'a'.repeat(40), name: 'main' }],
        nextCursor: null,
      });
    },
  );
  await page.route(`${apiBaseUrl}/v1/projects`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    projectRequests.push(mutation(route));
    await apiResponse(route, importedProjectFixture(), 201);
  });
  await page.route(`${apiBaseUrl}/v1/projects/proj-import/import/github`, async (route) => {
    if (route.request().method() === 'POST') {
      importRequests.push(mutation(route));
      if (importRequests.length > 1) retryProgressRequest = 0;
      await apiResponse(route, { import: { projectId: 'proj-import', status: 'queued' } }, 202);
      return;
    }
    const requeued = importRequests.length > 1;
    if (requeued) retryProgressRequest += 1;
    const accepted = requeued && retryProgressRequest > 1;
    await apiResponse(route, {
      branch: 'main',
      errorCode: requeued ? null : 'mirror_failed',
      externalRepoRef: accepted ? 'ada/portal' : null,
      headCommitSha: accepted ? 'a'.repeat(40) : null,
      projectId: 'proj-import',
      scanId: accepted ? 'scan-import' : null,
      status: accepted ? 'scan_accepted' : requeued ? 'queued' : 'failed',
      updatedAt: '2026-08-10T20:00:00.000Z',
    });
  });

  await signIn(page);
  await page.goto(
    '/projects?import=github&installation_id=41122&state=callback-state&code=callback-code',
  );
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub' });
  const repository = dialog.getByRole('combobox', { name: 'Repository' });
  await expect(repository).toBeVisible();
  await repository.selectOption('repo-portal');
  await dialog.getByRole('combobox', { name: 'Branch' }).selectOption('main');
  await dialog.getByRole('button', { name: 'Import repository' }).click();

  await expect(dialog.getByRole('alert')).toContainText('Mirror failed', { timeout: 3_000 });
  await expect(dialog.getByRole('button', { name: 'Import repository' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Import from GitHub' }).click();
  const reopenedDialog = page.getByRole('dialog', { name: 'Import from GitHub' });
  await expect(reopenedDialog.getByRole('alert')).toContainText('Mirror failed');
  expect(projectRequests).toHaveLength(1);
  expect(importRequests).toHaveLength(1);
  await reopenedDialog.getByRole('button', { name: 'Retry import' }).click();
  // The retry fixture deliberately requires two one-second status polls. Leave
  // enough observer slack for a saturated cold CI runner without changing the
  // product's polling cadence or accepted-state navigation contract.
  await expect(page).toHaveURL('/projects/proj-import', { timeout: 8_000 });

  expect(projectRequests).toHaveLength(2);
  expect(importRequests).toHaveLength(2);
  expect(projectRequests[1]?.headers['idempotency-key']).toBe(
    projectRequests[0]?.headers['idempotency-key'],
  );
  expect(importRequests[1]?.headers['idempotency-key']).toBe(
    importRequests[0]?.headers['idempotency-key'],
  );
});

test('renews import keys after selection changes and resets the flow on organization switch', async ({
  page,
}) => {
  const projectRequests: ObservedMutation[] = [];
  const importRequests: ObservedMutation[] = [];
  await emptyProjects(page);
  await page.route(`${apiBaseUrl}/v1/integrations/github/install`, async (route) => {
    await apiResponse(
      route,
      {
        connection: {
          configuration: { installationId: '41122' },
          credentialRef: null,
          id: 'int-github',
          organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
          projectId: null,
          provider: 'github',
          status: 'connected',
        },
      },
      201,
    );
  });
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/integrations/github/repositories(?:\\?.*)?$`, 'u'),
    async (route) => {
      await apiResponse(route, {
        items: [
          { defaultBranch: 'main', fullName: 'ada/portal', id: 'repo-portal', private: false },
        ],
        nextCursor: null,
      });
    },
  );
  await page.route(
    new RegExp(
      `^${apiBaseUrl}/v1/integrations/github/repositories/repo-portal/branches(?:\\?.*)?$`,
      'u',
    ),
    async (route) => {
      await apiResponse(route, {
        items: [
          { headCommitSha: 'a'.repeat(40), name: 'main' },
          { headCommitSha: 'b'.repeat(40), name: 'develop' },
        ],
        nextCursor: null,
      });
    },
  );
  await page.route(`${apiBaseUrl}/v1/projects`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    projectRequests.push(mutation(route));
    await apiResponse(route, importedProjectFixture(), 201);
  });
  await page.route(`${apiBaseUrl}/v1/projects/proj-import/import/github`, async (route) => {
    importRequests.push(mutation(route));
    await apiResponse(
      route,
      {
        error: {
          code: 'fixture_enqueue_failure',
          message: 'Fixture enqueue failure',
          requestId: 'req-enqueue-failure',
        },
      },
      500,
    );
  });

  await signIn(page);
  await page.goto(
    '/projects?import=github&installation_id=41122&state=callback-state&code=callback-code',
  );
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub' });
  await dialog.getByRole('combobox', { name: 'Repository' }).selectOption('repo-portal');
  const branch = dialog.getByRole('combobox', { name: 'Branch' });
  await branch.selectOption('main');
  await dialog.getByRole('button', { name: 'Import repository' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();

  await branch.selectOption('develop');
  await dialog.getByRole('button', { name: 'Import repository' }).click();
  await expect.poll(() => importRequests.length).toBe(2);
  expect(projectRequests[1]?.headers['idempotency-key']).not.toBe(
    projectRequests[0]?.headers['idempotency-key'],
  );
  expect(importRequests[1]?.headers['idempotency-key']).not.toBe(
    importRequests[0]?.headers['idempotency-key'],
  );

  await page.locator('select[aria-label="Organization"]').selectOption('org_01K27Q9C2W85CMN1V9S6Q3D4FE');
  await expect(dialog.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
  await expect(dialog.getByRole('option', { name: 'ada/portal' })).toHaveCount(0);
});

test('consumes successful callback material once across a keyboard close and reopen', async ({
  page,
}) => {
  let installRequests = 0;
  await emptyProjects(page);
  await page.route(`${apiBaseUrl}/v1/integrations/github/install`, async (route) => {
    installRequests += 1;
    await apiResponse(
      route,
      {
        connection: {
          configuration: { installationId: '41122' },
          credentialRef: null,
          id: 'int-github',
          organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
          projectId: null,
          provider: 'github',
          status: 'connected',
        },
      },
      201,
    );
  });
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/integrations/github/repositories(?:\\?.*)?$`, 'u'),
    async (route) => {
      await apiResponse(route, {
        items: [
          { defaultBranch: 'main', fullName: 'ada/portal', id: 'repo-portal', private: false },
        ],
        nextCursor: null,
      });
    },
  );

  await signIn(page);
  await page.goto(
    '/projects?import=github&installation_id=41122&state=one-time-state&code=one-time-code',
  );
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub' });
  await expect(dialog.getByRole('combobox', { name: 'Repository' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  const importButton = page.getByRole('button', { name: 'Import from GitHub' });
  await importButton.focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('combobox', { name: 'Repository' })).toBeVisible();
  expect(installRequests).toBe(1);
  await expect(page).toHaveURL('/projects');
  await expect(page.getByText('one-time-code')).toHaveCount(0);
  await expect(page.getByText('one-time-state')).toHaveCount(0);
});

test('consumes a failed GitHub callback once and requires fresh authorization after reopen', async ({
  page,
}) => {
  let installRequests = 0;
  await emptyProjects(page);
  await page.route(`${apiBaseUrl}/v1/integrations/github/install`, async (route) => {
    installRequests += 1;
    await apiResponse(
      route,
      {
        error: {
          code: 'github_callback_rejected',
          message: 'Callback rejected',
          requestId: `req-callback-${String(installRequests)}`,
        },
      },
      502,
    );
  });

  await signIn(page);
  await page.goto(
    '/projects?import=github&installation_id=41122&state=failed-state&code=failed-code',
  );
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub' });
  await expect(dialog.getByRole('alert')).toContainText('could not complete');
  await expect(page).toHaveURL('/projects');
  expect(installRequests).toBe(1);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Import from GitHub' }).click();
  const reopenedDialog = page.getByRole('dialog', { name: 'Import from GitHub' });
  await expect(reopenedDialog.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
  await page.waitForTimeout(250);
  expect(installRequests).toBe(1);
});

test('keeps branch discovery independent from overlapping repository pagination', async ({
  page,
}) => {
  const branchStarted = deferred();
  const releaseBranches = deferred();
  await emptyProjects(page);
  await page.route(`${apiBaseUrl}/v1/integrations/github/install`, async (route) => {
    await apiResponse(
      route,
      {
        connection: {
          configuration: { installationId: '41122' },
          credentialRef: null,
          id: 'int-github',
          organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
          projectId: null,
          provider: 'github',
          status: 'connected',
        },
      },
      201,
    );
  });
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/integrations/github/repositories(?:\\?.*)?$`, 'u'),
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      await apiResponse(
        route,
        cursor === null
          ? {
              items: [
                {
                  defaultBranch: 'main',
                  fullName: 'ada/portal',
                  id: 'repo-portal',
                  private: false,
                },
              ],
              nextCursor: 'repo-page-two',
            }
          : {
              items: [
                {
                  defaultBranch: 'trunk',
                  fullName: 'ada/second',
                  id: 'repo-second',
                  private: false,
                },
              ],
              nextCursor: null,
            },
      );
    },
  );
  await page.route(
    new RegExp(
      `^${apiBaseUrl}/v1/integrations/github/repositories/repo-portal/branches(?:\\?.*)?$`,
      'u',
    ),
    async (route) => {
      branchStarted.resolve();
      await releaseBranches.promise;
      await apiResponse(route, {
        items: [{ headCommitSha: 'a'.repeat(40), name: 'main' }],
        nextCursor: null,
      });
    },
  );

  await signIn(page);
  await page.goto(
    '/projects?import=github&installation_id=41122&state=callback-state&code=callback-code',
  );
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub' });
  await dialog.getByRole('combobox', { name: 'Repository' }).selectOption('repo-portal');
  await branchStarted.promise;
  await dialog.getByRole('button', { name: 'Load more repositories' }).click();
  await expect(dialog.getByRole('option', { name: 'ada/second' })).toHaveCount(1);
  releaseBranches.resolve();

  const branch = dialog.getByRole('combobox', { name: 'Branch' });
  await expect(branch).toBeEnabled();
  await expect(branch).toHaveValue('main');
});

test('clears branch loading immediately when repository selection is cleared', async ({ page }) => {
  const releaseBranches = deferred();
  await emptyProjects(page);
  await page.route(`${apiBaseUrl}/v1/integrations/github/install`, async (route) => {
    await apiResponse(
      route,
      {
        connection: {
          configuration: { installationId: '41122' },
          credentialRef: null,
          id: 'int-github',
          organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
          projectId: null,
          provider: 'github',
          status: 'connected',
        },
      },
      201,
    );
  });
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/integrations/github/repositories(?:\\?.*)?$`, 'u'),
    async (route) => {
      await apiResponse(route, {
        items: [
          { defaultBranch: 'main', fullName: 'ada/portal', id: 'repo-portal', private: false },
        ],
        nextCursor: null,
      });
    },
  );
  await page.route(
    new RegExp(
      `^${apiBaseUrl}/v1/integrations/github/repositories/repo-portal/branches(?:\\?.*)?$`,
      'u',
    ),
    async (route) => {
      await releaseBranches.promise;
      await apiResponse(route, {
        items: [{ headCommitSha: 'a'.repeat(40), name: 'main' }],
        nextCursor: null,
      });
    },
  );

  await signIn(page);
  await page.goto(
    '/projects?import=github&installation_id=41122&state=callback-state&code=callback-code',
  );
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub' });
  const repository = dialog.getByRole('combobox', { name: 'Repository' });
  await repository.selectOption('repo-portal');
  const loadingBranches = dialog.getByText('Loading branches…', { exact: true });
  await expect(loadingBranches).toBeVisible();
  await repository.selectOption('');
  try {
    await expect(loadingBranches).toHaveCount(0);
  } finally {
    releaseBranches.resolve();
  }
});
