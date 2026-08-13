import { expect, test, type Page, type Route } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';
const projectId = 'proj_01J00000000000000000000000';
const releaseId = 'rel_01J00000000000000000000000';
const currentDeploymentId = 'dep_01J00000000000000000000000';
const incompatibleId = 'dep_01J00000000000000000000001';
const compensationId = 'dep_01J00000000000000000000002';

function apiResponse(route: Route, body: unknown): Promise<void> { return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status: 200, headers: { 'access-control-allow-credentials': 'true', 'access-control-allow-origin': appBaseUrl } }); }
async function signIn(page: Page): Promise<void> { await page.goto('/login'); await page.getByRole('link', { name: 'Sign in' }).click(); await expect(page).toHaveURL('/'); }

test('renders production evidence and guards incompatible and compensation rollbacks', async ({ page }) => {
  const target = (id: string, targetReleaseId: string) => ({ id, releaseId: targetReleaseId, commitSha: 'b'.repeat(40), status: 'healthy', url: 'https://app.example.test', startedAt: '2026-08-12T11:00:00.000Z', completedAt: '2026-08-12T11:01:00.000Z', rollbackOfDeploymentId: null });
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}/production`, (route) => apiResponse(route, {
    deployments: [{ ...target(currentDeploymentId, releaseId), commitSha: 'a'.repeat(40) }],
    healthyTargets: [target(incompatibleId, 'rel_incompatible'), target(compensationId, 'rel_compensation')],
    health: [{ id: 'health-1', releaseId, deploymentId: currentDeploymentId, status: 'failed', evidenceArtifactId: 'art-health', occurredAt: '2026-08-12T12:00:00.000Z', result: { status: 'failed', automaticRollbackAttempted: false, evidenceArtifactId: 'art-health', production: { status: 'failed', healthEndpoint: { status: 'failed', path: '/health', intervalMs: 10000, attempts: [{ statusCode: 503 }] }, errorRate: { status: 'failed', windowMs: 120000, burstDetected: true, evidenceArtifactIds: ['art-errors'] }, smoke: { status: 'failed', flows: [{ flowId: 'checkout', status: 'failed' }], evidenceArtifactIds: ['art-smoke'] } } } }],
    synthetics: [{ id: 'syn-1', releaseId, syntheticCheckId: 'checkout', status: 'failed', summary: 'Checkout returned 500.', evidenceArtifactIds: ['art-syn'], completedAt: '2026-08-12T12:02:00.000Z' }],
    annotations: [{ id: 'ann-1', releaseId, deploymentId: currentDeploymentId, provider: 'grafana', kind: 'deployment', link: 'https://grafana.example.test/d/release', occurredAt: '2026-08-12T12:01:00.000Z' }],
  }));
  await page.route(new RegExp(`${apiBaseUrl}/v1/releases/${releaseId}/rollback-preview`, 'u'), (route) => { const selected = new URL(route.request().url()).searchParams.get('toDeploymentId'); const state = selected === compensationId ? 'requires_compensation' : 'incompatible'; return apiResponse(route, { currentDeploymentId, targetDeploymentId: selected, targetReleaseId: selected === compensationId ? 'rel_compensation' : 'rel_incompatible', targetCommitSha: 'b'.repeat(40), databaseState: state, compensationApproved: false, allowed: false }); });

  await signIn(page); await page.goto(`/projects/${projectId}/health`);
  await expect(page.getByRole('complementary', { name: 'Workspace' })).toBeVisible();
  await expect(
    page.getByText('Monitor production evidence and make guarded rollback decisions.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Health checks failed' })).toBeVisible();
  await expect(page.getByText('Error rate: failed')).toBeVisible();
  await expect(page.getByText('Checkout returned 500.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Fix run' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'grafana' })).toBeVisible();

  await page.getByRole('button', { name: 'Preview rollback' }).click();
  await expect(page.getByRole('heading', { name: 'Database state: incompatible' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start rollback' })).toBeDisabled();
  await page.getByLabel('Healthy target').selectOption(compensationId); await page.getByRole('button', { name: 'Preview rollback' }).click();
  await expect(page.getByText(/reviewed compensation plan is required/iu)).toBeVisible();
  await expect(page.getByText(/does not imply the database has been rolled back/iu)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start rollback' })).toBeDisabled();
});
