import { expect, test, type Page } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';
const projectId = 'proj_01K27Q9C2W85CMN1V9S6Q3D4FE';
const runId = 'run_01K27Q9C2W85CMN1V9S6Q3D4FF';
const conversationId = 'conv_01K27Q9C2W85CMN1V9S6Q3D4FY';
const branchId = 'br_01K27Q9C2W85CMN1V9S6Q3D4FQ';
const fixRunId = 'run_01K27Q9C2W85CMN1V9S6Q3D4FZ';
const workspaceId = 'ws_01K27Q9C2W85CMN1V9S6Q3D4FG';
const previewEvidenceId = 'art_01K27Q9C2W85CMN1V9S6Q3D4FH';
const previewCommitSha = '0123456789abcdef0123456789abcdef01234567';
const organizationId = 'org_01K27Q9C2W85CMN1V9S6Q3D4FD';
const contractOrganizationId = 'org_01K27Q9C2W85CMN1V9S6Q3D4FD';
const shareUrl = `${appBaseUrl}/preview/org_01K27Q9C2W85CMN1V9S6Q3D4FD/01j00000000000000000000000#token=psb_fixture`;

const projectRead = {
  branches: [
    {
      createdAt: '2026-08-10T12:00:00.000Z',
      headCommitSha: previewCommitSha,
      id: branchId,
      name: 'main',
      organizationId,
      projectId,
    },
  ],
  environments: [],
  project: {
    archivedAt: null,
    createdAt: '2026-08-10T12:00:00.000Z',
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
    description: 'A preview fixture.',
    id: projectId,
    name: 'Preview Fixture',
    organizationId,
    slug: 'preview-fixture',
    sourceType: 'prompt',
    supportLevel: 'compatible' as const,
  },
  repository: null,
};

const activeRun = {
  appType: 'web' as const,
  branchId: null,
  completedAt: null as string | null,
  conversationId,
  conversationRunNumber: 1,
  id: runId,
  mode: 'build' as const,
  model: null,
  organizationId,
  planMaxCredits: '1000.0000',
  projectId,
  startedAt: '2026-08-10T12:00:00.000Z',
  startedBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
  status: 'running',
};

function corsHeaders(contentType = 'application/json'): Record<string, string> {
  return {
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type, idempotency-key, x-zapp-csrf, x-organization-id',
    'access-control-allow-origin': appBaseUrl,
    'content-type': contentType,
  };
}

