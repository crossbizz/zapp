import { expect, test, type Page, type Route } from '@playwright/test';

import { apiBaseUrl, appBaseUrl } from './support/ports.js';
const explicitModel = 'anthropic/claude-sonnet-5';

interface ObservedMutation {
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly method: string;
  readonly url: string;
}

interface CreationMocks {
  readonly projectRequests: ObservedMutation[];
  readonly runRequests: ObservedMutation[];
}

const projectFixture = {
  branches: [
    {
      baseBranchId: null,
      headCommitSha: null,
      id: 'branch-main',
      name: 'main',
      organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
      projectId: 'proj-home',
      status: 'active',
    },
    {
      baseBranchId: 'branch-main',
      headCommitSha: null,
      id: 'branch-develop',
      name: 'develop',
      organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
      projectId: 'proj-home',
      status: 'active',
    },
  ],
  environments: [],
  project: {
    archivedAt: null,
    createdAt: '2026-08-05T12:00:00.000Z',
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
    description: null,
    id: 'proj-home',
    name: 'Customer Support Portal',
    organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
    slug: 'customer-support-portal',
    sourceType: 'prompt',
    supportLevel: 'compatible',
  },
  repository: {
    defaultBranch: 'main',
    externalRepoRef: null,
    id: 'repo-home',
    internalRepoRef: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD/proj-home',
    organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
    projectId: 'proj-home',
    provider: 'forgejo',
    syncPolicy: 'internal',
  },
} as const;

const runFixture = {
  run: {
    appType: 'web',
    branchId: 'branch-main',
    completedAt: null,
    id: 'run-home',
    mode: 'build',
    model: null,
    organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
    projectId: 'proj-home',
    startedAt: '2026-08-05T12:00:01.000Z',
    startedBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
    status: 'queued',
  },
} as const;

async function fakeRequests(page: Page): Promise<unknown[]> {
  return await page.request.get(`${apiBaseUrl}/__requests`).then(async (response) => {
    return (await response.json() as { requests: unknown[] }).requests;
  });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('textbox', { name: 'Describe your project' })).toBeVisible();
}

function mutation(route: Route): ObservedMutation {
  const request = route.request();
  return {
    body: request.postDataJSON(),
    headers: request.headers(),
    method: request.method(),
    url: request.url(),
  };
}

