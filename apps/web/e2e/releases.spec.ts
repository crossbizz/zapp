import { expect, test, type Page, type Route } from '@playwright/test';

import { apiBaseUrl, appBaseUrl } from './support/ports.js';
const projectId = 'proj_01J00000000000000000000000';
const releaseId = 'rel_01J00000000000000000000000';

function apiResponse(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status: 200, headers: { 'access-control-allow-credentials': 'true', 'access-control-allow-origin': appBaseUrl } });
}
async function signIn(page: Page): Promise<void> { await page.goto('/login'); await page.getByRole('link', { name: 'Sign in' }).click(); await expect(page).toHaveURL('/'); }

const gate = (gateId: string, status: 'passed' | 'failed' = 'passed') => ({ gateId, class: 'support_level_policy', status, evidenceArtifactIds: [`art-${gateId}`] });
const block = (gateId: string, status: 'passed' | 'failed' = 'passed') => ({ status, gates: [gate(gateId, status)] });
const release = { id: releaseId, organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', projectId, environmentId: 'env_01J00000000000000000000000', commitSha: 'a'.repeat(40), specificationId: null, status: 'approved', evidenceManifestArtifactId: null, createdBy: 'user_01J0000000000000000000000', createdAt: '2026-08-12T12:00:00.000Z' };
const emptyEvidence = { release_id: releaseId, commit_sha: 'a'.repeat(40), specification_version: 3, criteria: [], build: block('production_build'), typecheck: block('typecheck'), tests: block('unit_tests'), browser_tests: block('browser_smoke'), security: block('secret_scan'), migration: block('migration_validation'), preview: block('preview_health'), rollback: block('rollback_readiness'), known_risks: [] };
async function routeRelease(page: Page, readiness: { state: 'ready' | 'warnings' | 'blocked'; findings: Array<{ id: string; severity: 'blocker' | 'warning'; title: string; detail: string; action: 'fix_and_recheck' | 'review' | 'waive' }> }): Promise<void> {
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}`, (route) => apiResponse(route, { release, readiness }));
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/evidence`, (route) => apiResponse(route, { evidence: emptyEvidence }));
}

