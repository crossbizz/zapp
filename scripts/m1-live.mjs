import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_CREDENTIALS = [
  'STYTCH_PROJECT_ID',
  'STYTCH_SECRET',
  'STYTCH_PUBLIC_TOKEN',
  'ANTHROPIC_API_KEY',
  'MODAL_TOKEN_ID',
  'MODAL_TOKEN_SECRET',
];
const TERMINAL_RUN_STATUSES = new Set(['cancelled', 'completed', 'failed']);
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1_000;

class M1LiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'M1LiveError';
  }
}

function parseEnvFile(contents) {
  const parsed = {};
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    parsed[name] = value;
  }
  return parsed;
}

function environment(cwd, supplied) {
  if (supplied !== undefined) return { ...supplied };
  let file = {};
  try {
    file = parseEnvFile(readFileSync(resolve(cwd, '.env'), 'utf8'));
  } catch {
    throw new M1LiveError('Root .env is missing; run pnpm local first.');
  }
  return { ...file, ...process.env };
}

function missingCredential(value) {
  return typeof value !== 'string' || value.trim() === '' || /replace-me/iu.test(value);
}

function validateInvocation(argv, env) {
  if (argv.length > 0) {
    throw new M1LiveError(`The M1 live gate does not accept flags: ${argv.join(', ')}`);
  }
  const missing = REQUIRED_CREDENTIALS.filter((name) => missingCredential(env[name])).sort();
  if (missing.length > 0) {
    throw new M1LiveError(`M1 live provider configuration is missing: ${missing.join(', ')}`);
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new M1LiveError(`M1 evidence is missing ${label}.`);
  }
}

function validateRunEvidence(run, index) {
  if (typeof run !== 'object' || run === null || Array.isArray(run)) {
    throw new M1LiveError(`M1 evidence run ${String(index + 1)} is invalid.`);
  }
  for (const key of [
    'runId',
    'workspaceId',
    'providerWorkspaceId',
    'sandboxProvider',
    'modelProvider',
    'commitSha',
    'marker',
    'screenshotPath',
  ]) {
    requiredString(run[key], `runs[${String(index)}].${key}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(run.commitSha)) {
    throw new M1LiveError(`M1 evidence run ${String(index + 1)} has an invalid commit SHA.`);
  }
  if (!Array.isArray(run.eventSequences) || run.eventSequences.length === 0) {
    throw new M1LiveError(`M1 evidence run ${String(index + 1)} has no event sequence.`);
  }
  if (
    !Array.isArray(run.visibleMarkers) ||
    run.visibleMarkers.length === 0 ||
    run.visibleMarkers.some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    throw new M1LiveError(`M1 evidence run ${String(index + 1)} has no visible markers.`);
  }
  let previous = -1;
  for (const sequence of run.eventSequences) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence <= previous) {
      throw new M1LiveError(
        `M1 evidence run ${String(index + 1)} event sequences are not strictly ordered.`,
      );
    }
    previous = sequence;
  }
}

function assertRedacted(value, redactions, path = 'evidence') {
  if (typeof value === 'string') {
    for (const secret of redactions) {
      if (secret !== '' && value.includes(secret)) {
        throw new M1LiveError(`M1 evidence contains a credential at ${path}.`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertRedacted(item, redactions, `${path}[${String(index)}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|credential|modal.*url/iu.test(key)) {
      throw new M1LiveError(`M1 evidence contains a forbidden field at ${path}.${key}.`);
    }
    assertRedacted(item, redactions, `${path}.${key}`);
  }
}

export function validateM1Evidence(evidence, redactions) {
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    throw new M1LiveError('M1 evidence is invalid.');
  }
  if (evidence.version !== 1) throw new M1LiveError('M1 evidence has an invalid version.');
  for (const key of ['createdAt', 'userId', 'organizationId', 'projectId']) {
    requiredString(evidence[key], key);
  }
  if (Number.isNaN(Date.parse(evidence.createdAt))) {
    throw new M1LiveError('M1 evidence has an invalid createdAt timestamp.');
  }
  if (!Array.isArray(evidence.runs) || evidence.runs.length !== 3) {
    throw new M1LiveError('M1 evidence must contain initial, edit, and restore runs.');
  }
  evidence.runs.forEach(validateRunEvidence);
  if (evidence.runs[0].commitSha === evidence.runs[1].commitSha) {
    throw new M1LiveError('M1 evidence requires two distinct commits.');
  }
  if (new Set(evidence.runs.map((run) => run.runId)).size !== evidence.runs.length) {
    throw new M1LiveError('M1 evidence requires distinct run IDs.');
  }
  requiredString(evidence.terminatedWorkspaceId, 'terminatedWorkspaceId');
  if (evidence.terminatedWorkspaceId !== evidence.runs[1].workspaceId) {
    throw new M1LiveError('M1 evidence did not terminate the active edit workspace.');
  }
  if (
    evidence.terminatedWorkspaceId === evidence.runs[2].workspaceId ||
    evidence.runs[1].providerWorkspaceId === evidence.runs[2].providerWorkspaceId
  ) {
    throw new M1LiveError('M1 evidence did not restore into a replacement workspace.');
  }
  const markers = evidence.runs.map((run) => run.marker);
  for (const [index, run] of evidence.runs.entries()) {
    const expected = markers.slice(0, index + 1);
    if (
      run.visibleMarkers.length !== expected.length ||
      run.visibleMarkers.some((value, markerIndex) => value !== expected[markerIndex])
    ) {
      throw new M1LiveError('M1 evidence does not prove visible source continuity.');
    }
  }
  assertRedacted(evidence, redactions);
  return evidence;
}

