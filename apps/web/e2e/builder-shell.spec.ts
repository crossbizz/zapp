import { expect, test, type Page, type Request } from '@playwright/test';

import { apiBaseUrl, appBaseUrl } from './support/ports.js';
const projectId = 'project-apollo';
const organizationId = 'org_01K27Q9C2W85CMN1V9S6Q3D4FD';
const conversationWidthStorageKey = `zapp:builder:conversation-width:${projectId}`;
const defaultConversationWidth = 44;

const projectRead = {
  branches: [
    {
      baseBranchId: null,
      headCommitSha: null,
      id: 'branch-main',
      name: 'main',
      organizationId,
      projectId,
      status: 'active',
    },
  ],
  environments: [
    {
      createdAt: '2026-08-05T12:00:00.000Z',
      databaseConnectionId: null,
      deploymentProvider: null,
      id: 'environment-preview',
      name: 'preview',
      organizationId,
      projectId,
      type: 'preview',
    },
  ],
  project: {
    archivedAt: null,
    createdAt: '2026-08-05T12:00:00.000Z',
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
    description: 'A mission planning workspace.',
    id: projectId,
    name: 'Project Apollo',
    organizationId,
    slug: 'project-apollo',
    sourceType: 'prompt',
    supportLevel: 'compatible' as const,
  },
  repository: {
    defaultBranch: 'main',
    externalRepoRef: null,
    id: 'repository-apollo',
    internalRepoRef: 'org_alpha/project_apollo',
    organizationId,
    projectId,
    provider: 'forgejo',
    syncPolicy: 'none',
  },
};

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(
    page.getByRole('heading', {
      name: "Start with one prompt. We'll take it to production.",
    }),
  ).toBeVisible();
}

async function mockProjectRead(
  page: Page,
  body: typeof projectRead | { readonly repository: null } = projectRead,
): Promise<Request[]> {
  const requests: Request[] = [];
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    requests.push(route.request());
    await route.fulfill({
      body: JSON.stringify(body),
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
        'content-type': 'application/json',
      },
      status: 200,
    });
  });
  return requests;
}

async function openBuilder(page: Page): Promise<Request[]> {
  const requests = await mockProjectRead(page);
  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Project Apollo' })).toBeVisible();
  return requests;
}

async function mockCodeWorkspace(page: Page): Promise<Request[]> {
  const workspaceId = 'ws_01K27Q9C2W85CMN1V9S6Q3D4FZ';
  const workspaceRequests: Request[] = [];
  const corsHeaders = {
    'access-control-allow-credentials': 'true',
    'access-control-allow-origin': appBaseUrl,
    'content-type': 'application/json',
  };
  await page.route(
    new RegExp(`${apiBaseUrl}/v1/projects/${projectId}/workspaces(?:\\?.*)?$`, 'u'),
    async (route) => {
      workspaceRequests.push(route.request());
      await route.fulfill({
        body: JSON.stringify({
          workspaces: [
            {
              branchId: 'branch-main',
              createdAt: '2026-08-16T12:00:00.000Z',
              id: workspaceId,
              lastActiveAt: '2026-08-16T12:00:00.000Z',
              organizationId,
              projectId,
              provider: 'docker',
              providerWorkspaceId: 'provider-code-workspace',
              resourceProfile: 'standard',
              snapshotRef: null,
              status: 'ready',
              terminatedAt: null,
            },
          ],
        }),
        headers: corsHeaders,
        status: 200,
      });
    },
  );
  await page.route(
    new RegExp(`${apiBaseUrl}/v1/workspaces/${workspaceId}/files(?:\\?.*)?$`, 'u'),
    async (route) => {
      workspaceRequests.push(route.request());
      const path = new URL(route.request().url()).searchParams.get('path') ?? '.';
      await route.fulfill({
        body: JSON.stringify({
          entries:
            path === 'src'
              ? [
                  { path: 'App.tsx', type: 'file' },
                  { path: 'styles.css', type: 'file' },
                ]
              : [
                  { path: 'src', type: 'directory' },
                  { path: 'README.md', type: 'file' },
                ],
          truncated: false,
        }),
        headers: corsHeaders,
        status: 200,
      });
    },
  );
  await page.route(
    new RegExp(`${apiBaseUrl}/v1/workspaces/${workspaceId}/file(?:\\?.*)?$`, 'u'),
    async (route) => {
      workspaceRequests.push(route.request());
      const path = new URL(route.request().url()).searchParams.get('path') ?? '';
      const source =
        path === 'src/styles.css'
          ? '.app { color: #2563eb; display: grid; }'
          : 'export function App() { return <main className="app">Hello</main>; }';
      await route.fulfill({
        body: JSON.stringify({
          byteSize: Buffer.byteLength(source),
          compareToken: path === 'src/styles.css' ? 'b'.repeat(64) : 'a'.repeat(64),
          dataBase64: Buffer.from(source).toString('base64'),
          path,
        }),
        headers: corsHeaders,
        status: 200,
      });
    },
  );
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/compare*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        additions: 0,
        afterSha: '2'.repeat(40),
        beforeSha: '1'.repeat(40),
        changedFiles: 0,
        deletions: 0,
        files: [],
        filesTruncated: false,
        patch: '',
        patchTruncated: false,
      }),
      headers: corsHeaders,
      status: 200,
    });
  });
  return workspaceRequests;
}

