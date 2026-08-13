import { expect, test, type Page, type Route } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';
const organizationId = 'org-alpha';
const contractOrganizationId = 'org_01K27Q9C2W85CMN1V9S6Q3D4FD';
const projectId = 'proj_01K27Q9C2W85CMN1V9S6Q3D4FE';
const runId = 'run_01K27Q9C2W85CMN1V9S6Q3D4FF';
const releaseId = 'rel_01J00000000000000000000000';
const workspaceId = 'ws_01K27Q9C2W85CMN1V9S6Q3D4FG';

function headers(contentType = 'application/json'): Record<string, string> {
  return {
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type, idempotency-key, x-zapp-csrf, x-organization-id',
    'access-control-allow-origin': appBaseUrl,
    'content-type': contentType,
  };
}

function respond(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ body: JSON.stringify(body), headers: headers(), status });
}

function event(sequence: number, type: string, payload: Record<string, unknown>): string {
  return `id: ${String(sequence)}\nevent: ${type}\ndata: ${JSON.stringify({
    id: `evt_01K27Q9C2W85CMN1V9S6${sequence.toString(32).toUpperCase().padStart(6, '0')}`,
    occurredAt: new Date(Date.parse('2026-08-12T12:00:00.000Z') + sequence * 1_000).toISOString(),
    organizationId: contractOrganizationId,
    projectId,
    runId,
    sequence,
    type,
    visibility: 'user',
    payload,
  })}\n\n`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('Ada Lovelace')).toBeVisible();
}