function marker(phase) {
  return `zapp-m1-${phase}-${randomUUID()}`;
}

function promptFor(phase, visibleMarker) {
  if (phase === 'initial') {
    return `Build a polished single-page web app and show the exact visible text "${visibleMarker}" in a prominent heading. Keep it visible in the rendered preview.`;
  }
  if (phase === 'edit') {
    return `Preserve the existing page and add the exact visible text "${visibleMarker}" in a new prominent section. Keep both markers visible in the rendered preview.`;
  }
  return `Restore the existing project from durable source, preserve its current content, and add the exact visible text "${visibleMarker}" in the rendered preview.`;
}

function artifactTimestamp(date) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

async function defaultWriteEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function atStage(name, operation) {
  try {
    return await operation();
  } catch {
    throw new M1LiveError(`M1 live gate failed at ${name}.`);
  }
}

export async function runM1Live(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const argv = options.argv ?? process.argv.slice(2);
  const env = environment(cwd, options.env);
  validateInvocation(argv, env);
  const redactions = REQUIRED_CREDENTIALS.map((name) => env[name]).filter(
    (value) => typeof value === 'string' && value !== '',
  );
  const output = options.output ?? ((line) => process.stdout.write(`${line}\n`));
  const createdAt = (options.now ?? (() => new Date()))();
  const timestamp = artifactTimestamp(createdAt);
  const artifactRoot = resolve(options.artifactRoot ?? join(cwd, '.artifacts/m1-live'));
  const markerFactory = options.markerFactory ?? marker;
  const writeEvidence = options.writeEvidence ?? defaultWriteEvidence;
  const createSession = options.createSession ?? createPlaywrightSession;
  const initialMarker = markerFactory('initial');
  const editMarker = markerFactory('edit');
  const restoreMarker = markerFactory('restore');
  let session;
  let stage = 'browser startup';

  try {
    session = await atStage(stage, () =>
      createSession({ cwd, env, output, artifactRoot, timestamp }),
    );
    stage = 'login page';
    await atStage(stage, () => session.openLogin());
    output(
      '[m1-live] Sign in in the opened browser if prompted; waiting for an authenticated session.',
    );
    stage = 'authenticated session';
    const authenticated = await atStage(stage, () => session.waitForAuthenticated());

    stage = 'initial prompt';
    const project = await atStage(stage, () =>
      session.createFromPrompt({
        marker: initialMarker,
        prompt: promptFor('initial', initialMarker),
        organizationId: authenticated.organizationId,
      }),
    );
    stage = 'initial preview';
    const initial = await atStage(stage, () =>
      session.waitForRun({
        phase: 'initial',
        marker: initialMarker,
        requiredMarkers: [initialMarker],
        projectId: project.projectId,
        organizationId: authenticated.organizationId,
        excludedRunIds: [],
      }),
    );

    stage = 'follow-up edit';
    await atStage(stage, () =>
      session.sendFollowup({ marker: editMarker, prompt: promptFor('edit', editMarker) }),
    );
    stage = 'edited preview';
    const edited = await atStage(stage, () =>
      session.waitForRun({
        phase: 'edit',
        marker: editMarker,
        requiredMarkers: [initialMarker, editMarker],
        projectId: project.projectId,
        organizationId: authenticated.organizationId,
        excludedRunIds: [initial.runId],
      }),
    );

    stage = 'workspace termination';
    const terminated = await atStage(stage, () =>
      session.terminateWorkspace(edited.workspaceId, authenticated.organizationId),
    );
    if (terminated.status !== 'terminated') {
      throw new M1LiveError('M1 live gate failed at workspace termination.');
    }

    stage = 'restore prompt';
    await atStage(stage, () =>
      session.sendFollowup({ marker: restoreMarker, prompt: promptFor('restore', restoreMarker) }),
    );
    stage = 'restored preview';
    const restored = await atStage(stage, () =>
      session.waitForRun({
        phase: 'restore',
        marker: restoreMarker,
        requiredMarkers: [initialMarker, editMarker, restoreMarker],
        projectId: project.projectId,
        organizationId: authenticated.organizationId,
        excludedRunIds: [initial.runId, edited.runId],
      }),
    );

    const evidence = validateM1Evidence(
      {
        version: 1,
        createdAt: createdAt.toISOString(),
        userId: authenticated.userId,
        organizationId: authenticated.organizationId,
        projectId: project.projectId,
        runs: [initial, edited, restored],
        terminatedWorkspaceId: edited.workspaceId,
      },
      redactions,
    );
    const evidencePath = join(artifactRoot, `${timestamp}.json`);
    stage = 'evidence write';
    await atStage(stage, () => writeEvidence(evidencePath, evidence));
    output(`[m1-live] passed; evidence: ${evidencePath}`);
    return evidence;
  } catch (error) {
    if (error instanceof M1LiveError) throw error;
    throw new M1LiveError(`M1 live gate failed at ${stage}.`);
  } finally {
    if (session !== undefined) {
      try {
        await session.close();
      } catch {
        // The primary stage result remains authoritative if browser cleanup fails.
      }
    }
  }
}