async function mockMembership(page: Page, role: 'builder' | 'owner' | 'viewer'): Promise<void> {
  await page.route(`${apiBaseUrl}/v1/me`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        memberships: [
          {
            allowedModels: [],
            organization: { id: organizationId, name: 'Apollo Org', slug: 'apollo' },
            role,
            status: 'active',
          },
        ],
        user: {
          avatarUrl: null,
          displayName: 'Apollo Builder',
          email: 'apollo@example.test',
          id: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
        },
      }),
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
        'content-type': 'application/json',
      },
      status: 200,
    });
  });
}

async function setStoredConversationWidth(page: Page, value: number): Promise<void> {
  await page.evaluate(
    ({ key, width }) => {
      localStorage.setItem(key, String(width));
    },
    { key: conversationWidthStorageKey, width: value },
  );
}

async function storedConversationWidth(page: Page): Promise<number> {
  return await page.evaluate(
    (key) => Number(localStorage.getItem(key)),
    conversationWidthStorageKey,
  );
}

async function settleResponsiveLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('loads a compact immersive builder with truthful header actions and surface tabs', async ({
  page,
}) => {
  await page.setViewportSize({ height: 950, width: 1440 });
  const projectRequests = await openBuilder(page);

  await expect(page.getByRole('complementary', { name: 'Workspace' })).toHaveCount(0);
  const topBar = page.getByRole('region', { name: 'Project editor' });
  const conversation = page.getByRole('region', { name: 'Conversation' });
  const workspace = page.getByRole('region', { name: 'Workspace' });
  const composer = page.getByRole('form', { name: 'Message composer' });
  const topBarBounds = await topBar.boundingBox();
  const conversationBounds = await conversation.boundingBox();
  const workspaceBounds = await workspace.boundingBox();
  const composerBounds = await composer.boundingBox();
  if (
    topBarBounds === null ||
    conversationBounds === null ||
    workspaceBounds === null ||
    composerBounds === null
  ) {
    throw new Error('The immersive builder geometry was not rendered.');
  }
  expect(topBarBounds.height).toBeLessThanOrEqual(56);
  expect(conversationBounds.width).toBeGreaterThanOrEqual(400);
  const conversationShare =
    conversationBounds.width / (conversationBounds.width + workspaceBounds.width);
  expect(conversationShare).toBeGreaterThanOrEqual(0.4);
  expect(conversationShare).toBeLessThanOrEqual(0.5);
  expect(workspaceBounds.width).toBeGreaterThan(conversationBounds.width);
  expect(composerBounds.y + composerBounds.height).toBeLessThanOrEqual(950);
  await expect(page.getByRole('group', { name: 'Builder mode' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Project surfaces' })).toHaveCount(1);
  await expect(page.getByText('Compatible')).toHaveCount(0);
  await expect(page.getByText('Last saved version', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Preview', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Source repository' })).toHaveAttribute(
    'href',
    `/projects/${projectId}/settings/integrations`,
  );
  await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Deploy' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Mission Control' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Project settings' })).toHaveAttribute(
    'href',
    `/projects/${projectId}/settings/general`,
  );
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Manage', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
  for (const tab of ['Files', 'Code', 'More']) {
    await expect(page.getByRole('tab', { exact: true, name: tab })).toBeVisible();
  }
  await page.getByRole('tab', { name: 'Preview' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Files' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Files workspace' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Code changes' })).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Code' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Code' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Code changes' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Files workspace' })).toHaveCount(0);
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Preview' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'More' }).click();
  await expect(page.getByRole('tab', { name: 'More' })).toHaveText('More');
  const moreNavigation = page.getByRole('tablist', { name: 'More project views' });
  await expect(moreNavigation.getByText('◇', { exact: true })).toHaveCount(0);
  for (const tab of [
    'Analytics',
    'Cloud',
    'AI',
    'Agent integrations',
    'Payments',
    'Connectors',
    'Security',
    'SEO & AI search',
  ]) {
    await expect(page.getByRole('tab', { exact: true, name: tab })).toBeVisible();
  }
  await expect(moreNavigation.locator('svg')).toHaveCount(8);
  await page.getByRole('tab', { exact: true, name: 'Cloud' }).click();
  const cloudNavigation = page.getByRole('tablist', { name: 'Cloud project views' });
  await expect(cloudNavigation.getByRole('tab', { exact: true, name: 'Overview' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  for (const tab of ['Overview', 'Secrets', 'Logs', 'Usage']) {
    await expect(cloudNavigation.getByRole('tab', { exact: true, name: tab })).toBeVisible();
  }
  await cloudNavigation.getByRole('tab', { exact: true, name: 'Secrets' }).click();
  await expect(page.getByRole('heading', { exact: true, name: 'Secrets' })).toBeVisible();
  await page.getByRole('tab', { name: 'Preview' }).click();

  expect(projectRequests).toHaveLength(1);
  expect(projectRequests[0]?.method()).toBe('GET');
  expect(projectRequests[0]?.headers()['x-organization-id']).toBe('org_01K27Q9C2W85CMN1V9S6Q3D4FD');
});

test('renders a Lovable-style tabbed CodeMirror workspace with file actions', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const workspaceRequests = await mockCodeWorkspace(page);
  await openBuilder(page);
  await page.getByRole('tab', { exact: true, name: 'Code' }).click();

  await expect(page.getByRole('tree', { name: 'Workspace files' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand all folders' }).click();
  await expect(
    page
      .getByRole('button', { exact: true, name: 'src/App.tsx' })
      .locator('[data-file-icon="react"]'),
  ).toHaveCount(1);
  await expect(
    page
      .getByRole('button', { exact: true, name: 'src/styles.css' })
      .locator('[data-file-icon="css"]'),
  ).toHaveText('CSS');
  const appRowBounds = await page
    .getByRole('button', { exact: true, name: 'src/App.tsx' })
    .boundingBox();
  expect(appRowBounds?.height).toBeLessThanOrEqual(29);
  await page.getByRole('button', { exact: true, name: 'src/App.tsx' }).click();
  await expect(page.getByRole('tab', { exact: true, name: 'src/App.tsx' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const appEditor = page.getByLabel('Code editor for src/App.tsx');
  await expect(appEditor.locator('.cm-lineNumbers')).toBeVisible();
  expect(await appEditor.locator('.cm-line span').count()).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'src/styles.css' }).click();
  const openTabs = page.getByRole('tablist', { name: 'Open file tabs' });
  await expect(openTabs.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { exact: true, name: 'src/App.tsx' }).click();
  await expect(openTabs.getByRole('tab')).toHaveCount(2);

  await page.getByRole('button', { name: 'Reference file in chat' }).click();
  await expect(page.getByRole('list', { name: 'Code references' })).toContainText('@src/App.tsx');
  await page.getByRole('button', { name: 'Copy file content' }).click();
  await expect(page.getByRole('status')).toContainText('Copied src/App.tsx');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download file' }).click();
  expect((await download).suggestedFilename()).toBe('App.tsx');
  await expect(page.getByRole('button', { name: 'Edit file' })).toHaveCount(0);
  await expect(appEditor.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  const editorTypography = await appEditor.locator('.cm-content').evaluate((element) => {
    const style = getComputedStyle(element);
    return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight };
  });
  expect(editorTypography).toEqual({
    fontFamily: '"Roboto Mono Variable", monospace',
    fontSize: '14px',
    lineHeight: '19.6px',
  });
  await expect(page.getByRole('button', { exact: true, name: 'src/App.tsx' })).toHaveCSS(
    'font-size',
    '14px',
  );
  await page.getByRole('button', { name: 'Close src/App.tsx' }).click();
  await expect(page.getByRole('tab', { exact: true, name: 'src/styles.css' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(workspaceRequests.length).toBeGreaterThanOrEqual(4);
  for (const request of workspaceRequests) {
    expect(request.headers()['x-organization-id']).toBe(organizationId);
  }
});

for (const role of ['builder', 'viewer'] as const) {
  test(`keeps the Lovable-style CodeMirror workspace read-only for ${role}s`, async ({ page }) => {
    await mockCodeWorkspace(page);
    await mockProjectRead(page);
    await mockMembership(page, role);
    await signIn(page);
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { name: 'Project Apollo' })).toBeVisible();
    await page.getByRole('tab', { exact: true, name: 'Code' }).click();
    await page.getByRole('button', { name: 'Expand all folders' }).click();
    await page.getByRole('button', { exact: true, name: 'src/App.tsx' }).click();

    await expect(page.getByRole('button', { name: 'Edit file' })).toHaveCount(0);
    await expect(
      page.getByLabel('Code editor for src/App.tsx').locator('.cm-content'),
    ).toHaveAttribute('contenteditable', 'false');
  });
}

test('hands one referenced code file to a new run and keeps the transcript human-readable', async ({
  page,
}) => {
  const createdConversationId = 'conv_01K27Q9C2W85CMN1V9S6Q3D4FA';
  const createdRunId = 'run_01K27Q9C2W85CMN1V9S6Q3D4FF';
  const runRequests: Request[] = [];
  const supplementalRequests: Request[] = [];
  await mockCodeWorkspace(page);
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        body: JSON.stringify({ items: [], nextCursor: null }),
        headers: {
          'access-control-allow-credentials': 'true',
          'access-control-allow-origin': appBaseUrl,
          'content-type': 'application/json',
        },
        status: 200,
      });
      return;
    }
    runRequests.push(route.request());
    await route.fulfill({
      body: JSON.stringify({
        conversation: {
          createdAt: '2026-08-16T12:00:00.000Z',
          createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
          id: createdConversationId,
          organizationId,
          projectId,
          title: 'Fix the heading.',
          updatedAt: '2026-08-16T12:00:00.000Z',
        },
        run: {
          appType: 'web',
          branchId: 'branch-main',
          completedAt: null,
          conversationId: createdConversationId,
          conversationRunNumber: 1,
          id: createdRunId,
          mode: 'build',
          model: null,
          organizationId,
          projectId,
          startedAt: '2026-08-16T12:00:00.000Z',
          startedBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
          status: 'queued',
        },
      }),
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
        'content-type': 'application/json',
      },
      status: 201,
    });
  });
  await page.route(
    new RegExp(`${apiBaseUrl}/v1/projects/${projectId}/conversations(?:\\?.*)?$`, 'u'),
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({ items: [], nextCursor: null }),
        headers: {
          'access-control-allow-credentials': 'true',
          'access-control-allow-origin': appBaseUrl,
          'content-type': 'application/json',
        },
        status: 200,
      });
    },
  );
  await page.route(new RegExp(`${apiBaseUrl}/v1/runs/.+/messages$`, 'u'), async (route) => {
    supplementalRequests.push(route.request());
    await route.fulfill({
      body: JSON.stringify({ messageId: 'msg_01K27Q9C2W85CMN1V9S6Q3D4FG', sequence: 2 }),
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
        'content-type': 'application/json',
      },
      status: 202,
    });
  });

  await openBuilder(page);
  await page.getByRole('tab', { exact: true, name: 'Code' }).click();
  await page.getByRole('button', { name: 'Expand all folders' }).click();
  await page.getByRole('button', { exact: true, name: 'src/App.tsx' }).click();
  await page.getByRole('button', { name: 'Reference file in chat' }).click();
  await expect(page.getByRole('list', { name: 'Code references' })).toContainText('@src/App.tsx');
  await page.getByLabel('Message the agent').fill('Fix the heading.');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect.poll(() => runRequests).toHaveLength(1);
  const requestBody = runRequests[0]?.postDataJSON() as { prompt: string };
  expect(JSON.parse(requestBody.prompt)).toEqual({
    message: 'Fix the heading.',
    referencedFiles: [{ path: 'src/App.tsx' }],
  });
  expect(supplementalRequests).toHaveLength(0);
  await expect(page.getByRole('list', { name: 'Code references' })).not.toContainText(
    '@src/App.tsx',
  );
  await expect(page.getByLabel('You')).toContainText('Fix the heading.');
  await expect(page.getByLabel('You')).not.toContainText('referencedFiles');
});

