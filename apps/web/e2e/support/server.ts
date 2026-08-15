import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { createFeatureFlagEvaluator } from '../../../../packages/config/src/index.js';

import { buildApp } from '../../../../services/control-api/src/app.js';
import { createInMemoryTokenDenylist } from '../../../../services/control-api/src/auth/denylist.js';
import { createInMemoryDeviceStore } from '../../../../services/control-api/src/auth/device.js';
import type { AuthIdentity } from '../../../../services/control-api/src/auth/port.js';
import type {
  UserProfile,
  UserUpsertResult,
} from '../../../../services/control-api/src/auth/users.js';
import { createInMemoryIdempotencyStore } from '../../../../services/control-api/src/plugins/idempotency.js';
import { createInMemoryRateLimiter } from '../../../../services/control-api/src/plugins/rate-limit.js';
import { createInMemoryAuditSink } from '../../../../services/control-api/src/plugins/audit.js';
import { createInMemoryInviteStore } from '../../../../services/control-api/src/orgs/invites.js';
import {
  InMemoryUserStore,
  TEST_AUTH_CONFIG,
  TEST_CAPABILITY_SCAN,
  TEST_PRICING,
  TEST_PROXY_TRUST,
  TEST_RATE_LIMITS,
  TEST_RUN_INTENT_HMAC_KEY,
} from '../../../../services/control-api/test/support/harness.js';
import { FakeAuthPort } from '../../../../services/control-api/test/support/fake-auth-port.js';
import { InMemoryOrganizationStore } from '../../../../services/control-api/test/support/org-store.js';

import { createE1Composition, E1_ORGANIZATION_ID, E1_ORGANIZATION_NAME } from './e1-composition.js';
import {
  nextDevWatchEnvironment,
  preserveNextGeneratedFiles,
  resetNextDevOutput,
} from './next-dev-output.js';

const appPort = Number(process.env['ZAPP_WEB_E2E_APP_PORT'] ?? 3100);
const apiPort = Number(process.env['ZAPP_WEB_E2E_API_PORT'] ?? 4100);
const appBaseUrl = `http://127.0.0.1:${String(appPort)}`;
const apiBaseUrl = `http://127.0.0.1:${String(apiPort)}`;
const nextOutputName = `.next-e2e-${String(appPort)}`;
const nextOutputDirectory = resolve(process.cwd(), nextOutputName);
const betaOrganizationId = 'org_01K27Q9C2W85CMN1V9S6Q3D4FE';
const invitedOrganizationId = 'org_01K27Q9C2W85CMN1V9S6Q3D4FF';

const memberships: UserProfile['memberships'] = [
  {
    allowedModels: ['anthropic/claude-sonnet-5', 'openai:gpt_5.1-mini'],
    organization: { id: E1_ORGANIZATION_ID, name: 'Alpha Org', slug: 'alpha' },
    role: 'owner',
    status: 'active',
  },
  {
    allowedModels: [],
    organization: { id: betaOrganizationId, name: 'Beta Org', slug: 'beta' },
    role: 'builder',
    status: 'active',
  },
  {
    allowedModels: [],
    organization: { id: invitedOrganizationId, name: 'Invited Org', slug: 'invited' },
    role: 'viewer',
    status: 'invited',
  },
];

class FixtureUserStore extends InMemoryUserStore {
  override upsertFromIdentity(identity: AuthIdentity): Promise<UserUpsertResult> {
    this.upsertCount += 1;
    const user = {
      id: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
      email: identity.email,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl ?? null,
    };
    this.users.set(user.id, user);
    this.memberships.set(user.id, memberships);
    return Promise.resolve({ user, created: this.upsertCount === 1 });
  }
}