async function mockCreation(
  page: Page,
  options: { readonly failFirstRun?: boolean } = {},
): Promise<CreationMocks> {
  const projectRequests: ObservedMutation[] = [];
  const runRequests: ObservedMutation[] = [];

  await page.route(`${apiBaseUrl}/v1/projects/proj-home`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: JSON.stringify(projectFixture),
      contentType: 'application/json',
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
      },
      status: 200,
    });
  });

  await page.route(`${apiBaseUrl}/v1/projects`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    projectRequests.push(mutation(route));
    await route.fulfill({
      body: JSON.stringify(projectFixture),
      contentType: 'application/json',
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
      },
      status: 201,
    });
  });

  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/[^/]+/runs$`, 'u'), async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    runRequests.push(mutation(route));
    if (options.failFirstRun === true && runRequests.length === 1) {
      await route.fulfill({
        body: JSON.stringify({
          error: {
            code: 'fixture_failure',
            message: 'Fixture failure',
            requestId: 'req-home-run-failure',
          },
        }),
        contentType: 'application/json',
        headers: {
          'access-control-allow-credentials': 'true',
          'access-control-allow-origin': appBaseUrl,
        },
        status: 500,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify(runFixture),
      contentType: 'application/json',
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
      },
      status: 201,
    });
  });

  return { projectRequests, runRequests };
}

async function enableMobileApp(page: Page): Promise<void> {
  await page.request.get(`${apiBaseUrl}/__feature-flags?mobileApp=true`);
}

async function openModelControls(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add attachment or controls' }).click();
  await page.getByRole('button', { name: /Auto/u }).click();
}

async function submitPrompt(page: Page, prompt: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Describe your project' }).fill(prompt);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL('/projects/proj-home');
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('renders the prompt-first home with default-off flags and deterministic suggestions', async ({ page }) => {
  await signIn(page);

  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('heading', {
    name: "Start with one prompt. We'll take it to production.",
  })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Web App' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /Mobile App/u })).toBeDisabled();
  await expect(page.getByText('Coming after P0', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /voice/u })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '0 credits' })).toHaveAttribute('href', '/org/usage');

  for (const suggestion of [
    'Client portal for an agency',
    'Class scheduler for a yoga studio',
    'SaaS dashboard with Stripe billing',
  ]) {
    await expect(page.getByRole('button', { name: suggestion })).toBeVisible();
  }
});

test('renders real recent projects with thumbnail, fallback, statuses, and navigation', async ({ page }) => {
  const items = [
    {
      archivedAt: null,
      createdAt: '2026-08-13T18:00:00.000Z',
      createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
      description: null,
      id: 'proj-alpha',
      name: 'Customer portal',
      organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
      slug: 'customer-portal',
      sourceType: 'prompt',
      supportLevel: 'verified',
    },
    {
      archivedAt: null,
      createdAt: '2026-08-13T17:00:00.000Z',
      createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
      description: null,
      id: 'proj-beta',
      name: 'Inventory planner',
      organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
      slug: 'inventory-planner',
      sourceType: 'prompt',
      supportLevel: 'compatible',
    },
  ];
  const summaries = [
    {
      deployReadiness: { findings: [], releaseId: 'rel-alpha', state: 'ready' },
      lastActivityAt: '2026-08-13T18:04:00.000Z',
      preview: { occurredAt: '2026-08-13T18:02:00.000Z', status: 'ready' },
      previewThumbnail: {
        alt: 'Preview of Customer portal',
        artifactId: 'art-alpha',
        capturedAt: '2026-08-13T18:03:00.000Z',
        contentHash: 'b'.repeat(64),
      },
      production: {
        occurredAt: '2026-08-13T18:03:00.000Z',
        releaseId: 'rel-alpha',
        status: 'healthy',
      },
      projectId: 'proj-alpha',
    },
    {
      deployReadiness: null,
      lastActivityAt: null,
      preview: { occurredAt: null, status: 'not_started' },
      previewThumbnail: null,
      production: { occurredAt: null, releaseId: null, status: 'not_deployed' },
      projectId: 'proj-beta',
    },
  ];

  await page.route(`${apiBaseUrl}/v1/projects?*`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ items, nextCursor: null }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/projects/summaries?*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ summaries }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route(
    `${apiBaseUrl}/v1/projects/proj-alpha/preview-thumbnail/art-alpha`,
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          thumbnail: {
            content: 'iVBORw0KGgo=',
            contentHash: 'b'.repeat(64),
            contentType: 'image/png',
            encoding: 'base64',
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    },
  );

  await signIn(page);

  await expect(page.getByRole('heading', { name: 'My projects' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Preview of Customer portal' })).toBeVisible();
  await expect(page.getByLabel('Preview unavailable for Inventory planner')).toBeVisible();
  await expect(page.getByText('Preview: Ready')).toBeVisible();
  await expect(page.getByText('Production: Healthy')).toBeVisible();
  await expect(page.getByText('Deploy readiness: Unavailable')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Customer portal' })).toHaveAttribute(
    'href',
    '/projects/proj-alpha',
  );
  await expect(page.getByRole('link', { name: 'Browse all projects' })).toHaveAttribute(
    'href',
    '/projects',
  );
});

test('retries a failed recent-project read without hiding the prompt workflow', async ({ page }) => {
  let attempts = 0;
  const item = {
    archivedAt: null,
    createdAt: '2026-08-13T18:00:00.000Z',
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
    description: null,
    id: 'proj-retry',
    name: 'Recovered project',
    organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
    slug: 'recovered-project',
    sourceType: 'prompt',
    supportLevel: 'compatible',
  };
  await page.route(`${apiBaseUrl}/v1/projects?*`, async (route) => {
    attempts += 1;
    await route.fulfill({
      body: attempts === 1
        ? JSON.stringify({ error: { code: 'fixture_failure' } })
        : JSON.stringify({ items: [item], nextCursor: null }),
      contentType: 'application/json',
      status: attempts === 1 ? 500 : 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/projects/summaries?*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        summaries: [{
          deployReadiness: null,
          lastActivityAt: null,
          preview: { occurredAt: null, status: 'not_started' },
          previewThumbnail: null,
          production: { occurredAt: null, releaseId: null, status: 'not_deployed' },
          projectId: item.id,
        }],
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await signIn(page);
  await expect(page.getByText('Projects could not load.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Describe your project' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Recovered project' })).toBeVisible();
  expect(attempts).toBe(2);
});

test('preserves base project cards when summaries fail', async ({ page }) => {
  const item = {
    archivedAt: null,
    createdAt: '2026-08-13T18:00:00.000Z',
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
    description: null,
    id: 'proj-summary-failure',
    name: 'Base project',
    organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
    slug: 'base-project',
    sourceType: 'prompt',
    supportLevel: 'compatible',
  };
  await page.route(`${apiBaseUrl}/v1/projects?*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ items: [item], nextCursor: null }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/projects/summaries?*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ error: { code: 'fixture_failure' } }),
      contentType: 'application/json',
      status: 500,
    });
  });

  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Base project' })).toBeVisible();
  await expect(page.getByLabel('Preview unavailable for Base project')).toBeVisible();
  await expect(page.getByText('Project details could not load.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Base project' })).toBeVisible();
});

