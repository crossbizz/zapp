import { ApiErrorSchema } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppInstance } from '../src/app.js';
import type { AuthIdentity } from '../src/auth/port.js';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  OAUTH_STATE_COOKIE,
  REFRESH_COOKIE,
  SESSION_COOKIE,
} from '../src/auth/cookies.js';
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from '../src/auth/session.js';
import {
  buildHarness,
  cookieHeader,
  cookieJar,
  cookiesOf,
  InMemoryUserStore,
  TEST_PREVIOUS_SECRET,
  TEST_SECRET,
  type Harness,
} from './support/harness.js';

/**
 * Everything the session layer promises, exercised through the real HTTP
 * pipeline with `inject`: the identity provider is a fake, the clock is a
 * counter, and nothing else is stubbed. A route that only works because a test
 * called a helper directly is a route that has not been tested.
 */

const harnesses: Harness[] = [];

function harness(options?: Parameters<typeof buildHarness>[0]): Harness {
  const built = buildHarness(options);
  harnesses.push(built);
  return built;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((built) => built.app.close()));
});

const ALICE: AuthIdentity = {
  externalId: 'member-test-alice',
  email: 'alice@acme.test',
  displayName: 'Alice Example',
  avatarUrl: 'https://cdn.fake.test/alice.png',
};

interface LoginResult {
  readonly cookies: Map<string, string>;
  readonly status: number;
  readonly location: string | undefined;
}