test('keeps the immersive editor and both builder panes at 1180px', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 1180 });
  await openBuilder(page);

  await expect(page.getByRole('complementary', { name: 'Workspace' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Workspace' })).toBeVisible();
});

test('keeps conversation mounted while Preview and Manage restore from the URL', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.route(`${apiBaseUrl}/v1/integrations`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ connections: [] }),
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
        'content-type': 'application/json',
      },
      status: 200,
    });
  });
  await openBuilder(page);
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await conversation.evaluate((element) => {
    element.setAttribute('data-mount-probe', 'preserved');
  });

  await page.getByRole('tab', { name: 'Code' }).click();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project Apollo settings' })).toBeVisible();
  await expect(conversation).toHaveAttribute('data-mount-probe', 'preserved');
  await expect(page.getByRole('link', { name: 'Project settings' })).toHaveAttribute(
    'href',
    `/projects/${projectId}/settings/general`,
  );

  await page.getByRole('button', { name: 'Integrations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(
      `/projects/${projectId}\\?mode=manage&view=code&section=integrations&pane=workspace$`,
      'u',
    ),
  );
  await expect(conversation).toHaveAttribute('data-mount-probe', 'preserved');

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Code' })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Code' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible();
});

test('resizes panes by pointer and keyboard and restores the project width on reload', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);

  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  await expect(separator).toHaveAttribute('aria-valuenow', String(defaultConversationWidth));
  const bounds = await separator.boundingBox();
  if (bounds === null) throw new Error('The pane separator was not rendered.');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 120, bounds.y + bounds.height / 2);
  await page.mouse.up();

  const pointerWidth = Number(await separator.getAttribute('aria-valuenow'));
  expect(pointerWidth).toBeGreaterThan(defaultConversationWidth);
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  const keyboardWidth = Number(await separator.getAttribute('aria-valuenow'));
  expect(keyboardWidth).toBe(pointerWidth - 2);

  await page.reload();
  await expect(page.getByRole('separator', { name: 'Resize conversation pane' })).toHaveAttribute(
    'aria-valuenow',
    String(keyboardWidth),
  );
});