async function createPlaywrightSession({ cwd, env, output, artifactRoot, timestamp }) {
  const requireFromWeb = createRequire(resolve(cwd, 'apps/web/package.json'));
  const { chromium } = requireFromWeb('@playwright/test');
  const { createZappClient } = await import('../packages/api-client/dist/index.js');
  const userDataDir = resolve(artifactRoot, 'browser-profile');
  await mkdir(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1440, height: 1000 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const webBaseUrl = env.M1_WEB_URL ?? 'http://127.0.0.1:3000';
  const apiBaseUrl = env.M1_API_URL ?? 'http://127.0.0.1:4000';
  const timeoutMs = Number(env.M1_LIVE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 60 * 60 * 1_000) {
    await context.close();
    throw new M1LiveError('M1_LIVE_TIMEOUT_MS must be between 30000 and 3600000.');
  }

  const browserFetch = async (input, init) => {
    const request = {
      url: input.toString(),
      method: init.method,
      headers: [...new Headers(init.headers).entries()],
      body: typeof init.body === 'string' ? init.body : undefined,
      credentials: init.credentials,
      redirect: init.redirect,
    };
    const response = await page.evaluate(async (value) => {
      const result = await fetch(value.url, {
        method: value.method,
        headers: value.headers,
        ...(value.body === undefined ? {} : { body: value.body }),
        credentials: value.credentials,
        redirect: value.redirect,
      });
      return {
        ok: result.ok,
        status: result.status,
        headers: [...result.headers.entries()],
        body: await result.text(),
      };
    }, request);
    return {
      ok: response.ok,
      status: response.status,
      headers: new Headers(response.headers),
      body: response.status === 204 ? null : new Response(response.body).body,
      text: async () => response.body,
    };
  };

  const client = () =>
    createZappClient({ baseUrl: apiBaseUrl, getToken: () => '', fetch: browserFetch });
  const organizationHeaders = (organizationId) => ({ 'x-organization-id': organizationId });
  const poll = async (name, operation) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = await operation();
        if (value !== undefined) return value;
      } catch (error) {
        if (error instanceof M1LiveError) throw error;
      }
      await page.waitForTimeout(500);
    }
    throw new M1LiveError(`${name} timed out.`);
  };

  const readEvents = async (runId) => {
    const events = await page.evaluate((id) => {
      const raw = localStorage.getItem(`zapp:run-events:${id}`);
      if (raw === null) return [];
      try {
        const value = JSON.parse(raw);
        return Array.isArray(value) ? value : [];
      } catch {
        return [];
      }
    }, runId);
    return events
      .filter((event) => Number.isSafeInteger(event?.data?.sequence))
      .sort((left, right) => left.data.sequence - right.data.sequence);
  };

  return {
    async openLogin() {
      await page.goto(`${webBaseUrl}/login`, { waitUntil: 'domcontentloaded' });
    },
    async waitForAuthenticated() {
      return await poll('authenticated session', async () => {
        try {
          const me = await client().request('/v1/me', { method: 'GET' });
          const membership = me.memberships.find((item) => item.status === 'active');
          if (membership === undefined) return undefined;
          output(`[m1-live] authenticated as ${me.user.id}`);
          return { userId: me.user.id, organizationId: membership.organization.id };
        } catch {
          return undefined;
        }
      });
    },
    async createFromPrompt({ prompt, organizationId }) {
      await page.goto(`${webBaseUrl}/?organizationId=${encodeURIComponent(organizationId)}`, {
        waitUntil: 'domcontentloaded',
      });
      const composer = page.locator('#home-prompt');
      await composer.waitFor({ state: 'visible' });
      await composer.fill(prompt);
      await page.getByRole('button', { name: 'Create project' }).click();
      await page.waitForURL(/\/projects\/proj_[0-9A-HJKMNP-TV-Z]{26}$/u, { timeout: timeoutMs });
      const projectId = new URL(page.url()).pathname.split('/').filter(Boolean).at(-1);
      requiredString(projectId, 'projectId');
      return { projectId };
    },
    async sendFollowup({ prompt }) {
      const composer = page.locator('#conversation-message');
      await composer.waitFor({ state: 'visible' });
      await composer.fill(prompt);
      await page.getByRole('button', { name: 'Send message' }).click();
    },
    async waitForRun({
      phase,
      marker: visibleMarker,
      requiredMarkers,
      projectId,
      organizationId,
      excludedRunIds,
    }) {
      const headers = organizationHeaders(organizationId);
      const run = await poll(`${phase} run`, async () => {
        const response = await client().request('/v1/projects/{projectId}/runs', {
          method: 'GET',
          path: { projectId },
          headers,
        });
        return response.items.find((item) => !excludedRunIds.includes(item.id));
      });
      const projection = await poll(`${phase} commit and preview`, async () => {
        const value = await client().request('/v1/runs/{runId}/mission-control', {
          method: 'GET',
          path: { runId: run.id },
          headers,
        });
        if (!TERMINAL_RUN_STATUSES.has(value.run.status)) return undefined;
        if (value.run.status !== 'completed')
          throw new M1LiveError(`${phase} run did not complete.`);
        if (value.previewStatus?.status !== 'ready' || value.commits.length === 0) return undefined;
        return value;
      });
      const events = await poll(`${phase} ordered events`, async () => {
        const value = await readEvents(run.id);
        const workspaceEvent = value.findLast(
          (event) =>
            event.type === 'preview.ready' && typeof event.data?.payload?.workspaceId === 'string',
        );
        return workspaceEvent === undefined ? undefined : { value, workspaceEvent };
      });
      const workspaceId = events.workspaceEvent.data.payload.workspaceId;
      const workspaceResponse = await client().request('/v1/workspaces/{workspaceId}', {
        method: 'GET',
        path: { workspaceId },
        headers,
      });
      await page.locator('iframe[title="Application preview"]').waitFor({
        state: 'visible',
        timeout: timeoutMs,
      });
      for (const requiredMarker of requiredMarkers) {
        await page
          .frameLocator('iframe[title="Application preview"]')
          .getByText(requiredMarker, { exact: false })
          .first()
          .waitFor({ state: 'visible', timeout: timeoutMs });
      }
      const screenshotPath = join(artifactRoot, `${timestamp}-${phase}.png`);
      await page
        .locator('iframe[title="Application preview"]')
        .screenshot({ path: screenshotPath });
      const commit = projection.commits[0];
      return {
        runId: run.id,
        workspaceId,
        providerWorkspaceId: workspaceResponse.workspace.providerWorkspaceId,
        sandboxProvider: workspaceResponse.workspace.provider,
        modelProvider: 'anthropic',
        ...(projection.run.model === null ? {} : { modelIdentifier: projection.run.model }),
        commitSha: commit.sha,
        marker: visibleMarker,
        visibleMarkers: [...requiredMarkers],
        eventSequences: events.value.map((event) => event.data.sequence),
        screenshotPath,
      };
    },
    async terminateWorkspace(workspaceId, organizationId) {
      const cookies = await context.cookies(apiBaseUrl);
      const csrf = cookies.find((cookie) => cookie.name === 'zapp_csrf')?.value;
      requiredString(csrf, 'CSRF session cookie');
      const response = await client().request('/v1/workspaces/{workspaceId}/terminate', {
        method: 'POST',
        path: { workspaceId },
        headers: {
          ...organizationHeaders(organizationId),
          'x-zapp-csrf': decodeURIComponent(csrf),
          'idempotency-key': randomUUID(),
        },
      });
      return response.workspace;
    },
    async close() {
      await context.close();
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runM1Live();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'M1 live gate failed.';
    process.stderr.write(`[m1-live] ${message}\n`);
    process.exitCode = 1;
  }
}
