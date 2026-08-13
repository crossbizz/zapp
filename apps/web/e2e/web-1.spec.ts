import { expect, test, type Page } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';

async function fakeRequests(page: Page): Promise<unknown[]> {
  return await page.request.get(`${apiBaseUrl}/__requests`).then(async (response) => {
    return (await response.json() as { requests: unknown[] }).requests;
  });
}

async function signIn(page: Page, userCode?: string): Promise<void> {
  await page.goto(userCode === undefined ? '/login' : `/login?userCode=${encodeURIComponent(userCode)}`);
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(
    userCode === undefined ? '/' : `/device?userCode=${encodeURIComponent(userCode)}`,
  );
}

async function issueDeviceCode(page: Page): Promise<string> {
  const response = await page.request.get(`${apiBaseUrl}/v1/auth/device`);
  const body = await response.json() as { userCode: string };
  return body.userCode;
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('follows the fake Stytch login redirect and callback cookie flow', async ({ page, context }) => {
  await page.goto('/login');
  await expect(page.getByText('zapp.build', { exact: true })).toBeVisible();
  await expect(page.getByText('Turn an idea into working software.')).toBeVisible();
  await page.getByRole('link', { name: 'Sign in' }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByText('Ada Lovelace')).toBeVisible();
  await expect.poll(async () => (await context.cookies()).some((item) => item.name === 'zapp_session')).toBe(true);
  await expect.poll(async () => (await fakeRequests(page)).some((request) => {
    const typed = request as {
      path: string;
      hasOauthNonce: boolean;
      query: { hasState: boolean; hasProviderToken: boolean; providerTokenType?: string };
    };
    return typed.path === '/v1/auth/callback'
      && typed.hasOauthNonce
      && typed.query.hasState
      && typed.query.hasProviderToken
      && typed.query.providerTokenType === 'discovery_oauth';
  })).toBe(true);
});

test('renders the authenticated product navigation around the prompt dashboard', async ({ page }) => {
  await signIn(page);

  const navigation = page.getByRole('navigation', { name: 'Primary' });
  await expect(navigation.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/');
  await expect(navigation.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects');
  await expect(navigation.getByRole('link', { name: 'Templates' })).toHaveAttribute('href', '/templates');
  await expect(navigation.getByRole('link', { name: 'Usage' })).toHaveAttribute('href', '/org/usage');
  await expect(navigation.getByRole('link', { name: 'Billing' })).toHaveAttribute('href', '/org/billing');
  await expect(page.getByRole('combobox', { name: 'Organization' })).toHaveValue(
    'org_01K27Q9C2W85CMN1V9S6Q3D4FD',
  );
  await expect(page.getByRole('textbox', { name: 'Describe your project' })).toBeVisible();
});

test('redirects unauthenticated requests to login', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL('/login');
});

test('rejects a forged session cookie before rendering a protected device route', async ({ page }) => {
  await page.context().addCookies([
    { name: 'zapp_session', value: 'forged', url: 'http://127.0.0.1:3100' },
  ]);
  await page.goto('/device?userCode=ABCD-1234');

  await expect(page).toHaveURL('/login?userCode=ABCD-1234');
  await expect(page.getByRole('heading', { name: 'Sign in to zapp.build' })).toBeVisible();
});

test('rejects an expired signed session before rendering a protected device route', async ({ page }) => {
  await signIn(page);
  await page.request.get(`${apiBaseUrl}/__advance-time?milliseconds=${String(13 * 60 * 60 * 1000)}`);
  await page.goto('/device?userCode=ABCD-1234');

  await expect(page).toHaveURL('/login?userCode=ABCD-1234');
  await expect(page.getByRole('heading', { name: 'Sign in to zapp.build' })).toBeVisible();
});

test('loads the authenticated user from /v1/me with the session cookie', async ({ page }) => {
  await signIn(page);

  await expect(page.getByText('Ada Lovelace')).toBeVisible();
  await expect.poll(async () => (await fakeRequests(page)).some((request) => {
    return (request as { path: string; hasSession: boolean }).path === '/v1/me'
      && (request as { hasSession: boolean }).hasSession;
  })).toBe(true);
});

test('consumes the UI card without nesting main landmarks', async ({ page }) => {
  await signIn(page);

  await expect(page.locator('.zapp-card')).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
});

test('middleware forwards only the zapp session cookie to CP-2', async ({ page }) => {
  await signIn(page);
  await page.context().addCookies([
    {
      name: 'unrelated_app_cookie',
      value: 'must-stay-in-web',
      url: 'http://127.0.0.1:3100',
    },
  ]);
  await page.request.get(`${apiBaseUrl}/__reset`);

  await page.goto('/device?userCode=ABCD-1234');

  await expect.poll(async () => {
    const validation = (await fakeRequests(page)).find((request) => {
      return (request as { path: string }).path === '/v1/me';
    }) as { hasSession: boolean; hasUnrelatedCookie: boolean } | undefined;
    return validation === undefined
      ? undefined
      : {
          hasSession: validation.hasSession,
          hasUnrelatedCookie: validation.hasUnrelatedCookie,
        };
  }).toEqual({ hasSession: true, hasUnrelatedCookie: false });
});

for (const status of [429, 500]) {
  test(`returns a protected 503 when CP-2 validation returns ${String(status)}`, async ({ page }) => {
    await signIn(page);
    await page.request.get(`${apiBaseUrl}/__fail-me?request=1&status=${String(status)}`);

    const response = await page.goto('/device?userCode=ABCD-1234');

    expect(response?.status()).toBe(503);
    await expect(page).toHaveURL('/device?userCode=ABCD-1234');
    await expect(page.getByText('Authentication service is temporarily unavailable.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Approve device sign-in' })).toHaveCount(0);
  });
}

test('returns a protected 503 when CP-2 validation has a transport outage', async ({ page }) => {
  await signIn(page);
  await page.request.get(`${apiBaseUrl}/__drop-me?request=1`);

  const response = await page.goto('/device?userCode=ABCD-1234');

  expect(response?.status()).toBe(503);
  await expect(page).toHaveURL('/device?userCode=ABCD-1234');
  await expect(page.getByText('Authentication service is temporarily unavailable.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Approve device sign-in' })).toHaveCount(0);
});