test('persists a multi-step pointer resize exactly once when the drag completes', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  await page.evaluate((storageKey) => {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const state = window as typeof window & { conversationWidthWrites?: number };
    state.conversationWidthWrites = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key === storageKey) {
        state.conversationWidthWrites = (state.conversationWidthWrites ?? 0) + 1;
      }
      originalSetItem(key, value);
    };
  }, conversationWidthStorageKey);

  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  const bounds = await separator.boundingBox();
  if (bounds === null) throw new Error('The pane separator was not rendered.');
  const pointerY = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + bounds.width / 2, pointerY);
  await page.mouse.down();
  for (const offset of [30, 60, 90, 120]) {
    await page.mouse.move(bounds.x + offset, pointerY);
  }
  await page.mouse.up();

  expect(Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(
    defaultConversationWidth,
  );
  expect(
    await page.evaluate(() => {
      const state = window as typeof window & { conversationWidthWrites?: number };
      return state.conversationWidthWrites;
    }),
  ).toBe(1);
});

test('ignores non-initiating pointers during resize and persists once for the initiator', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  await page.evaluate((storageKey) => {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const state = window as typeof window & { conversationWidthWrites?: number };
    state.conversationWidthWrites = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key === storageKey) {
        state.conversationWidthWrites = (state.conversationWidthWrites ?? 0) + 1;
      }
      originalSetItem(key, value);
    };
  }, conversationWidthStorageKey);

  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  const bounds = await separator.boundingBox();
  if (bounds === null) throw new Error('The pane separator was not rendered.');
  const pointerY = bounds.y + bounds.height / 2;
  const dispatchWindowPointer = async (
    type: 'pointercancel' | 'pointermove' | 'pointerup',
    pointerId: number,
    clientX: number,
  ): Promise<void> => {
    await page.evaluate(
      ({ eventType, id, x, y }) => {
        window.dispatchEvent(
          new PointerEvent(eventType, {
            bubbles: true,
            clientX: x,
            clientY: y,
            pointerId: id,
            pointerType: 'touch',
          }),
        );
      },
      { eventType: type, id: pointerId, x: clientX, y: pointerY },
    );
  };

  await separator.evaluate(
    (element, { id, x, y }) => {
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerId: id,
          pointerType: 'touch',
        }),
      );
    },
    { id: 11, x: bounds.x + bounds.width / 2, y: pointerY },
  );

  await dispatchWindowPointer('pointermove', 22, bounds.x + 200);
  await expect(separator).toHaveAttribute('aria-valuenow', String(defaultConversationWidth));
  await dispatchWindowPointer('pointerup', 22, bounds.x + 200);
  expect(
    await page.evaluate(() => {
      const state = window as typeof window & { conversationWidthWrites?: number };
      return state.conversationWidthWrites;
    }),
  ).toBe(0);

  await dispatchWindowPointer('pointermove', 11, bounds.x + 120);
  expect(Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(
    defaultConversationWidth,
  );
  await dispatchWindowPointer('pointerup', 11, bounds.x + 120);
  expect(
    await page.evaluate(() => {
      const state = window as typeof window & { conversationWidthWrites?: number };
      return state.conversationWidthWrites;
    }),
  ).toBe(1);
  expect(await storedConversationWidth(page)).toBeGreaterThan(defaultConversationWidth);
});