function runFrame(
  sequence: number,
  type:
    'commit.created' | 'preview.failed' | 'preview.ready' | 'preview.starting' | 'run.completed',
  payload: Readonly<Record<string, unknown>>,
): string {
  const data = {
    id: `evt_01K27Q9C2W85CMN1V9S6${sequence.toString(32).toUpperCase().padStart(6, '0')}`,
    occurredAt: new Date(Date.parse('2026-08-10T12:00:00.000Z') + sequence * 1_000).toISOString(),
    organizationId: contractOrganizationId,
    payload,
    projectId,
    runId,
    sequence,
    type,
    visibility: 'user' as const,
  };
  return `id: ${String(sequence)}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function captureFrame(event: Readonly<Record<string, unknown>>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
}

async function reloadBuilder(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByRole('region', { name: 'Workspace' })).toBeVisible({
    timeout: 15_000,
  });
}

async function installBuilder(
  page: Page,
  runEvents: () => string,
  run: typeof activeRun = activeRun,
): Promise<void> {
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({ body: JSON.stringify(projectRead), headers: corsHeaders(), status: 200 });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ items: [run], nextCursor: null }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/workspaces*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        workspaces: [
          {
            branchId,
            createdAt: '2026-08-10T12:00:00.000Z',
            id: workspaceId,
            lastActiveAt: '2026-08-10T12:00:00.000Z',
            organizationId,
            projectId,
            provider: 'docker',
            providerWorkspaceId: 'provider-preview-fixture',
            resourceProfile: 'standard',
            snapshotRef: null,
            status: 'ready',
            terminatedAt: null,
          },
        ],
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/events*`, async (route) => {
    await route.fulfill({
      body: runEvents(),
      headers: corsHeaders('text/event-stream'),
      status: 200,
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('keeps preview controls compact and gives the remaining workspace to the stage', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await installBuilder(page, () => '', { ...activeRun, status: 'queued' });
  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  const workspace = page.getByRole('region', { name: 'Workspace' });
  const toolbar = page.getByRole('toolbar', { name: 'Preview controls' });
  const stage = page.getByRole('region', { name: 'Application preview' });
  const select = page.getByRole('button', { name: 'Select element' });
  const workspaceBounds = await workspace.boundingBox();
  const toolbarBounds = await toolbar.boundingBox();
  const stageBounds = await stage.boundingBox();
  const selectBounds = await select.boundingBox();
  if (
    workspaceBounds === null ||
    toolbarBounds === null ||
    stageBounds === null ||
    selectBounds === null
  ) {
    throw new Error('The compact preview geometry was not rendered.');
  }

  expect(toolbarBounds.height).toBeLessThanOrEqual(40);
  for (const name of ['Desktop view', 'Tablet view', 'Mobile view']) {
    const deviceControl = page.getByRole('button', { name });
    await expect(deviceControl).toBeVisible();
    await expect(deviceControl).toHaveText('');
    await expect(deviceControl).toHaveAttribute('title', name);
  }
  expect(selectBounds.y).toBeGreaterThanOrEqual(toolbarBounds.y);
  expect(selectBounds.y + selectBounds.height).toBeLessThanOrEqual(
    toolbarBounds.y + toolbarBounds.height,
  );
  expect(stageBounds.height).toBeGreaterThanOrEqual(workspaceBounds.height - 130);
  expect(stageBounds.width).toBeGreaterThanOrEqual(workspaceBounds.width - 24);
  await expect(page.getByRole('status', { name: 'Build status' })).toHaveText('Build queued');
});

test('leaves initial workspace provisioning to the active run while run state hydrates', async ({
  page,
}) => {
  const workspaceRequests: string[] = [];
  await installBuilder(page, () => '');
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      body: JSON.stringify({ items: [activeRun], nextCursor: null }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/workspaces*`, async (route) => {
    workspaceRequests.push(route.request().method());
    await route.fulfill({
      body: JSON.stringify({ workspaces: [] }),
      headers: corsHeaders(),
      status: 200,
    });
  });

  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect(page.getByRole('status', { name: 'Build status' })).toHaveText('Agent is running');
  expect(workspaceRequests).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Build in progress' })).toBeVisible();
});

test('restores a failed run from its project branch when no workspace was started', async ({
  page,
}) => {
  const recoveredWorkspaceId = 'ws_01K27Q9C2W85CMN1V9S6Q3D4FR';
  const workspaceCreateBodies: unknown[] = [];
  await installBuilder(page, () => '', {
    ...activeRun,
    completedAt: '2026-08-10T12:01:00.000Z',
    status: 'failed',
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/workspaces*`, async (route) => {
    if (route.request().method() === 'POST') {
      workspaceCreateBodies.push(route.request().postDataJSON());
      await route.fulfill({
        body: JSON.stringify({
          workspace: {
            branchId,
            createdAt: '2026-08-10T12:01:00.000Z',
            id: recoveredWorkspaceId,
            lastActiveAt: '2026-08-10T12:01:00.000Z',
            organizationId,
            projectId,
            provider: 'docker',
            providerWorkspaceId: 'provider-failed-run-preview',
            resourceProfile: 'standard',
            snapshotRef: null,
            status: 'ready',
            terminatedAt: null,
          },
        }),
        headers: corsHeaders(),
        status: 201,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ workspaces: [] }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(
    `${apiBaseUrl}/v1/workspaces/${recoveredWorkspaceId}/dev-server/restart`,
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          ownership: 'process_group',
          pid: 42,
          port: 3000,
          supervisorId: 'failed-run-preview-fixture',
        }),
        headers: corsHeaders(),
        status: 200,
      });
    },
  );
  await page.route(
    `${apiBaseUrl}/v1/workspaces/${recoveredWorkspaceId}/dev-server/logs*`,
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          entries: [],
          failureId: null,
          nextCursor: 0,
          state: 'starting',
          truncated: false,
        }),
        headers: corsHeaders(),
        status: 200,
      });
    },
  );

  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect(page.getByRole('heading', { name: 'Preview starting' })).toBeVisible();
  expect(workspaceCreateBodies).toEqual([{ branchId, resourceProfile: 'standard' }]);
  await expect(
    page.getByText('This run ended before the agent started a project workspace.'),
  ).toHaveCount(0);
});