test('persists a valid organization override under the authenticated user key', async ({ page }) => {
  await signIn(page);
  await page.goto('/?organizationId=org_01K27Q9C2W85CMN1V9S6Q3D4FE');

  await expect(page.getByText('Selected organization: Beta Org')).toBeVisible();
  await expect.poll(async () => await page.evaluate(() => localStorage.getItem('zapp:selected-organization:user_01K27Q9C2W85CMN1V9S6Q3D4FG'))).toBe('org_01K27Q9C2W85CMN1V9S6Q3D4FE');
  await page.reload();
  await expect(page.getByText('Selected organization: Beta Org')).toBeVisible();
});

test('rejects an organization override outside the active memberships', async ({ page }) => {
  await signIn(page);
  await page.goto('/?organizationId=org-not-a-member');

  await expect(page.getByText('Invalid organization selection.')).toBeVisible();
  await expect(page.getByText('Selected organization: Alpha Org')).toBeVisible();
  await expect.poll(async () => await page.evaluate(() => localStorage.getItem('zapp:selected-organization:user_01K27Q9C2W85CMN1V9S6Q3D4FG'))).toBe('org_01K27Q9C2W85CMN1V9S6Q3D4FD');
});

test('invalid URL override falls back to the persisted active organization', async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    localStorage.setItem('zapp:selected-organization:user_01K27Q9C2W85CMN1V9S6Q3D4FG', 'org_01K27Q9C2W85CMN1V9S6Q3D4FE');
  });
  await page.goto('/?organizationId=org-not-a-member');

  await expect(page.getByText('Invalid organization selection.')).toBeVisible();
  await expect(page.getByText('Selected organization: Beta Org')).toBeVisible();
  await expect.poll(async () => await page.evaluate(() => localStorage.getItem('zapp:selected-organization:user_01K27Q9C2W85CMN1V9S6Q3D4FG'))).toBe('org_01K27Q9C2W85CMN1V9S6Q3D4FE');
});