test('keeps resize and Mission Control operational when preference writes fail', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  await page.evaluate(
    ({ missionKey, widthKey }) => {
      const originalSetItem = localStorage.setItem.bind(localStorage);
      Storage.prototype.setItem = function (key, value) {
        if (key === missionKey || key === widthKey) {
          throw new DOMException('Preference storage unavailable.', 'QuotaExceededError');
        }
        originalSetItem(key, value);
      };
    },
    {
      missionKey: `zapp:builder:mission-control:${projectId}`,
      widthKey: conversationWidthStorageKey,
    },
  );

  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '46');
  await expect(page.getByRole('status')).toHaveText('Preferences could not be saved.');
  await expect(page.getByRole('heading', { name: 'Project Apollo' })).toBeVisible();

  await page.getByRole('button', { name: 'Mission Control' }).click();
  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project Apollo' })).toBeVisible();
});

test('keeps the warning until every failed preference key saves successfully', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  await page.evaluate((widthKey) => {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const state = window as typeof window & { failNextConversationWidthWrite?: boolean };
    state.failNextConversationWidthWrite = true;
    Storage.prototype.setItem = function (key, value) {
      if (key === widthKey && state.failNextConversationWidthWrite === true) {
        state.failNextConversationWidthWrite = false;
        throw new DOMException('Preference storage unavailable.', 'QuotaExceededError');
      }
      originalSetItem(key, value);
    };
  }, conversationWidthStorageKey);

  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '46');
  await expect(page.getByRole('status')).toHaveText('Preferences could not be saved.');

  await page.getByRole('button', { name: 'Mission Control' }).click();
  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Preferences could not be saved.');

  const beforeRetry = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', String(beforeRetry + 2));
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(Math.round(await storedConversationWidth(page))).toBe(beforeRetry + 2);
});

