import { expect, test, type Page, type Request } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:4100';
const appBaseUrl = 'http://127.0.0.1:3100';
const projectId = 'project-apollo';
const conversationWidthStorageKey = `zapp:builder:conversation-width:${projectId}`;

const projectRead = {
  branches: [
    {
      baseBranchId: null,
      headCommitSha: null,
      id: 'branch-main',
      name: 'main',
      organizationId: 'org-alpha',
      projectId,
      status: 'active',
    },
  ],
  environments: [
    {
      createdAt: '2026-08-05T12:00:00.000Z',
      databaseConnectionId: null,
      deploymentProvider: null,
      id: 'environment-preview',
      name: 'preview',
      organizationId: 'org-alpha',
      projectId,
      type: 'preview',
    },
  ],
  project: {
    archivedAt: null,
    createdAt: '2026-08-05T12:00:00.000Z',
    createdBy: 'user-ada',
    description: 'A mission planning workspace.',
    id: projectId,
    name: 'Project Apollo',
    organizationId: 'org-alpha',
    slug: 'project-apollo',
    sourceType: 'prompt',
    supportLevel: 'compatible' as const,
  },
  repository: {
    defaultBranch: 'main',
    externalRepoRef: null,
    id: 'repository-apollo',
    internalRepoRef: 'org_alpha/project_apollo',
    organizationId: 'org-alpha',
    projectId,
    provider: 'forgejo',
    syncPolicy: 'none',
  },
};

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('Ada Lovelace')).toBeVisible();
}

async function mockProjectRead(
  page: Page,
  body: typeof projectRead | { readonly repository: null } = projectRead,
): Promise<Request[]> {
  const requests: Request[] = [];
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    requests.push(route.request());
    await route.fulfill({
      body: JSON.stringify(body),
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
        'content-type': 'application/json',
      },
      status: 200,
    });
  });
  return requests;
}

async function openBuilder(page: Page): Promise<Request[]> {
  const requests = await mockProjectRead(page);
  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Project Apollo' })).toBeVisible();
  return requests;
}

async function setStoredConversationWidth(page: Page, value: number): Promise<void> {
  await page.evaluate(
    ({ key, width }) => {
      localStorage.setItem(key, String(width));
    },
    { key: conversationWidthStorageKey, width: value },
  );
}

async function storedConversationWidth(page: Page): Promise<number> {
  return await page.evaluate(
    (key) => Number(localStorage.getItem(key)),
    conversationWidthStorageKey,
  );
}