test('revokes thumbnail object URLs when a dashboard generation is refreshed', async ({ page }) => {
  const revoked: string[] = [];
  await page.exposeFunction('recordThumbnailRevocation', (url: string) => {
    revoked.push(url);
  });
  await page.addInitScript(() => {
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string): void => {
      void (window as unknown as {
        recordThumbnailRevocation: (value: string) => Promise<void>;
      }).recordThumbnailRevocation(url);
      original(url);
    };
  });

  const item = {
    archivedAt: null,
    createdAt: '2026-08-13T18:00:00.000Z',
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
    description: null,
    id: 'proj-revocation',
    name: 'Thumbnail project',
    organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
    slug: 'thumbnail-project',
    sourceType: 'prompt',
    supportLevel: 'verified',
  };
  const summary = {
    deployReadiness: null,
    lastActivityAt: null,
    preview: { occurredAt: '2026-08-13T18:02:00.000Z', status: 'ready' },
    previewThumbnail: {
      alt: 'Preview of Thumbnail project',
      artifactId: 'art-revocation',
      capturedAt: '2026-08-13T18:03:00.000Z',
      contentHash: 'b'.repeat(64),
    },
    production: { occurredAt: null, releaseId: null, status: 'not_deployed' },
    projectId: item.id,
  };
  await page.route(`${apiBaseUrl}/v1/projects?*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ items: [item], nextCursor: null }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/projects/summaries?*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ summaries: [summary] }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route(
    `${apiBaseUrl}/v1/projects/proj-revocation/preview-thumbnail/art-revocation`,
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          thumbnail: {
            content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+P8LHAAAAAElFTkSuQmCC',
            contentHash: 'b'.repeat(64),
            contentType: 'image/png',
            encoding: 'base64',
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    },
  );

  await signIn(page);
  await expect(page.getByRole('img', { name: 'Preview of Thumbnail project' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh projects' }).click();
  await expect.poll(() => revoked.length).toBeGreaterThan(0);
});

test('does not render a late thumbnail after switching organizations', async ({ page }) => {
  const alphaOrganization = 'org_01K27Q9C2W85CMN1V9S6Q3D4FD';
  const betaOrganization = 'org_01K27Q9C2W85CMN1V9S6Q3D4FE';
  let thumbnailRequested = false;
  let releaseThumbnail = (): void => undefined;
  const thumbnailGate = new Promise<void>((resolve) => {
    releaseThumbnail = resolve;
  });
  const projectFor = (organizationId: string) => ({
    archivedAt: null,
    createdAt: '2026-08-13T18:00:00.000Z',
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
    description: null,
    id: organizationId === alphaOrganization ? 'proj-late-alpha' : 'proj-current-beta',
    name: organizationId === alphaOrganization ? 'Late Alpha project' : 'Current Beta project',
    organizationId,
    slug: organizationId === alphaOrganization ? 'late-alpha' : 'current-beta',
    sourceType: 'prompt',
    supportLevel: 'compatible',
  });
  await page.route(`${apiBaseUrl}/v1/projects?*`, async (route) => {
    const organizationId = route.request().headers()['x-organization-id'] ?? alphaOrganization;
    await route.fulfill({
      body: JSON.stringify({ items: [projectFor(organizationId)], nextCursor: null }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/projects/summaries?*`, async (route) => {
    const organizationId = route.request().headers()['x-organization-id'] ?? alphaOrganization;
    const project = projectFor(organizationId);
    await route.fulfill({
      body: JSON.stringify({
        summaries: [{
          deployReadiness: null,
          lastActivityAt: null,
          preview: {
            occurredAt: organizationId === alphaOrganization
              ? '2026-08-13T18:02:00.000Z'
              : null,
            status: organizationId === alphaOrganization ? 'ready' : 'not_started',
          },
          previewThumbnail: organizationId === alphaOrganization
            ? {
                alt: 'Preview of Late Alpha project',
                artifactId: 'art-late-alpha',
                capturedAt: '2026-08-13T18:03:00.000Z',
                contentHash: 'b'.repeat(64),
              }
            : null,
          production: { occurredAt: null, releaseId: null, status: 'not_deployed' },
          projectId: project.id,
        }],
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route(
    `${apiBaseUrl}/v1/projects/proj-late-alpha/preview-thumbnail/art-late-alpha`,
    async (route) => {
      thumbnailRequested = true;
      await thumbnailGate;
      await route.fulfill({
        body: JSON.stringify({
          thumbnail: {
            content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+P8LHAAAAAElFTkSuQmCC',
            contentHash: 'b'.repeat(64),
            contentType: 'image/png',
            encoding: 'base64',
          },
        }),
        contentType: 'application/json',
        status: 200,
      }).catch(() => undefined);
    },
  );

  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Late Alpha project' })).toBeVisible();
  await expect.poll(() => thumbnailRequested).toBe(true);
  try {
    await page.getByRole('combobox', { name: 'Organization' }).selectOption(betaOrganization);
    await expect(page.getByText('Selected organization: Beta Org')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Current Beta project' })).toBeVisible();
  } finally {
    releaseThumbnail();
  }
  await expect(page.getByRole('img', { name: 'Preview of Late Alpha project' })).toHaveCount(0);
  await expect(page.getByLabel('Preview unavailable for Current Beta project')).toBeVisible();
});

test('explains the disabled Mobile App option from a keyboard-accessible help control', async ({ page }) => {
  await signIn(page);

  const help = page.getByRole('button', { name: 'Why Mobile App is unavailable' });
  await expect(help).toBeVisible();
  await help.focus();
  await expect(help).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText('Mobile App is coming after P0.');
});

test('enables Mobile App behind its flag and submits mobile appType', async ({ page }) => {
  const observed = await mockCreation(page);
  await enableMobileApp(page);
  await signIn(page);

  const mobileTab = page.getByRole('tab', { name: /Mobile App/u });
  await expect(mobileTab).toBeEnabled();
  await mobileTab.click();
  await expect(mobileTab).toHaveAttribute('aria-selected', 'true');
  await submitPrompt(page, 'Build a mobile inventory application');

  expect(observed.runRequests[0]?.body).toEqual({
    appType: 'mobile',
    branchId: 'branch-main',
    mode: 'build',
    prompt: 'Build a mobile inventory application',
  });
});

test('loads organization-scoped flags before rendering the home controls', async ({ page }) => {
  await enableMobileApp(page);
  await signIn(page);

  await expect(page.getByRole('tab', { name: /Mobile App/u })).toBeEnabled();
  await expect.poll(async () => (await fakeRequests(page)).some((request) => {
    const typed = request as { path?: string; organizationId?: string | null };
    return typed.path === '/v1/feature-flags' && typed.organizationId === 'org_01K27Q9C2W85CMN1V9S6Q3D4FD';
  })).toBe(true);
});

test('keeps short prompts disabled and fills without submitting from a suggestion', async ({ page }) => {
  await signIn(page);
  const composer = page.getByRole('textbox', { name: 'Describe your project' });
  const submit = page.getByRole('button', { name: 'Create project' });

  await expect(composer).toHaveAttribute('rows', '3');
  await composer.fill('Tiny app');
  await expect(submit).toBeDisabled();

  await page.getByRole('button', { name: 'Client portal for an agency' }).click();
  await expect(composer).toHaveValue('Client portal for an agency');
  await expect(submit).toBeEnabled();
  await expect(page).toHaveURL('/');
  expect((await fakeRequests(page)).filter((request) => {
    const typed = request as { method?: string; path?: string };
    return typed.method === 'POST' && typed.path === '/v1/projects';
  })).toHaveLength(0);

  await composer.fill(Array.from({ length: 12 }, (_, index) => `Line ${String(index + 1)}`).join('\n'));
  await expect(composer).toHaveAttribute('rows', '10');
});

test('autosizes wrapped prompt content from rendered height and clamps to ten rows', async ({ page }) => {
  await signIn(page);
  const composer = page.getByRole('textbox', { name: 'Describe your project' });

  await composer.fill('A rendered wrapping prompt '.repeat(24));
  await expect.poll(async () => Number(await composer.getAttribute('rows'))).toBeGreaterThan(3);

  await composer.fill('A much longer rendered wrapping prompt '.repeat(160));
  await expect(composer).toHaveAttribute('rows', '10');

  await composer.fill('Short again');
  await expect(composer).toHaveAttribute('rows', '3');
});

test('shuffles to a different deterministic group of suggestions', async ({ page }) => {
  await signIn(page);

  await page.getByRole('button', { name: 'Shuffle suggestions' }).click();

  await expect(page.getByRole('button', { name: 'Client portal for an agency' })).toHaveCount(0);
  for (const suggestion of [
    'Inventory tracker for a small retailer',
    'Community event planning hub',
    'Restaurant reservation manager',
  ]) {
    await expect(page.getByRole('button', { name: suggestion })).toBeVisible();
  }
});

test('exposes attachment, mode, model-policy, and advanced controls', async ({ page }) => {
  await signIn(page);

  await page.getByRole('button', { name: 'Add attachment or controls' }).click();
  await expect(page.getByLabel('Upload file')).toHaveAttribute('type', 'file');
  await expect(page.getByRole('link', { name: 'Import from GitHub' })).toHaveAttribute(
    'href',
    '/projects?import=github',
  );
  await page.getByRole('button', { name: /Auto/u }).click();

  await expect(page.getByRole('radio', { name: 'Auto (recommended)' })).toBeChecked();
  for (const mode of ['Ask', 'Prototype', 'Build', 'Autonomous']) {
    await expect(page.getByRole('radio', { name: new RegExp(`^${mode}`, 'u') })).toBeVisible();
  }
  await expect(page.getByRole('radio', { name: /^Fix/u })).toHaveCount(0);
  await expect(page.getByText('Automatic selection managed by your organization.')).toBeVisible();
  await page.getByRole('radio', { name: /^Ask/u }).check();
  await expect(page.getByLabel('Selected mode: Ask')).toBeVisible();

  await page.getByRole('button', { name: 'Advanced controls' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Run budget cap' })).toHaveAttribute('min', '1');
  await expect(page.getByRole('textbox', { name: 'Target branch' })).toHaveValue('main');
});

test('pastes an image, uploads it once, and retries the initial attachment handoff with stable keys', async ({
  page,
}) => {
  const observed = await mockCreation(page);
  const uploadRequests: import('@playwright/test').Request[] = [];
  const messageRequests: import('@playwright/test').Request[] = [];
  await page.route(`${apiBaseUrl}/v1/projects/proj-home/attachments`, async (route) => {
    uploadRequests.push(route.request());
    await route.fulfill({
      body: JSON.stringify({
        attachmentId: 'art_01K27Q9C2W85CMN1V9S6Q3D4FA',
        byteSize: 3,
        contentType: 'image/png',
        kind: 'image',
        name: 'reference.png',
      }),
      contentType: 'application/json',
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
      },
      status: 201,
    });
  });
  await page.route(`${apiBaseUrl}/v1/runs/run-home/messages`, async (route) => {
    messageRequests.push(route.request());
    if (messageRequests.length === 1) {
      await route.fulfill({
        body: JSON.stringify({
          error: { code: 'fixture_failure', message: 'Try again', requestId: 'req-image' },
        }),
        contentType: 'application/json',
        headers: {
          'access-control-allow-credentials': 'true',
          'access-control-allow-origin': appBaseUrl,
        },
        status: 500,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ messageId: 'msg_01K27Q9C2W85CMN1V9S6Q3D4FG', sequence: 2 }),
      contentType: 'application/json',
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
      },
      status: 202,
    });
  });

  await signIn(page);
  const composer = page.getByRole('textbox', { name: 'Describe your project' });
  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['png'], 'reference.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  });
  await expect(page.getByRole('list', { name: 'Attached images' })).toContainText('reference.png');
  await composer.fill('Build a gallery from this visual reference');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'We could not start your project.' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page).toHaveURL('/projects/proj-home');

  expect(uploadRequests).toHaveLength(1);
  expect(messageRequests).toHaveLength(2);
  expect(messageRequests[0]?.postDataJSON()).toEqual({
    attachments: [
      {
        attachmentId: 'art_01K27Q9C2W85CMN1V9S6Q3D4FA',
        byteSize: 3,
        contentType: 'image/png',
        kind: 'image',
        name: 'reference.png',
      },
    ],
    content: 'Use this visual reference with my initial request.',
  });
  expect(uploadRequests[0]?.headers()['x-organization-id']).toBe(
    'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
  );
  expect(uploadRequests[0]?.headers()['idempotency-key']).toBeTruthy();
  expect(messageRequests[0]?.headers()['idempotency-key']).toBe(
    messageRequests[1]?.headers()['idempotency-key'],
  );
  expect(observed.projectRequests[0]?.headers['idempotency-key']).toBe(
    observed.projectRequests[1]?.headers['idempotency-key'],
  );
  expect(observed.runRequests[0]?.headers['idempotency-key']).toBe(
    observed.runRequests[1]?.headers['idempotency-key'],
  );
});

test('renders only valid policy model radios and submits the explicit generated-SDK model', async ({ page }) => {
  const observed = await mockCreation(page);
  await signIn(page);

  await openModelControls(page);
  const modelChoices = page.getByRole('group', { name: 'Model' });
  await expect(modelChoices.getByRole('radio', { name: 'Automatic' })).toBeChecked();
  await expect(modelChoices.getByRole('radio', { name: explicitModel })).toBeVisible();
  await expect(modelChoices.getByRole('radio', { name: 'openai:gpt_5.1-mini' })).toBeVisible();
  await expect(modelChoices.getByRole('radio')).toHaveCount(3);
  for (const malformed of [
    `a${'b'.repeat(160)}`,
    'model with spaces',
    '-leading-punctuation',
    '42',
  ]) {
    await expect(modelChoices.getByRole('radio', { name: malformed, exact: true })).toHaveCount(0);
  }

  await page.getByRole('radio', { name: explicitModel }).check();
  await expect(page.getByLabel(`Selected model: ${explicitModel}`)).toBeVisible();
  await submitPrompt(page, 'Build a policy approved support portal');
  expect(observed.runRequests[0]?.body).toEqual({
    appType: 'web',
    branchId: 'branch-main',
    mode: 'build',
    model: explicitModel,
    prompt: 'Build a policy approved support portal',
  });
});

test('keeps the exact creation controls in keyboard tab order', async ({ page }) => {
  await signIn(page);
  await page.getByRole('textbox', { name: 'Describe your project' }).fill('Build a useful customer portal');
  const webTab = page.getByRole('tab', { name: 'Web App' });
  await webTab.focus();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Describe your project' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Add attachment or controls' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Create project' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Client portal for an agency' })).toBeFocused();
});

test('defaults Auto to web without model and hands the first prompt to the real builder', async ({ page }) => {
  const observed = await mockCreation(page);
  await signIn(page);

  await page.getByRole('button', { name: 'Add attachment or controls' }).click();
  await page.getByRole('button', { name: 'Advanced controls' }).click();
  await page.getByRole('spinbutton', { name: 'Run budget cap' }).fill('24');
  await page.getByRole('textbox', { name: 'Target branch' }).fill('develop');

  const prompt = 'Build a customer support portal';
  await submitPrompt(page, prompt);
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.getByText(prompt, { exact: true })).toBeVisible();
  await expect(conversation.getByText('No conversation yet')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Preview' })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');

  expect(observed.projectRequests).toHaveLength(1);
  expect(observed.runRequests).toHaveLength(1);
  const projectRequest = observed.projectRequests[0];
  const runRequest = observed.runRequests[0];
  expect(projectRequest?.method).toBe('POST');
  expect(projectRequest?.body).toEqual({
    name: 'Customer Support Portal',
    sourceType: 'prompt',
  });
  expect(runRequest?.method).toBe('POST');
  expect(runRequest?.url).toBe(`${apiBaseUrl}/v1/projects/proj-home/runs`);
  expect(runRequest?.body).toEqual({
    appType: 'web',
    branchId: 'branch-develop',
    budget: { maxCredits: 24 },
    mode: 'build',
    prompt,
  });

  for (const request of [projectRequest, runRequest]) {
    expect(request?.headers['x-organization-id']).toBe('org_01K27Q9C2W85CMN1V9S6Q3D4FD');
    expect(request?.headers['x-zapp-csrf']).toBeTruthy();
    expect(request?.headers.cookie).toContain('zapp_session=');
    expect(request?.headers['idempotency-key']).toBeTruthy();
  }
  expect(projectRequest?.headers['idempotency-key']).not.toBe(runRequest?.headers['idempotency-key']);
});