test('normalizes an undersized restored width before announcing or resizing it', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1200 });
  await mockProjectRead(page);
  await signIn(page);
  await setStoredConversationWidth(page, 28);
  await page.goto(`/projects/${projectId}`);

  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  const assertMeasuredMinimum = async (): Promise<number> => {
    const splitWidth = await separator.evaluate((element) => {
      const split = element.parentElement;
      if (split === null) throw new Error('The pane separator has no split container.');
      return split.getBoundingClientRect().width;
    });
    const pixelMinimumPercentage = (400 / splitWidth) * 100;
    const announced = Number(await separator.getAttribute('aria-valuenow'));
    const announcedMinimum = Number(await separator.getAttribute('aria-valuemin'));
    const persisted = await storedConversationWidth(page);
    expect(announced).toBeGreaterThanOrEqual(Math.ceil(pixelMinimumPercentage));
    expect(announcedMinimum).toBeGreaterThanOrEqual(Math.ceil(pixelMinimumPercentage));
    expect(persisted).toBe(28);
    return announced;
  };

  const openedWidth = await assertMeasuredMinimum();
  await page.reload();
  const restoredWidth = await assertMeasuredMinimum();
  expect(restoredWidth).toBe(openedWidth);

  await separator.focus();
  await page.keyboard.press('ArrowRight');
  const resizedWidth = Number(await separator.getAttribute('aria-valuenow'));
  expect(resizedWidth).toBeGreaterThan(restoredWidth);
  expect(resizedWidth).toBeLessThanOrEqual(restoredWidth + 2);
  expect(Math.round(await storedConversationWidth(page))).toBe(resizedWidth);
});

test('preserves a deliberate desktop split across mobile and back', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '46');
  expect(await storedConversationWidth(page)).toBe(46);

  await page.setViewportSize({ height: 900, width: 900 });
  await expect(page.getByRole('navigation', { name: 'Builder pane' })).toBeVisible();
  await expect(separator).toBeHidden();
  await settleResponsiveLayout(page);
  expect(await storedConversationWidth(page)).toBe(46);

  await page.setViewportSize({ height: 900, width: 1440 });
  await expect(separator).toBeVisible();
  await settleResponsiveLayout(page);
  await expect(separator).toHaveAttribute('aria-valuenow', '46');
  expect(await storedConversationWidth(page)).toBe(46);
});

test('temporarily clamps a low preference for inline Mission Control without persisting it', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await mockProjectRead(page);
  await signIn(page);
  await setStoredConversationWidth(page, 26);
  await page.goto(`/projects/${projectId}`);
  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  const compactWidth = Number(await separator.getAttribute('aria-valuenow'));
  expect(compactWidth).toBeGreaterThan(26);
  expect(await storedConversationWidth(page)).toBe(26);

  await page.getByRole('button', { name: 'Mission Control' }).click();
  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toBeVisible();
  await expect
    .poll(async () => Number(await separator.getAttribute('aria-valuenow')))
    .toBeGreaterThan(compactWidth);
  expect(await storedConversationWidth(page)).toBe(26);

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toHaveCount(0);
  await expect(separator).toHaveAttribute('aria-valuenow', String(compactWidth));
  expect(await storedConversationWidth(page)).toBe(26);
});

