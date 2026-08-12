import { expect, test, type Page, type Request } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';
const projectId = 'proj_01K27Q9C2W85CMN1V9S6Q3D4FE';
const runId = 'run_01K27Q9C2W85CMN1V9S6Q3D4FF';
const organizationId = 'org-alpha';
const contractOrganizationId = 'org_01K27Q9C2W85CMN1V9S6Q3D4FD';

const projectRead = {
  branches: [],
  environments: [],
  project: {
    archivedAt: null,
    createdAt: '2026-08-10T12:00:00.000Z',
    createdBy: 'user-ada',
    description: 'A conversation fixture.',
    id: projectId,
    name: 'Conversation Fixture',
    organizationId,
    slug: 'conversation-fixture',
    sourceType: 'prompt',
    supportLevel: 'compatible' as const,
  },
  repository: null,
};

const activeRun = {
  appType: 'web' as const,
  branchId: null,
  completedAt: null as string | null,
  id: runId,
  mode: 'build' as const,
  model: null,
  organizationId,
  projectId,
  startedAt: '2026-08-10T12:00:00.000Z',
  startedBy: 'user-ada',
  status: 'running',
};

interface EventInput {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sequence: number;
  readonly type:
    | 'commit.created'
    | 'message.assistant'
    | 'message.user'
    | 'phase.completed'
    | 'phase.started'
    | 'run.cancelled'
    | 'tool.completed'
    | 'tool.started';
}

function eventData({ payload, sequence, type }: EventInput) {
  const tail = sequence.toString(32).toUpperCase().padStart(6, '0');
  return {
    id: `evt_01K27Q9C2W85CMN1V9S6${tail}`,
    occurredAt: new Date(Date.parse('2026-08-10T12:00:00.000Z') + sequence * 1_000).toISOString(),
    organizationId: contractOrganizationId,
    payload,
    projectId,
    runId,
    sequence,
    type,
    visibility: 'user' as const,
  };
}

function eventFrame(input: EventInput): string {
  const data = eventData(input);
  return [
    `id: ${String(input.sequence)}`,
    `event: ${input.type}`,
    `data: ${JSON.stringify(data)}`,
    '',
    '',
  ].join('\n');
}

function corsHeaders(contentType = 'application/json'): Record<string, string> {
  return {
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type, idempotency-key, x-zapp-csrf, x-organization-id',
    'access-control-allow-origin': appBaseUrl,
    'content-type': contentType,
  };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
}

async function mockBuilder(
  page: Page,
  runs: readonly (typeof activeRun)[] = [activeRun],
): Promise<void> {
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify(projectRead),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ items: runs, nextCursor: null }),
      headers: corsHeaders(),
      status: 200,
    });
  });
}