/** Drives login → callback end to end and returns the resulting cookie jar. */
async function login(
  built: Harness,
  options: { identity?: AuthIdentity; userCode?: string; code?: string } = {},
): Promise<LoginResult> {
  const identity = options.identity ?? ALICE;
  const code = options.code ?? 'auth-code-1';
  const start = await built.app.inject({
    method: 'GET',
    url:
      options.userCode === undefined
        ? '/v1/auth/login'
        : `/v1/auth/login?userCode=${options.userCode}`,
  });
  const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
  built.port.issueCode(code, identity);

  const callback = await built.app.inject({
    method: 'GET',
    url: `/v1/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
    headers: { cookie: cookieJar(cookiesOf(start.headers['set-cookie'])) },
  });

  return {
    cookies: cookiesOf(callback.headers['set-cookie']),
    status: callback.statusCode,
    location: callback.headers.location,
  };
}

/** The session cookie jar, as a `Cookie` header, minus whatever `drop` names. */
function jar(cookies: Map<string, string>, drop: string[] = []): string {
  const copy = new Map(cookies);
  for (const name of drop) {
    copy.delete(name);
  }
  return cookieJar(copy);
}

/** What `inject` resolves to — spelled once rather than restated per helper. */
type LightResponse = Awaited<ReturnType<AppInstance['inject']>>;

function me(app: AppInstance, headers: Record<string, string>): Promise<LightResponse> {
  return app.inject({ method: 'GET', url: '/v1/me', headers });
}

describe('GET /v1/auth/login', () => {
  it('redirects to the provider with the callback URI and a state the cookie can prove', async () => {
    const built = harness();

    const response = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin + location.pathname).toBe('https://idp.fake.test/authorize');
    expect(built.port.authorizationRequests).toHaveLength(1);
    expect(built.port.authorizationRequests[0]?.redirectUri).toBe(
      'https://api.zapp.test/v1/auth/callback',
    );

    // The nonce never leaves the cookie, and the state never leaves the URL:
    // holding one without the other is exactly what the callback rejects.
    const nonce = cookiesOf(response.headers['set-cookie']).get(OAUTH_STATE_COOKIE);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(location.searchParams.get('state')).not.toContain(nonce as string);
  });

  it('scopes the state cookie to the auth routes and keeps it off JavaScript', async () => {
    const built = harness();

    const response = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });

    const header = cookieHeader(response.headers['set-cookie'], OAUTH_STATE_COOKIE) ?? '';
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/v1/auth');
  });
});

describe('GET /v1/auth/callback', () => {
  it('sets the session, refresh and CSRF cookies and sends the browser to the app', async () => {
    const built = harness();

    const result = await login(built);

    expect(result.status).toBe(302);
    expect(result.location).toBe('https://app.zapp.test');
    expect(result.cookies.get(SESSION_COOKIE)).toEqual(expect.stringMatching(/\S/));
    expect(result.cookies.get(REFRESH_COOKIE)).toEqual(expect.stringMatching(/\S/));
    expect(result.cookies.get(CSRF_COOKIE)).toMatch(/^[0-9a-f]{32}$/);
    // The state cookie is single-use: it is cleared as the session is created.
    expect(result.cookies.get(OAUTH_STATE_COOKIE)).toBe('');
  });

  it('keeps the session and refresh cookies off JavaScript, and the CSRF cookie on it', async () => {
    const built = harness();

    const start = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
    built.port.issueCode('auth-code-1', ALICE);
    const response = await built.app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(start.headers['set-cookie'])) },
    });

    const setCookie = response.headers['set-cookie'];
    for (const [name, path] of [
      [SESSION_COOKIE, 'Path=/'],
      [REFRESH_COOKIE, 'Path=/v1/auth'],
    ] as const) {
      const header = cookieHeader(setCookie, name) ?? '';
      expect(header, name).toContain('HttpOnly');
      expect(header, name).toContain('Secure');
      expect(header, name).toContain('SameSite=Lax');
      expect(header, name).toContain(path);
    }
    // Double-submit only works if the page can read it back and echo it.
    expect(cookieHeader(setCookie, CSRF_COOKIE) ?? '').not.toContain('HttpOnly');
  });

  it('rejects a state that does not match the nonce cookie', async () => {
    const built = harness();

    const first = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
    const second = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(first.headers.location as string).searchParams.get('state') ?? '';
    built.port.issueCode('auth-code-1', ALICE);

    const response = await built.app.inject({
      method: 'GET',
      // Someone else's nonce: the CSRF-on-login case the state parameter exists for.
      url: `/v1/auth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(second.headers['set-cookie'])) },
    });

    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('invalid_state');
    expect(cookiesOf(response.headers['set-cookie']).has(SESSION_COOKIE)).toBe(false);
  });

  it('rejects a callback with no state cookie at all', async () => {
    const built = harness();

    const start = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
    built.port.issueCode('auth-code-1', ALICE);

    const response = await built.app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('invalid_state');
  });

  it('rejects a state that was not signed by this service', async () => {
    const built = harness();

    const start = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
    const cookies = cookiesOf(start.headers['set-cookie']);
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
    // Same claims, forged signature.
    const forged = `${state.slice(0, state.lastIndexOf('.'))}.${'A'.repeat(43)}`;
    built.port.issueCode('auth-code-1', ALICE);

    const response = await built.app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=auth-code-1&state=${encodeURIComponent(forged)}`,
      headers: { cookie: cookieJar(cookies) },
    });

    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('invalid_state');
  });

  it('answers a code the provider will not exchange with authentication_failed', async () => {
    const built = harness();

    const start = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';

    const response = await built.app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=never-issued&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(start.headers['set-cookie'])) },
    });

    expect(response.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('authentication_failed');
  });

  it('links a second login to the same user row rather than creating another', async () => {
    const users = new InMemoryUserStore();
    const built = harness({ users });

    await login(built, { code: 'first' });
    await login(built, { code: 'second' });

    expect(users.upsertCount).toBe(2);
    expect(users.users.size).toBe(1);
  });
});

describe('GET /v1/me', () => {
  it('answers the session user and their memberships', async () => {
    const users = new InMemoryUserStore();
    const built = harness({ users });
    const { cookies } = await login(built);
    const [user] = [...users.users.values()];
    users.memberships.set(user?.id ?? '', [
      {
        organization: { id: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7N9', name: 'Acme', slug: 'acme' },
        role: 'owner',
        status: 'active',
      },
    ]);

    const response = await me(built.app, { cookie: jar(cookies) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        id: user?.id,
        email: 'alice@acme.test',
        displayName: 'Alice Example',
        avatarUrl: 'https://cdn.fake.test/alice.png',
      },
      memberships: [
        {
          organization: { id: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7N9', name: 'Acme', slug: 'acme' },
          role: 'owner',
          status: 'active',
        },
      ],
    });
  });

  it('rejects a request with no credentials at all', async () => {
    const response = await me(harness().app, {});

    expect(response.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('unauthenticated');
  });

  it('rejects a tampered session JWT', async () => {
    const built = harness();
    const { cookies } = await login(built);
    const token = cookies.get(SESSION_COOKIE) ?? '';
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    claims['sub'] = 'user_00000000000000000000000000';
    const forged = [
      header,
      Buffer.from(JSON.stringify(claims)).toString('base64url'),
      signature,
    ].join('.');

    const response = await me(built.app, { cookie: `${SESSION_COOKIE}=${forged}` });

    expect(response.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('unauthenticated');
  });

  it('rejects an expired session', async () => {
    const built = harness();
    const { cookies } = await login(built);

    expect((await me(built.app, { cookie: jar(cookies) })).statusCode).toBe(200);
    built.advance(ACCESS_TOKEN_TTL_MS + 1_000);

    const response = await me(built.app, { cookie: jar(cookies) });
    expect(response.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('unauthenticated');
  });

  it('still accepts a session signed with the previous secret during rotation', async () => {
    const users = new InMemoryUserStore();
    const before = harness({ users, config: { sessionSecret: TEST_SECRET } });
    const { cookies } = await login(before);
    const after = harness({
      users,
      config: { sessionSecret: TEST_PREVIOUS_SECRET, previousSecret: TEST_SECRET },
    });

    expect((await me(after.app, { cookie: jar(cookies) })).statusCode).toBe(200);
  });

  it('refuses a session signed with a secret that is no longer accepted', async () => {
    const users = new InMemoryUserStore();
    const before = harness({ users, config: { sessionSecret: TEST_SECRET } });
    const { cookies } = await login(before);
    const after = harness({ users, config: { sessionSecret: TEST_PREVIOUS_SECRET } });

    expect((await me(after.app, { cookie: jar(cookies) })).statusCode).toBe(401);
  });

  it('refuses a refresh token presented as a session', async () => {
    const built = harness();
    const { cookies } = await login(built);

    const response = await me(built.app, {
      cookie: `${SESSION_COOKIE}=${cookies.get(REFRESH_COOKIE) ?? ''}`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('accepts the session as a bearer token as well as a cookie', async () => {
    const built = harness();
    const { cookies } = await login(built);

    const response = await me(built.app, {
      authorization: `Bearer ${cookies.get(SESSION_COOKIE) ?? ''}`,
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('POST /v1/auth/refresh', () => {
  it('rotates both tokens and denies the refresh token it consumed', async () => {
    const built = harness();
    const { cookies } = await login(built);

    const rotated = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: jar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
    });

    expect(rotated.statusCode).toBe(200);
    const next = cookiesOf(rotated.headers['set-cookie']);
    expect(next.get(REFRESH_COOKIE)).not.toBe(cookies.get(REFRESH_COOKIE));
    expect(next.get(SESSION_COOKIE)).not.toBe(cookies.get(SESSION_COOKIE));
    // The new session works...
    expect((await me(built.app, { cookie: jar(next) })).statusCode).toBe(200);

    // ...and replaying the old refresh token does not.
    const replay = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: jar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
    });
    expect(replay.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(replay.json()).error.code).toBe('invalid_refresh_token');
  });

  it('refuses an expired refresh token', async () => {
    const built = harness();
    const { cookies } = await login(built);
    built.advance(REFRESH_TOKEN_TTL_MS + 1_000);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: jar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('accepts a refresh token in the body and answers with tokens, not cookies', async () => {
    const built = harness();
    const device = await approveDevice(built);

    const response = await refresh(built, device.refreshToken);

    expect(response.statusCode).toBe(200);
    const body: { accessToken: string; refreshToken: string } = response.json();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect((await me(built.app, { authorization: `Bearer ${body.accessToken}` })).statusCode).toBe(
      200,
    );
    expect(body.refreshToken).not.toBe(device.refreshToken);
  });

  it('refuses a session token presented as a refresh token', async () => {
    const built = harness();
    const { cookies } = await login(built);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: cookies.get(SESSION_COOKIE) },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /v1/auth/logout', () => {
  it('clears the cookies and makes the session it ended unusable', async () => {
    const built = harness();
    const { cookies } = await login(built);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: jar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
    });

    expect(response.statusCode).toBe(204);
    const cleared = cookiesOf(response.headers['set-cookie']);
    expect(cleared.get(SESSION_COOKIE)).toBe('');
    expect(cleared.get(REFRESH_COOKIE)).toBe('');
    expect(cleared.get(CSRF_COOKIE)).toBe('');
    // A cookie the browser kept anyway is worth nothing: the token is denied.
    expect((await me(built.app, { cookie: jar(cookies) })).statusCode).toBe(401);
  });

  it('also denies the refresh token that came with the session', async () => {
    const built = harness();
    const { cookies } = await login(built);

    await built.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: jar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
    });

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: jar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('CSRF', () => {
  it('rejects a cookie-authenticated POST with no CSRF header', async () => {
    const built = harness();
    const { cookies } = await login(built);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: jar(cookies) },
    });

    expect(response.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('csrf_required');
  });

  it('rejects a CSRF header that does not match the cookie', async () => {
    const built = harness();
    const { cookies } = await login(built);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: jar(cookies), [CSRF_HEADER]: 'f'.repeat(32) },
    });

    expect(response.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('csrf_invalid');
  });

  it('exempts a bearer-authenticated POST, which carries no ambient credential', async () => {
    const built = harness();
    const { cookies } = await login(built);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${cookies.get(SESSION_COOKIE) ?? ''}` },
    });

    expect(response.statusCode).toBe(204);
  });
});

