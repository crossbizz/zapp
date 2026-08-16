import { expect, test, type Page, type Route } from '@playwright/test';

import { apiBaseUrl, appBaseUrl } from './support/ports.js';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    headers: {
      'access-control-allow-credentials': 'true',
      'access-control-allow-origin': appBaseUrl,
    },
    status,
  });
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('renders usage burn-down and persists budget alert channels through the public API', async ({
  page,
}) => {
  const preferenceMutations: { readonly body: unknown; readonly type: string }[] = [];
  let finishPreferenceMutation: (() => void) | undefined;
  await page.route(new RegExp(`^${apiBaseUrl}/v1/usage/summary\?`, 'u'), async (route) => {
    expect(route.request().headers()['x-organization-id']).toBe('org_01K27Q9C2W85CMN1V9S6Q3D4FD');
    await json(route, {
      credits: {
        available: '82.5000',
        reserved: '17.5000',
        source: 'wallet',
        wallet: '100.0000',
      },
      usage: {
        byCategory: [{ category: 'model_input_tokens', credits: '1.2000' }],
        byProject: [{ projectId: 'proj-home', credits: '1.2000' }],
        byRun: [{ runId: 'run-home', credits: '1.2000' }],
      },
      window: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
    });
  });
  await page.route(`${apiBaseUrl}/v1/notification-preferences`, async (route) => {
    await json(route, {
      preferences: [50, 80, 100].map((threshold) => ({
        desktopPush: true,
        email: true,
        inApp: true,
        organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
        type: `budget_${String(threshold)}`,
        userId: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
      })),
    });
  });
  await page.route(
    new RegExp(`^${apiBaseUrl}/v1/notification-preferences/budget_(50|80|100)$`, 'u'),
    async (route) => {
      preferenceMutations.push({
        body: route.request().postDataJSON(),
        type: route.request().url().split('/').at(-1) ?? '',
      });
      expect(route.request().headers()['x-zapp-csrf']).toBeTruthy();
      await new Promise<void>((resolve) => {
        finishPreferenceMutation = resolve;
      });
      await json(route, {
        preference: {
          desktopPush: true,
          email: false,
          inApp: true,
          organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
          type: 'budget_80',
          userId: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
        },
      });
    },
  );

  await signIn(page);
  await page.goto('/org/usage');

  await expect(page.getByRole('complementary', { name: 'Workspace' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible();
  await expect(
    page.getByText('Track credit balance, spend, and budget alerts for your organization.'),
  ).toBeVisible();
  await expect(page.getByText('82.5000 credits')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'By category' })).toBeVisible();
  await expect(page.getByText('model input tokens')).toBeVisible();
  await expect(page.getByText('proj-home')).toBeVisible();
  await expect(page.getByText('run-home')).toBeVisible();

  const emailAtEighty = page.getByRole('checkbox', { name: 'Email at 80%' });
  await emailAtEighty.click();
  await expect
    .poll(() => preferenceMutations)
    .toEqual([
      {
        body: { desktopPush: true, email: false, inApp: true },
        type: 'budget_80',
      },
    ]);
  await expect(emailAtEighty).not.toBeChecked();
  finishPreferenceMutation?.();
  await expect(page.getByRole('status')).toContainText('Budget alert saved');
});

test('manages plan seats, payment method, and top-up checkout', async ({ page }) => {
  const mutations: string[] = [];
  await page.route(`${apiBaseUrl}/v1/billing/status`, async (route) => {
    await json(route, {
      billing: {
        customerId: 'cus_fixture',
        dunning: { state: 'current' },
        planId: 'studio',
        seats: 6,
        subscriptionId: 'sub_fixture',
        subscriptionStatus: 'active',
      },
    });
  });
  await page.route(`${apiBaseUrl}/v1/billing/topups`, async (route) => {
    await json(route, { packs: [{ amountUsd: '25.00', credits: '100.0000', id: 'starter' }] });
  });
  await page.route(`${apiBaseUrl}/v1/billing/subscription`, async (route) => {
    mutations.push(`seats:${JSON.stringify(route.request().postDataJSON())}`);
    await json(route, { accepted: true }, 202);
  });
  await page.route(`${apiBaseUrl}/v1/billing/portal`, async (route) => {
    mutations.push('portal');
    await json(route, { url: 'https://billing.example.test/portal' }, 201);
  });
  await page.route(`${apiBaseUrl}/v1/billing/topups/checkout`, async (route) => {
    mutations.push(`topup:${JSON.stringify(route.request().postDataJSON())}`);
    await json(route, { url: 'https://billing.example.test/topup' }, 201);
  });

  await signIn(page);
  await page.goto('/org/billing');

  await expect(page.getByRole('complementary', { name: 'Workspace' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
  await expect(
    page.getByText('Manage the organization plan, Stripe payment method, seats, and prepaid credits.'),
  ).toBeVisible();
  await expect(page.getByText('Studio')).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Seats' })).toHaveValue('6');
  await page.getByRole('spinbutton', { name: 'Seats' }).fill('4');
  await page.getByRole('button', { name: 'Update seats' }).click();
  await page.getByRole('button', { name: 'Manage payment method' }).click();
  await page.getByRole('button', { name: 'Buy 100.0000 credits' }).click();

  await expect
    .poll(() => mutations)
    .toEqual(['seats:{"seats":4}', 'portal', 'topup:{"packId":"starter"}']);
});

test('shows the filterable audit table only to an organization owner', async ({ page }) => {
  let auditReads = 0;
  await page.route(`${apiBaseUrl}/v1/organizations/org_01K27Q9C2W85CMN1V9S6Q3D4FD/audit-events*`, async (route) => {
    auditReads += 1;
    const query = new URL(route.request().url()).searchParams;
    expect(query.get('action')).toBe(auditReads === 1 ? null : 'project.created');
    await json(route, {
      items: [
        {
          action: 'project.created',
          actorId: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
          actorType: 'user',
          id: 'aud_fixture',
          metadata: {},
          occurredAt: '2026-08-12T12:00:00.000Z',
          organizationId: 'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
          targetId: 'proj-home',
          targetType: 'project',
        },
      ],
      nextCursor: null,
    });
  });

  await signIn(page);
  await page.goto('/org/audit');
  await expect(page.getByRole('complementary', { name: 'Workspace' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(page.getByText('Immutable organization activity, newest first.')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'project.created' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Action' }).selectOption('project.created');
  await expect.poll(() => auditReads).toBe(2);

  await page.goto('/org/audit?organizationId=org_01K27Q9C2W85CMN1V9S6Q3D4FE');
  await expect(page.getByRole('heading', { name: 'Owner access required' })).toBeVisible();
  expect(auditReads).toBe(2);
});