test('navigates with the first prompt when session storage rejects the handoff', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeSetItem = Storage.prototype.setItem.bind(window.localStorage);
    Storage.prototype.setItem = function setItem(key: string, value: string): void {
      if (this === window.sessionStorage && key === 'proj-home') {
        throw new DOMException('Storage disabled', 'SecurityError');
      }
      nativeSetItem(key, value);
    };
  });
  await mockCreation(page);
  await signIn(page);

  const prompt = 'Build a resilient customer portal';
  await submitPrompt(page, prompt);

  await expect(
    page.getByRole('region', { name: 'Conversation' }).getByText(prompt, { exact: true }),
  ).toBeVisible();
});

test('uses the Auto heuristic and lets an explicit mode win', async ({ page }) => {
  const exploratory = await mockCreation(page);
  await signIn(page);
  await submitPrompt(page, 'What if we prototype a garden planning app?');
  expect(exploratory.runRequests[0]?.body).toEqual({
    appType: 'web',
    branchId: 'branch-main',
    mode: 'prototype',
    prompt: 'What if we prototype a garden planning app?',
  });

  await page.unrouteAll({ behavior: 'wait' });
  await page.goto('/');
  const explicit = await mockCreation(page);
  await page.getByRole('button', { name: 'Add attachment or controls' }).click();
  await page.getByRole('button', { name: /Auto/u }).click();
  await page.getByRole('radio', { name: /^Ask/u }).check();
  await submitPrompt(page, 'I have an idea for a garden planning app');
  expect(explicit.runRequests[0]?.body).toEqual({
    appType: 'web',
    branchId: 'branch-main',
    mode: 'ask',
    prompt: 'I have an idea for a garden planning app',
  });
});

