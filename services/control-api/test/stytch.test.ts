import { describe, expect, it, vi } from 'vitest';

import { AuthPortError } from '../src/auth/port.js';
import {
  classifyStytchFailure,
  createStytchAuthPort,
  type StytchClientLike,
  type StytchFault,
} from '../src/auth/stytch.js';

/**
 * The Stytch adapter, tested where it can be: the request it shapes and the
 * response it maps. The live round trip is `test/integration/auth.test.ts`,
 * which is env-gated on `STYTCH_PROJECT_ID` + `STYTCH_SECRET` and skips
 * visibly without them — so these assertions are the only thing standing
 * between a wrong field name and staging.
 */

const CONFIG = {
  projectId: 'project-test-00000000-0000-0000-0000-000000000000',
  secret: 'secret-test-not-a-real-key',
  publicToken: 'public-token-test-abc',
};

const MEMBER = {
  member_id: 'member-test-9f0b',
  email_address: 'alice@acme.test',
  name: 'Alice Example',
  oauth_registrations: [
    { provider_type: 'Google', profile_picture_url: 'https://cdn.google.test/alice.png' },
  ],
};

interface MockCalls {
  readonly authenticate: ReturnType<typeof vi.fn>;
  readonly exchange: ReturnType<typeof vi.fn>;
  readonly createDiscoveredOrganization: ReturnType<typeof vi.fn>;
  readonly authenticateJwt: ReturnType<typeof vi.fn>;
  readonly create: ReturnType<typeof vi.fn>;
}

function mockClient(overrides: Partial<Record<keyof MockCalls, unknown>> = {}): {
  client: StytchClientLike;
  calls: MockCalls;
} {
  const calls: MockCalls = {
    authenticate: vi.fn().mockResolvedValue(
      overrides.authenticate ?? {
        intermediate_session_token: 'ist-1',
        email_address: 'alice@acme.test',
        discovered_organizations: [
          {
            member_authenticated: true,
            organization: { organization_id: 'organization-test-acme', organization_slug: 'acme' },
            membership: { type: 'active_member' },
          },
        ],
      },
    ),
    exchange: vi
      .fn()
      .mockResolvedValue(
        overrides.exchange ?? { member_authenticated: true, member: MEMBER, session_jwt: 'jwt-1' },
      ),
    createDiscoveredOrganization: vi.fn().mockResolvedValue(
      overrides.createDiscoveredOrganization ?? {
        member_authenticated: true,
        member: MEMBER,
        organization: {
          organization_id: 'organization-test-self-service',
          organization_name: "Alice Example's Workspace",
          organization_slug: 'alice-example-workspace-e383094d4770',
        },
        session_jwt: 'jwt-self-service',
      },
    ),
    authenticateJwt: vi
      .fn()
      .mockResolvedValue(
        overrides.authenticateJwt ?? { member_session: { member_id: 'member-test-9f0b' } },
      ),
    create: vi
      .fn()
      .mockResolvedValue(
        overrides.create ?? { organization: { organization_id: 'organization-test-new' } },
      ),
  };

  return {
    calls,
    client: {
      oauth: { discovery: { authenticate: calls.authenticate } },
      discovery: {
        intermediateSessions: { exchange: calls.exchange },
        organizations: { create: calls.createDiscoveredOrganization },
      },
      sessions: { authenticateJwt: calls.authenticateJwt },
      organizations: { create: calls.create },
    } as unknown as StytchClientLike,
  };
}

describe('getAuthorizationUrl', () => {
  it('starts the B2B discovery OAuth flow on the test host for a test project', () => {
    const { client } = mockClient();
    const port = createStytchAuthPort(CONFIG, client);

    const url = new URL(
      port.getAuthorizationUrl({
        redirectUri: 'https://api.zapp.test/v1/auth/callback',
        state: 'state-token',
      }),
    );

    expect(url.origin).toBe('https://test.stytch.com');
    expect(url.pathname).toBe('/v1/b2b/public/oauth/google/discovery/start');
    expect(url.searchParams.get('public_token')).toBe(CONFIG.publicToken);
    // Stytch appends its own `token`/`stytch_token_type`; our state rides along
    // on the redirect URL, and the callback fails closed if it does not return.
    expect(url.searchParams.get('discovery_redirect_url')).toBe(
      'https://api.zapp.test/v1/auth/callback?state=state-token',
    );
  });

  it('uses the live host for a live project and the configured provider', () => {
    const { client } = mockClient();
    const port = createStytchAuthPort(
      { ...CONFIG, projectId: 'project-live-0000', oauthProvider: 'github' },
      client,
    );

    const url = new URL(
      port.getAuthorizationUrl({ redirectUri: 'https://api.zapp.build/cb', state: 's' }),
    );

    expect(url.origin).toBe('https://api.stytch.com');
    expect(url.pathname).toBe('/v1/b2b/public/oauth/github/discovery/start');
  });
});