class LocalFakeAuthPort extends FakeAuthPort {
  override getAuthorizationUrl(input: { redirectUri: string; state: string }): string {
    super.getAuthorizationUrl(input);
    const provider = new URL('/__stytch', apiBaseUrl);
    provider.searchParams.set('redirect_uri', input.redirectUri);
    provider.searchParams.set('state', input.state);
    return provider.toString();
  }
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: {
    readonly hasState: boolean;
    readonly hasProviderToken: boolean;
    readonly providerTokenType?: string;
  };
  readonly hasOauthNonce: boolean;
  readonly hasSession: boolean;
  readonly hasUnrelatedCookie: boolean;
  readonly hasCsrf: boolean;
  readonly organizationId: string | null;
  readonly body?: unknown;
}

const users = new FixtureUserStore();
const port = new LocalFakeAuthPort();
let clockOffset = 0;
const now = (): Date => new Date(Date.now() + clockOffset);
const e1 = await createE1Composition({ appBaseUrl: new URL('https://app.e1.test') });
const organizations = new InMemoryOrganizationStore();
organizations.organizations.set(E1_ORGANIZATION_ID, {
  id: E1_ORGANIZATION_ID,
  name: E1_ORGANIZATION_NAME,
  slug: 'alpha',
  plan: 'trial',
});
organizations.memberships.set(`${E1_ORGANIZATION_ID}\u0000user_01K27Q9C2W85CMN1V9S6Q3D4FG`, {
  organizationId: E1_ORGANIZATION_ID,
  userId: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
  role: 'owner',
  status: 'active',
});
organizations.organizations.set(betaOrganizationId, {
  id: betaOrganizationId,
  name: 'Beta Org',
  slug: 'beta',
  plan: 'trial',
});
organizations.memberships.set(`${betaOrganizationId}\u0000user_01K27Q9C2W85CMN1V9S6Q3D4FG`, {
  organizationId: betaOrganizationId,
  userId: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
  role: 'builder',
  status: 'active',
});
organizations.organizations.set(invitedOrganizationId, {
  id: invitedOrganizationId,
  name: 'Invited Org',
  slug: 'invited',
  plan: 'trial',
});
organizations.memberships.set(`${invitedOrganizationId}\u0000user_01K27Q9C2W85CMN1V9S6Q3D4FG`, {
  organizationId: invitedOrganizationId,
  userId: 'user_01K27Q9C2W85CMN1V9S6Q3D4FG',
  role: 'viewer',
  status: 'invited',
});
let clientFeatureFlags = {
  'voice-input': false,
  'mobile-app-tab': false,
  'visual-editing': false,
};
let featureFlagClock = 0;
const built = {
  port,
  app: buildApp({
    logger: false,
    now,
    auth: {
      port,
      users,
      config: { ...TEST_AUTH_CONFIG, appBaseUrl, apiBaseUrl },
      denylist: createInMemoryTokenDenylist(now),
      deviceStore: createInMemoryDeviceStore(now),
      now,
    },
    limits: {
      config: TEST_RATE_LIMITS,
      proxy: TEST_PROXY_TRUST,
      limiter: createInMemoryRateLimiter(now),
      idempotency: createInMemoryIdempotencyStore(now),
    },
    orgs: {
      organizations,
      audit: createInMemoryAuditSink(),
      invites: createInMemoryInviteStore(now),
    },
    tenant: {
      tenantDb: e1.data.factory,
      runIntentHmacKey: TEST_RUN_INTENT_HMAC_KEY,
      capabilityScan: TEST_CAPABILITY_SCAN,
      orchestrator: e1.orchestrator,
      pricing: TEST_PRICING,
      builderPreviewSandbox: e1.builderPreviewSandbox,
      builderPreviewProxy: e1.builderPreviewProxy,
      releasePort: e1.releasePort,
      eventStream: {
        onError(error) {
          e1.recordEventError(error);
        },
        wakeups: {
          subscribe(_channel, signal) {
            return Promise.resolve({
              next: () =>
                new Promise((resolve) => {
                  signal.addEventListener(
                    'abort',
                    () => {
                      resolve({ sequence: 1 });
                    },
                    { once: true },
                  );
                }),
              close: () => Promise.resolve(),
              abort: () => undefined,
            });
          },
        },
      },
    },
    preview: e1.preview,
    featureFlags: createFeatureFlagEvaluator({
      now: () => {
        featureFlagClock += 60_001;
        return featureFlagClock;
      },
      provider: {
        evaluate({ flag }) {
          return Promise.resolve(clientFeatureFlags[flag as keyof typeof clientFeatureFlags]);
        },
      },
    }),
  }),
};
const requests: RecordedRequest[] = [];
let providerSequence = 0;
let meRequestCount = 0;
let failMeRequest: number | undefined;
let failMeStatus = 500;
let dropMeRequest: number | undefined;