async function openBuilder(page: Page, runs?: readonly (typeof activeRun)[]): Promise<void> {
  await mockBuilder(page, runs);
  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Conversation Fixture' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('renders Mission Control state and reconciles pause and approval actions', async ({ page }) => {
  let runStatus = 'running';
  let approvalStatus = 'pending';
  const mission = () => ({
    run: { ...activeRun, status: runStatus },
    currentPhase: { id: 'phase_build', sequence: 1, title: 'Build checkout', status: 'running' },
    progress: { done: 1, total: 2 },
    taskGraph: {
      nodes: [
        { id: 'task_form', phaseId: 'phase_build', title: 'Create form', status: 'failed', riskLevel: 'medium', assignedAgentRole: 'builder' },
        { id: 'task_verify', phaseId: 'phase_build', title: 'Verify checkout', status: 'queued', riskLevel: 'low', assignedAgentRole: 'verifier' },
      ],
      edges: [{ from: 'task_form', to: 'task_verify' }],
    },
    activeAgents: [{ agentId: 'agent-builder', role: 'builder', taskId: 'task_form', startedAt: '2026-08-10T12:00:00.000Z' }],
    recentToolCalls: [{ sequence: 3, toolCallId: 'tool-write', toolName: 'write_file', status: 'failed', userSummary: 'Edited checkout form', durationMs: 42, taskId: 'task_form', agentId: 'agent-builder', occurredAt: '2026-08-10T12:00:03.000Z' }],
    filesChanged: [{ path: 'src/checkout.tsx', additions: 12, deletions: 1 }],
    commits: [],
    testRuns: [],
    previewStatus: { status: 'ready', occurredAt: '2026-08-10T12:00:04.000Z' },
    screenshots: [],
    cost: { creditsUsed: 2, budget: 10 },
    approvals: [{ approvalId: 'appr_plan', taskId: null, type: 'plan', status: approvalStatus, request: { artifactId: 'art_plan' }, response: null, requestedAt: '2026-08-10T12:00:05.000Z', resolvedAt: null }],
    risks: [{ id: 'risk-1', severity: 'medium', summary: 'Checkout needs browser evidence' }],
    actions: {
      retryFailedTasks: [{ taskId: 'task_form', eligible: true, reason: 'eligible' }],
      skipOptionalPhases: [],
    },
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/mission-control`, async (route) => {
    await route.fulfill({ body: JSON.stringify(mission()), headers: corsHeaders(), status: 200 });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/pause`, async (route) => {
    runStatus = 'paused';
    await route.fulfill({ body: JSON.stringify({ run: { ...activeRun, status: runStatus } }), headers: corsHeaders(), status: 200 });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/approvals/appr_plan`, async (route) => {
    approvalStatus = 'approved';
    await route.fulfill({ body: JSON.stringify({ approval: { approvalId: 'appr_plan', kind: 'plan', status: 'approved' } }), headers: corsHeaders(), status: 200 });
  });
  await mockBuilder(page);
  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await page.getByRole('button', { name: 'Mission Control' }).click();
  await expect(page.getByText('Build checkout')).toBeVisible();
  await page.getByRole('tab', { name: 'Tasks' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Create form' })).toContainText('failed');
  await expect(page.getByRole('button', { name: 'Retry failed task' })).toBeEnabled();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByText('Run status: paused')).toBeVisible({ timeout: 5_000 });
  await page.getByRole('tab', { name: 'Approvals' }).click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/plan — approved/u)).toBeVisible();
});

test('reduces the seeded stream into messages, grouped activity, progress, and a commit link', async ({
  page,
}) => {
  const frames = [
    eventFrame({
      payload: {
        attachments: [],
        content: 'Build the checkout flow',
        messageId: 'msg_01K27Q9C2W85CMN1V9S6Q3D4FG',
        source: 'web',
      },
      sequence: 1,
      type: 'message.user',
    }),
    eventFrame({
      payload: { name: 'Build', phase: 'implementation' },
      sequence: 2,
      type: 'phase.started',
    }),
    eventFrame({
      payload: { tool: 'write_file', userSummary: 'Edited 3 files' },
      sequence: 3,
      type: 'tool.started',
    }),
    eventFrame({
      payload: { tool: 'write_file', userSummary: 'Edited 3 files' },
      sequence: 4,
      type: 'tool.completed',
    }),
    eventFrame({
      payload: { tool: 'run_build', userSummary: 'Ran build' },
      sequence: 5,
      type: 'tool.completed',
    }),
    eventFrame({
      payload: {
        content: '**Checkout** is ready.',
        messageId: 'msg_01K27Q9C2W85CMN1V9S6Q3D4FH',
        model: 'anthropic/claude-sonnet-5',
        turnId: 'turn_01K27Q9C2W85CMN1V9S6Q3D4FJ',
      },
      sequence: 6,
      type: 'message.assistant',
    }),
    eventFrame({
      payload: { phase: 'implementation' },
      sequence: 7,
      type: 'phase.completed',
    }),
    eventFrame({
      payload: {
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        message: 'Complete checkout flow',
      },
      sequence: 8,
      type: 'commit.created',
    }),
  ].join('');
  const eventRequests: Request[] = [];
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/events*`, async (route) => {
    eventRequests.push(route.request());
    await route.fulfill({ body: frames, headers: corsHeaders('text/event-stream'), status: 200 });
  });

  await openBuilder(page);

  await expect(page.getByText('Build the checkout flow', { exact: true })).toBeVisible();
  await expect(page.getByText('Checkout', { exact: true })).toBeVisible();
  await expect(page.getByText('Edited 3 files · Ran build ✓')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Build progress' })).toContainText('Complete');
  await page.getByRole('button', { name: /0123456 Complete checkout flow/u }).click();
  await expect(page.getByRole('tab', { name: 'Code' })).toHaveAttribute('aria-selected', 'true');
  expect(eventRequests[0]?.headers()['x-organization-id']).toBe(organizationId);
});

test('reconnects after a dropped stream and deduplicates replayed sequences', async ({ page }) => {
  let streamAttempt = 0;
  const assistant = eventFrame({
    payload: {
      content: 'One durable answer',
      messageId: 'msg_01K27Q9C2W85CMN1V9S6Q3D4FH',
      model: 'anthropic/claude-sonnet-5',
      turnId: 'turn_01K27Q9C2W85CMN1V9S6Q3D4FJ',
    },
    sequence: 3,
    type: 'message.assistant',
  });
  const cachedAssistant = eventData({
    payload: {
      content: 'One durable answer',
      messageId: 'msg_01K27Q9C2W85CMN1V9S6Q3D4FH',
      model: 'anthropic/claude-sonnet-5',
      turnId: 'turn_01K27Q9C2W85CMN1V9S6Q3D4FJ',
    },
    sequence: 3,
    type: 'message.assistant',
  });
  await page.addInitScript(
    ({ cacheRunId, event }) => {
      localStorage.setItem(
        `zapp:run-events:${cacheRunId}`,
        JSON.stringify([{ data: event, id: String(event.sequence), type: event.type }]),
      );
    },
    { cacheRunId: runId, event: cachedAssistant },
  );
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/events*`, async (route) => {
    streamAttempt += 1;
    if (streamAttempt === 1) {
      await route.fulfill({
        body: JSON.stringify({ error: { code: 'fixture_drop' } }),
        headers: corsHeaders(),
        status: 503,
      });
      return;
    }
    await route.fulfill({
      body: `${assistant}${eventFrame({
        payload: { tool: 'run_build', userSummary: 'Ran build' },
        sequence: 4,
        type: 'tool.completed',
      })}`,
      headers: corsHeaders('text/event-stream'),
      status: 200,
    });
  });

  await openBuilder(page);

  await expect(page.getByText('Reconnecting to the run…')).toBeVisible();
  await expect(page.getByText('Ran build ✓')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('One durable answer')).toHaveCount(1);
  expect(streamAttempt).toBeGreaterThanOrEqual(2);
});

test('stops the active run and reflects the cancellation event within five seconds', async ({
  page,
}) => {
  let cancelled = false;
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/events*`, async (route) => {
    const body = cancelled
      ? eventFrame({ payload: {}, sequence: 9, type: 'run.cancelled' })
      : eventFrame({
          payload: { name: 'Build', phase: 'implementation' },
          sequence: 1,
          type: 'phase.started',
        });
    await route.fulfill({ body, headers: corsHeaders('text/event-stream'), status: 200 });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/cancel`, async (route) => {
    cancelled = true;
    await route.fulfill({
      body: JSON.stringify({ run: { ...activeRun, status: 'cancelled' } }),
      headers: corsHeaders(),
      status: 200,
    });
  });

  await openBuilder(page);
  await expect(page.getByRole('status', { name: 'Build progress' })).toContainText(
    /[1-9]\d*s elapsed/u,
  );
  await page.getByRole('button', { name: 'Stop run' }).click();

  await expect(page.getByText('Run cancelled')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('button', { name: 'Stop run' })).toHaveCount(0);
});

test('pastes at most ten supported images, uploads them, and sends their public references', async ({
  page,
}) => {
  const uploadRequests: Request[] = [];
  let sentMessage: unknown;
  await page.route(`${apiBaseUrl}/v1/runs/*/events*`, async (route) => {
    await route.fulfill({ body: '', headers: corsHeaders('text/event-stream'), status: 200 });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/attachments`, async (route) => {
    uploadRequests.push(route.request());
    const ordinal = uploadRequests.length.toString(32).toUpperCase().padStart(6, '0');
    await route.fulfill({
      body: JSON.stringify({
        attachmentId: `art_01K27Q9C2W85CMN1V9S6${ordinal}`,
        byteSize: 3,
        contentType: 'image/png',
        kind: 'image',
        name: `pasted-${String(uploadRequests.length)}.png`,
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/messages`, async (route) => {
    sentMessage = route.request().postDataJSON();
    await route.fulfill({
      body: JSON.stringify({ messageId: 'msg_01K27Q9C2W85CMN1V9S6Q3D4FG', sequence: 11 }),
      headers: corsHeaders(),
      status: 202,
    });
  });

  await openBuilder(page);
  const composer = page.getByLabel('Message the agent');
  await composer.evaluate((element) => {
    for (const [start, end] of [
      [1, 6],
      [7, 12],
    ] as const) {
      const transfer = new DataTransfer();
      for (let index = start; index <= end; index += 1) {
        transfer.items.add(new File(['png'], `pasted-${String(index)}.png`, { type: 'image/png' }));
      }
      element.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
    }
  });

  await expect(page.getByText('You can attach up to 10 images.')).toBeVisible();
  await expect(page.getByLabel('Attached images')).toContainText('pasted-10.png');
  await expect(page.getByLabel('Attached images')).not.toContainText('pasted-11.png');
  await composer.fill('Use these references for the gallery.');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect.poll(() => uploadRequests.length).toBe(10);
  await expect
    .poll(() => sentMessage)
    .toMatchObject({
      attachments: expect.arrayContaining([
        expect.objectContaining({ contentType: 'image/png', kind: 'image' }),
      ]),
      content: 'Use these references for the gallery.',
    });
  expect((sentMessage as { attachments: unknown[] }).attachments).toHaveLength(10);
});

test('retries a partially created run with the same idempotency keys and attachment continuation', async ({
  page,
}) => {
  const createdRunId = 'run_01K27Q9C2W85CMN1V9S6Q3D4FK';
  const createRequests: Request[] = [];
  const continuationRequests: Request[] = [];
  await page.route(`${apiBaseUrl}/v1/runs/*/events*`, async (route) => {
    await route.fulfill({ body: '', headers: corsHeaders('text/event-stream'), status: 200 });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/attachments`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        attachmentId: 'art_01K27Q9C2W85CMN1V9S6Q3D4FL',
        byteSize: 3,
        contentType: 'image/png',
        kind: 'image',
        name: 'retry.png',
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await openBuilder(page, []);
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    createRequests.push(route.request());
    await route.fulfill({
      body: JSON.stringify({ run: { ...activeRun, id: createdRunId } }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${createdRunId}/messages`, async (route) => {
    continuationRequests.push(route.request());
    if (continuationRequests.length === 1) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ messageId: 'msg_01K27Q9C2W85CMN1V9S6Q3D4FM', sequence: 2 }),
      headers: corsHeaders(),
      status: 202,
    });
  });

  const composer = page.getByLabel('Message the agent');
  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['png'], 'retry.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  });
  await composer.fill('Build from this image.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(/message was not sent/u)).toBeVisible();
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect.poll(() => continuationRequests.length).toBe(2);
  expect(createRequests).toHaveLength(2);
  expect(createRequests[0]?.headers()['idempotency-key']).toBe(
    createRequests[1]?.headers()['idempotency-key'],
  );
  expect(continuationRequests[0]?.headers()['idempotency-key']).toBe(
    continuationRequests[1]?.headers()['idempotency-key'],
  );
  expect(continuationRequests.map((request): unknown => request.postDataJSON() as unknown)).toEqual(
    [
      expect.objectContaining({ content: 'Use these reference images with my request.' }),
      expect.objectContaining({ content: 'Use these reference images with my request.' }),
    ],
  );
});

test('uploads a replacement image after a failed send even when its metadata is identical', async ({
  page,
}) => {
  let createAttempt = 0;
  let uploadCount = 0;
  await page.route(`${apiBaseUrl}/v1/runs/*/events*`, async (route) => {
    await route.fulfill({ body: '', headers: corsHeaders('text/event-stream'), status: 200 });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/attachments`, async (route) => {
    uploadCount += 1;
    await route.fulfill({
      body: JSON.stringify({
        attachmentId: `art_01K27Q9C2W85CMN1V9S6${uploadCount === 1 ? 'Q3D4FL' : 'Q3D4FM'}`,
        byteSize: 3,
        contentType: 'image/png',
        kind: 'image',
        name: 'replacement.png',
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await openBuilder(page, []);
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    createAttempt += 1;
    if (createAttempt === 1) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ run: { ...activeRun, id: 'run_01K27Q9C2W85CMN1V9S6Q3D4FN' } }),
      headers: corsHeaders(),
      status: 201,
    });
  });
  await page.route(`${apiBaseUrl}/v1/runs/*/messages`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ messageId: 'msg_01K27Q9C2W85CMN1V9S6Q3D4FP', sequence: 2 }),
      headers: corsHeaders(),
      status: 202,
    });
  });

  const composer = page.getByLabel('Message the agent');
  const pasteImage = async (contents: string): Promise<void> => {
    await composer.evaluate((element, fileContents) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([fileContents], 'replacement.png', {
          lastModified: 1_786_412_000_000,
          type: 'image/png',
        }),
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
    }, contents);
  };

  await pasteImage('one');
  await composer.fill('Use the selected image.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(/message was not sent/u)).toBeVisible();
  await page.getByRole('button', { name: 'Remove replacement.png' }).click();
  await pasteImage('two');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect.poll(() => uploadCount).toBe(2);
});

test('starts a new run with the project-persisted mode and model when the latest run is inactive', async ({
  page,
}) => {
  const completedRun = {
    ...activeRun,
    completedAt: '2026-08-10T12:10:00.000Z',
    status: 'completed',
  };
  let createdRunBody: unknown;
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    {
      key: `zapp:conversation:settings:${projectId}`,
      value: { mode: 'ask', model: 'anthropic/claude-sonnet-5' },
    },
  );
  await page.route(`${apiBaseUrl}/v1/runs/*/events*`, async (route) => {
    await route.fulfill({ body: '', headers: corsHeaders('text/event-stream'), status: 200 });
  });
  await openBuilder(page, [completedRun]);
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    createdRunBody = route.request().postDataJSON();
    await route.fulfill({
      body: JSON.stringify({
        run: {
          ...activeRun,
          id: 'run_01K27Q9C2W85CMN1V9S6Q3D4FK',
          mode: 'ask',
          model: 'anthropic/claude-sonnet-5',
        },
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });

  await page.getByLabel('Message the agent').fill('Fix the checkout validation race.');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect
    .poll(() => createdRunBody)
    .toMatchObject({
      appType: 'web',
      mode: 'ask',
      model: 'anthropic/claude-sonnet-5',
      prompt: 'Fix the checkout validation race.',
    });
});