test('renders the canonical dashboard composer with the approved neutral focus rhythm', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/dashboard');

  const composer = page.getByRole('textbox', { name: 'Describe your project' });
  await expect(composer).toBeVisible();
  await composer.focus();

  await expect
    .poll(async () => {
      return await composer.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return {
          boxShadow: style.boxShadow,
          paddingBottom: style.paddingBottom,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          paddingTop: style.paddingTop,
        };
      });
    })
    .toEqual({
      boxShadow: 'none',
      paddingBottom: '12px',
      paddingLeft: '24px',
      paddingRight: '24px',
      paddingTop: '20px',
    });

  const actions = page.getByTestId('project-composer-actions');
  await expect
    .poll(async () => {
      return await actions.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return {
          paddingBottom: style.paddingBottom,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          paddingTop: style.paddingTop,
        };
      });
    })
    .toEqual({
      paddingBottom: '16px',
      paddingLeft: '20px',
      paddingRight: '20px',
      paddingTop: '4px',
    });
});

test('matches Auto exploratory terms as words instead of prompt fragments', async ({ page }) => {
  const observed = await mockCreation(page);
  await signIn(page);

  await submitPrompt(page, 'Build a country club booking portal');

  expect(observed.runRequests[0]?.body).toEqual({
    appType: 'web',
    branchId: 'branch-main',
    mode: 'build',
    prompt: 'Build a country club booking portal',
  });
});

