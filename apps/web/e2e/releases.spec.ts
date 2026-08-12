import { expect, test, type Page, type Route } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';
const projectId = 'proj_01J00000000000000000000000';
const releaseId = 'rel_01J00000000000000000000000';

function apiResponse(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status: 200, headers: { 'access-control-allow-credentials': 'true', 'access-control-allow-origin': appBaseUrl } });
}
async function signIn(page: Page): Promise<void> { await page.goto('/login'); await page.getByRole('link', { name: 'Sign in' }).click(); await expect(page).toHaveURL('/'); }

const gate = (gateId: string, status: 'passed' | 'failed' = 'passed') => ({ gateId, class: 'support_level_policy', status, evidenceArtifactIds: [`art-${gateId}`] });
const block = (gateId: string, status: 'passed' | 'failed' = 'passed') => ({ status, gates: [gate(gateId, status)] });

test('renders release history and every evidence criterion including failure', async ({ page }) => {
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/${projectId}/releases`, 'u'), (route) => apiResponse(route, {
    items: [{ id: releaseId, projectId, environmentId: 'env_01J00000000000000000000000', commitSha: 'a'.repeat(40), status: 'approved', createdBy: 'user_01J0000000000000000000000', supportLevel: 'managed', activeProduction: true, createdAt: '2026-08-12T12:00:00.000Z', deployments: [{ id: 'dep_01J00000000000000000000000', provider: 'fly', providerDeploymentId: 'machine-1', status: 'healthy', url: 'https://alpha.example.test', startedAt: '2026-08-12T12:01:00.000Z', completedAt: '2026-08-12T12:02:00.000Z', rollbackOfDeploymentId: null }], evidence: { artifactId: 'art_01J00000000000000000000000', href: `/v1/releases/${releaseId}/evidence` } }],
    rollbackTargets: [], nextCursor: null,
  }));
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}`, (route) => apiResponse(route, { release: { id: releaseId, organizationId: 'org-alpha', projectId, environmentId: 'env_01J00000000000000000000000', commitSha: 'a'.repeat(40), specificationId: null, status: 'approved', evidenceManifestArtifactId: 'art_01J00000000000000000000000', createdBy: 'user_01J0000000000000000000000', createdAt: '2026-08-12T12:00:00.000Z' }, readiness: { state: 'ready', findings: [] } }));
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
