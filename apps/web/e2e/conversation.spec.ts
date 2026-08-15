import { expect, test, type Page, type Request } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';
const projectId = 'proj_01K27Q9C2W85CMN1V9S6Q3D4FE';
const runId = 'run_01K27Q9C2W85CMN1V9S6Q3D4FF';
const organizationId = 'org_01K27Q9C2W85CMN1V9S6Q3D4FD';
const contractOrganizationId = 'org_01K27Q9C2W85CMN1V9S6Q3D4FD';

const projectRead = {
  branches: [],
  environments: [],
  project: {
    archivedAt: null,
    createdAt: '2026-08-10T12:00:00.000Z',
    createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
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
  branchId: null as string | null,
  completedAt: null as string | null,
  id: runId,
  mode: 'build' as const,
  model: null,
  organizationId,
  projectId,
  startedAt: '2026-08-10T12:00:00.000Z',
  startedBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
  status: 'running' as const,
};

type RunFixture = Omit<typeof activeRun, 'status'> & {
  readonly status:
    'cancelled' | 'completed' | 'failed' | 'paused' | 'queued' | 'running' | 'waiting_for_approval';
};

interface EventInput {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sequence: number;
  readonly type:
    | 'commit.created'
    | 'conversation.card'
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

async function mockBuilder(page: Page, runs: readonly RunFixture[] = [activeRun]): Promise<void> {
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

async function openBuilder(page: Page, runs?: readonly RunFixture[]): Promise<void> {
  await mockBuilder(page, runs);
  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Conversation Fixture' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('runs every Mission Control lifecycle action through its exact public API', async ({
  page,
}) => {
  let runStatus = 'running';
  let approvalStatus = 'pending';
  const lifecycleRequests: Array<{
    action: 'cancel' | 'pause' | 'redirect' | 'resume';
    body: unknown;
    idempotencyKey: string | undefined;
    method: string;
  }> = [];
  const mission = () => ({
    run: { ...activeRun, status: runStatus },
    currentPhase: { id: 'phase_build', sequence: 1, title: 'Build checkout', status: 'running' },
    progress: { done: 1, total: 2 },
    taskGraph: {
      nodes: [
        {
          id: 'task_form',
          phaseId: 'phase_build',
          title: 'Create form',
          status: 'failed',
          riskLevel: 'medium',
          assignedAgentRole: 'builder',
        },
        {
          id: 'task_verify',
          phaseId: 'phase_build',
          title: 'Verify checkout',
          status: 'queued',
          riskLevel: 'low',
          assignedAgentRole: 'verifier',
        },
      ],
      edges: [{ from: 'task_form', to: 'task_verify' }],
    },
    activeAgents: [
      {
        agentId: 'agent-builder',
        role: 'builder',
        taskId: 'task_form',
        startedAt: '2026-08-10T12:00:00.000Z',
      },
    ],
    recentToolCalls: [
      {
        sequence: 3,
        toolCallId: 'tool-write',
        toolName: 'write_file',
        status: 'failed',
        userSummary: 'Edited checkout form',
        durationMs: 42,
        taskId: 'task_form',
        agentId: 'agent-builder',
        occurredAt: '2026-08-10T12:00:03.000Z',
      },
    ],
    filesChanged: [{ path: 'src/checkout.tsx', additions: 12, deletions: 1 }],
    commits: [],
    testRuns: [],
    previewStatus: { status: 'ready', occurredAt: '2026-08-10T12:00:04.000Z' },
    screenshots: [],
    cost: { creditsUsed: 2, budget: 10 },
    approvals: [
      {
        approvalId: 'appr_plan',
        taskId: null,
        type: 'plan',
        status: approvalStatus,
        request: { artifactId: 'art_plan' },
        response: null,
        requestedAt: '2026-08-10T12:00:05.000Z',
        resolvedAt: null,
      },
    ],
    risks: [{ id: 'risk-1', severity: 'medium', summary: 'Checkout needs browser evidence' }],
    actions: {
      retryFailedTasks: [{ taskId: 'task_form', eligible: true, reason: 'eligible' }],
      skipOptionalPhases: [],
    },
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/mission-control`, async (route) => {
    await route.fulfill({ body: JSON.stringify(mission()), headers: corsHeaders(), status: 200 });
  });
  for (const action of ['pause', 'resume', 'redirect', 'cancel'] as const) {
    await page.route(`${apiBaseUrl}/v1/runs/${runId}/${action}`, async (route) => {
      lifecycleRequests.push({
        action,
        body: route.request().postDataJSON(),
        idempotencyKey: route.request().headers()['idempotency-key'],
        method: route.request().method(),
      });
      if (action === 'pause') runStatus = 'paused';
      if (action === 'resume' || action === 'redirect') runStatus = 'running';
      if (action === 'cancel') runStatus = 'cancelled';
      await route.fulfill({
        body: JSON.stringify({ run: { ...activeRun, status: runStatus } }),
        headers: corsHeaders(),
        status: 200,
      });
    });
  }
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/approvals/appr_plan`, async (route) => {
    approvalStatus = 'approved';
    await route.fulfill({
      body: JSON.stringify({
        approval: { approvalId: 'appr_plan', kind: 'plan', status: 'approved' },
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await mockBuilder(page);
  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await page.getByRole('button', { name: 'Mission Control' }).click();
  await expect(page.getByText('Build checkout')).toBeVisible();
  await page.getByRole('tab', { name: 'Tasks' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Create form' })).toContainText(
    'failed',
  );
  await expect(page.getByRole('button', { name: 'Retry failed task' })).toBeEnabled();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByText('Run status: paused')).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('Run status: running')).toBeVisible({ timeout: 5_000 });
  await page.getByLabel('Redirect instructions').fill('Use the accessible checkout instead');
  await page.getByRole('button', { name: 'Redirect', exact: true }).click();
  await expect(page.getByText('Redirect applied.')).toBeVisible();
  page.once('dialog', async (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('Run status: cancelled')).toBeVisible({ timeout: 5_000 });
  expect(lifecycleRequests).toEqual([
    { action: 'pause', body: null, idempotencyKey: expect.any(String), method: 'POST' },
    { action: 'resume', body: null, idempotencyKey: expect.any(String), method: 'POST' },
    {
      action: 'redirect',
      body: { prompt: 'Use the accessible checkout instead' },
      idempotencyKey: expect.any(String),
      method: 'POST',
    },
    { action: 'cancel', body: null, idempotencyKey: expect.any(String), method: 'POST' },
  ]);
  expect(new Set(lifecycleRequests.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(4);
  await page.getByRole('tab', { name: 'Approvals' }).click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/plan — approved/u)).toBeVisible();
});

test('submits typed interview answers and resolves specification and plan cards', async ({
  page,
}) => {
  const specificationId = 'spec_01K27Q9C2W85CMN1V9S6Q3D4FA';
  const specificationApprovalId = 'appr_01K27Q9C2W85CMN1V9S6Q3D4FB';
  const planArtifactId = 'art_01K27Q9C2W85CMN1V9S6Q3D4FC';
  const planApprovalId = 'appr_01K27Q9C2W85CMN1V9S6Q3D4FD';
  const frames = [
    eventFrame({
      payload: {
        card: {
          version: 1,
          cardId: 'card_interview',
          kind: 'question',
          questions: [
            {
              questionId: 'audience',
              prompt: 'Who is this for?',
              options: [
                { label: 'Teams', tradeoff: 'Supports collaboration.', recommended: true },
                { label: 'Individuals', tradeoff: 'Simpler permissions.', recommended: false },
              ],
            },
          ],
        },
      },
      sequence: 1,
      type: 'conversation.card',
    }),
    eventFrame({
      payload: {
        card: {
          version: 1,
          cardId: 'card_specification',
          kind: 'specification',
          approvalId: specificationApprovalId,
          artifactId: specificationId,
          artifactVersion: 1,
        },
      },
      sequence: 2,
      type: 'conversation.card',
    }),
    eventFrame({
      payload: {
        card: {
          version: 1,
          cardId: 'card_plan',
          kind: 'plan',
          approvalId: planApprovalId,
          artifactId: planArtifactId,
          approvalKind: 'plan_diff',
        },
      },
      sequence: 3,
      type: 'conversation.card',
    }),
  ].join('');
  let submittedAnswers: unknown;
  const approvalBodies: unknown[] = [];
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/events*`, async (route) => {
    await route.fulfill({ body: frames, headers: corsHeaders('text/event-stream'), status: 200 });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/conversation-responses`, async (route) => {
    submittedAnswers = route.request().postDataJSON();
    await route.fulfill({
      body: JSON.stringify({ operationKey: `op_${'a'.repeat(64)}` }),
      headers: corsHeaders(),
      status: 202,
    });
  });
  await page.route(
    `${apiBaseUrl}/v1/runs/${runId}/specifications/${specificationId}`,
    async (route) => {
      const content = {
        problem: 'Teams need a reliable release workspace.',
        targetUsers: ['Product teams'],
        goals: ['Ship safely'],
        nonGoals: ['Native mobile'],
        journeys: ['Create and deploy'],
        pagesRoutes: ['/'],
        rolesPermissions: ['Owner approves'],
        dataModel: ['Project'],
        integrations: ['GitHub'],
        functionalRequirements: ['Build project'],
        nonfunctionalRequirements: ['Accessible'],
        acceptanceCriteria: [
          {
            id: 'AC-1',
            text: 'A release can be approved',
            priority: 'critical',
            criticalFlow: true,
          },
        ],
        assumptions: ['Authenticated user'],
        risks: ['Deployment failure'],
        definitionOfDone: ['Evidence attached'],
      };
      await route.fulfill({
        body: JSON.stringify({
          specification: {
            id: specificationId,
            organizationId,
            projectId,
            version: 1,
            status: 'draft',
            content,
            createdBy: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
            approvedBy: null,
            approvedAt: null,
          },
        }),
        headers: corsHeaders(),
        status: 200,
      });
    },
  );
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/plans/${planArtifactId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        plan: {
          artifactId: planArtifactId,
          approvalId: planApprovalId,
          approvalKind: 'plan_diff',
          phaseCount: 1,
          taskCount: 1,
          truncated: false,
          phases: [
            {
              id: 'phase_01K27Q9C2W85CMN1V9S6Q3D4FE',
              sequence: 1,
              title: 'Checkout',
              status: 'queued',
              acceptanceCriteria: ['AC-1'],
              optional: false,
            },
          ],
          tasks: [
            {
              id: 'task_01K27Q9C2W85CMN1V9S6Q3D4FF',
              phaseId: 'phase_01K27Q9C2W85CMN1V9S6Q3D4FE',
              title: 'Build checkout',
              status: 'queued',
              riskLevel: 'medium',
              acceptanceCriteria: ['AC-1'],
              dependencies: [],
              assignedAgentRole: 'builder',
            },
          ],
        },
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/approvals/*`, async (route) => {
    approvalBodies.push(route.request().postDataJSON());
    await route.fulfill({
      body: JSON.stringify({
        approval: {
          approvalId: route.request().url().split('/').at(-1),
          kind: approvalBodies.length === 1 ? 'specification' : 'plan_diff',
          status: 'approved',
        },
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });

  await openBuilder(page);
  await page.getByLabel('Agent questions').getByLabel(/Teams/u).check();
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await expect(page.getByText('Answers submitted.')).toBeVisible();
  expect(submittedAnswers).toMatchObject({
    kind: 'question_answers',
    cardId: 'card_interview',
    answers: [{ questionId: 'audience', answer: 'Teams' }],
  });
  await expect(page.getByRole('article', { name: 'Specification summary' })).toContainText(
    'Teams need a reliable release workspace.',
  );
  await page.getByRole('button', { name: 'Start building' }).click();
  await expect(page.getByText('Specification approved.')).toBeVisible();
  const plan = page.getByRole('article', { name: 'Plan review' });
  await expect(plan).toContainText('1 phases · 1 tasks');
  await expect(plan).toContainText('medium risk');
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await expect(page.getByText('Plan approved.')).toBeVisible();
  expect(approvalBodies).toEqual([
    { kind: 'specification', decision: 'approved' },
    { kind: 'plan_diff', decision: 'approved' },
  ]);
});

test('opens code and diff data and renders failed-test evidence with a Fix action', async ({
  page,
}) => {
  const workspaceId = 'ws_01K27Q9C2W85CMN1V9S6Q3D4FA';
  const testRunId = 'trun_01K27Q9C2W85CMN1V9S6Q3D4FB';
  const testCaseId = 'tcase_01K27Q9C2W85CMN1V9S6Q3D4FC';
  const taskId = 'task_01K27Q9C2W85CMN1V9S6Q3D4FD';
  const artifactId = 'art_01K27Q9C2W85CMN1V9S6Q3D4FE';
  const before = '1'.repeat(40);
  const after = '2'.repeat(40);
  const listedWorkspacePaths: string[] = [];
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/events*`, async (route) => {
    await route.fulfill({ body: '', headers: corsHeaders('text/event-stream'), status: 200 });
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/workspaces*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ workspaces: [{ id: workspaceId }] }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(
    new RegExp(`${apiBaseUrl}/v1/workspaces/${workspaceId}/files(?:\\?.*)?$`, 'u'),
    async (route) => {
      const requestUrl = new URL(route.request().url());
      const requestedPath = requestUrl.searchParams.get('path') ?? '.';
      const maximumDepth = requestUrl.searchParams.get('maxDepth') ?? '';
      listedWorkspacePaths.push(`${requestedPath}:${maximumDepth}`);
      await route.fulfill({
        body: JSON.stringify({
          entries:
            requestedPath === 'src'
              ? [{ path: 'page.tsx', type: 'file' }]
              : [
                  { path: 'src', type: 'directory' },
                  { path: 'index.html', type: 'file' },
                ],
          truncated: false,
        }),
        headers: corsHeaders(),
        status: 200,
      });
    },
  );
  await page.route(
    new RegExp(`${apiBaseUrl}/v1/workspaces/${workspaceId}/file(?:\\?.*)?$`, 'u'),
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          path: 'src/page.tsx',
          dataBase64: Buffer.from(
            'export default function Page() { return <h1>Checkout</h1>; }',
          ).toString('base64'),
          byteSize: 59,
          compareToken: 'a'.repeat(64),
        }),
        headers: corsHeaders(),
        status: 200,
      });
    },
  );
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/compare*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        beforeSha: before,
        afterSha: after,
        changedFiles: 1,
        files: [{ path: 'src/page.tsx', status: 'modified', additions: 2, deletions: 1 }],
        filesTruncated: false,
        patch: '+ Checkout',
        patchTruncated: false,
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/tests`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        runs: [
          {
            id: testRunId,
            organizationId: contractOrganizationId,
            runId,
            taskId,
            commitSha: after,
            type: 'browser',
            status: 'failed',
            startedAt: '2026-08-10T12:00:00.000Z',
            completedAt: '2026-08-10T12:00:02.000Z',
            summary: null,
            cases: [
              {
                id: testCaseId,
                testRunId,
                name: 'checkout submits',
                status: 'failed',
                durationMs: 1200,
                criterionIds: ['AC-1'],
                evidenceArtifactIds: [artifactId],
                error: { message: 'button missing' },
              },
            ],
            casesTruncated: false,
          },
        ],
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/evidence/${artifactId}*`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        artifact: {
          id: artifactId,
          organizationId: contractOrganizationId,
          projectId,
          runId,
          taskId,
          testRunId,
          testCaseId,
          criterionIds: ['AC-1'],
          kind: 'screenshot',
          description: 'Checkout form missing its submit button',
          contentType: 'image/png',
          byteSize: 100,
          contentHash: 'b'.repeat(64),
          createdAt: '2026-08-10T12:00:02.000Z',
        },
        download: {
          url: 'https://evidence.zapp.test/screenshot.png',
          expiresAt: '2026-08-10T12:05:00.000Z',
        },
      }),
      headers: corsHeaders(),
      status: 200,
    });
  });

  await openBuilder(page);
  await page.getByRole('tab', { name: 'Code' }).click();
  await expect(page.getByRole('button', { name: 'src/page.tsx' })).toHaveCount(0);
  await page.getByRole('button', { name: 'src', exact: true }).click();
  await expect(page.getByRole('button', { name: 'src/page.tsx' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'page.tsx', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'src/page.tsx' }).click();
  await expect(page.getByText(/Checkout/u)).toBeVisible();
  await page.getByRole('button', { name: 'src', exact: true }).click();
  await expect(page.getByRole('button', { name: 'src/page.tsx' })).toHaveCount(0);
  expect(listedWorkspacePaths).toEqual(['.:0', 'src:0']);
  await page.getByLabel('Before commit').fill(before);
  await page.getByLabel('After commit').fill(after);
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByText('src/page.tsx +2 −1')).toBeVisible();
  await page.getByRole('tab', { name: 'More' }).click();
  await page.getByRole('tab', { name: 'Security' }).click();
  await expect(page.getByText('checkout submits — failed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Fix run' })).toBeVisible();
  await page.getByRole('button', { name: 'View evidence' }).click();
  await expect(page.getByAltText('Checkout form missing its submit button')).toBeVisible();
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

test('shows an accepted queued prompt immediately and reconciles the durable user event once', async ({
  page,
}) => {
  const prompt = 'Build the first usable client portal homepage.';
  const createdRunId = 'run_01K27Q9C2W85CMN1V9S6Q3D4FQ';
  let releaseEvent: (() => void) | undefined;
  const eventGate = new Promise<void>((resolve) => {
    releaseEvent = resolve;
  });

  await page.route(`${apiBaseUrl}/v1/runs/${createdRunId}/events*`, async (route) => {
    await eventGate;
    await route.fulfill({
      body: eventFrame({
        payload: {
          attachments: [],
          content: prompt,
          messageId: 'msg_01K27Q9C2W85CMN1V9S6Q3D4FR',
          source: 'web',
        },
        sequence: 1,
        type: 'message.user',
      }),
      headers: corsHeaders('text/event-stream'),
      status: 200,
    });
  });
  await openBuilder(page, []);
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        body: JSON.stringify({
          items: [{ ...activeRun, id: createdRunId, status: 'queued' }],
          nextCursor: null,
        }),
        headers: corsHeaders(),
        status: 200,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        run: {
          ...activeRun,
          id: createdRunId,
          status: 'queued',
        },
      }),
      headers: corsHeaders(),
      status: 201,
    });
  });

  const composer = page.getByLabel('Message the agent');
  await composer.fill(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.getByText(prompt, { exact: true })).toBeVisible({ timeout: 500 });
  await expect(page.getByRole('status', { name: 'Build status' })).toContainText('Build queued');
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();

  releaseEvent?.();
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
});

test('reconciles a failed run from the public runs API when the event stream stays empty', async ({
  page,
}) => {
  const prompt = 'Build a project status dashboard.';
  const createdRunId = 'run_01K27Q9C2W85CMN1V9S6Q3D4FS';
  await page.route(`${apiBaseUrl}/v1/runs/${createdRunId}/events*`, async (route) => {
    await route.fulfill({
      body: '',
      headers: corsHeaders('text/event-stream'),
      status: 200,
    });
  });
  await openBuilder(page, []);
  await page.unroute(`${apiBaseUrl}/v1/projects/${projectId}/runs`);
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    const run = { ...activeRun, id: createdRunId, status: 'failed' };
    await route.fulfill({
      body:
        route.request().method() === 'POST'
          ? JSON.stringify({ run: { ...run, status: 'queued' } })
          : JSON.stringify({ items: [run], nextCursor: null }),
      headers: corsHeaders(),
      status: route.request().method() === 'POST' ? 201 : 200,
    });
  });

  await page.getByLabel('Message the agent').fill(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.getByRole('status', { name: 'Build status' })).toContainText('Build queued');
  await expect(page.getByRole('status', { name: 'Build status' })).toContainText('Build failed');
  await expect(page.getByRole('button', { name: 'Stop run' })).toHaveCount(0);
  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
});

test('marks an interrupted running phase as failed when its run is terminal', async ({ page }) => {
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/events*`, async (route) => {
    await route.fulfill({
      body: eventFrame({
        payload: { name: 'Conversation', phase: 'conversation' },
        sequence: 1,
        type: 'phase.started',
      }),
      headers: corsHeaders('text/event-stream'),
      status: 200,
    });
  });

  await openBuilder(page, [{ ...activeRun, status: 'failed' }]);

  await expect(page.getByRole('status', { name: 'Build status' })).toContainText('Build failed');
  await expect(page.getByRole('status', { name: 'Conversation progress' })).toContainText('Failed');
  await expect(page.getByRole('status', { name: 'Conversation progress' })).not.toContainText(
    'In progress',
  );
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
  const previousBranchId = 'br_01K27Q9C2W85CMN1V9S6Q3D4FX';
  const completedRun = {
    ...activeRun,
    branchId: previousBranchId,
    completedAt: '2026-08-10T12:10:00.000Z',
    status: 'completed' as const,
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
    if (route.request().method() === 'GET') {
      await route.fulfill({
        body: JSON.stringify({ items: [completedRun], nextCursor: null }),
        headers: corsHeaders(),
        status: 200,
      });
      return;
    }
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
      branchId: previousBranchId,
      mode: 'ask',
      model: 'anthropic/claude-sonnet-5',
      prompt: 'Fix the checkout validation race.',
    });
});