test('lists active organizations and signs out through the public API', async ({ page }) => {
  await signIn(page);

  await page.getByRole('button', { name: 'Open account menu' }).click();
  await expect(page.getByRole('link', { name: 'Alpha Org' })).toHaveAttribute(
    'href',
    '/?organizationId=org_01K27Q9C2W85CMN1V9S6Q3D4FD',
  );
  await expect(page.getByRole('link', { name: 'Beta Org' })).toHaveAttribute(
    'href',
    '/?organizationId=org_01K27Q9C2W85CMN1V9S6Q3D4FE',
  );
  await expect(page.getByRole('link', { name: 'Organization settings' })).toHaveAttribute(
    'href',
    '/org/settings',
  );
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page).toHaveURL('/login');
  await expect.poll(async () => (await fakeRequests(page)).some((request) => {
    const typed = request as { method: string; path: string; hasCsrf: boolean };
    return typed.method === 'POST' && typed.path === '/v1/auth/logout' && typed.hasCsrf;
  })).toBe(true);
});

test('re-runs tenant selection when an organization is chosen from the account menu', async ({ page }) => {
  await signIn(page);

  await page.getByRole('button', { name: 'Open account menu' }).click();
  await page.getByRole('link', { name: 'Beta Org' }).click();

  await expect(page).toHaveURL('/?organizationId=org_01K27Q9C2W85CMN1V9S6Q3D4FE');
  await expect(page.getByText('Selected organization: Beta Org')).toBeVisible();
  await expect.poll(async () => (await fakeRequests(page)).some((request) => {
    const typed = request as { path?: string; organizationId?: string | null };
    return typed.path === '/v1/me' && typed.organizationId === 'org_01K27Q9C2W85CMN1V9S6Q3D4FE';
  })).toBe(true);
});