test('renders a recoverable error instead of redirecting for a control-plane failure', async ({ page }) => {
  await signIn(page);
  await page.request.get(`${apiBaseUrl}/__fail-me?request=2&status=500`);
  await page.goto('/');

  await expect(page).toHaveURL('/');
  await expect(page.getByText('We could not load your session. Please try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('renders a recoverable error instead of redirecting for localStorage failure', async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error('storage unavailable');
    };
  });
  await page.goto('/');

  await expect(page).toHaveURL('/');
  await expect(page.getByText('We could not load your session. Please try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('invited memberships cannot be selected from the URL or persisted storage', async ({ page }) => {
  await signIn(page);
  const body = await page.evaluate(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/me`, { credentials: 'include' });
    return await response.json() as {
      memberships: { organization: { id: string }; status: string }[];
    };
  }, apiBaseUrl);
  expect(body.memberships).toContainEqual(expect.objectContaining({
    organization: expect.objectContaining({ id: 'org_01K27Q9C2W85CMN1V9S6Q3D4FF' }),
    status: 'invited',
  }));

  await page.addInitScript(() => {
    localStorage.setItem('zapp:selected-organization:user_01K27Q9C2W85CMN1V9S6Q3D4FG', 'org_01K27Q9C2W85CMN1V9S6Q3D4FF');
  });
  await page.goto('/?organizationId=org_01K27Q9C2W85CMN1V9S6Q3D4FF');
  await expect(page.getByText('Invalid organization selection.')).toBeVisible();
  await expect(page.getByText('Selected organization: Alpha Org')).toBeVisible();
  await expect.poll(async () => await page.evaluate(() => localStorage.getItem('zapp:selected-organization:user_01K27Q9C2W85CMN1V9S6Q3D4FG'))).toBe('org_01K27Q9C2W85CMN1V9S6Q3D4FD');
});

test('injects the selected organization header through the central SDK wrapper', async ({ page }) => {
  await signIn(page);
  await page.goto('/?organizationId=org_01K27Q9C2W85CMN1V9S6Q3D4FE');

  await expect.poll(async () => (await fakeRequests(page)).some((request) => {
    const typed = request as { path: string; organizationId: string | null };
    return typed.path === '/v1/me' && typed.organizationId === 'org_01K27Q9C2W85CMN1V9S6Q3D4FE';
  })).toBe(true);
});

test('returns to device consent after login and approves the displayed code with CSRF', async ({ page }) => {
  const userCode = await issueDeviceCode(page);
  await signIn(page, userCode);

  await expect(page.getByText(userCode)).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(async () => (await fakeRequests(page)).some((request) => {
    const typed = request as { path: string; body: { userCode: string }; hasCsrf: boolean };
    return typed.path === '/v1/auth/device/approve' && typed.body.userCode === userCode
      && typed.hasCsrf;
  })).toBe(true);
  await expect(page.getByText('Device sign-in approved.')).toBeVisible();
});

test('denies device consent with the displayed code and CSRF', async ({ page }) => {
  const userCode = await issueDeviceCode(page);
  await signIn(page);
  await page.goto(`/device?userCode=${encodeURIComponent(userCode)}`);

  await page.getByRole('button', { name: 'Deny' }).click();
  await expect.poll(async () => (await fakeRequests(page)).some((request) => {
    const typed = request as { path: string; body: { userCode: string }; hasCsrf: boolean };
    return typed.path === '/v1/auth/device/deny' && typed.body.userCode === userCode
      && typed.hasCsrf;
  })).toBe(true);
  await expect(page.getByText('Device sign-in denied.')).toBeVisible();
});
