import { expect, test, type Page, type Route } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const organizationId = 'org_01J00000000000000000000000';
const shareId = '01j00000000000000000000000';
const bearer = 'psb_public-fragment-secret';
const previewOrigin = `http://${organizationId.slice(4).toLowerCase()}-${shareId}.preview.localhost:4100`;

function cors(route: Route, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  return route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    headers: {
      'access-control-allow-credentials': 'true',
      'access-control-allow-origin': 'http://127.0.0.1:3100',
      ...headers,
    },
    status: 200,
  });
}

async function installPreviewExchange(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.route(
    `${apiBaseUrl}/v1/organizations/${organizationId}/preview-shares/${shareId}/sessions`,
    async (route) => {
      const request = route.request();
      seen.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`);
      expect(request.headers()['idempotency-key']).toBeTruthy();
      await cors(route, {
        previewOrigin,
        grant: 'pbg_short-lived-grant',
        expiresAt: '2026-08-09T12:00:00.000Z',
      });
    },
  );
  await page.route(`${previewOrigin}/v1/preview/session`, async (route) => {
    const request = route.request();
    seen.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`);
    expect(request.headers()['idempotency-key']).toBeTruthy();
    await cors(
      route,
      { expiresAt: '2026-08-09T12:00:00.000Z' },
      {
        'set-cookie':
          '__Host-zapp_preview=opaque; Path=/; Secure; HttpOnly; SameSite=None; Partitioned',
      },
    );
  });
  await page.route(`${previewOrigin}/`, async (route) => {
    seen.push(`GET ${route.request().url()}`);
    expect(route.request().headers()['cookie']).toContain('__Host-zapp_preview=opaque');
    await route.fulfill({
      body: '<!doctype html><title>Isolated preview</title><h1>Preview ready</h1>',
      contentType: 'text/html',
      status: 200,
    });
  });
  return seen;
}

test('exchanges a fragment bearer, clears secrets, redeems at the isolated origin, and navigates', async ({
  page,
}) => {
  const seen = await installPreviewExchange(page);
  await page.goto(`/preview/${organizationId}/${shareId}#token=${bearer}`);

  await expect(page.getByRole('heading', { name: 'Preview ready' })).toBeVisible();
  await expect(page).toHaveURL(`${previewOrigin}/`);
  expect(seen).toHaveLength(3);
  expect(seen[0]).toContain(JSON.stringify({ bearer }));
  expect(seen[1]).toContain(
    JSON.stringify({ organizationId, shareId, grant: 'pbg_short-lived-grant' }),
  );
  expect(seen.join('\n')).not.toContain('modal');
  expect(await page.evaluate(() => window.location.hash)).toBe('');
});

test('fails closed when the fragment bearer is missing', async ({ page }) => {
  await page.goto(`/preview/${organizationId}/${shareId}`);
  await expect(page.getByText(/missing or invalid/iu)).toBeVisible();
  await expect(page).toHaveURL(`/preview/${organizationId}/${shareId}`);
});