test('rebuilds a failed project that has no durable preview revision', async ({ page }) => {
  const runBodies: unknown[] = [];
  const workspaceRequests: string[] = [];
  const failedRun = {
    ...activeRun,
    completedAt: '2026-08-10T12:01:00.000Z',
    status: 'failed',
  };
  await installBuilder(page, () => '', failedRun);
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        ...projectRead,
        branches: projectRead.branches.map((branch) => ({ ...branch, headCommitSha: null })),
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/workspaces*`, async (route) => {
    workspaceRequests.push(route.request().method());
    await route.fulfill({
      body: JSON.stringify({ workspaces: [] }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    if (route.request().method() === 'POST') {
      runBodies.push(route.request().postDataJSON());
      await route.fulfill({
        body: JSON.stringify({
          run: {
            ...failedRun,
            completedAt: null,
            conversationRunNumber: 2,
            id: fixRunId,
            status: 'queued',
          },
        }),
        headers: corsHeaders(),
        status: 202,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ items: [failedRun], nextCursor: null }),
      headers: corsHeaders(),
      status: 200,
    });
  });

  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect(page.getByRole('heading', { name: 'Build needs another run' })).toBeVisible();
  expect(workspaceRequests).toEqual([]);
  await page.getByRole('button', { name: 'Retry build' }).click();
  await expect.poll(() => runBodies.length).toBe(1);
  expect(runBodies[0]).toMatchObject({
    appType: 'web',
    branchId,
    conversationId,
    mode: 'build',
  });
  expect(runBodies[0]).toMatchObject({
    prompt: expect.stringContaining('Retry the failed build'),
  });
});

test('does not race an active run for control of its idle preview workspace', async ({ page }) => {
  const restartRequests: string[] = [];
  await installBuilder(page, () =>
    runFrame(1, 'preview.starting', { action: 'start', workspaceId }),
  );
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/dev-server/logs*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        entries: [],
        failureId: null,
        nextCursor: 0,
        state: 'idle',
        truncated: false,
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(
    `${apiBaseUrl}/v1/workspaces/${workspaceId}/dev-server/restart`,
    async (route) => {
      restartRequests.push(route.request().headers()['idempotency-key'] ?? '');
      await route.fulfill({ body: '{}', headers: corsHeaders(), status: 200 });
    },
  );

  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect(page.getByRole('status', { name: 'Build status' })).toHaveText('Agent is running');
  await expect(page.getByRole('heading', { name: 'Build in progress' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wake preview' })).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(restartRequests).toEqual([]);
});

test('keeps an existing healthy preview open when a repeated start reports failure', async ({
  page,
}) => {
  await installBuilder(page, () =>
    runFrame(1, 'preview.failed', {
      action: 'start',
      code: 'dev_server_operation_failed',
      workspaceId,
    }),
  );
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/dev-server/logs*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        entries: [],
        failureId: null,
        nextCursor: 0,
        state: 'ready',
        truncated: false,
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/shares`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        share: {
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString(),
          id: '01j00000000000000000000000',
          policy: 'org',
          url: shareUrl,
        },
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/events`, async (route) => {
    await route.fulfill({ body: '', headers: corsHeaders('text/event-stream'), status: 200 });
  });
  await page.route(
    `${appBaseUrl}/preview/org_01K27Q9C2W85CMN1V9S6Q3D4FD/01j00000000000000000000000*`,
    async (route) => {
      await route.fulfill({
        body: '<!doctype html><title>Fixture preview</title><h1>Preview application</h1>',
        contentType: 'text/html',
        status: 200,
      });
    },
  );

  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect(page.getByTitle('Application preview')).toBeVisible();
  await expect(page.getByText('Preview failed')).toHaveCount(0);
});

test('rehydrates an expired run workspace from the project branch and opens its preview', async ({
  page,
}) => {
  const recoveredWorkspaceId = 'ws_01K27Q9C2W85CMN1V9S6Q3D4FR';
  const workspaceCreateBodies: unknown[] = [];
  let restartRequests = 0;
  await installBuilder(page, () => runFrame(1, 'preview.ready', { action: 'start', workspaceId }));
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/workspaces*`, async (route) => {
    if (route.request().method() === 'POST') {
      workspaceCreateBodies.push(route.request().postDataJSON());
      await route.fulfill({
        body: JSON.stringify({
          workspace: {
            branchId,
            createdAt: '2026-08-10T12:01:00.000Z',
            id: recoveredWorkspaceId,
            lastActiveAt: '2026-08-10T12:01:00.000Z',
            organizationId,
            projectId,
            provider: 'docker',
            providerWorkspaceId: 'provider-recovered-preview',
            resourceProfile: 'standard',
            snapshotRef: null,
            status: 'ready',
            terminatedAt: null,
          },
        }),
        headers: corsHeaders(),
        status: 201,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        workspaces: [
          {
            branchId,
            createdAt: '2026-08-10T12:00:00.000Z',
            id: workspaceId,
            lastActiveAt: '2026-08-10T12:00:00.000Z',
            organizationId,
            projectId,
            provider: 'docker',
            providerWorkspaceId: null,
            resourceProfile: 'standard',
            snapshotRef: null,
            status: 'terminated',
            terminatedAt: '2026-08-10T12:00:01.000Z',
          },
        ],
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(
    `${apiBaseUrl}/v1/workspaces/${recoveredWorkspaceId}/dev-server/restart`,
    async (route) => {
      restartRequests += 1;
      await route.fulfill({
        body: JSON.stringify({
          ownership: 'process_group',
          pid: 42,
          port: 3000,
          supervisorId: 'recovered-preview-fixture',
        }),
        headers: corsHeaders(),
        status: 200,
      });
    },
  );
  await page.route(
    `${apiBaseUrl}/v1/workspaces/${recoveredWorkspaceId}/dev-server/logs*`,
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          entries: [],
          failureId: null,
          nextCursor: 0,
          state: 'ready',
          truncated: false,
        }),
        headers: corsHeaders(),
        status: 200,
      });
    },
  );
  await page.route(
    `${apiBaseUrl}/v1/workspaces/${recoveredWorkspaceId}/preview/shares`,
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          share: {
            expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString(),
            id: '01j00000000000000000000000',
            policy: 'org',
            url: shareUrl,
          },
        }),
        headers: corsHeaders(),
        status: 201,
      });
    },
  );
  await page.route(
    `${apiBaseUrl}/v1/workspaces/${recoveredWorkspaceId}/preview/events`,
    async (route) => {
      await route.fulfill({ body: '', headers: corsHeaders('text/event-stream'), status: 200 });
    },
  );
  await page.route(
    `${appBaseUrl}/preview/org_01K27Q9C2W85CMN1V9S6Q3D4FD/01j00000000000000000000000*`,
    async (route) => {
      await route.fulfill({
        body: '<!doctype html><title>Recovered preview</title><h1>Recovered application</h1>',
        contentType: 'text/html',
        status: 200,
      });
    },
  );

  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect(page.getByTitle('Application preview')).toBeVisible();
  expect(workspaceCreateBodies).toEqual([{ branchId, resourceProfile: 'standard' }]);
  expect(restartRequests).toBe(1);
  await expect(page.getByText('Opening preview')).toHaveCount(0);
});