test('renders release history and every evidence criterion including failure', async ({ page }) => {
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/${projectId}/releases`, 'u'), (route) => apiResponse(route, {
    items: [{ id: releaseId, projectId, environmentId: 'env_01J00000000000000000000000', commitSha: 'a'.repeat(40), status: 'approved', createdBy: 'user_01J0000000000000000000000', supportLevel: 'managed', activeProduction: true, createdAt: '2026-08-12T12:00:00.000Z', deployments: [{ id: 'dep_01J00000000000000000000000', provider: 'fly', providerDeploymentId: 'machine-1', status: 'healthy', url: 'https://alpha.example.test', startedAt: '2026-08-12T12:01:00.000Z', completedAt: '2026-08-12T12:02:00.000Z', rollbackOfDeploymentId: null }], evidence: { artifactId: 'art_01J00000000000000000000000', href: `/v1/releases/${releaseId}/evidence` } }],
    rollbackTargets: [], nextCursor: null,
  }));
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}`, (route) => apiResponse(route, { release: { id: releaseId, organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD', projectId, environmentId: 'env_01J00000000000000000000000', commitSha: 'a'.repeat(40), specificationId: null, status: 'approved', evidenceManifestArtifactId: 'art_01J00000000000000000000000', createdBy: 'user_01J0000000000000000000000', createdAt: '2026-08-12T12:00:00.000Z' }, readiness: { state: 'ready', findings: [] } }));
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/evidence`, (route) => apiResponse(route, { evidence: {
    release_id: releaseId, commit_sha: 'a'.repeat(40), specification_version: 3,
    criteria: [
      { criterionId: 'AC-1', specificationVersion: 3, taskIds: ['task-a'], testCaseIds: ['case-a'], result: 'passed', evidenceArtifactIds: ['art-pass'], verifierComments: [] },
      { criterionId: 'AC-2', specificationVersion: 3, taskIds: ['task-b'], testCaseIds: ['case-b'], result: 'failed', evidenceArtifactIds: ['art-fail'], verifierComments: ['Checkout still fails.'] },
      { criterionId: 'AC-3', specificationVersion: 3, taskIds: [], testCaseIds: [], result: 'unverified', evidenceArtifactIds: [], verifierComments: [] },
    ],
    build: block('production_build'), typecheck: block('typecheck'), tests: block('unit_tests', 'failed'), browser_tests: block('browser_smoke'), security: block('secret_scan'), migration: block('migration_validation'), preview: block('preview_health'), rollback: block('rollback_readiness'), known_risks: [],
  } }));

  await signIn(page);
  await page.goto(`/projects/${projectId}/releases`);
  await expect(page.getByRole('complementary', { name: 'Workspace' })).toBeVisible();
  await expect(
    page.getByText('Review release evidence, deployment readiness, and production history.'),
  ).toBeVisible();
  await expect(page.getByText('Active in production')).toBeVisible();
  await expect(page.getByText('managed', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: releaseId }).click();
  await expect(page.getByRole('heading', { name: 'Evidence report' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'AC-1' })).toContainText('passed');
  await expect(page.getByRole('row').filter({ hasText: 'AC-2' })).toHaveAttribute('data-result', 'failed');
  await expect(page.getByRole('row').filter({ hasText: 'AC-3' })).toContainText('unverified');
  await expect(page.getByRole('button', { name: 'Deploy' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Fork to repair' })).toBeVisible();
});

test('blocks deployment at readiness and requires replacement data disposition', async ({ page }) => {
  await routeRelease(page, { state: 'blocked', findings: [{ id: 'db', severity: 'blocker', title: 'Database risk', detail: 'Migration is destructive.', action: 'fix_and_recheck' }] });
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/deployment-preview?retarget=false`, (route) => apiResponse(route, { title: 'Replace deployment', deploymentType: 'replace_deployment', effects: { productionData: 'Transferred after confirmation', secrets: 'Reused', url: 'Changed', activeUsers: 'Zero downtime' }, requiresExplicitDataDisposition: true }));
  await signIn(page); await page.goto(`/projects/${projectId}/releases/${releaseId}`); await page.getByRole('button', { name: 'Deploy' }).click();
  await expect(page.getByRole('heading', { name: 'Deployment blocked' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

  await page.unroute(`${apiBaseUrl}/v1/releases/${releaseId}`);
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}`, (route) => apiResponse(route, { release, readiness: { state: 'ready', findings: [] } }));
  await page.reload(); await page.getByRole('button', { name: 'Deploy' }).click(); await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Replace deployment' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm deployment' })).toBeDisabled();
  await page.getByLabel('transfer').check();
  await expect(page.getByRole('button', { name: 'Confirm deployment' })).toBeEnabled();
});

test('renders failed stages without a success state and exposes safe actions', async ({ page }) => {
  await routeRelease(page, { state: 'ready', findings: [] });
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/deployment-preview?retarget=false`, (route) => apiResponse(route, { title: 'Redeploy', deploymentType: 'redeploy', effects: { productionData: 'Preserved', secrets: 'Reused', url: 'Preserved', activeUsers: 'Zero downtime' }, requiresExplicitDataDisposition: false }));
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/deploy`, (route) => apiResponse(route, { deploymentId: 'dep_01J00000000000000000000000' }));
  await page.route(`${apiBaseUrl}/v1/deployments/dep_01J00000000000000000000000`, (route) => apiResponse(route, { deploymentId: 'dep_01J00000000000000000000000', releaseId, projectId, environmentId: release.environmentId, status: 'failed', url: null, terminalSuccess: null, events: [{ sequence: 1, stage: 'build_artifact', status: 'failed', elapsedMs: 4200, summary: 'Build failed.', evidenceArtifactId: 'art-build', occurredAt: '2026-08-12T12:01:00.000Z' }] }));
  await signIn(page); await page.goto(`/projects/${projectId}/releases/${releaseId}`); await page.getByRole('button', { name: 'Deploy' }).click(); await page.getByRole('button', { name: 'Continue' }).click(); await page.getByRole('button', { name: 'Confirm deployment' }).click();
  await expect(page.getByText('Build failed.')).toBeVisible(); await expect(page.getByText('Production unaffected.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry stage-safe' })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Deployment succeeded' })).toHaveCount(0);
});

test('renders the terminal success contract', async ({ page }) => {
  await routeRelease(page, { state: 'ready', findings: [] });
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/deployment-preview?retarget=false`, (route) => apiResponse(route, { title: 'First deploy', deploymentType: 'first_deploy', effects: { productionData: 'Created', secrets: 'Applied', url: 'Created', activeUsers: 'No users affected' }, requiresExplicitDataDisposition: false }));
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/deploy`, (route) => apiResponse(route, { deploymentId: 'dep_01J00000000000000000000000' }));
  await page.route(`${apiBaseUrl}/v1/deployments/dep_01J00000000000000000000000`, (route) => apiResponse(route, { deploymentId: 'dep_01J00000000000000000000000', releaseId, projectId, environmentId: release.environmentId, status: 'healthy', url: 'https://app.example.test', events: [], terminalSuccess: { status: 'succeeded', permanentUrl: 'https://app.example.test', release: { id: releaseId, commitSha: release.commitSha }, evidence: { statusLink: `/v1/releases/${releaseId}/evidence` }, productionHealth: { status: 'healthy' }, monitoring: { grafanaDashboardLinks: [], faroAppLink: 'https://grafana.example.test/faro', posthogAnnotationLink: 'https://posthog.example.test/release' }, customDomainAction: { method: 'POST', href: `/v1/projects/${projectId}/domains` }, previousHealthyRelease: { releaseId: 'rel_previous', deploymentId: 'dep_previous', commitSha: 'b'.repeat(40), rollbackAction: { method: 'POST', href: `/v1/releases/${releaseId}/rollback`, body: { toDeploymentId: 'dep_previous' } } }, previewChanges: { requireRedeploy: true, note: 'Preview changes require a new release and redeploy before they reach production.' } } }));
  await signIn(page); await page.goto(`/projects/${projectId}/releases/${releaseId}`); await page.getByRole('button', { name: 'Deploy' }).click(); await page.getByRole('button', { name: 'Continue' }).click(); await page.getByRole('button', { name: 'Confirm deployment' }).click();
  await expect(page.getByRole('heading', { name: 'Deployment succeeded' })).toBeVisible(); await expect(page.getByRole('link', { name: 'https://app.example.test' })).toBeVisible(); await expect(page.getByLabel('Deployment succeeded').getByText(`Release ${releaseId}`, { exact: false })).toBeVisible(); await expect(page.getByRole('link', { name: 'Rollback to rel_previous' })).toBeVisible();
});