describe('exchangeCode', () => {
  it('authenticates the discovery token, then exchanges it into the discovered organization', async () => {
    const { client, calls } = mockClient();
    const port = createStytchAuthPort(CONFIG, client);

    const identity = await port.exchangeCode('stytch-discovery-token');

    expect(calls.authenticate).toHaveBeenCalledWith({
      discovery_oauth_token: 'stytch-discovery-token',
    });
    expect(calls.exchange).toHaveBeenCalledWith(
      expect.objectContaining({
        intermediate_session_token: 'ist-1',
        organization_id: 'organization-test-acme',
      }),
    );
    expect(identity).toEqual({
      externalId: 'member-test-9f0b',
      email: 'alice@acme.test',
      displayName: 'Alice Example',
      avatarUrl: 'https://cdn.google.test/alice.png',
    });
  });

  it('prefers an organization the member is already authenticated for', async () => {
    const { client, calls } = mockClient({
      authenticate: {
        intermediate_session_token: 'ist-2',
        email_address: 'alice@acme.test',
        discovered_organizations: [
          {
            member_authenticated: false,
            organization: { organization_id: 'organization-test-invited' },
            membership: { type: 'invited_member' },
          },
          {
            member_authenticated: true,
            organization: { organization_id: 'organization-test-active' },
            membership: { type: 'active_member' },
          },
        ],
      },
    });
    const port = createStytchAuthPort(CONFIG, client);

    await port.exchangeCode('token');

    expect(calls.exchange).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: 'organization-test-active' }),
    );
  });

  it('falls back to the email address when the member has no name', async () => {
    const { client } = mockClient({
      exchange: {
        member_authenticated: true,
        member: { member_id: 'member-test-1', email_address: 'bob@acme.test', name: '' },
      },
    });
    const port = createStytchAuthPort(CONFIG, client);

    expect(await port.exchangeCode('token')).toEqual({
      externalId: 'member-test-1',
      email: 'bob@acme.test',
      displayName: 'bob@acme.test',
    });
  });

  it('creates and authenticates a user-prefixed organization when discovery finds none', async () => {
    const newMember = {
      member_id: 'member-test-nora',
      email_address: 'nora@acme.test',
      name: 'Nora New',
      oauth_registrations: [],
    };
    const { client, calls } = mockClient({
      authenticate: {
        intermediate_session_token: 'ist-3',
        email_address: 'nora@acme.test',
        full_name: 'Nora New',
        discovered_organizations: [],
      },
      createDiscoveredOrganization: {
        member_authenticated: true,
        member: newMember,
        organization: {
          organization_id: 'organization-test-nora',
          organization_name: "Nora New's Workspace",
          organization_slug: 'nora-new-workspace-08dd54604eb2',
        },
        session_jwt: 'jwt-nora',
      },
    });
    const port = createStytchAuthPort(CONFIG, client);

    await expect(port.exchangeCode('token')).resolves.toEqual({
      externalId: 'member-test-nora',
      email: 'nora@acme.test',
      displayName: 'Nora New',
    });
    expect(calls.createDiscoveredOrganization).toHaveBeenCalledWith({
      intermediate_session_token: 'ist-3',
      organization_name: "Nora New's Workspace",
      organization_slug: 'nora-new-workspace-08dd54604eb2',
      session_duration_minutes: 60,
    });
    expect(calls.exchange).not.toHaveBeenCalled();
  });

  it('reports authentication_incomplete when the exchange still wants a second factor', async () => {
    const { client } = mockClient({
      exchange: { member_authenticated: false, intermediate_session_token: 'ist-4' },
    });
    const port = createStytchAuthPort(CONFIG, client);

    await expect(port.exchangeCode('token')).rejects.toMatchObject({
      code: 'authentication_incomplete',
    });
  });

  it('wraps a provider failure rather than leaking it', async () => {
    const { client, calls } = mockClient();
    calls.authenticate.mockRejectedValue(new Error('stytch says: invalid secret sk-live-abc'));
    const port = createStytchAuthPort(CONFIG, client);

    const error = await port.exchangeCode('token').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AuthPortError);
    expect((error as AuthPortError).code).toBe('exchange_failed');
    expect((error as AuthPortError).message).not.toContain('sk-live-abc');
  });
});

describe('verifySession', () => {
  it('maps a valid Stytch session JWT to its member id', async () => {
    const { client, calls } = mockClient();
    const port = createStytchAuthPort(CONFIG, client);

    expect(await port.verifySession('stytch-session-jwt')).toEqual({
      externalId: 'member-test-9f0b',
    });
    expect(calls.authenticateJwt).toHaveBeenCalledWith({ session_jwt: 'stytch-session-jwt' });
  });

  it('answers null — not an exception — for a session Stytch rejects', async () => {
    const { client, calls } = mockClient();
    calls.authenticateJwt.mockRejectedValue(new Error('session_not_found'));
    const port = createStytchAuthPort(CONFIG, client);

    expect(await port.verifySession('expired')).toBeNull();
  });
});

/**
 * The half of the adapter that decides whether a failure is routine.
 *
 * Written because it was not decided at all: `verifySession` was
 * `catch { return null }` and `exchangeCode` funnelled everything into
 * `exchange_failed`, so a 401 from a wrong secret and a 401 from an expired
 * session were the same event to every reader — including
 * `test/integration/auth.test.ts`, which is how that suite passed against
 * `STYTCH_SECRET=replace-me` with a project id of all zeros.
 */