test('announces a fractional 1180px minimum without an invalid ARIA range', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1180 });
  await mockProjectRead(page);
  await signIn(page);
  await setStoredConversationWidth(page, 28);
  await page.goto(`/projects/${projectId}`);
  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  const values = await separator.evaluate((element) => {
    const split = element.parentElement;
    const conversation = element.previousElementSibling;
    if (!(split instanceof HTMLElement) || !(conversation instanceof HTMLElement)) {
      throw new Error('The pane split is incomplete.');
    }
    return {
      actualPercentage:
        (conversation.getBoundingClientRect().width / split.getBoundingClientRect().width) * 100,
      maximum: Number(element.getAttribute('aria-valuemax')),
      minimum: Number(element.getAttribute('aria-valuemin')),
      now: Number(element.getAttribute('aria-valuenow')),
      splitWidth: split.getBoundingClientRect().width,
    };
  });

  expect(values.now).toBeGreaterThanOrEqual(values.minimum);
  expect(values.minimum).toBeLessThanOrEqual(values.maximum);
  expect(values.now).toBe(Math.max(values.minimum, Math.round(values.actualPercentage)));
  expect(values.minimum).toBe(Math.ceil((400 / values.splitWidth) * 100));
});

test('keeps Deploy disabled when the project has no approved release', async ({ page }) => {
  await openBuilder(page);
  await expect(page.getByRole('button', { name: 'Deploy' })).toBeDisabled();
});