interface DeviceTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/**
 * The whole desktop handshake: start a grant, sign in, *explicitly approve the
 * displayed code*, then claim the token. The approval is a separate,
 * authenticated call — that separation is the fix for the device-consent hole,
 * so every test that wants a device token has to go through it.
 */
async function approveDevice(built: Harness, session?: Map<string, string>): Promise<DeviceTokens> {
  const started = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });
  const grant: { deviceCode: string; userCode: string } = started.json();
  const cookies = session ?? (await login(built)).cookies;

  const approved = await built.app.inject({
    method: 'POST',
    url: '/v1/auth/device/approve',
    headers: { cookie: jar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
    payload: { userCode: grant.userCode },
  });
  expect(approved.statusCode).toBe(204);

  const claimed = await built.app.inject({
    method: 'POST',
    url: '/v1/auth/device/token',
    payload: { deviceCode: grant.deviceCode },
  });
  expect(claimed.statusCode).toBe(200);
  return claimed.json();
}

/** POSTs a refresh token the way a bearer client does: in the body, no cookies. */
function refresh(built: Harness, refreshToken: string): Promise<LightResponse> {
  return built.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken } });
}

describe('device flow', () => {
  it('starts a grant the desktop app can send a human to', async () => {
    const built = harness();

    const response = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });

    expect(response.statusCode).toBe(200);
    const grant: Record<string, unknown> = response.json();
    expect(grant['deviceCode']).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(grant['userCode']).toEqual(expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/));
    expect(grant['verificationUri']).toBe('https://api.zapp.test/v1/auth/login');
    expect(grant['verificationUriComplete']).toBe(
      `https://api.zapp.test/v1/auth/login?userCode=${String(grant['userCode'])}`,
    );
    expect(grant['interval']).toBeGreaterThan(0);
    expect(grant['expiresIn']).toBeGreaterThan(0);
  });

  it('answers authorization_pending until a human finishes the browser leg', async () => {
    const built = harness();
    const started = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });
    const grant: { deviceCode: string } = started.json();

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: grant.deviceCode },
    });

    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('authorization_pending');
  });

  it('issues a bearer that authenticates /v1/me, exactly once', async () => {
    const built = harness();
    const started = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });
    const grant: { deviceCode: string; userCode: string } = started.json();

    const browser = await login(built, { userCode: grant.userCode });
    expect(browser.status).toBe(302);
    const approved = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/approve',
      headers: {
        cookie: jar(browser.cookies),
        [CSRF_HEADER]: browser.cookies.get(CSRF_COOKIE) ?? '',
      },
      payload: { userCode: grant.userCode },
    });
    expect(approved.statusCode).toBe(204);

    const claimed = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: grant.deviceCode },
    });
    expect(claimed.statusCode).toBe(200);
    const tokens: { accessToken: string; tokenType: string; expiresIn: number } = claimed.json();
    expect(tokens.tokenType).toBe('Bearer');
    expect(
      (await me(built.app, { authorization: `Bearer ${tokens.accessToken}` })).statusCode,
    ).toBe(200);

    // A device code is a bearer secret in a poll loop: it is spent on first use.
    const replay = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: grant.deviceCode },
    });
    expect(replay.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(replay.json()).error.code).toBe('invalid_device_code');
  });

  it('expires a grant nobody approved', async () => {
    const built = harness();
    const started = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });
    const grant: { deviceCode: string; expiresIn: number } = started.json();
    built.advance(grant.expiresIn * 1_000 + 1_000);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: grant.deviceCode },
    });

    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('expired_device_code');
  });

  it('rejects a device code it never issued', async () => {
    const built = harness();

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: '0'.repeat(64) },
    });

    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('invalid_device_code');
  });

  it('signs the human in and sends them to the approval screen, whatever the code', async () => {
    const built = harness();

    // Even a code that was never issued: the browser leg only ever signs
    // someone in and shows them a screen, so it has nothing to leak.
    const result = await login(built, { userCode: 'ZZZZ-ZZZZ' });

    expect(result.status).toBe(302);
    expect(result.location).toBe('https://app.zapp.test/device?userCode=ZZZZ-ZZZZ');
    expect(result.cookies.get(SESSION_COOKIE)).toEqual(expect.stringMatching(/\S/));
  });
});