async function settleResponsiveLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${apiBaseUrl}/__reset`);
});

test('loads an organization-scoped shell with truthful header actions and surface tabs', async ({
  page,
}) => {
  const projectRequests = await openBuilder(page);

  await expect(page.getByText('Compatible')).toBeVisible();
  await expect(page.getByText('Preview', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview' })).toBeVisible();
  await expect(page.getByRole('link', { name: /GitHub Unavailable/u })).toHaveAttribute(
    'href',
    `/projects/${projectId}/settings/integrations`,
  );
  await expect(page.getByRole('button', { name: 'Deploy' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Mission Control' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Project settings' })).toHaveAttribute(
    'href',
    `/projects/${projectId}/settings/general`,
  );
  await expect(page.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
  for (const tab of ['Code', 'Logs', 'Tests']) {
    await expect(page.getByRole('tab', { name: tab })).toBeVisible();
  }

  expect(projectRequests).toHaveLength(1);
  expect(projectRequests[0]?.method()).toBe('GET');
  expect(projectRequests[0]?.headers()['x-organization-id']).toBe('org-alpha');
});

test('resizes panes by pointer and keyboard and restores the project width on reload', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);

  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  await expect(separator).toHaveAttribute('aria-valuenow', '40');
  const bounds = await separator.boundingBox();
  if (bounds === null) throw new Error('The pane separator was not rendered.');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 120, bounds.y + bounds.height / 2);
  await page.mouse.up();

  const pointerWidth = Number(await separator.getAttribute('aria-valuenow'));
  expect(pointerWidth).toBeGreaterThan(40);
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  const keyboardWidth = Number(await separator.getAttribute('aria-valuenow'));
  expect(keyboardWidth).toBe(pointerWidth - 2);

  await page.reload();
  await expect(page.getByRole('separator', { name: 'Resize conversation pane' })).toHaveAttribute(
    'aria-valuenow',
    String(keyboardWidth),
  );
});

test('persists a multi-step pointer resize exactly once when the drag completes', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  await page.evaluate((storageKey) => {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const state = window as typeof window & { conversationWidthWrites?: number };
    state.conversationWidthWrites = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key === storageKey) {
        state.conversationWidthWrites = (state.conversationWidthWrites ?? 0) + 1;
      }
      originalSetItem(key, value);
    };
  }, conversationWidthStorageKey);

  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  const bounds = await separator.boundingBox();
  if (bounds === null) throw new Error('The pane separator was not rendered.');
  const pointerY = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + bounds.width / 2, pointerY);
  await page.mouse.down();
  for (const offset of [30, 60, 90, 120]) {
    await page.mouse.move(bounds.x + offset, pointerY);
  }
  await page.mouse.up();

  expect(Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(40);
  expect(
    await page.evaluate(() => {
      const state = window as typeof window & { conversationWidthWrites?: number };
      return state.conversationWidthWrites;
    }),
  ).toBe(1);
});

test('ignores non-initiating pointers during resize and persists once for the initiator', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  await page.evaluate((storageKey) => {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const state = window as typeof window & { conversationWidthWrites?: number };
    state.conversationWidthWrites = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key === storageKey) {
        state.conversationWidthWrites = (state.conversationWidthWrites ?? 0) + 1;
      }
      originalSetItem(key, value);
    };
  }, conversationWidthStorageKey);

  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  const bounds = await separator.boundingBox();
  if (bounds === null) throw new Error('The pane separator was not rendered.');
  const pointerY = bounds.y + bounds.height / 2;
  const dispatchWindowPointer = async (
    type: 'pointercancel' | 'pointermove' | 'pointerup',
    pointerId: number,
    clientX: number,
  ): Promise<void> => {
    await page.evaluate(
      ({ eventType, id, x, y }) => {
        window.dispatchEvent(
          new PointerEvent(eventType, {
            bubbles: true,
            clientX: x,
            clientY: y,
            pointerId: id,
            pointerType: 'touch',
          }),
        );
      },
      { eventType: type, id: pointerId, x: clientX, y: pointerY },
    );
  };

  await separator.evaluate(
    (element, { id, x, y }) => {
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerId: id,
          pointerType: 'touch',
        }),
      );
    },
    { id: 11, x: bounds.x + bounds.width / 2, y: pointerY },
  );

  await dispatchWindowPointer('pointermove', 22, bounds.x + 200);
  await expect(separator).toHaveAttribute('aria-valuenow', '40');
  await dispatchWindowPointer('pointerup', 22, bounds.x + 200);
  expect(
    await page.evaluate(() => {
      const state = window as typeof window & { conversationWidthWrites?: number };
      return state.conversationWidthWrites;
    }),
  ).toBe(0);

  await dispatchWindowPointer('pointermove', 11, bounds.x + 120);
  expect(Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(40);
  await dispatchWindowPointer('pointerup', 11, bounds.x + 120);
  expect(
    await page.evaluate(() => {
      const state = window as typeof window & { conversationWidthWrites?: number };
      return state.conversationWidthWrites;
    }),
  ).toBe(1);
  expect(await storedConversationWidth(page)).toBeGreaterThan(40);
});

test('keeps resize and Mission Control operational when preference writes fail', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  await page.evaluate(
    ({ missionKey, widthKey }) => {
      const originalSetItem = localStorage.setItem.bind(localStorage);
      Storage.prototype.setItem = function (key, value) {
        if (key === missionKey || key === widthKey) {
          throw new DOMException('Preference storage unavailable.', 'QuotaExceededError');
        }
        originalSetItem(key, value);
      };
    },
    {
      missionKey: `zapp:builder:mission-control:${projectId}`,
      widthKey: conversationWidthStorageKey,
    },
  );

  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '42');
  await expect(page.getByRole('status')).toHaveText('Preferences could not be saved.');
  await expect(page.getByRole('heading', { name: 'Project Apollo' })).toBeVisible();

  await page.getByRole('button', { name: 'Mission Control' }).click();
  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project Apollo' })).toBeVisible();
});

test('keeps the warning until every failed preference key saves successfully', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  await page.evaluate((widthKey) => {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const state = window as typeof window & { failNextConversationWidthWrite?: boolean };
    state.failNextConversationWidthWrite = true;
    Storage.prototype.setItem = function (key, value) {
      if (key === widthKey && state.failNextConversationWidthWrite === true) {
        state.failNextConversationWidthWrite = false;
        throw new DOMException('Preference storage unavailable.', 'QuotaExceededError');
      }
      originalSetItem(key, value);
    };
  }, conversationWidthStorageKey);

  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '42');
  await expect(page.getByRole('status')).toHaveText('Preferences could not be saved.');

  await page.getByRole('button', { name: 'Mission Control' }).click();
  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Preferences could not be saved.');

  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '44');
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(Math.round(await storedConversationWidth(page))).toBe(44);
});

test('normalizes an undersized restored width before announcing or resizing it', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1200 });
  await mockProjectRead(page);
  await signIn(page);
  await setStoredConversationWidth(page, 28);
  await page.goto(`/projects/${projectId}`);

  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  const assertMeasuredMinimum = async (): Promise<number> => {
    const splitWidth = await separator.evaluate((element) => {
      const split = element.parentElement;
      if (split === null) throw new Error('The pane separator has no split container.');
      return split.getBoundingClientRect().width;
    });
    const pixelMinimumPercentage = (380 / splitWidth) * 100;
    const announced = Number(await separator.getAttribute('aria-valuenow'));
    const announcedMinimum = Number(await separator.getAttribute('aria-valuemin'));
    const persisted = await storedConversationWidth(page);
    expect(announced).toBeGreaterThanOrEqual(Math.ceil(pixelMinimumPercentage));
    expect(announcedMinimum).toBeGreaterThanOrEqual(Math.ceil(pixelMinimumPercentage));
    expect(persisted).toBe(28);
    return announced;
  };

  const openedWidth = await assertMeasuredMinimum();
  await page.reload();
  const restoredWidth = await assertMeasuredMinimum();
  expect(restoredWidth).toBe(openedWidth);

  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', String(restoredWidth + 2));
  expect(Math.round(await storedConversationWidth(page))).toBe(restoredWidth + 2);
});

test('preserves a deliberate desktop split across mobile and back', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '42');
  expect(await storedConversationWidth(page)).toBe(42);

  await page.setViewportSize({ height: 900, width: 900 });
  await expect(page.getByRole('navigation', { name: 'Builder pane' })).toBeVisible();
  await expect(separator).toBeHidden();
  await settleResponsiveLayout(page);
  expect(await storedConversationWidth(page)).toBe(42);

  await page.setViewportSize({ height: 900, width: 1440 });
  await expect(separator).toBeVisible();
  await settleResponsiveLayout(page);
  await expect(separator).toHaveAttribute('aria-valuenow', '42');
  expect(await storedConversationWidth(page)).toBe(42);
});

test('temporarily clamps a low preference for inline Mission Control without persisting it', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await mockProjectRead(page);
  await signIn(page);
  await setStoredConversationWidth(page, 28);
  await page.goto(`/projects/${projectId}`);
  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  await expect(separator).toHaveAttribute('aria-valuenow', '28');
  expect(await storedConversationWidth(page)).toBe(28);

  await page.getByRole('button', { name: 'Mission Control' }).click();
  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toBeVisible();
  await expect
    .poll(async () => Number(await separator.getAttribute('aria-valuenow')))
    .toBeGreaterThan(28);
  expect(await storedConversationWidth(page)).toBe(28);

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toHaveCount(0);
  await expect(separator).toHaveAttribute('aria-valuenow', '28');
  expect(await storedConversationWidth(page)).toBe(28);
});

test('announces a fractional 1180px minimum without an invalid ARIA range', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1180 });
  await mockProjectRead(page);
  await signIn(page);
  await setStoredConversationWidth(page, 28);
  await page.goto(`/projects/${projectId}`);
  const separator = page.getByRole('separator', { name: 'Resize conversation pane' });
  const values = await separator.evaluate((element) => {
    const split = element.parentElement;
    const conversation = element.previousElementSibling;
    if (!(split instanceof HTMLElement) || !(conversation instanceof HTMLElement)) {
      throw new Error('The pane split is incomplete.');
    }
    return {
      actualPercentage:
        (conversation.getBoundingClientRect().width / split.getBoundingClientRect().width) * 100,
      maximum: Number(element.getAttribute('aria-valuemax')),
      minimum: Number(element.getAttribute('aria-valuemin')),
      now: Number(element.getAttribute('aria-valuenow')),
      splitWidth: split.getBoundingClientRect().width,
    };
  });

  expect(values.now).toBeGreaterThanOrEqual(values.minimum);
  expect(values.minimum).toBeLessThanOrEqual(values.maximum);
  expect(values.now).toBe(Math.round(values.actualPercentage));
  expect(values.minimum).toBe(Math.round((380 / values.splitWidth) * 100));
});

test('keeps Deploy disabled when the project has no approved release', async ({ page }) => {
  await openBuilder(page);
  await expect(page.getByRole('button', { name: 'Deploy' })).toBeDisabled();
});

test('deploys an approved release without leaving the unified builder', async ({ page }) => {
  const releaseId = 'rel_01J00000000000000000000000';
  const deploymentId = 'dep_01J00000000000000000000000';
  const release = {
    id: releaseId,
    organizationId: 'org-alpha',
    projectId,
    environmentId: 'environment-preview',
    commitSha: 'a'.repeat(40),
    specificationId: null,
    status: 'approved',
    evidenceManifestArtifactId: null,
    createdBy: 'user-ada',
    createdAt: '2026-08-12T12:00:00.000Z',
  };
  const respond = (route: import('@playwright/test').Route, body: unknown) =>
    route.fulfill({
      body: JSON.stringify(body),
      contentType: 'application/json',
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
      },
      status: 200,
    });
  await page.route(new RegExp(`^${apiBaseUrl}/v1/projects/${projectId}/releases`, 'u'), (route) =>
    respond(route, { items: [{ ...release, supportLevel: 'compatible', activeProduction: false, deployments: [] }], nextCursor: null, rollbackTargets: [] }),
  );
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}`, (route) =>
    respond(route, { release, readiness: { state: 'ready', findings: [] } }),
  );
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/deployment-preview?retarget=false`, (route) =>
    respond(route, {
      title: 'First deploy',
      deploymentType: 'first_deploy',
      effects: { productionData: 'Created', secrets: 'Applied', url: 'Created', activeUsers: 'No users affected' },
      requiresExplicitDataDisposition: false,
    }),
  );
  await page.route(`${apiBaseUrl}/v1/releases/${releaseId}/deploy`, (route) =>
    respond(route, { deploymentId }),
  );
  await page.route(`${apiBaseUrl}/v1/deployments/${deploymentId}`, (route) =>
    respond(route, {
      deploymentId,
      releaseId,
      projectId,
      environmentId: 'environment-preview',
      status: 'healthy',
      url: 'https://app.example.test',
      events: [],
      terminalSuccess: {
        status: 'succeeded',
        permanentUrl: 'https://app.example.test',
        release: { id: releaseId, commitSha: release.commitSha },
        evidence: { statusLink: `/v1/releases/${releaseId}/evidence` },
        productionHealth: { status: 'healthy' },
        monitoring: { grafanaDashboardLinks: [], faroAppLink: 'https://grafana.example.test/faro', posthogAnnotationLink: 'https://posthog.example.test/release' },
        customDomainAction: { method: 'POST', href: `/v1/projects/${projectId}/domains` },
        previousHealthyRelease: null,
        previewChanges: { requireRedeploy: true, note: 'Preview changes require a new release and redeploy before they reach production.' },
      },
    }),
  );

  await openBuilder(page);
  const builderUrl = page.url();
  await page.getByRole('button', { name: 'Deploy' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to deploy' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'First deploy' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm deployment' }).click();
  await expect(page.getByRole('heading', { name: 'Deployment succeeded' })).toBeVisible();
  expect(page.url()).toBe(builderUrl);
});

test('opens and persists Mission Control without changing the URL', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1180 });
  await openBuilder(page);
  const before = page.url();

  await page.getByRole('button', { name: 'Mission Control' }).click();
  await expect(page.getByRole('dialog', { name: 'Mission Control' })).toBeVisible();
  await expect(page.getByText('No run in progress')).toBeVisible();
  expect(page.url()).toBe(before);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Mission Control' })).toHaveCount(0);
  expect(page.url()).toBe(before);

  await page.getByRole('button', { name: 'Mission Control' }).click();
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Mission Control' })).toBeVisible();
  expect(page.url()).toBe(before);
});

test('renders inline Mission Control as a pushing desktop region', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  const workspace = page.getByTestId('builder-workspace');
  const beforeColumns = await workspace.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns,
  );

  await page.getByRole('button', { name: 'Mission Control' }).click();

  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toBeVisible();
  const afterColumns = await workspace.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns,
  );
  expect(afterColumns.split(' ')).toHaveLength(2);
  expect(afterColumns).not.toBe(beforeColumns);
});

test('restores focus to the inline Mission Control toggle after Close', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openBuilder(page);
  const missionControlToggle = page.getByRole('button', { name: 'Mission Control' });
  await missionControlToggle.click();
  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toBeVisible();

  await page.getByRole('button', { name: 'Close' }).click();

  await expect(page.getByRole('complementary', { name: 'Mission Control' })).toHaveCount(0);
  await expect(missionControlToggle).toBeFocused();
});

test('Preview action selects and focuses the Preview surface', async ({ page }) => {
  await openBuilder(page);
  await page.getByRole('tab', { name: 'Code' }).click();
  await expect(page.getByRole('tab', { name: 'Code' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Preview' }).click();

  const previewTab = page.getByRole('tab', { name: 'Preview' });
  await expect(previewTab).toHaveAttribute('aria-selected', 'true');
  await expect(previewTab).toBeFocused();
});

test('defaults to Conversation and switches to Surface below 1024px', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 900 });
  await openBuilder(page);

  await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Surface' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Conversation' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Surface' }).click();
  await expect(page.getByRole('region', { name: 'Conversation' })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Surface' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Surface' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('shows truthful unavailable sync state when the repository record is absent', async ({
  page,
}) => {
  await mockProjectRead(page, { ...projectRead, repository: null });
  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect(page.getByRole('link', { name: /GitHub Unavailable/u })).toBeVisible();
});

test('warns about an invalid organization override while using the safe membership', async ({
  page,
}) => {
  const projectRequests = await mockProjectRead(page);
  await signIn(page);
  const builderUrl = `/projects/${projectId}?organizationId=org-outside-memberships`;

  await page.goto(builderUrl);

  await expect(page.getByRole('heading', { name: 'Project Apollo' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    'Invalid organization selection. Showing your active organization.',
  );
  await expect(page).toHaveURL(builderUrl);
  expect(projectRequests).toHaveLength(1);
  expect(projectRequests[0]?.headers()['x-organization-id']).toBe('org-alpha');
});

test('offers all standard recovery actions when the project cannot load', async ({ page }) => {
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        error: { code: 'fixture_failure', message: 'fixture failure', requestId: 'request-web-5' },
      }),
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
        'content-type': 'application/json',
      },
      status: 500,
    });
  });
  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect(
    page.getByRole('alert').filter({ hasText: 'We could not load this project' }),
  ).toBeVisible();
  for (const action of ['Fix automatically', 'Inspect details', 'Retry', 'Ask the agent']) {
    await expect(page.getByRole('button', { name: action })).toBeVisible();
  }
});

test('redirects to login when the organization-scoped project read returns 401', async ({
  page,
}) => {
  await page.route(`${apiBaseUrl}/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        error: { code: 'unauthorized', message: 'unauthorized', requestId: 'request-web-5' },
      }),
      headers: {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': appBaseUrl,
        'content-type': 'application/json',
      },
      status: 401,
    });
  });
  await signIn(page);

  await page.goto(`/projects/${projectId}`);

  await expect(page).toHaveURL('/login');
});