describe('classifyStytchFailure', () => {
  /** What the SDK constructs from a non-2xx body (`stytch/dist/shared/errors.js`). */
  const stytchError = (fields: Record<string, unknown>): unknown =>
    Object.assign(new Error('stytch'), {
      status_code: 401,
      request_id: 'request-id-test-9f0b',
      ...fields,
    });

  it('calls a refusal of our own credentials a misconfiguration', () => {
    expect(
      classifyStytchFailure(
        stytchError({ error_type: 'unauthorized_credentials' }),
        'verifySession',
      ),
    ).toEqual({
      kind: 'misconfigured',
      operation: 'verifySession',
      errorType: 'unauthorized_credentials',
      statusCode: 401,
      requestId: 'request-id-test-9f0b',
    });
  });

  it('calls a refusal of the subject a rejection, at the same status code', () => {
    // The pair that matters: both are 401s, and only the error type separates
    // "this session is over" from "we cannot sign in to Stytch at all".
    const fault = classifyStytchFailure(
      stytchError({ error_type: 'session_not_found' }),
      'verifySession',
    );
    expect(fault.kind).toBe('rejected');
    expect(fault.statusCode).toBe(401);
    expect(fault.requestId).toBe('request-id-test-9f0b');
  });

  it('calls anything that never answered unreachable, and invents no detail', () => {
    // A RequestError, a fetch TypeError, an abort: no status, no request id,
    // and — the point — never mistaken for Stytch having rejected something.
    for (const thrown of [new Error('fetch failed'), 'nonsense', undefined, { request: {} }]) {
      const fault = classifyStytchFailure(thrown, 'exchangeCode');
      expect(fault).toEqual({ kind: 'unreachable', operation: 'exchangeCode' });
    }
  });
});

describe('fault reporting', () => {
  it('reports a rejected session and still answers null', async () => {
    const faults: StytchFault[] = [];
    const { client, calls } = mockClient();
    calls.authenticateJwt.mockRejectedValue(
      Object.assign(new Error('stytch'), {
        status_code: 401,
        error_type: 'session_not_found',
        request_id: 'request-id-test-1',
      }),
    );
    const port = createStytchAuthPort({ ...CONFIG, onFault: (f) => faults.push(f) }, client);

    expect(await port.verifySession('expired')).toBeNull();
    expect(faults).toEqual([
      {
        kind: 'rejected',
        operation: 'verifySession',
        errorType: 'session_not_found',
        statusCode: 401,
        requestId: 'request-id-test-1',
      },
    ]);
  });

  it('reports a misconfiguration through exchangeCode without changing what the caller sees', async () => {
    const faults: StytchFault[] = [];
    const { client, calls } = mockClient();
    calls.authenticate.mockRejectedValue(
      Object.assign(new Error('stytch'), {
        status_code: 401,
        error_type: 'unauthorized_credentials',
        request_id: 'request-id-test-2',
      }),
    );
    const port = createStytchAuthPort({ ...CONFIG, onFault: (f) => faults.push(f) }, client);

    const error = await port.exchangeCode('token').catch((thrown: unknown) => thrown);

    // The client is told nothing about our credentials — telling them would be
    // an oracle, and the wording is the same one every other failure produces.
    expect((error as AuthPortError).code).toBe('exchange_failed');
    expect((error as AuthPortError).message).toBe('Sign-in could not be completed.');
    // The operator is told exactly which of the two things went wrong.
    expect(faults.map((fault) => fault.kind)).toEqual(['misconfigured']);
  });

  it('says nothing when the failure was ours rather than the provider’s', async () => {
    // `authentication_incomplete` is raised inside the guarded operation by
    // this adapter. Stytch answered fine; there is no provider fault to
    // classify, and reporting one would put noise in front of the real ones.
    const faults: StytchFault[] = [];
    const { client } = mockClient({
      authenticate: {
        intermediate_session_token: 'ist-5',
        email_address: 'nobody@acme.test',
        discovered_organizations: [],
      },
      createDiscoveredOrganization: {
        member_authenticated: false,
        intermediate_session_token: 'ist-6',
      },
    });
    const port = createStytchAuthPort({ ...CONFIG, onFault: (f) => faults.push(f) }, client);

    await expect(port.exchangeCode('token')).rejects.toMatchObject({
      code: 'authentication_incomplete',
    });
    expect(faults).toEqual([]);
  });
});

describe('createOrganization', () => {
  it('maps a zapp organization onto a Stytch one, name and slug alike', async () => {
    const { client, calls } = mockClient();
    const port = createStytchAuthPort(CONFIG, client);

    expect(await port.createOrganization({ name: 'Acme Inc', slug: 'acme-inc' })).toEqual({
      externalOrgId: 'organization-test-new',
    });
    expect(calls.create).toHaveBeenCalledWith(
      expect.objectContaining({ organization_name: 'Acme Inc', organization_slug: 'acme-inc' }),
    );
  });
});