describe('device consent', () => {
  it('does not hand an attacker a session when a victim follows verificationUriComplete', async () => {
    // The chain the security review found, run end to end. Before the fix the
    // final poll returned the victim's access token and a 30-day refresh token.
    const built = harness();

    // 1. The attacker starts a device grant on their own machine…
    const started = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });
    const grant: { deviceCode: string; userCode: string; verificationUriComplete: string } =
      started.json();

    // 2. …and sends the victim the link. The victim signs in; for someone
    //    already signed in with the provider this is entirely silent.
    const victim = await login(built, { userCode: grant.userCode });
    expect(victim.status).toBe(302);
    expect(victim.cookies.get(SESSION_COOKIE)).toEqual(expect.stringMatching(/\S/));

    // 3. The attacker polls. There is nothing to collect: signing in is not
    //    consent, and the victim was taken to a screen naming the code instead.
    const polled = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: grant.deviceCode },
    });

    expect(polled.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(polled.json()).error.code).toBe('authorization_pending');
    expect(polled.body).not.toContain('accessToken');
    expect(polled.body).not.toContain('refreshToken');
    expect(victim.location).toBe(`https://app.zapp.test/device?userCode=${grant.userCode}`);
  });

  it('refuses to approve without a session', async () => {
    const built = harness();
    const started = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });
    const grant: { userCode: string } = started.json();

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/approve',
      payload: { userCode: grant.userCode },
    });

    expect(response.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('unauthenticated');
  });

  it('refuses to approve a cookie-authenticated request with no CSRF header', async () => {
    const built = harness();
    const { cookies } = await login(built);
    const started = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });
    const grant: { userCode: string } = started.json();

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/approve',
      headers: { cookie: jar(cookies) },
      payload: { userCode: grant.userCode },
    });

    expect(response.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('csrf_required');
  });

  it('binds the grant to whoever approved it, not to whoever started the browser leg', async () => {
    const users = new InMemoryUserStore();
    const built = harness({ users });
    const started = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });
    const grant: { deviceCode: string; userCode: string } = started.json();

    // Alice walks through the browser leg — which no longer decides anything.
    await login(built, { userCode: grant.userCode, code: 'alice-code' });
    // Bob is the one who presses Approve.
    const bob = await login(built, {
      identity: { externalId: 'member-test-bob', email: 'bob@acme.test', displayName: 'Bob' },
      code: 'bob-code',
    });
    await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/approve',
      headers: { cookie: jar(bob.cookies), [CSRF_HEADER]: bob.cookies.get(CSRF_COOKIE) ?? '' },
      payload: { userCode: grant.userCode },
    });

    const claimed = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: grant.deviceCode },
    });
    const tokens: DeviceTokens = claimed.json();
    const profile = await me(built.app, { authorization: `Bearer ${tokens.accessToken}` });

    expect(profile.statusCode).toBe(200);
    const body: { user: { email: string } } = profile.json();
    expect(body.user.email).toBe('bob@acme.test');
  });

  it('tells the polling device when a human declines', async () => {
    const built = harness();
    const { cookies } = await login(built);
    const started = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });
    const grant: { deviceCode: string; userCode: string } = started.json();

    const denied = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/deny',
      headers: { cookie: jar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
      payload: { userCode: grant.userCode },
    });
    expect(denied.statusCode).toBe(204);

    const polled = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: grant.deviceCode },
    });
    expect(polled.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(polled.json()).error.code).toBe('access_denied');
  });

  it('answers 404 for a code that was never issued, and for one already decided', async () => {
    const built = harness();
    const { cookies } = await login(built);
    const headers = { cookie: jar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' };
    const started = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });
    const grant: { userCode: string } = started.json();

    const unknown = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/approve',
      headers,
      payload: { userCode: 'ZZZZ-ZZZZ' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(unknown.json()).error.code).toBe('device_request_not_found');

    await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/approve',
      headers,
      payload: { userCode: grant.userCode },
    });
    // A second approval would let one code be pointed at a second identity.
    const again = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/approve',
      headers,
      payload: { userCode: grant.userCode },
    });
    expect(again.statusCode).toBe(404);
  });

  it('lets a bearer client approve without a CSRF header', async () => {
    const built = harness();
    const { cookies } = await login(built);
    const started = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });
    const grant: { userCode: string } = started.json();

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/approve',
      headers: { authorization: `Bearer ${cookies.get(SESSION_COOKIE) ?? ''}` },
      payload: { userCode: grant.userCode },
    });

    expect(response.statusCode).toBe(204);
  });
});