test('creates the authenticated share before opening the long-lived capture stream', async ({
  page,
}) => {
  let shareCreated = false;
  let captureOpenedBeforeShare = false;
  await installBuilder(page, () => runFrame(1, 'preview.ready', { action: 'start', workspaceId }));
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/dev-server/logs*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        entries: [],
        failureId: null,
        nextCursor: 0,
        state: 'ready',
        truncated: false,
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/shares`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    shareCreated = true;
    await route.fulfill({
      body: JSON.stringify({
        share: {
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString(),
          id: '01j00000000000000000000000',
          policy: 'org',
          url: shareUrl,
        },
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/events`, async (route) => {
    captureOpenedBeforeShare ||= !shareCreated;
    await route.fulfill({ body: '', headers: corsHeaders('text/event-stream'), status: 200 });
  });
  await page.route(
    `${appBaseUrl}/preview/org_01K27Q9C2W85CMN1V9S6Q3D4FD/01j00000000000000000000000*`,
    async (route) => {
      await route.fulfill({
        body: '<!doctype html><title>Fixture preview</title><h1>Preview application</h1>',
        contentType: 'text/html',
        status: 200,
      });
    },
  );

  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect(page.getByTitle('Application preview')).toBeVisible();
  expect(captureOpenedBeforeShare).toBe(false);
});