test('clears stale session-derived state before retry revalidation', async ({ page }) => {
  let unscopedRequests = 0;
  let failedScopedRequest = false;
  let releaseRetry = (): void => undefined;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });

  await page.route(`${apiBaseUrl}/v1/me`, async (route) => {
    const organizationId = route.request().headers()['x-organization-id'];
    if (organizationId === 'org_01K27Q9C2W85CMN1V9S6Q3D4FD' && !failedScopedRequest) {
      failedScopedRequest = true;
      await route.fulfill({
        body: JSON.stringify({ error: { code: 'fixture_failure' } }),
        contentType: 'application/json',
        headers: {
          'access-control-allow-credentials': 'true',
          'access-control-allow-origin': appBaseUrl,
        },
        status: 500,
      });
      return;
    }
    if (organizationId === undefined) {
      unscopedRequests += 1;
      if (unscopedRequests === 2) await retryGate;
    }
    await route.fallback();
  });

  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('We could not load your session. Please try again.')).toBeVisible();

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => unscopedRequests).toBe(2);
  try {
    await expect(page.getByText('Loading session…')).toBeVisible();
    await expect(page.getByText('Selected organization: Alpha Org')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Describe your project' })).toHaveCount(0);
    await expect(page.getByText('We could not load your session. Please try again.')).toHaveCount(0);
  } finally {
    releaseRetry();
  }
});

