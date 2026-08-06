import { expect, test, type Page, type Route } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';
const explicitModel = 'anthropic/claude-sonnet-5';

interface ObservedMutation {
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly method: string;
  readonly url: string;
}

interface CreationMocks {
  readonly projectRequests: ObservedMutation[];
  readonly runRequests: ObservedMutation[];
}

const projectFixture = {
  branches: [
    {
      baseBranchId: null,
      headCommitSha: null,
      id: 'branch-main',
      name: 'main',
      organizationId: 'org-alpha',
      projectId: 'proj-home',
      status: 'active',
    },
    {
      baseBranchId: 'branch-main',
      headCommitSha: null,
      id: 'branch-develop',
      name: 'develop',
      organizationId: 'org-alpha',
      projectId: 'proj-home',
      status: 'active',
    },
  ],
  environments: [],
  project: {
    archivedAt: null,
    createdAt: '2026-08-05T12:00:00.000Z',
    createdBy: 'user-ada',
    description: null,
    id: 'proj-home',
    name: 'Build a customer support portal',
    organizationId: 'org-alpha',
    slug: 'build-a-customer-support-portal',
    sourceType: 'prompt',
    supportLevel: 'compatible',
  },
  repository: {
    defaultBranch: 'main',
    externalRepoRef: null,
    id: 'repo-home',
    internalRepoRef: 'org-alpha/proj-home',
    organizationId: 'org-alpha',
    projectId: 'proj-home',
    provider: 'forgejo',
    syncPolicy: 'internal',
  },
} as const;

const runFixture = {
  run: {
    appType: 'web',
    branchId: 'branch-main',
    completedAt: null,
    id: 'run-home',
    mode: 'build',
    model: null,
    organizationId: 'org-alpha',
    projectId: 'proj-home',
    startedAt: '2026-08-05T12:00:01.000Z',
    startedBy: 'user-ada',
    status: 'queued',
  },
} as const;

async function fakeRequests(page: Page): Promise<unknown[]> {
  return await page.request.get(`${apiBaseUrl}/__requests`).then(async (response) => {
    return (await response.json() as { requests: unknown[] }).requests;
  });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('textbox', { name: 'Describe your project' })).toBeVisible();
}

function mutation(route: Route): ObservedMutation {
  const request = route.request();
  return {
    body: request.postDataJSON(),
    headers: request.headers(),
    method: request.method(),
    url: request.url(),
  };
}