describe('refresh rotation races', () => {
  it('lets exactly one of two concurrent presentations spend the token', async () => {
    const built = harness();
    const device = await approveDevice(built);

    const [first, second] = await Promise.all([
      refresh(built, device.refreshToken),
      refresh(built, device.refreshToken),
    ]);

    // The write is the test: one caller denied the jti, the other found it
    // already denied. A read-then-write would have let both mint a session.
    expect([first.statusCode, second.statusCode].sort((a, b) => a - b)).toEqual([200, 401]);
  });

  it('revokes the whole family when a spent refresh token is replayed', async () => {
    const built = harness();
    const device = await approveDevice(built);

    const rotated: DeviceTokens = (await refresh(built, device.refreshToken)).json();
    // The thief replays the token the victim already spent.
    const replay = await refresh(built, device.refreshToken);
    expect(replay.statusCode).toBe(401);

    // Everything minted from that login dies with it — including the token the
    // victim rotated to legitimately, because there is no way to tell the two
    // holders apart.
    expect((await refresh(built, rotated.refreshToken)).statusCode).toBe(401);
    expect(
      (await me(built.app, { authorization: `Bearer ${rotated.accessToken}` })).statusCode,
    ).toBe(401);
  });
});

describe('logout never fails closed', () => {
  it('revokes a refresh token a bearer client hands it in the body', async () => {
    const built = harness();
    const device = await approveDevice(built);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${device.accessToken}` },
      payload: { refreshToken: device.refreshToken },
    });

    expect(response.statusCode).toBe(204);
    // The desktop app cannot send our host-only cookie, so the body is the only
    // way its 30-day credential can be revoked at all.
    expect((await refresh(built, device.refreshToken)).statusCode).toBe(401);
    expect(
      (await me(built.app, { authorization: `Bearer ${device.accessToken}` })).statusCode,
    ).toBe(401);
  });

  it('still clears cookies and answers 204 once the access token has expired', async () => {
    const built = harness();
    const { cookies } = await login(built);
    built.advance(ACCESS_TOKEN_TTL_MS + 1_000);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: jar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
    });

    // A 401 here would leave a live 30-day refresh token in the field.
    expect(response.statusCode).toBe(204);
    expect(cookiesOf(response.headers['set-cookie']).get(SESSION_COOKIE)).toBe('');
    const refreshed = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: jar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
    });
    expect(refreshed.statusCode).toBe(401);
  });

  it('still demands CSRF when the cookie it was handed is expired', async () => {
    const built = harness();
    const { cookies } = await login(built);
    built.advance(ACCESS_TOKEN_TTL_MS + 1_000);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: jar(cookies) },
    });

    // An expired cookie is still an ambient credential; tolerating it must not
    // mean a cross-site page can force a logout.
    expect(response.statusCode).toBe(403);
  });
});

describe('token handling hygiene', () => {
  it('marks every token-bearing response no-store', async () => {
    const built = harness();
    const started = await built.app.inject({ method: 'GET', url: '/v1/auth/device' });
    const grant: { deviceCode: string; userCode: string } = started.json();
    const { cookies } = await login(built);
    await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/approve',
      headers: { cookie: jar(cookies), [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '' },
      payload: { userCode: grant.userCode },
    });

    const claimed = await built.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: grant.deviceCode },
    });
    expect(claimed.headers['cache-control']).toBe('no-store');

    const tokens: DeviceTokens = claimed.json();
    expect((await refresh(built, tokens.refreshToken)).headers['cache-control']).toBe('no-store');
  });

  it('accepts the Bearer scheme however it is capitalised', async () => {
    const built = harness();
    const { cookies } = await login(built);

    // RFC 7235: the scheme token is case-insensitive.
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      const response = await me(built.app, {
        authorization: `${scheme} ${cookies.get(SESSION_COOKIE) ?? ''}`,
      });
      expect(response.statusCode, scheme).toBe(200);
    }
  });

  it('refuses a callback carrying a Stytch token type this flow cannot exchange', async () => {
    const built = harness();
    const start = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
    built.port.issueCode('auth-code-1', ALICE);

    const response = await built.app.inject({
      method: 'GET',
      url: `/v1/auth/callback?token=auth-code-1&stytch_token_type=sso&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(start.headers['set-cookie'])) },
    });

    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('invalid_state');
  });

  it('accepts the discovery token type Stytch actually sends', async () => {
    const built = harness();
    const start = await built.app.inject({ method: 'GET', url: '/v1/auth/login' });
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
    built.port.issueCode('auth-code-1', ALICE);

    const response = await built.app.inject({
      method: 'GET',
      url: `/v1/auth/callback?token=auth-code-1&stytch_token_type=discovery_oauth&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(cookiesOf(start.headers['set-cookie'])) },
    });

    expect(response.statusCode).toBe(302);
  });
});