test('takes one signed-in user from an initial prompt to deployed app in one unified builder', async ({ page }) => {
  const initialPrompt = 'Build a friendly appointment scheduler for neighborhood clinics.';
  const iteration = 'Make the booking confirmation warmer and easier to scan.';
  const project = {
    archivedAt: null,
    createdAt: '2026-08-12T12:00:00.000Z',
    createdBy: 'user-ada',
    description: initialPrompt,
    id: projectId,
    name: 'Neighborhood clinic scheduler',
    organizationId,
    slug: 'neighborhood-clinic-scheduler',
    sourceType: 'prompt',
    supportLevel: 'compatible',
  };
  const run = {
    appType: 'web', branchId: 'branch_main', completedAt: null, id: runId, mode: 'build', model: null,
    organizationId, projectId, startedAt: '2026-08-12T12:00:00.000Z', startedBy: 'user-ada', status: 'running',
  };
  const requests: Array<{ body: unknown; path: string; projectId: string | undefined }> = [];
  const stream = [
    event(1, 'conversation.card', { card: { version: 1, cardId: 'card_interview', kind: 'question', questions: [{ questionId: 'audience', prompt: 'Who will book appointments?', options: [{ label: 'Patients', tradeoff: 'Simple patient booking.', recommended: true }, { label: 'Staff', tradeoff: 'Staff schedule appointments.', recommended: false }] }] } }),
    event(2, 'conversation.card', { card: { version: 1, cardId: 'card_spec', kind: 'specification', approvalId: 'appr_01K27Q9C2W85CMN1V9S6Q3D4FB', artifactId: 'spec_01K27Q9C2W85CMN1V9S6Q3D4FA', artifactVersion: 1 } }),
    event(3, 'conversation.card', { card: { version: 1, cardId: 'card_plan', kind: 'plan', approvalId: 'appr_01K27Q9C2W85CMN1V9S6Q3D4FD', artifactId: 'art_01K27Q9C2W85CMN1V9S6Q3D4FC', approvalKind: 'plan_diff' } }),
    event(4, 'phase.started', { name: 'Build checkout', phase: 'build' }),
    event(5, 'tool.completed', { tool: 'write_file', userSummary: 'Built appointment booking' }),
    event(6, 'preview.ready', { workspaceId }),
  ].join('');

  await page.route(`${apiBaseUrl}/v1/projects`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    requests.push({ body: route.request().postDataJSON(), path: '/v1/projects', projectId: undefined });
    await respond(route, { project, branches: [{ id: 'branch_main', name: 'main' }], repository: { defaultBranch: 'main' } }, 201);
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/runs`, async (route) => {
    if (route.request().method() === 'GET') {
      await respond(route, { items: [run], nextCursor: null });
      return;
    }
    requests.push({ body: route.request().postDataJSON(), path: '/runs', projectId });
    await respond(route, { run }, 201);
  });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, (route) =>
    respond(route, { project, branches: [{ id: 'branch_main', name: 'main', organizationId, projectId, status: 'active', baseBranchId: null, headCommitSha: null }], environments: [], repository: { defaultBranch: 'main' } }),
  );
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/events*`, (route) =>
    route.fulfill({ body: stream, headers: headers('text/event-stream'), status: 200 }),
  );
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/conversation-responses`, async (route) => {
    requests.push({ body: route.request().postDataJSON(), path: '/conversation-responses', projectId });
    await respond(route, { operationKey: `op_${'a'.repeat(64)}` }, 202);
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/approvals/*`, async (route) => {
    requests.push({ body: route.request().postDataJSON(), path: new URL(route.request().url()).pathname, projectId });
    await respond(route, { approval: { approvalId: route.request().url().split('/').at(-1), kind: 'plan_diff', status: 'approved' } });
  });
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/specifications/*`, (route) => respond(route, { specification: { id: 'spec_01K27Q9C2W85CMN1V9S6Q3D4FA', organizationId, projectId, version: 1, status: 'draft', content: { problem: 'Patients need warm appointment booking.', targetUsers: ['Patients'], goals: ['Book appointments'], nonGoals: [], journeys: ['Book appointment'], pagesRoutes: ['/'], rolesPermissions: [], dataModel: [], integrations: [], functionalRequirements: [], nonfunctionalRequirements: [], acceptanceCriteria: [], assumptions: [], risks: [], definitionOfDone: [] }, createdBy: 'user-ada', approvedBy: null, approvedAt: null } }));
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/plans/*`, (route) => respond(route, { plan: { artifactId: 'art_01K27Q9C2W85CMN1V9S6Q3D4FC', approvalId: 'appr_01K27Q9C2W85CMN1V9S6Q3D4FD', approvalKind: 'plan_diff', phaseCount: 1, taskCount: 1, truncated: false, phases: [{ id: 'phase_01K27Q9C2W85CMN1V9S6Q3D4FE', sequence: 1, title: 'Build appointment booking', status: 'running', acceptanceCriteria: [], optional: false }], tasks: [{ id: 'task_01K27Q9C2W85CMN1V9S6Q3D4FF', phaseId: 'phase_01K27Q9C2W85CMN1V9S6Q3D4FE', title: 'Build booking flow', status: 'running', riskLevel: 'low', acceptanceCriteria: [], dependencies: [], assignedAgentRole: 'builder' }] } }));
  await page.route(`${apiBaseUrl}/v1/runs/${runId}/messages`, async (route) => {
    requests.push({ body: route.request().postDataJSON(), path: '/messages', projectId });
    await respond(route, { messageId: 'msg_01K27Q9C2W85CMN1V9S6Q3D4FC', sequence: 7 }, 202);
  });
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/dev-server/logs*`, (route) => respond(route, { entries: [], failureId: null, nextCursor: 0, state: 'ready', truncated: false }));
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/shares`, (route) => respond(route, { share: { id: '01j00000000000000000000000', policy: 'org', expiresAt: new Date(Date.now() + 300_000).toISOString(), url: `${appBaseUrl}/preview/${organizationId}/01j00000000000000000000000` } }, 201));
  await page.route(`${apiBaseUrl}/v1/workspaces/${workspaceId}/preview/events`, (route) => route.fulfill({ body: '', headers: headers('text/event-stream'), status: 200 }));
  await page.route(`${appBaseUrl}/preview/${organizationId}/01j00000000000000000000000`, (route) => route.fulfill({ body: '<h1>Authenticated clinic preview</h1>', contentType: 'text/html', status: 200 }));
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/${projectId}/releases`, 'u'), (route) => respond(route, { items: [{ id: releaseId, projectId, environmentId: 'env_preview', commitSha: 'a'.repeat(40), status: 'approved', createdBy: 'user-ada', supportLevel: 'compatible', activeProduction: false, createdAt: '2026-08-12T12:00:00.000Z', deployments: [] }], nextCursor: null, rollbackTargets: [] }));
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}`, (route) => respond(route, { release: { id: releaseId, organizationId, projectId, environmentId: 'env_preview', commitSha: 'a'.repeat(40), specificationId: null, status: 'approved', evidenceManifestArtifactId: null, createdBy: 'user-ada', createdAt: '2026-08-12T12:00:00.000Z' }, readiness: { state: 'ready', findings: [] } }));
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/deployment-preview?retarget=false`, (route) => respond(route, { title: 'First deploy', deploymentType: 'first_deploy', effects: { productionData: 'Created', secrets: 'Applied', url: 'Created', activeUsers: 'No users affected' }, requiresExplicitDataDisposition: false }));
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/deploy`, (route) => respond(route, { deploymentId: 'dep_01J00000000000000000000000' }));
  await page.route(`${apiBaseUrl}/v1/deployments/dep_01J00000000000000000000000`, (route) => respond(route, { deploymentId: 'dep_01J00000000000000000000000', releaseId, projectId, environmentId: 'env_preview', status: 'healthy', url: 'https://clinic.example.test', events: [], terminalSuccess: { status: 'succeeded', permanentUrl: 'https://clinic.example.test', release: { id: releaseId, commitSha: 'a'.repeat(40) }, evidence: { statusLink: `/v1/releases/${releaseId}/evidence` }, productionHealth: { status: 'healthy' }, monitoring: { grafanaDashboardLinks: [], faroAppLink: 'https://grafana.example.test/faro', posthogAnnotationLink: 'https://posthog.example.test/release' }, customDomainAction: { method: 'POST', href: `/v1/projects/${projectId}/domains` }, previousHealthyRelease: null, previewChanges: { requireRedeploy: true, note: 'Preview changes require redeploy.' } } }));

  await signIn(page);
  await page.getByLabel('Describe your project').fill(initialPrompt);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(`/projects/${projectId}`);
  const builderUrl = page.url();
  await expect(page.getByText(initialPrompt)).toBeVisible();
  await page.getByLabel('Agent questions').getByLabel(/Patients/u).check();
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await expect(page.getByText('Answers submitted.')).toBeVisible();
  await page.getByRole('button', { name: 'Start building' }).click();
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await expect(page.getByText('Build appointment booking')).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(1);
  await page.getByLabel('Message the agent').fill(iteration);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Deploy' })).toBeEnabled();
  await page.getByRole('button', { name: 'Deploy' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to deploy' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Confirm deployment' }).click();
  await expect(page.getByRole('heading', { name: 'Deployment succeeded' })).toBeVisible();
  expect(page.url()).toBe(builderUrl);
  await expect(page.getByText(/terminal/iu)).toHaveCount(0);
  expect(requests.find((request) => request.path === '/v1/projects')).toEqual({
    body: { name: 'Build a friendly appointment scheduler for neighborhood clinics', sourceType: 'prompt' },
    path: '/v1/projects',
    projectId: undefined,
  });
  expect(requests.find((request) => request.path === '/runs')?.body).toMatchObject({ prompt: initialPrompt });
  expect(requests.find((request) => request.path === '/conversation-responses')?.body).toEqual({ version: 1, kind: 'question_answers', cardId: 'card_interview', answers: [{ questionId: 'audience', answer: 'Patients' }] });
  expect(requests.find((request) => request.path === '/messages')?.body).toEqual({ attachments: [], content: iteration });
});