async function mockCreation(
  page: Page,
  options: { readonly failFirstRun?: boolean } = {},
): Promise<CreationMocks> {
  const projectRequests: ObservedMutation[] = [];
  const runRequests: ObservedMutation[] = [];

  await page.route(`${apiBaseUrl}/v1/projects/proj-home`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: JSON.stringify(projectFixture),
      contentType: 'application/json',
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
      },
      status: 200,
    });
  });

  await page.route(`${apiBaseUrl}/v1/projects`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    projectRequests.push(mutation(route));
    await route.fulfill({
      body: JSON.stringify(projectFixture),
      contentType: 'application/json',
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
      },
      status: 201,
    });
  });

  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/[^/]+/runs$`, 'u'), async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    runRequests.push(mutation(route));
    if (options.failFirstRun === true && runRequests.length === 1) {
      await route.fulfill({
        body: JSON.stringify({
          error: {
            code: 'fixture_failure',
            message: 'Fixture failure',
            requestId: 'req-home-run-failure',
          },
        }),
        contentType: 'application/json',
        headers: {
          'access-control-allow-credentials': 'true',
          'access-control-allow-origin': appBaseUrl,
        },
        status: 500,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify(runFixture),
      contentType: 'application/json',
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
      },
      status: 201,
    });
  });

  return { projectRequests, runRequests };
}

async function mockAllowedModels(page: Page): Promise<void> {
  await page.route(`${apiBaseUrl}/v1/me`, async (route) => {
    const response = await route.fetch();
    const body = await response.json() as {
      memberships: {
        organization: { id: string };
        role: string;
        status: string;
      }[];
      user: unknown;
    };
    await route.fulfill({
      response,
      json: {
        ...body,
        memberships: body.memberships.map((membership) =>
          membership.organization.id === 'org-alpha'
            ? {
                ...membership,
                allowedModels: [explicitModel, 'openai:gpt_5.1-mini'],
                role: 'builder',
              }
            : { ...membership, allowedModels: [] }),
      },
    });
  });
}

async function enableMobileApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'posthog', {
      configurable: true,
      value: {
        isFeatureEnabled(flag: string): boolean {
          return flag === 'mobile-app-tab';
        },
      },
    });
  });
}

async function enableMobileAppAfterFeatureLoad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let enabled = false;
    Object.defineProperty(window, 'posthog', {
      configurable: true,
      value: {
        group(kind: string, key: string): void {
          (window as Window & { __posthogGroup?: readonly string[] }).__posthogGroup = [kind, key];
        },
        isFeatureEnabled(flag: string): boolean {
          return flag === 'mobile-app-tab' && enabled;
        },
        onFeatureFlags(callback: () => void): () => void {
          const timer = window.setTimeout(() => {
            enabled = true;
            callback();
          }, 0);
          return () => {
            window.clearTimeout(timer);
          };
        },
      },
    });
  });
}

async function openModelControls(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add attachment or controls' }).click();
  await page.getByRole('button', { name: /Auto/u }).click();
}

async function submitPrompt(page: Page, prompt: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Describe your project' }).fill(prompt);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL('/projects/proj-home');
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('renders the prompt-first home with default-off flags and deterministic suggestions', async ({ page }) => {
  await signIn(page);

  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('heading', {
    name: "Start with one prompt. We'll take it to production.",
  })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Web App' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /Mobile App/u })).toBeDisabled();
  await expect(page.getByText('Coming after P0', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /voice/u })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '0 credits' })).toHaveAttribute('href', '/org/usage');

  for (const suggestion of [
    'Client portal for an agency',
    'Class scheduler for a yoga studio',
    'SaaS dashboard with Stripe billing',
  ]) {
    await expect(page.getByRole('button', { name: suggestion })).toBeVisible();
  }
});

test('explains the disabled Mobile App option from a keyboard-accessible help control', async ({ page }) => {
  await signIn(page);

  const help = page.getByRole('button', { name: 'Why Mobile App is unavailable' });
  await expect(help).toBeVisible();
  await help.focus();
  await expect(help).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText('Mobile App is coming after P0.');
});

test('enables Mobile App behind its flag and submits mobile appType', async ({ page }) => {
  const observed = await mockCreation(page);
  await enableMobileApp(page);
  await signIn(page);

  const mobileTab = page.getByRole('tab', { name: /Mobile App/u });
  await expect(mobileTab).toBeEnabled();
  await mobileTab.click();
  await expect(mobileTab).toHaveAttribute('aria-selected', 'true');
  await submitPrompt(page, 'Build a mobile inventory application');

  expect(observed.runRequests[0]?.body).toEqual({
    appType: 'mobile',
    branchId: 'branch-main',
    mode: 'build',
    prompt: 'Build a mobile inventory application',
  });
});

test('reacts to asynchronously loaded organization-scoped PostHog flags', async ({ page }) => {
  await enableMobileAppAfterFeatureLoad(page);
  await signIn(page);

  await expect(page.getByRole('tab', { name: /Mobile App/u })).toBeEnabled();
  expect(await page.evaluate(() => {
    return (window as Window & { __posthogGroup?: readonly string[] }).__posthogGroup;
  })).toEqual(['organization', 'org-alpha']);
});

test('keeps short prompts disabled and fills without submitting from a suggestion', async ({ page }) => {
  await signIn(page);
  const composer = page.getByRole('textbox', { name: 'Describe your project' });
  const submit = page.getByRole('button', { name: 'Create project' });

  await expect(composer).toHaveAttribute('rows', '3');
  await composer.fill('Tiny app');
  await expect(submit).toBeDisabled();

  await page.getByRole('button', { name: 'Client portal for an agency' }).click();
  await expect(composer).toHaveValue('Client portal for an agency');
  await expect(submit).toBeEnabled();
  await expect(page).toHaveURL('/');
  expect((await fakeRequests(page)).filter((request) => {
    return (request as { path?: string }).path === '/v1/projects';
  })).toHaveLength(0);

  await composer.fill(Array.from({ length: 12 }, (_, index) => `Line ${String(index + 1)}`).join('\n'));
  await expect(composer).toHaveAttribute('rows', '10');
});

test('autosizes wrapped prompt content from rendered height and clamps to ten rows', async ({ page }) => {
  await signIn(page);
  const composer = page.getByRole('textbox', { name: 'Describe your project' });

  await composer.fill('A rendered wrapping prompt '.repeat(24));
  await expect.poll(async () => Number(await composer.getAttribute('rows'))).toBeGreaterThan(3);

  await composer.fill('A much longer rendered wrapping prompt '.repeat(160));
  await expect(composer).toHaveAttribute('rows', '10');

  await composer.fill('Short again');
  await expect(composer).toHaveAttribute('rows', '3');
});

test('shuffles to a different deterministic group of suggestions', async ({ page }) => {
  await signIn(page);

  await page.getByRole('button', { name: 'Shuffle suggestions' }).click();

  await expect(page.getByRole('button', { name: 'Client portal for an agency' })).toHaveCount(0);
  for (const suggestion of [
    'Inventory tracker for a small retailer',
    'Community event planning hub',
    'Restaurant reservation manager',
  ]) {
    await expect(page.getByRole('button', { name: suggestion })).toBeVisible();
  }
});

test('exposes attachment, mode, model-policy, and advanced controls', async ({ page }) => {
  await signIn(page);

  await page.getByRole('button', { name: 'Add attachment or controls' }).click();
  await expect(page.getByLabel('Upload file')).toHaveAttribute('type', 'file');
  await expect(page.getByRole('link', { name: 'Import from GitHub' })).toHaveAttribute(
    'href',
    '/projects?import=github',
  );
  await page.getByRole('button', { name: /Auto/u }).click();

  await expect(page.getByRole('radio', { name: 'Auto (recommended)' })).toBeChecked();
  for (const mode of ['Ask', 'Prototype', 'Build', 'Fix', 'Autonomous']) {
    await expect(page.getByRole('radio', { name: new RegExp(`^${mode}`, 'u') })).toBeVisible();
  }
  await expect(page.getByText('Automatic selection managed by your organization.')).toBeVisible();
  await page.getByRole('radio', { name: /^Fix/u }).check();
  await expect(page.getByLabel('Selected mode: Fix')).toBeVisible();

  await page.getByRole('button', { name: 'Advanced controls' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Run budget cap' })).toHaveAttribute('min', '1');
  await expect(page.getByRole('textbox', { name: 'Target branch' })).toHaveValue('main');
});

test('renders only valid policy model radios and submits the explicit generated-SDK model', async ({ page }) => {
  const observed = await mockCreation(page);
  await mockAllowedModels(page);
  await signIn(page);

  await openModelControls(page);
  const modelChoices = page.getByRole('group', { name: 'Model' });
  await expect(modelChoices.getByRole('radio', { name: 'Automatic' })).toBeChecked();
  await expect(modelChoices.getByRole('radio', { name: explicitModel })).toBeVisible();
  await expect(modelChoices.getByRole('radio', { name: 'openai:gpt_5.1-mini' })).toBeVisible();
  await expect(modelChoices.getByRole('radio')).toHaveCount(3);
  for (const malformed of [
    `a${'b'.repeat(160)}`,
    'model with spaces',
    '-leading-punctuation',
    '42',
  ]) {
    await expect(modelChoices.getByRole('radio', { name: malformed, exact: true })).toHaveCount(0);
  }

  await page.getByRole('radio', { name: explicitModel }).check();
  await expect(page.getByLabel(`Selected model: ${explicitModel}`)).toBeVisible();
  await submitPrompt(page, 'Build a policy approved support portal');
  expect(observed.runRequests[0]?.body).toEqual({
    appType: 'web',
    branchId: 'branch-main',
    mode: 'build',
    model: explicitModel,
    prompt: 'Build a policy approved support portal',
  });
});

test('keeps the exact creation controls in keyboard tab order', async ({ page }) => {
  await signIn(page);
  await page.getByRole('textbox', { name: 'Describe your project' }).fill('Build a useful customer portal');
  const webTab = page.getByRole('tab', { name: 'Web App' });
  await webTab.focus();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Describe your project' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Add attachment or controls' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Create project' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Client portal for an agency' })).toBeFocused();
});

test('defaults Auto to web without model and hands the first prompt to the real builder', async ({ page }) => {
  const observed = await mockCreation(page);
  await signIn(page);

  await page.getByRole('button', { name: 'Add attachment or controls' }).click();
  await page.getByRole('button', { name: 'Advanced controls' }).click();
  await page.getByRole('spinbutton', { name: 'Run budget cap' }).fill('24');
  await page.getByRole('textbox', { name: 'Target branch' }).fill('develop');

  const prompt = 'Build a customer support portal';
  await submitPrompt(page, prompt);
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.getByText(prompt, { exact: true })).toBeVisible();
  await expect(conversation.getByText('No conversation yet')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Preview' })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');

  expect(observed.projectRequests).toHaveLength(1);
  expect(observed.runRequests).toHaveLength(1);
  const projectRequest = observed.projectRequests[0];
  const runRequest = observed.runRequests[0];
  expect(projectRequest?.method).toBe('POST');
  expect(projectRequest?.body).toEqual({
    name: 'Build a customer support portal',
    sourceType: 'prompt',
  });
  expect(runRequest?.method).toBe('POST');
  expect(runRequest?.url).toBe(`${apiBaseUrl}/v1/projects/proj-home/runs`);
  expect(runRequest?.body).toEqual({
    appType: 'web',
    branchId: 'branch-develop',
    budget: { maxCredits: 24 },
    mode: 'build',
    prompt,
  });

  for (const request of [projectRequest, runRequest]) {
    expect(request?.headers['x-organization-id']).toBe('org-alpha');
    expect(request?.headers['x-zapp-csrf']).toBeTruthy();
    expect(request?.headers.cookie).toContain('zapp_session=');
    expect(request?.headers['idempotency-key']).toBeTruthy();
  }
  expect(projectRequest?.headers['idempotency-key']).not.toBe(runRequest?.headers['idempotency-key']);
});

test('navigates with the first prompt when session storage rejects the handoff', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeSetItem = Storage.prototype.setItem.bind(window.localStorage);
    Storage.prototype.setItem = function setItem(key: string, value: string): void {
      if (this === window.sessionStorage && key === 'proj-home') {
        throw new DOMException('Storage disabled', 'SecurityError');
      }
      nativeSetItem(key, value);
    };
  });
  await mockCreation(page);
  await signIn(page);

  const prompt = 'Build a resilient customer portal';
  await submitPrompt(page, prompt);

  await expect(
    page.getByRole('region', { name: 'Conversation' }).getByText(prompt, { exact: true }),
  ).toBeVisible();
});

test('uses the Auto heuristic and lets an explicit mode win', async ({ page }) => {
  const exploratory = await mockCreation(page);
  await signIn(page);
  await submitPrompt(page, 'What if we prototype a garden planning app?');
  expect(exploratory.runRequests[0]?.body).toEqual({
    appType: 'web',
    branchId: 'branch-main',
    mode: 'prototype',
    prompt: 'What if we prototype a garden planning app?',
  });

  await page.unrouteAll({ behavior: 'wait' });
  await page.goto('/');
  const explicit = await mockCreation(page);
  await page.getByRole('button', { name: 'Add attachment or controls' }).click();
  await page.getByRole('button', { name: /Auto/u }).click();
  await page.getByRole('radio', { name: /^Fix/u }).check();
  await submitPrompt(page, 'I have an idea for a garden planning app');
  expect(explicit.runRequests[0]?.body).toEqual({
    appType: 'web',
    branchId: 'branch-main',
    mode: 'fix',
    prompt: 'I have an idea for a garden planning app',
  });
});

test('matches Auto exploratory terms as words instead of prompt fragments', async ({ page }) => {
  const observed = await mockCreation(page);
  await signIn(page);

  await submitPrompt(page, 'Build a country club booking portal');

  expect(observed.runRequests[0]?.body).toEqual({
    appType: 'web',
    branchId: 'branch-main',
    mode: 'build',
    prompt: 'Build a country club booking portal',
  });
});

test('lists active organizations and signs out through the public API', async ({ page }) => {
  await signIn(page);

  await page.getByRole('button', { name: 'Open account menu' }).click();
  await expect(page.getByRole('link', { name: 'Alpha Org' })).toHaveAttribute(
    'href',
    '/?organizationId=org-alpha',
  );
  await expect(page.getByRole('link', { name: 'Beta Org' })).toHaveAttribute(
    'href',
    '/?organizationId=org-beta',
  );
  await expect(page.getByRole('link', { name: 'Organization settings' })).toHaveAttribute(
    'href',
    '/org/settings',
  );
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page).toHaveURL('/login');
  await expect.poll(async () => (await fakeRequests(page)).some((request) => {
    const typed = request as { method: string; path: string; hasCsrf: boolean };
    return typed.method === 'POST' && typed.path === '/v1/auth/logout' && typed.hasCsrf;
  })).toBe(true);
});

test('re-runs tenant selection when an organization is chosen from the account menu', async ({ page }) => {
  await signIn(page);

  await page.getByRole('button', { name: 'Open account menu' }).click();
  await page.getByRole('link', { name: 'Beta Org' }).click();

  await expect(page).toHaveURL('/?organizationId=org-beta');
  await expect(page.getByText('Selected organization: Beta Org')).toBeVisible();
  await expect.poll(async () => (await fakeRequests(page)).some((request) => {
    const typed = request as { path?: string; organizationId?: string | null };
    return typed.path === '/v1/me' && typed.organizationId === 'org-beta';
  })).toBe(true);
});

test('clears stale session-derived state before retry revalidation', async ({ page }) => {
  let unscopedRequests = 0;
  let failedScopedRequest = false;
  let releaseRetry = (): void => undefined;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });

  await page.route(`${apiBaseUrl}/v1/me`, async (route) => {
    const organizationId = route.request().headers()['x-organization-id'];
    if (organizationId === 'org-alpha' && !failedScopedRequest) {
      failedScopedRequest = true;
      await route.fulfill({
        body: JSON.stringify({ error: { code: 'fixture_failure' } }),
        contentType: 'application/json',
        headers: {
          'access-control-allow-credentials': 'true',
          'access-control-allow-origin': appBaseUrl,
        },
        status: 500,
      });
      return;
    }
    if (organizationId === undefined) {
      unscopedRequests += 1;
      if (unscopedRequests === 2) await retryGate;
    }
    await route.fallback();
  });

  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('We could not load your session. Please try again.')).toBeVisible();

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => unscopedRequests).toBe(2);
  try {
    await expect(page.getByText('Loading session…')).toBeVisible();
    await expect(page.getByText('Selected organization: Alpha Org')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Describe your project' })).toHaveCount(0);
    await expect(page.getByText('We could not load your session. Please try again.')).toHaveCount(0);
  } finally {
    releaseRetry();
  }
});

test('surfaces failed creation with all four standard recovery actions', async ({ page }) => {
  await page.route(`${apiBaseUrl}/v1/projects`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        error: {
          code: 'fixture_failure',
          message: 'Fixture failure',
          requestId: 'req-home-failure',
        },
      }),
      contentType: 'application/json',
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
      },
      status: 500,
    });
  });
  await signIn(page);

  await page.getByRole('textbox', { name: 'Describe your project' }).fill('Build a customer support portal');
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByRole('alert').filter({
    hasText: 'We could not start your project.',
  })).toContainText('We could not start your project.');
  for (const action of ['Fix automatically', 'Inspect details', 'Retry', 'Ask the agent']) {
    await expect(page.getByRole('button', { name: action })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Inspect details' }).click();
  await expect(page.getByText('Request failed before the project handoff completed.')).toBeVisible();
});

test('retries frozen appType and model with the original distinct idempotency keys', async ({ page }) => {
  const observed = await mockCreation(page, { failFirstRun: true });
  await mockAllowedModels(page);
  await enableMobileApp(page);
  await signIn(page);

  await page.getByRole('tab', { name: /Mobile App/u }).click();
  await openModelControls(page);
  await page.getByRole('radio', { name: explicitModel }).check();

  const originalPrompt = 'Build a customer support portal';
  await page.getByRole('textbox', { name: 'Describe your project' }).fill(originalPrompt);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('alert').filter({
    hasText: 'We could not start your project.',
  })).toBeVisible();

  await page.getByRole('textbox', { name: 'Describe your project' }).fill(
    'Build a completely different inventory application',
  );
  await page.getByRole('tab', { name: 'Web App' }).click();
  await page.getByRole('radio', { name: 'Automatic' }).check();
  await page.getByRole('button', { name: 'Retry' }).click();

  await expect(page).toHaveURL('/projects/proj-home');
  await expect(
    page.getByRole('region', { name: 'Conversation' }).getByText(originalPrompt, { exact: true }),
  ).toBeVisible();
  expect(observed.projectRequests).toHaveLength(2);
  expect(observed.runRequests).toHaveLength(2);
  expect(observed.projectRequests[1]?.body).toEqual(observed.projectRequests[0]?.body);
  expect(observed.runRequests[1]?.body).toEqual(observed.runRequests[0]?.body);
  expect(observed.runRequests[0]?.body).toEqual({
    appType: 'mobile',
    branchId: 'branch-main',
    mode: 'build',
    model: explicitModel,
    prompt: originalPrompt,
  });
  expect(observed.projectRequests[1]?.headers['idempotency-key']).toBe(
    observed.projectRequests[0]?.headers['idempotency-key'],
  );
  expect(observed.runRequests[1]?.headers['idempotency-key']).toBe(
    observed.runRequests[0]?.headers['idempotency-key'],
  );
  expect(observed.projectRequests[0]?.headers['idempotency-key']).not.toBe(
    observed.runRequests[0]?.headers['idempotency-key'],
  );
});