test('uses one run event stream for the conversation and preview surfaces', async ({ page }) => {
  let runStreamRequests = 0;
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({ body: JSON.stringify(projectRead), headers: corsHeaders(), status: 200 });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ items: [activeRun], nextCursor: null }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/events*`, async (route) => {
    runStreamRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      body: runFrame(1, 'preview.ready', { action: 'start', workspaceId }),
      headers: corsHeaders('text/event-stream'),
      status: 200,
    });
  });

  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect.poll(() => runStreamRequests).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(runStreamRequests).toBe(1);
});

test('renders preview lifecycle states from structured events and public workspace APIs', async ({
  page,
}) => {
  let frames = runFrame(1, 'preview.starting', { action: 'start', workspaceId });
  let logState: 'failed' | 'idle' | 'ready' | 'restarting' | 'starting' = 'starting';
  let captureFails = false;
  const restartRequests: string[] = [];
  const sharePolicies: string[] = [];
  const shareKeys: string[] = [];
  const fixRunBodies: unknown[] = [];
  const fixRunKeys: string[] = [];
  const fixScreenshotKeys: string[] = [];
  const fixUploadKeys: string[] = [];
  const observedRunStreams: string[] = [];
  await installBuilder(page, () => frames);
  await page.route(`${apiBaseUrl}/v1/runs/${fixRunId}/events*`, async (route) => {
    observedRunStreams.push(fixRunId);
    await route.fulfill({ body: '', headers: corsHeaders('text/event-stream'), status: 200 });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fallback();
      return;
    }
    fixRunBodies.push(route.request().postDataJSON());
    fixRunKeys.push(route.request().headers()['idempotency-key'] ?? '');
    if (fixRunBodies.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({ body: '{}', headers: corsHeaders(), status: 502 });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ run: { ...activeRun, id: fixRunId, mode: 'fix' } }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await page.route(
    `${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/screenshot`,
    async (route) => {
      fixScreenshotKeys.push(route.request().headers()['idempotency-key'] ?? '');
      await route.fulfill({
        body: Buffer.from([137, 80, 78, 71]),
        headers: corsHeaders('image/png'),
        status: 200,
      });
    },
  );
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/attachments`, async (route) => {
    fixUploadKeys.push(route.request().headers()['idempotency-key'] ?? '');
    await route.fulfill({
      body: JSON.stringify({
        attachmentId: previewEvidenceId,
        byteSize: 4,
        contentType: 'image/png',
        kind: 'image',
        name: 'preview-boot-failure.png',
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/dev-server/logs*`, async (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0);
    const entries =
      after === 0
        ? Array.from({ length: 100 }, (_, index) => ({
            at: new Date(Date.parse('2026-08-10T12:00:01.000Z') + index).toISOString(),
            cursor: index + 1,
            message: index === 0 ? 'Installing dependencies' : `Boot line ${String(index + 1)}`,
            stream: 'stdout' as const,
          }))
        : after === 100
          ? [
              {
                at: '2026-08-10T12:00:02.000Z',
                cursor: 101,
                message: 'Application listening on port 3000',
                stream: 'stdout' as const,
              },
            ]
          : after === 101 && logState === 'failed'
            ? [
                {
                  at: '2026-08-10T12:00:03.000Z',
                  cursor: 102,
                  message: 'Checkout boot crashed after binding the port',
                  stream: 'stderr' as const,
                },
              ]
            : [];
    await route.fulfill({
      body: JSON.stringify({
        entries,
        failureId: null,
        nextCursor: entries.at(-1)?.cursor ?? after,
        state: logState,
        truncated: false,
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/shares`, async (route) => {
    const policy = (route.request().postDataJSON() as { policy: string }).policy;
    sharePolicies.push(policy);
    shareKeys.push(route.request().headers()['idempotency-key'] ?? '');
    if (
      policy === 'anyone_with_link' &&
      sharePolicies.filter((value) => value === policy).length === 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({ body: '{}', headers: corsHeaders(), status: 502 });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        share: {
          expiresAt:
            policy === 'org' && sharePolicies.filter((value) => value === policy).length === 1
              ? new Date(Date.now() + 61_000).toISOString()
              : new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString(),
          id: '01j00000000000000000000000',
          policy: 'org',
          url: shareUrl,
        },
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await page.route(
    `${apiBaseUrl}/v1/workspaces/${workspaceId}/dev-server/restart`,
    async (route) => {
      restartRequests.push(route.request().headers()['idempotency-key'] ?? '');
      if (restartRequests.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({ body: '{}', headers: corsHeaders(), status: 502 });
        return;
      }
      await route.fulfill({
        body: JSON.stringify({
          ownership: 'process_group',
          pid: 42,
          port: 3000,
          supervisorId: 'preview-fixture',
        }),
        headers: corsHeaders(),
        status: 200,
      });
    },
  );
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/events`, async (route) => {
    if (captureFails) {
      await route.fulfill({ body: '{}', headers: corsHeaders(), status: 503 });
      return;
    }
    await route.fulfill({
      body: captureFrame({
        payload: { url: 'https://preview.zapp.test/settings' },
        type: 'route_change',
      }),
      headers: corsHeaders('text/event-stream'),
      status: 200,
    });
  });
  await page.route(
    `${appBaseUrl}/preview/org_01K27Q9C2W85CMN1V9S6Q3D4FD/01j00000000000000000000000*`,
    async (route) => {
      await route.fulfill({
        body: '<!doctype html><title>Fixture preview</title><h1>Preview application</h1>',
        contentType: 'text/html',
        status: 200,
      });
    },
  );

  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Preview starting' })).toBeVisible();
  await expect(page.getByText('Application listening on port 3000')).toBeVisible();

  logState = 'ready';
  frames += runFrame(2, 'preview.ready', { action: 'start', workspaceId });
  await reloadBuilder(page);
  await expect(page.getByTitle('Application preview')).toBeVisible();
  await expect(page.getByText('/settings', { exact: true })).toBeVisible();
  await expect(page.getByText('Preview', { exact: true }).last()).toBeVisible();
  await expect
    .poll(() => sharePolicies.filter((policy) => policy === 'org').length)
    .toBeGreaterThanOrEqual(2);
  const orgShareKeys = shareKeys.filter((_, index) => sharePolicies[index] === 'org');
  expect(orgShareKeys[0]).not.toBe(orgShareKeys[1]);
  await page.getByRole('button', { name: 'Share link', exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByText('The share link could not be created.')).toBeVisible();
  expect(sharePolicies.filter((policy) => policy === 'anyone_with_link')).toHaveLength(1);
  await page.getByRole('button', { name: 'Share link', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Share link', exact: true })).toHaveValue(
    shareUrl,
  );
  const publicShareKeys = shareKeys.filter(
    (_, index) => sharePolicies[index] === 'anyone_with_link',
  );
  expect(publicShareKeys).toHaveLength(2);
  expect(publicShareKeys[0]).toBe(publicShareKeys[1]);

  frames += runFrame(3, 'commit.created', { commitSha: previewCommitSha });
  await reloadBuilder(page);
  await expect(page.getByText('Preview is behind latest changes — Restart')).toBeVisible();
  await page.getByRole('button', { name: 'Restart', exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByText('Preview restart failed. Retry safely.')).toBeVisible();
  expect(restartRequests).toHaveLength(1);
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect.poll(() => restartRequests.length).toBe(2);
  expect(restartRequests[0]).not.toBe(restartRequests[1]);

  frames += runFrame(4, 'run.completed', { status: 'completed' });
  await reloadBuilder(page);
  await expect(page.getByText('Preview is behind latest changes — Restart')).toHaveCount(0);

  frames += runFrame(5, 'preview.ready', { action: 'restart', workspaceId });
  logState = 'idle';
  await reloadBuilder(page);
  await expect.poll(() => restartRequests.length).toBe(3);
  await expect(page.getByRole('heading', { name: 'Preview starting' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wake preview' })).toHaveCount(0);
  expect(restartRequests[2]).not.toBe(restartRequests[1]);

  await reloadBuilder(page);
  await expect(page.getByRole('heading', { name: 'Preview starting' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wake preview' })).toHaveCount(0);
  expect(restartRequests).toHaveLength(3);

  logState = 'ready';
  captureFails = true;
  await reloadBuilder(page);
  await expect(page.getByTitle('Application preview')).toBeVisible();
  await expect(page.getByText('Preview interaction channel disconnected.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry preview connection' })).toBeVisible();

  captureFails = false;
  logState = 'failed';
  frames += runFrame(6, 'preview.failed', {
    code: 'dev_server_operation_failed',
    workspaceId,
  });
  await expect(page.getByText('Preview failed')).toBeVisible();
  for (const action of ['Fix automatically', 'Inspect details', 'Retry', 'Ask the agent']) {
    await expect(page.getByRole('button', { name: action })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Fix automatically' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByText('The Fix run could not be started.')).toBeVisible();
  expect(fixRunBodies).toHaveLength(1);
  await page.getByRole('button', { name: 'Fix automatically' }).click();
  await expect.poll(() => fixRunBodies.length).toBe(2);
  expect(fixRunKeys[0]).toBe(fixRunKeys[1]);
  expect(fixRunBodies[1]).toEqual(fixRunBodies[0]);
  expect(fixRunBodies[0]).toMatchObject({
    appType: 'web',
    fixRequest: {
      evidence: [
        {
          artifactId: previewEvidenceId,
          kind: 'preview_console',
          summary: expect.stringContaining('Checkout boot crashed after binding the port'),
        },
      ],
      relevantCommitSha: previewCommitSha,
      reproductionRef: `preview-workspace:${workspaceId}`,
      source: 'error_report',
      summary: expect.stringContaining('Checkout boot crashed after binding the port'),
    },
    mode: 'fix',
    prompt: expect.stringContaining('Checkout boot crashed after binding the port'),
  });
  expect(fixScreenshotKeys).toHaveLength(1);
  expect(fixUploadKeys).toHaveLength(1);
  expect(fixScreenshotKeys[0]).not.toBe('');
  expect(fixUploadKeys[0]).not.toBe('');
  await expect
    .poll(() => observedRunStreams.filter((id) => id === fixRunId).length)
    .toBeGreaterThan(0);
});

test('captures a console error and attaches its screenshot to the conversation composer', async ({
  page,
}) => {
  const screenshotKeys: string[] = [];
  let captureDelivered = false;
  await installBuilder(page, () => runFrame(1, 'preview.ready', { action: 'start', workspaceId }));
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/dev-server/logs*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        entries: [],
        failureId: null,
        nextCursor: 0,
        state: 'ready',
        truncated: false,
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/shares`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        share: {
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString(),
          id: '01j00000000000000000000000',
          policy: 'org',
          url: shareUrl,
        },
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/events`, async (route) => {
    await route.fulfill({
      body: captureDelivered
        ? ': keep-alive\n\n'
        : captureFrame({
            payload: {
              level: 'error',
              message: 'Checkout total crashed',
              stack: 'at Checkout (/src/Checkout.tsx:42:9)',
            },
            type: 'console',
          }),
      headers: corsHeaders('text/event-stream'),
      status: 200,
    });
    captureDelivered = true;
  });
  await page.route(
    `${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/screenshot`,
    async (route) => {
      screenshotKeys.push(route.request().headers()['idempotency-key'] ?? '');
      if (screenshotKeys.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({ body: '{}', headers: corsHeaders(), status: 502 });
        return;
      }
      await route.fulfill({
        body: Buffer.from([137, 80, 78, 71]),
        headers: corsHeaders('image/png'),
        status: 200,
      });
    },
  );
  await page.route(
    `${appBaseUrl}/preview/org_01K27Q9C2W85CMN1V9S6Q3D4FD/01j00000000000000000000000*`,
    async (route) => {
      await route.fulfill({ body: '<!doctype html><h1>Preview</h1>', contentType: 'text/html' });
    },
  );

  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByTitle('Application preview')).toBeVisible();
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  const error = page.getByRole('row', { name: /Checkout total crashed/u });
  await expect(error).toBeVisible();
  await error.getByRole('button', { name: 'Attach to chat' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByText('The error screenshot could not be attached.')).toBeVisible();
  expect(screenshotKeys).toHaveLength(1);
  await error.getByRole('button', { name: 'Attach to chat' }).click();

  await expect(page.getByLabel('Attached images')).toContainText('console-error.png');
  await expect(page.getByLabel('Attached images')).toContainText('Checkout total crashed');
  await expect(page.getByLabel('Message the agent')).toBeFocused();
  expect(screenshotKeys[0]).toBe(screenshotKeys[1]);

  const composer = page.getByLabel('Message the agent');
  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    for (let index = 1; index <= 9; index += 1) {
      transfer.items.add(new File(['png'], `capacity-${String(index)}.png`, { type: 'image/png' }));
    }
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  });
  await expect(page.getByLabel('Attached images')).toContainText('capacity-9.png');
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await page
    .getByRole('row', { name: /Checkout total crashed/u })
    .getByRole('button', { name: 'Attach to chat' })
    .click();
  await expect(
    page.getByText('The chat composer already has the maximum of 10 images.'),
  ).toBeVisible();
  await expect(page.getByLabel('Attached images')).toContainText('capacity-9.png');
  expect(screenshotKeys[2]).not.toBe(screenshotKeys[1]);
});

test('attaches a trusted selected element and sends its canonical context with the public screenshot', async ({
  page,
}) => {
  let sentMessage: unknown;
  const screenshotRequests: string[] = [];
  const uploads: unknown[] = [];
  await installBuilder(page, () => runFrame(1, 'preview.ready', { action: 'start', workspaceId }));
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/dev-server/logs*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        entries: [],
        failureId: null,
        nextCursor: 0,
        state: 'ready',
        truncated: false,
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/shares`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        share: {
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString(),
          id: '01j00000000000000000000000',
          policy: 'org',
          url: shareUrl,
        },
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/events`, async (route) => {
    await route.fulfill({
      body: captureFrame({
        type: 'route_change',
        payload: { url: new URL('/settings', appBaseUrl).toString() },
      }),
      headers: corsHeaders('text/event-stream'),
      status: 200,
    });
  });
  await page.route(
    `${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/screenshot`,
    async (route) => {
      screenshotRequests.push(route.request().headers()['idempotency-key'] ?? '');
      await route.fulfill({
        body: Buffer.from([137, 80, 78, 71]),
        headers: corsHeaders('image/png'),
        status: 200,
      });
    },
  );
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/attachments`, async (route) => {
    uploads.push(route.request().postData());
    await route.fulfill({
      body: JSON.stringify({
        attachmentId: previewEvidenceId,
        byteSize: 4,
        contentType: 'image/png',
        kind: 'image',
        name: 'selected-element.png',
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/messages`, async (route) => {
    sentMessage = route.request().postDataJSON();
    await route.fulfill({
      body: JSON.stringify({ messageId: 'msg_01K27Q9C2W85CMN1V9S6Q3D4FG', sequence: 2 }),
      headers: corsHeaders(),
      status: 202,
    });
  });
  await page.route(
    `${appBaseUrl}/preview/org_01K27Q9C2W85CMN1V9S6Q3D4FD/01j00000000000000000000000*`,
    async (route) => {
      await route.fulfill({
        body: `<!doctype html><script>
        window.addEventListener('message', (event) => {
          if (event.data?.type === 'zapp:selection-mode') {
            document.body.dataset.selectionMode = String(event.data.enabled);
          }
        });
      </script><h1>Preview</h1>`,
        contentType: 'text/html',
      });
    },
  );

  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByTitle('Application preview')).toBeVisible();
  await page.getByRole('button', { name: 'Select element' }).click();
  await expect(
    page.getByTitle('Application preview').contentFrame().locator('body'),
  ).toHaveAttribute('data-selection-mode', 'true');
  await page
    .getByTitle('Application preview')
    .contentFrame()
    .locator('body')
    .evaluate(() => {
      window.parent.postMessage(
        {
          payload: {
            boundingBox: { height: 36, width: 88, x: 24, y: 16 },
            componentHint: 'Button',
            computedRole: 'button',
            selector: '[data-testid="save-settings"]',
            text: 'Save',
          },
          type: 'zapp:element-selected',
        },
        window.location.origin,
      );
    });

  await expect(page.getByLabel('Attached selections')).toContainText(
    "Selected: <Button> 'Save' on /settings",
  );
  await expect(
    page.getByTitle('Application preview').contentFrame().locator('body'),
  ).toHaveAttribute('data-selection-mode', 'false');
  await expect(page.getByRole('button', { name: 'Remove selected Button Save' })).toBeVisible();
  await page
    .getByTitle('Application preview')
    .contentFrame()
    .locator('body')
    .evaluate(async () => {
      window.parent.postMessage(
        {
          payload: {
            boundingBox: { height: 36, width: 88, x: 24, y: 16 },
            componentHint: 'Button',
            computedRole: 'button',
            selector: '[data-testid="save-settings"]',
            text: 'Save',
          },
          type: 'zapp:element-selected',
        },
        window.location.origin,
      );
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      });
    });
  expect(screenshotRequests).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Remove selected Button Save' })).toHaveCount(1);
  await page.getByLabel('Message the agent').fill('Move this beside the password field.');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect.poll(() => uploads).toHaveLength(1);
  await expect.poll(() => sentMessage).toBeDefined();
  const body = sentMessage as { attachments: readonly unknown[]; content: string };
  expect(body.attachments).toEqual([
    expect.objectContaining({
      attachmentId: previewEvidenceId,
      contentType: 'image/png',
      kind: 'image',
    }),
  ]);
  expect(JSON.parse(body.content)).toEqual({
    message: 'Move this beside the password field.',
    selectedElements: [
      {
        boundingBox: { height: 36, width: 88, x: 24, y: 16 },
        componentHint: 'Button',
        path: '/settings',
        role: 'button',
        selector: '[data-testid="save-settings"]',
        text: 'Save',
      },
    ],
  });
});

test('does not attach a selected-element screenshot completed after the preview iframe is refreshed', async ({
  page,
}) => {
  let markScreenshotStarted: (() => void) | undefined;
  let releaseScreenshot: (() => void) | undefined;
  const screenshotStarted = new Promise<void>((resolve) => {
    markScreenshotStarted = resolve;
  });
  const screenshotReleased = new Promise<void>((resolve) => {
    releaseScreenshot = resolve;
  });
  await installBuilder(page, () => runFrame(1, 'preview.ready', { action: 'start', workspaceId }));
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/dev-server/logs*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        entries: [],
        failureId: null,
        nextCursor: 0,
        state: 'ready',
        truncated: false,
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/shares`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        share: {
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString(),
          id: '01j00000000000000000000000',
          policy: 'org',
          url: shareUrl,
        },
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/events`, async (route) => {
    await route.fulfill({ body: '', headers: corsHeaders('text/event-stream'), status: 200 });
  });
  await page.route(
    `${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/screenshot`,
    async (route) => {
      markScreenshotStarted?.();
      await screenshotReleased;
      await route.fulfill({
        body: Buffer.from([137, 80, 78, 71]),
        headers: corsHeaders('image/png'),
        status: 200,
      });
    },
  );
  await page.route(
    `${appBaseUrl}/preview/org_01K27Q9C2W85CMN1V9S6Q3D4FD/01j00000000000000000000000*`,
    async (route) => {
      await route.fulfill({ body: '<!doctype html><h1>Preview</h1>', contentType: 'text/html' });
    },
  );

  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByTitle('Application preview')).toBeVisible();
  await page.getByRole('button', { name: 'Select element' }).click();
  await page
    .getByTitle('Application preview')
    .contentFrame()
    .locator('body')
    .evaluate(() => {
      window.parent.postMessage(
        {
          payload: {
            boundingBox: { height: 36, width: 88, x: 24, y: 16 },
            componentHint: 'Button',
            computedRole: 'button',
            selector: '[data-testid="save-settings"]',
            text: 'Save',
          },
          type: 'zapp:element-selected',
        },
        window.location.origin,
      );
    });
  await screenshotStarted;

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(
    page.getByTitle('Application preview').contentFrame().getByRole('heading', { name: 'Preview' }),
  ).toBeVisible();
  const screenshotResponse = page.waitForResponse(
    `${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/screenshot`,
  );
  releaseScreenshot?.();
  await screenshotResponse;
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  });

  await expect(page.getByLabel('Attached selections')).toBeEmpty();
});