function hasCookie(header: string | undefined, name: string): boolean {
  return header?.split(';').some((pair) => pair.trim().startsWith(`${name}=`)) ?? false;
}

built.app.addHook('onRequest', async (request, reply) => {
  const allowedOrigin =
    request.headers.origin === e1.preview.appBaseUrl.origin
      ? e1.preview.appBaseUrl.origin
      : appBaseUrl;
  reply.header('access-control-allow-origin', allowedOrigin);
  reply.header('access-control-allow-credentials', 'true');
  reply.header(
    'access-control-allow-headers',
    'content-type, idempotency-key, x-zapp-csrf, x-organization-id',
  );
  reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (request.headers['access-control-request-private-network'] === 'true') {
    reply.header('access-control-allow-private-network', 'true');
  }

  if (request.method === 'OPTIONS') {
    await reply.status(204).send();
    return reply;
  }

  const path = new URL(request.raw.url ?? '/', apiBaseUrl).pathname;
  if (path === '/v1/me') {
    meRequestCount += 1;
    if (meRequestCount === dropMeRequest) {
      reply.hijack();
      request.raw.socket.destroy();
      return reply;
    }
    if (meRequestCount === failMeRequest) {
      await reply.status(failMeStatus).send({ error: { code: 'fixture_failure' } });
      return reply;
    }
  }
  return undefined;
});