test('does not hammer an unavailable release service', async ({ page }) => {
  let requests = 0;
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/projects/${projectId}/releases`, 'u'),
    async (route) => {
      requests += 1;
      await route.fulfill({ body: 'release service unavailable', status: 503 });
    },
  );

  await openBuilder(page);
  await expect(page.getByRole('button', { name: 'Deploy' })).toBeDisabled();
  await expect.poll(() => requests).toBeGreaterThanOrEqual(1);
  const initialRequests = requests;
  await page.waitForTimeout(2_500);
  expect(requests).toBe(initialRequests);
  expect(initialRequests).toBeLessThanOrEqual(2);
});

test('approves a readiness-evaluated release before deploying without leaving the builder', async ({
  page,
}) => {
  const releaseId = 'rel_01J00000000000000000000000';
  const deploymentId = 'dep_01J00000000000000000000000';
  const release = {
    id: releaseId,
    organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
    projectId,
    environmentId: 'environment-preview',
    commitSha: 'a'.repeat(40),
    specificationId: null,
    status: 'warnings',
    evidenceManifestArtifactId: null,
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
    createdAt: '2026-08-12T12:00:00.000Z',
  };
  const respond = (route: import('@playwright/test').Route, body: unknown) =>
    route.fulfill({
      body: JSON.stringify(body),
      contentType: 'application/json',
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
      },
      status: 200,
    });
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/${projectId}/releases`, 'u'), (route) =>
    respond(route, {
      items: [{ ...release, supportLevel: 'compatible', activeProduction: false, deployments: [] }],
      nextCursor: null,
      rollbackTargets: [],
    }),
  );
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}`, (route) =>
    respond(route, { release, readiness: { state: 'ready', findings: [] } }),
  );
  await page.route(
    `${apiBaseUrl}/v1/releases/${releaseId}/deployment-preview?retarget=false`,
    (route) =>
      respond(route, {
        title: 'First deploy',
        deploymentType: 'first_deploy',
        effects: {
          productionData: 'Created',
          secrets: 'Applied',
          url: 'Created',
          activeUsers: 'No users affected',
        },
        requiresExplicitDataDisposition: false,
      }),
  );
  let approved = false;
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/approve`, (route) => {
    approved = true;
    return respond(route, { release: { ...release, status: 'approved' } });
  });
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/deploy`, (route) =>
    approved
      ? respond(route, { deploymentId })
      : route.fulfill({ body: 'release not approved', status: 409 }),
  );
  await page.route(`${apiBaseUrl}/v1/deployments/${deploymentId}`, (route) =>
    respond(route, {
      deploymentId,
      releaseId,
      projectId,
      environmentId: 'environment-preview',
      status: 'healthy',
      url: 'https://app.example.test',
      events: [],
      terminalSuccess: {
        status: 'succeeded',
        permanentUrl: 'https://app.example.test',
        release: { id: releaseId, commitSha: release.commitSha },
        evidence: { statusLink: `/v1/releases/${releaseId}/evidence` },
        productionHealth: { status: 'healthy' },
        monitoring: {
          grafanaDashboardLinks: [],
          faroAppLink: 'https://grafana.example.test/faro',
          posthogAnnotationLink: 'https://posthog.example.test/release',
        },
        customDomainAction: { method: 'POST', href: `/v1/projects/${projectId}/domains` },
        previousHealthyRelease: null,
        previewChanges: {
          requireRedeploy: true,
          note: 'Preview changes require a new release and redeploy before they reach production.',
        },
      },
    }),
  );

  await openBuilder(page);
  const builderUrl = page.url();
  await page.getByRole('button', { name: 'Deploy' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to deploy' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'First deploy' })).toBeVisible();
  expect(approved).toBe(true);
  await page.getByRole('button', { name: 'Confirm deployment' }).click();
  await expect(page.getByRole('heading', { name: 'Deployment succeeded' })).toBeVisible();
  expect(page.url()).toBe(builderUrl);
});

test('opens and persists Mission Control without changing the URL', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1180 });
  await openBuilder(page);
  const before = page.url();

  await page.getByRole('button', { name: 'Mission Control' }).click();
  await expect(page.getByRole('dialog', { name: 'Mission Control' })).toBeVisible();
  await expect(page.getByText('No run in progress')).toBeVisible();
  expect(page.url()).toBe(before);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Mission Control' })).toHaveCount(0);
  expect(page.url()).toBe(before);

  await page.getByRole('button', { name: 'Mission Control' }).click();
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Mission Control' })).toBeVisible();
  expect(page.url()).toBe(before);
});

test('renders inline Mission Control as a pushing desktop region', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  const workspace = page.getByTestId('builder-workspace');
  const beforeColumns = await workspace.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns,
  );

  await page.getByRole('button', { name: 'Mission Control' }).click();

  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toBeVisible();
  const afterColumns = await workspace.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns,
  );
  expect(afterColumns.split(' ')).toHaveLength(2);
  expect(afterColumns).not.toBe(beforeColumns);
});

test('restores focus to the inline Mission Control toggle after Close', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  const missionControlToggle = page.getByRole('button', { name: 'Mission Control' });
  await missionControlToggle.click();
  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toBeVisible();

  await page.getByRole('button', { name: 'Close' }).click();

  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toHaveCount(0);
  await expect(missionControlToggle).toBeFocused();
});

test('Preview action selects and focuses the Preview surface', async ({ page }) => {
  await openBuilder(page);
  await page.getByRole('tab', { name: 'Code' }).click();
  await expect(page.getByRole('tab', { name: 'Code' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Preview' }).click();

  const previewTab = page.getByRole('tab', { name: 'Preview' });
  await expect(previewTab).toHaveAttribute('aria-selected', 'true');
  await expect(previewTab).toBeFocused();
});

test('defaults to Conversation and switches to Workspace below 1024px', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 900 });
  await openBuilder(page);

  await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Workspace' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Conversation' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conversation' })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('keeps the Lovable-style More hierarchy usable on a narrow workspace', async ({ page }) => {
  await page.setViewportSize({ height: 820, width: 680 });
  await openBuilder(page);

  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('tab', { name: 'More' }).click();
  await expect(page.getByRole('tab', { name: 'More' })).toHaveText('More');
  await page.getByRole('tab', { exact: true, name: 'Cloud' }).click();
  await expect(page.getByRole('tablist', { name: 'Cloud project views' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('omits repository actions when the repository record is absent', async ({ page }) => {
  await mockProjectRead(page, { ...projectRead, repository: null });
  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect(page.getByRole('link', { name: 'Source repository' })).toHaveCount(0);
  await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(0);
});

test('warns about an invalid organization override while using the safe membership', async ({
  page,
}) => {
  const projectRequests = await mockProjectRead(page);
  await signIn(page);
  const builderUrl = `/projects/${projectId}?organizationId=org-outside-memberships`;

  await page.goto(builderUrl);

  await expect(page.getByRole('heading', { name: 'Project Apollo' })).toBeVisible();
  await expect(
    page.getByRole('status').filter({
      hasText: 'Invalid organization selection. Showing your active organization.',
    }),
  ).toHaveText('Invalid organization selection. Showing your active organization.');
  await expect(page).toHaveURL(builderUrl);
  expect(projectRequests).toHaveLength(1);
  expect(projectRequests[0]?.headers()['x-organization-id']).toBe('org_01K27Q9C2W85CMN1V9S6Q3D4FD');
});

test('offers all standard recovery actions when the project cannot load', async ({ page }) => {
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        error: { code: 'fixture_failure', message: 'fixture failure', requestId: 'request-web-5' },
      }),
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
        'content-type': 'application/json',
      },
      status: 500,
    });
  });
  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect(
    page.getByRole('alert').filter({ hasText: 'We could not load this project' }),
  ).toBeVisible();
  for (const action of ['Fix automatically', 'Inspect details', 'Retry', 'Ask the agent']) {
    await expect(page.getByRole('button', { name: action })).toBeVisible();
  }
});

test('redirects to login when the organization-scoped project read returns 401', async ({
  page,
}) => {
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        error: { code: 'unauthorized', message: 'unauthorized', requestId: 'request-web-5' },
      }),
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
        'content-type': 'application/json',
      },
      status: 401,
    });
  });
  await signIn(page);

  await page.goto(`/projects/${projectId}`);

  await expect(page).toHaveURL('/login');
});