test('surfaces failed creation with all four standard recovery actions', async ({ page }) => {
  await page.route(`${apiBaseUrl}/v1/projects`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        error: {
          code: 'fixture_failure',
          message: 'Fixture failure',
          requestId: 'req-home-failure',
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

  await page.getByRole('textbox', { name: 'Describe your project' }).fill('Build a customer support portal');
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByRole('alert').filter({
    hasText: 'We could not start your project.',
  })).toContainText('We could not start your project.');
  for (const action of ['Fix automatically', 'Inspect details', 'Retry', 'Ask the agent']) {
    await expect(page.getByRole('button', { name: action })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Inspect details' }).click();
  await expect(page.getByText('Request failed before the project handoff completed.')).toBeVisible();
});

test('retries frozen appType and model with the original distinct idempotency keys', async ({ page }) => {
  const observed = await mockCreation(page, { failFirstRun: true });
  await enableMobileApp(page);
  await signIn(page);

  await page.getByRole('tab', { name: /Mobile App/u }).click();
  await openModelControls(page);
  await page.getByRole('radio', { name: explicitModel }).check();

  const originalPrompt = 'Build a customer support portal';
  await page.getByRole('textbox', { name: 'Describe your project' }).fill(originalPrompt);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('alert').filter({
    hasText: 'We could not start your project.',
  })).toBeVisible();

  await page.getByRole('textbox', { name: 'Describe your project' }).fill(
    'Build a completely different inventory application',
  );
  await page.getByRole('tab', { name: 'Web App' }).click();
  await page.getByRole('radio', { name: 'Automatic' }).check();
  await page.getByRole('button', { name: 'Retry' }).click();

  await expect(page).toHaveURL('/projects/proj-home');
  await expect(
    page.getByRole('region', { name: 'Conversation' }).getByText(originalPrompt, { exact: true }),
  ).toBeVisible();
  expect(observed.projectRequests).toHaveLength(2);
  expect(observed.runRequests).toHaveLength(2);
  expect(observed.projectRequests[1]?.body).toEqual(observed.projectRequests[0]?.body);
  expect(observed.runRequests[1]?.body).toEqual(observed.runRequests[0]?.body);
  expect(observed.runRequests[0]?.body).toEqual({
    appType: 'mobile',
    branchId: 'branch-main',
    mode: 'build',
    model: explicitModel,
    prompt: originalPrompt,
  });
  expect(observed.projectRequests[1]?.headers['idempotency-key']).toBe(
    observed.projectRequests[0]?.headers['idempotency-key'],
  );
  expect(observed.runRequests[1]?.headers['idempotency-key']).toBe(
    observed.runRequests[0]?.headers['idempotency-key'],
  );
  expect(observed.projectRequests[0]?.headers['idempotency-key']).not.toBe(
    observed.runRequests[0]?.headers['idempotency-key'],
  );
});
