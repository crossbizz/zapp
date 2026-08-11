import { expect, test, type Page } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';
const projectId = 'proj_01K27Q9C2W85CMN1V9S6Q3D4FE';
const runId = 'run_01K27Q9C2W85CMN1V9S6Q3D4FF';
const fixRunId = 'run_01K27Q9C2W85CMN1V9S6Q3D4FZ';
const workspaceId = 'ws_01K27Q9C2W85CMN1V9S6Q3D4FG';
const organizationId = 'org-alpha';
const contractOrganizationId = 'org_01K27Q9C2W85CMN1V9S6Q3D4FD';
const shareUrl = `${appBaseUrl}/preview/org-alpha/01j00000000000000000000000#token=psb_fixture`;

const projectRead = {
  branches: [],
  environments: [],
  project: {
    archivedAt: null,
    createdAt: '2026-08-10T12:00:00.000Z',
    createdBy: 'user-ada',
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
  completedAt: null,
  id: runId,
  mode: 'build' as const,
  model: null,
  organizationId,
  projectId,
  startedAt: '2026-08-10T12:00:00.000Z',
  startedBy: 'user-ada',
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
  type: 'commit.created' | 'preview.failed' | 'preview.ready' | 'preview.starting',
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

async function installBuilder(page: Page, runEvents: () => string): Promise<void> {
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({ body: JSON.stringify(projectRead), headers: corsHeaders(), status: 200 });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ items: [activeRun], nextCursor: null }),
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

test('renders preview lifecycle states from structured events and public workspace APIs', async ({
  page,
}) => {
  let frames = runFrame(1, 'preview.starting', { action: 'start', workspaceId });
  let logState: 'failed' | 'idle' | 'ready' | 'restarting' | 'starting' = 'starting';
  let captureFails = false;
  const restartRequests: string[] = [];
  const startRequests: string[] = [];
  const sharePolicies: string[] = [];
  const shareKeys: string[] = [];
  const fixRunBodies: unknown[] = [];
  const fixRunKeys: string[] = [];
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
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/start`, async (route) => {
    startRequests.push(route.request().headers()['idempotency-key'] ?? '');
    if (startRequests.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({ body: '{}', headers: corsHeaders(), status: 502 });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        workspace: {
          branchId: null,
          createdAt: '2026-08-10T12:00:00.000Z',
          id: workspaceId,
          lastActiveAt: '2026-08-10T12:00:01.000Z',
          organizationId,
          projectId,
          provider: 'modal',
          providerWorkspaceId: 'sb_fixture',
          resourceProfile: 'standard',
          snapshotRef: null,
          status: 'ready',
          terminatedAt: null,
        },
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
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
  await page.route(`${appBaseUrl}/preview/org-alpha/01j00000000000000000000000*`, async (route) => {
    await route.fulfill({
      body: '<!doctype html><title>Fixture preview</title><h1>Preview application</h1>',
      contentType: 'text/html',
      status: 200,
    });
  });

  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Preview starting' })).toBeVisible();
  await expect(page.getByText('Application listening on port 3000')).toBeVisible();

  logState = 'ready';
  frames += runFrame(2, 'preview.ready', { action: 'start', workspaceId });
  await page.reload();
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
  await expect(page.getByLabel('Share link')).toHaveValue(shareUrl);
  const publicShareKeys = shareKeys.filter(
    (_, index) => sharePolicies[index] === 'anyone_with_link',
  );
  expect(publicShareKeys).toHaveLength(2);
  expect(publicShareKeys[0]).toBe(publicShareKeys[1]);

  frames += runFrame(3, 'commit.created', { commitSha: '0123456789abcdef' });
  await page.reload();
  await expect(page.getByText('Preview is behind latest changes — Restart')).toBeVisible();
  await page.getByRole('button', { name: 'Restart', exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByText('Preview restart failed. Retry safely.')).toBeVisible();
  expect(restartRequests).toHaveLength(1);
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect.poll(() => restartRequests.length).toBe(2);
  expect(restartRequests[0]).toBe(restartRequests[1]);

  frames += runFrame(4, 'preview.ready', { action: 'restart', workspaceId });
  logState = 'idle';
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Preview sleeping' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wake preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Wake preview' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByText('Preview could not be woken. Retry safely.')).toBeVisible();
  expect(startRequests).toHaveLength(1);
  await page.getByRole('button', { name: 'Wake preview' }).click();
  await expect.poll(() => startRequests.length).toBe(2);
  expect(startRequests[0]).toBe(startRequests[1]);

  logState = 'ready';
  captureFails = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Preview disconnected' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry preview connection' })).toBeVisible();

  captureFails = false;
  logState = 'failed';
  frames += runFrame(5, 'preview.failed', {
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
    mode: 'fix',
    prompt: expect.stringContaining('Checkout boot crashed after binding the port'),
  });
  await expect
    .poll(() => observedRunStreams.filter((id) => id === fixRunId).length)
    .toBeGreaterThan(0);
});

test('captures a console error and attaches its screenshot to the conversation composer', async ({
  page,
}) => {
  const screenshotKeys: string[] = [];
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
  await page.route(`${appBaseUrl}/preview/org-alpha/01j00000000000000000000000*`, async (route) => {
    await route.fulfill({ body: '<!doctype html><h1>Preview</h1>', contentType: 'text/html' });
  });

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
