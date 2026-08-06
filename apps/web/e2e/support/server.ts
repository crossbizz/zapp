import { spawn } from 'node:child_process';

import { buildApp } from '../../../../services/control-api/src/app.js';
import { createInMemoryTokenDenylist } from '../../../../services/control-api/src/auth/denylist.js';
import { createInMemoryDeviceStore } from '../../../../services/control-api/src/auth/device.js';
import type { AuthIdentity } from '../../../../services/control-api/src/auth/port.js';
import type { UserProfile } from '../../../../services/control-api/src/auth/users.js';
import { createInMemoryIdempotencyStore } from '../../../../services/control-api/src/plugins/idempotency.js';
import { createInMemoryRateLimiter } from '../../../../services/control-api/src/plugins/rate-limit.js';
import {
  InMemoryUserStore,
  TEST_AUTH_CONFIG,
  TEST_PROXY_TRUST,
  TEST_RATE_LIMITS,
} from '../../../../services/control-api/test/support/harness.js';
import { FakeAuthPort } from '../../../../services/control-api/test/support/fake-auth-port.js';

const appPort = 3100;
const apiPort = 4100;
const appBaseUrl = `http://127.0.0.1:${String(appPort)}`;
const apiBaseUrl = `http://127.0.0.1:${String(apiPort)}`;

const memberships: UserProfile['memberships'] = [
  {
    allowedModels: ['anthropic/claude-sonnet-5', 'openai:gpt_5.1-mini'],
    organization: { id: 'org-alpha', name: 'Alpha Org', slug: 'alpha' },
    role: 'owner',
    status: 'active',
  },
  {
    allowedModels: [],
    organization: { id: 'org-beta', name: 'Beta Org', slug: 'beta' },
    role: 'builder',
    status: 'active',
  },
  {
    allowedModels: [],
    organization: { id: 'org-invited', name: 'Invited Org', slug: 'invited' },
    role: 'viewer',
    status: 'invited',
  },
];

class FixtureUserStore extends InMemoryUserStore {
  override upsertFromIdentity(identity: AuthIdentity): Promise<UserProfile['user']> {
    this.upsertCount += 1;
    const user = {
      id: 'user-ada',
      email: identity.email,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl ?? null,
    };
    this.users.set(user.id, user);
    this.memberships.set(user.id, memberships);
    return Promise.resolve(user);
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
  reply.header('access-control-allow-origin', appBaseUrl);
  reply.header('access-control-allow-credentials', 'true');
  reply.header('access-control-allow-headers', 'content-type, x-zapp-csrf, x-organization-id');
  reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');

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

built.app.get('/__requests', () => ({ requests }));
built.app.get('/__reset', () => {
  requests.length = 0;
  clockOffset = 0;
  meRequestCount = 0;
  failMeRequest = undefined;
  failMeStatus = 500;
  dropMeRequest = undefined;
  return { ok: true };
});
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

await built.app.listen({ host: '127.0.0.1', port: apiPort });

const next = spawn('pnpm', ['exec', 'next', 'dev', '--port', String(appPort)], {
  env: {
    ...process.env,
    NEXT_PUBLIC_APP_BASE_URL: appBaseUrl,
    NEXT_PUBLIC_CONTROL_API_URL: apiBaseUrl,
  },
  stdio: 'inherit',
});

let stopping = false;
async function stop(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  next.kill('SIGTERM');
  await built.app.close();
  process.exit(exitCode);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
next.on('exit', (code) => void stop(code ?? 1));