built.app.addHook('preHandler', (request) => {
  const url = new URL(request.raw.url ?? '/', apiBaseUrl);
  if (!url.pathname.startsWith('/v1/')) return Promise.resolve();
  const providerTokenType = url.searchParams.get('stytch_token_type') ?? undefined;
  requests.push({
    method: request.method,
    path: url.pathname,
    query: {
      hasState: url.searchParams.has('state'),
      hasProviderToken: url.searchParams.has('token') || url.searchParams.has('code'),
      ...(providerTokenType === undefined ? {} : { providerTokenType }),
    },
    hasOauthNonce: hasCookie(request.headers.cookie, 'zapp_oauth_state'),
    hasSession: hasCookie(request.headers.cookie, 'zapp_session'),
    hasUnrelatedCookie: hasCookie(request.headers.cookie, 'unrelated_app_cookie'),
    hasCsrf: typeof request.headers['x-zapp-csrf'] === 'string',
    organizationId:
      typeof request.headers['x-organization-id'] === 'string'
        ? request.headers['x-organization-id']
        : null,
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  return Promise.resolve();
});

built.app.addHook('onError', (request, _reply, error) => {
  const path = new URL(request.raw.url ?? '/', apiBaseUrl).pathname;
  if (path.includes('/preview')) e1.recordEventError(error);
  return Promise.resolve();
});

built.app.get('/__requests', () => ({ requests }));
built.app.get('/__feature-flags', (request) => {
  const url = new URL(request.raw.url ?? '/', apiBaseUrl);
  clientFeatureFlags = {
    ...clientFeatureFlags,
    'mobile-app-tab': url.searchParams.get('mobileApp') === 'true',
  };
  return { flags: clientFeatureFlags };
});
built.app.get('/__reset', () => {
  requests.length = 0;
  e1.reset();
  clockOffset = 0;
  meRequestCount = 0;
  failMeRequest = undefined;
  failMeStatus = 500;
  dropMeRequest = undefined;
  clientFeatureFlags = {
    'voice-input': false,
    'mobile-app-tab': false,
    'visual-editing': false,
  };
  return { ok: true };
});
built.app.get('/__e1', () => ({ ...e1.status(), requests }));
built.app.get('/__advance-time', (request) => {
  const url = new URL(request.raw.url ?? '/', apiBaseUrl);
  const milliseconds = Number(url.searchParams.get('milliseconds'));
  if (Number.isFinite(milliseconds) && milliseconds > 0) clockOffset += milliseconds;
  return { ok: true };
});
built.app.get('/__fail-me', (request) => {
  const url = new URL(request.raw.url ?? '/', apiBaseUrl);
  const requestNumber = Number(url.searchParams.get('request'));
  const status = Number(url.searchParams.get('status'));
  failMeRequest = Number.isInteger(requestNumber) && requestNumber > 0 ? requestNumber : 1;
  failMeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  meRequestCount = 0;
  return { ok: true };
});
built.app.get('/__drop-me', (request) => {
  const url = new URL(request.raw.url ?? '/', apiBaseUrl);
  const requestNumber = Number(url.searchParams.get('request'));
  dropMeRequest = Number.isInteger(requestNumber) && requestNumber > 0 ? requestNumber : 1;
  meRequestCount = 0;
  return { ok: true };
});
built.app.get('/__stytch', async (request, reply) => {
  const url = new URL(request.raw.url ?? '/', apiBaseUrl);
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state');
  if (redirectUri !== `${apiBaseUrl}/v1/auth/callback` || state === null || state.length === 0) {
    return await reply.status(400).send({ error: { code: 'invalid_provider_request' } });
  }

  providerSequence += 1;
  const code = built.port.issueCode(`web-e2e-${String(providerSequence)}`, {
    externalId: 'stytch-ada',
    email: 'ada@example.test',
    displayName: 'Ada Lovelace',
  });
  const callback = new URL(redirectUri);
  callback.searchParams.set('token', code);
  callback.searchParams.set('stytch_token_type', 'discovery_oauth');
  callback.searchParams.set('state', state);
  return await reply.redirect(callback.toString(), 302);
});

const restoreNextGeneratedFiles = await preserveNextGeneratedFiles([
  resolve(process.cwd(), 'next-env.d.ts'),
  resolve(process.cwd(), 'tsconfig.json'),
]);
await resetNextDevOutput(nextOutputDirectory);
await built.app.listen({ host: '127.0.0.1', port: apiPort });

const next = spawn('./node_modules/.bin/next', ['dev', '--port', String(appPort)], {
  env: {
    ...process.env,
    ...nextDevWatchEnvironment(),
    NEXT_PUBLIC_APP_BASE_URL: appBaseUrl,
    NEXT_PUBLIC_CONTROL_API_URL: apiBaseUrl,
    ZAPP_WEB_NEXT_DIST_DIR: nextOutputName,
  },
  stdio: 'inherit',
});

let stopping = false;
let nextExited = false;
let resolveNextExit: (() => void) | undefined;
const nextExit = new Promise<void>((resolveExit) => {
  resolveNextExit = resolveExit;
});

async function stop(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  let resolvedExitCode = exitCode;

  try {
    if (!nextExited) {
      next.kill('SIGTERM');
      const forceKill = setTimeout(() => next.kill('SIGKILL'), 5_000);
      forceKill.unref();
      await nextExit;
      clearTimeout(forceKill);
    }
    await built.app.close();
    await e1.close();
  } catch {
    resolvedExitCode = 1;
  } finally {
    await resetNextDevOutput(nextOutputDirectory);
    await restoreNextGeneratedFiles();
    process.exit(resolvedExitCode);
  }
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
next.on('exit', (code) => {
  nextExited = true;
  resolveNextExit?.();
  if (!stopping) void stop(code ?? 1);
});
