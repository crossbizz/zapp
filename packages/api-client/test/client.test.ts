import { afterEach, describe, expect, it, vi } from 'vitest';

import type { paths } from '../src/generated.js';

type SdkModule = typeof import('../src/client.js');
type FetchImplementation = SdkModule['createZappClient'] extends (options: infer Options) => unknown
  ? Options extends { fetch?: infer Fetch }
    ? Exclude<Fetch, undefined>
    : never
  : never;

const controllers: AbortController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function loadSdk(): Promise<SdkModule | undefined> {
  try {
    return await import('../src/client.js');
  } catch {
    return undefined;
  }
}

function stream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function failingStream(
  chunk: string,
  error = new Error('socket failed'),
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let delivered = false;
  return new ReadableStream({
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(encoder.encode(chunk));
        return;
      }
      controller.error(error);
    },
  });
}

function neverEndingStream(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      signal.addEventListener(
        'abort',
        () => {
          controller.error(signal.reason);
        },
        { once: true },
      );
    },
  });
}

function agentEvent(
  sequence: number,
  type = 'task.updated',
  payload: Record<string, unknown> = {},
) {
  return {
    id: 'evt_01J8ME7YQZJ2V9Q0X3T5B6K7N8',
    runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
    sequence,
    occurredAt: '2026-08-03T12:00:00.000Z',
    organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
    projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
    type,
    visibility: 'user',
    payload,
  };
}

function eventFrame(sequence: number, type = 'task.updated'): string {
  return `id: ${String(sequence)}\nevent: ${type}\ndata: ${JSON.stringify(agentEvent(sequence, type))}\n\n`;
}

function rawEventFrame(id: string, sequence: number): string {
  return `id: ${id}\nevent: task.updated\ndata: ${JSON.stringify(agentEvent(sequence))}\n\n`;
}

async function closesWithin(closed: Promise<void>, timeoutMs = 50): Promise<boolean> {
  return Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    }),
  ]);
}

describe('createZappClient', () => {
  it('streams desktop local-agent completions through the generated public operation', async () => {
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(
        stream([
          'data: {"type":"text-delta","text":"hel',
          'lo"}\n\ndata: {"type":"done"}\n\n',
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
      ),
    );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 'desktop-user-token',
      fetch,
    });

    expect(client).toHaveProperty('streamLocalAgentCompletion');
    const events = [];
    for await (const event of client.streamLocalAgentCompletion(
      '01912f8f-6cb0-7a52-9d3d-2b24f32062b0',
      {
        completionId: `cmp_${'a'.repeat(64)}`,
        agentRole: 'builder',
        messages: [{ role: 'user', content: 'Change the heading' }],
        cacheBreakpointMessageIndexes: [],
        maxInputTokens: 8,
        maxOutputTokens: 64,
      },
      { organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA' },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text-delta', text: 'hello' },
      { type: 'done' },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toEqual(
      new URL(
        'https://api.zapp.test/v1/local-agent/sessions/01912f8f-6cb0-7a52-9d3d-2b24f32062b0/completions',
      ),
    );
    const init = call?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeTypeOf('string');
    const requestHeaders = new Headers(init?.headers);
    expect(requestHeaders.get('authorization')).toBe('Bearer desktop-user-token');
    expect(requestHeaders.get('x-organization-id')).toBe(
      'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
    );
  });

  it('sends structured run intent through the generated create-run operation', async () => {
    // Break caught: generated path typing or runtime request serialization drops
    // the selected app target/model even though the public API accepts both.
    type CreateRunOperation = paths['/v1/projects/{projectId}/runs']['post'];
    type CreateRunBody = CreateRunOperation['requestBody']['content']['application/json'];
    const body = {
      mode: 'build',
      prompt: 'Build a native inventory scanner',
      appType: 'mobile',
      model: 'anthropic/claude-sonnet-5',
    } satisfies CreateRunBody;
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(
        JSON.stringify({
          run: {
            id: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
            organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
            projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
            branchId: null,
            mode: 'build',
            appType: 'mobile',
            model: 'anthropic/claude-sonnet-5',
            status: 'queued',
            startedBy: 'user_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
            startedAt: '2026-08-06T12:00:00.000Z',
            completedAt: null,
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 'device-token',
      fetch,
    });

    await expect(
      client.request('/v1/projects/{projectId}/runs', {
        method: 'POST',
        path: { projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB' },
        body,
      }),
    ).resolves.toMatchObject({
      run: { appType: 'mobile', model: 'anthropic/claude-sonnet-5' },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(body));
  });

  it('sends generated attachment operations as multipart without overriding the boundary', async () => {
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(
        JSON.stringify({
          attachmentId: 'art_01J8ME7YQZJ2V9Q0X3T5B6K7NE',
          kind: 'image',
          name: 'reference.png',
          byteSize: 3,
          contentType: 'image/png',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 'device-token',
      fetch,
    });
    const form = new FormData();
    form.append('file', new Blob(['png'], { type: 'image/png' }), 'reference.png');

    await expect(
      client.request('/v1/projects/{projectId}/attachments', {
        method: 'POST',
        path: { projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB' },
        body: form,
      }),
    ).resolves.toMatchObject({ attachmentId: 'art_01J8ME7YQZJ2V9Q0X3T5B6K7NE' });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.body).toBe(form);
    expect(new Headers(init?.headers).has('content-type')).toBe(false);
  });

  it.each([
    'https://attacker.example/collect',
    '//attacker.example/collect',
    '/v1/not-a-generated-route',
  ])('rejects unsafe path %s before retrieving or sending a token', async (path) => {
    // Break caught: an attacker-controlled absolute, protocol-relative, or
    // unknown URL receives a freshly retrieved bearer token.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const getToken = vi.fn(() => 'secret-token');
    const fetch = vi.fn<FetchImplementation>();
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken,
      fetch,
    });

    await expect(client.request(path as never, { method: 'GET' } as never)).rejects.toThrow(
      /public API path|supported operation/i,
    );
    expect(getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('adds a fetched bearer token and encodes path query, body, and caller headers', async () => {
    // Break caught: a client silently drops query/body/authentication fields and
    // requests a different public API contract than its caller specified.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ project: { id: 'proj_1' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ project: { id: 'proj_1' } }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test/root/',
      getToken: () => Promise.resolve('device-token'),
      fetch,
    });

    await expect(
      client.request('/v1/projects', {
        method: 'POST',
        body: { name: 'Checkout' },
        headers: { 'x-request-id': 'request-1' },
      }),
    ).resolves.toEqual({ project: { id: 'proj_1' } });
    await client.request('/v1/projects', {
      method: 'GET',
      query: { includeArchived: 'false', limit: 20 },
    });
    await client.request('/v1/projects/{projectId}', {
      method: 'GET',
      path: { projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NC' },
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    const [input, init] = fetch.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.href).toBe('https://api.zapp.test/v1/projects');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ name: 'Checkout' }) });
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer device-token');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-request-id')).toBe('request-1');
    expect(new URL(String(fetch.mock.calls[1]?.[0])).href).toBe(
      'https://api.zapp.test/v1/projects?includeArchived=false&limit=20',
    );
    expect(new URL(String(fetch.mock.calls[2]?.[0])).pathname).toBe(
      '/v1/projects/proj_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
    );
  });

  it('rejects path parameters that can normalize into another route before authentication', async () => {
    // Break caught: dot segments and encoded slash/backslash variants survive
    // URL construction and can normalize an authenticated request to a new route.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const getToken = vi.fn(() => 'secret-token');
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(JSON.stringify({ project: { id: 'proj_1' } }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = sdk.createZappClient({ baseUrl: 'https://api.zapp.test', getToken, fetch });

    for (const projectId of [
      '.',
      '..',
      '%2e',
      '%2E%2E',
      '%252e%252e',
      '.\\',
      '..\\child',
      '%2fchild',
      '%5cchild',
    ]) {
      await expect(
        client.request('/v1/projects/{projectId}', {
          method: 'GET',
          path: { projectId },
        }),
      ).rejects.toThrow(/path parameter/i);
    }

    expect(getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      client.request('/v1/projects/{projectId}', {
        method: 'GET',
        path: { projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NC' },
      }),
    ).resolves.toEqual({ project: { id: 'proj_1' } });
    expect(getToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not retrieve a bearer token for public auth operations', async () => {
    // Break caught: bootstrap calls that cannot yet possess an access token
    // invoke getToken and can fail before reaching their public endpoint.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const getToken = vi.fn(() => 'secret-token');
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://idp.zapp.test/authorize' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://app.zapp.test' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deviceCode: 'device-code',
            expiresIn: 600,
            interval: 5,
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://api.zapp.test/v1/auth/login',
            verificationUriComplete: 'https://api.zapp.test/v1/auth/login?userCode=ABCD-EFGH',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            expiresIn: 900,
            tokenType: 'Bearer',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    const client = sdk.createZappClient({ baseUrl: 'https://api.zapp.test', getToken, fetch });

    await client.request('/v1/auth/login', { method: 'GET' });
    await client.request('/v1/auth/callback', { method: 'GET', query: { state: 'state' } });
    await client.request('/v1/auth/device', { method: 'GET' });
    await client.request('/v1/auth/device/token', {
      method: 'POST',
      body: { deviceCode: 'device-code' },
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(getToken).not.toHaveBeenCalled();
  });

  it('reaches a cookie-capable required operation when no bearer token is available', async () => {
    // Break caught: /v1/me allows a sessionCookie alternative, but a collapsed
    // required auth mode rejects before fetch when getToken has no bearer.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const getToken = vi.fn(() => Promise.reject(new Error('no bearer token')));
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: {
            id: 'user_1',
            email: 'cookie-user@zapp.test',
            displayName: 'Cookie User',
            avatarUrl: null,
          },
          memberships: [],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = sdk.createZappClient({ baseUrl: 'https://api.zapp.test', getToken, fetch });

    await expect(client.request('/v1/me', { method: 'GET' })).resolves.toMatchObject({
      user: { id: 'user_1' },
    });

    expect(getToken).toHaveBeenCalledOnce();
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(init?.credentials).toBe('include');
  });

  it('never retrieves or sends bearer auth for anonymous or refresh-cookie refresh', async () => {
    // Break caught: optional auth is mistaken for optional bearer auth, leaking
    // an access token to a route whose alternatives are anonymous and cookie-only.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const getToken = vi.fn(() => 'must-not-be-sent');
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(JSON.stringify({ tokenType: 'Bearer', expiresIn: 900 }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = sdk.createZappClient({ baseUrl: 'https://api.zapp.test', getToken, fetch });

    await client.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { authorization: 'Bearer caller-token' },
    });

    expect(getToken).not.toHaveBeenCalled();
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(init?.credentials).toBe('include');
  });

  it('uses optional bearer authentication when available and continues without it on failure', async () => {
    // Break caught: treating logout as public omits an available bearer token,
    // so the live endpoint returns 204 without revoking that access token.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    let bearerActive = true;
    const authenticatedFetch: FetchImplementation = (_url, init) => {
      if (new Headers(init.headers).get('authorization') === 'Bearer active-access-token') {
        bearerActive = false;
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const authenticated = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 'active-access-token',
      fetch: authenticatedFetch,
    });

    await expect(
      authenticated.request('/v1/auth/logout', { method: 'POST' }),
    ).resolves.toBeUndefined();
    expect(bearerActive).toBe(false);

    let authorization: string | null = 'not-requested';
    const tokenless = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => Promise.reject(new Error('no access token is available')),
      fetch: (_url, init) => {
        authorization = new Headers(init.headers).get('authorization');
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    await expect(
      tokenless.request('/v1/auth/logout', {
        method: 'POST',
        body: { refreshToken: 'refresh-token' },
      }),
    ).resolves.toBeUndefined();
    expect(authorization).toBeNull();
  });

  it('observes a documented redirect and returns its required location and status', async () => {
    // Break caught: automatic redirect following hides the documented 302, or
    // decoding it as undefined erases the required Location header.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const getToken = vi.fn(() => 'unused-token');
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://idp.zapp.test/authorize' },
      }),
    );
    const client = sdk.createZappClient({ baseUrl: 'https://api.zapp.test', getToken, fetch });

    await expect(client.request('/v1/auth/login', { method: 'GET' })).resolves.toEqual({
      status: 302,
      headers: { Location: 'https://idp.zapp.test/authorize' },
    });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0]?.[1].redirect).toBe('manual');
  });

  it.each([
    ['missing Location', () => new Response(null, { status: 302 })],
    [
      'undocumented media',
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://idp.zapp.test/authorize',
            'content-type': 'text/plain',
          },
        }),
    ],
    [
      'undocumented body',
      () =>
        new Response('private redirect marker', {
          status: 302,
          headers: { location: 'https://idp.zapp.test/authorize' },
        }),
    ],
  ])(
    'rejects a bodyless redirect with %s without exposing its response',
    async (_case, response) => {
      // Break caught: a 302 can violate its exact required-header/body/media
      // contract while the SDK still reports it as a valid redirect.
      const sdk = await loadSdk();
      expect(sdk?.createZappClient).toBeTypeOf('function');
      if (sdk === undefined) return;
      const client = sdk.createZappClient({
        baseUrl: 'https://api.zapp.test',
        getToken: () => 'unused',
        fetch: () => Promise.resolve(response()),
      });

      let error: unknown;
      try {
        await client.request('/v1/auth/login', { method: 'GET' });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ name: 'ZappProtocolError' });
      expect(String(error)).not.toContain('private redirect marker');
    },
  );

  it.each([
    [206, 'application/json'],
    [206, 'text/plain'],
    [200, 'text/plain'],
  ])(
    'rejects undocumented success status/media %i %s without exposing its body',
    async (status, mediaType) => {
      // Break caught: any response with ok=true and valid JSON is accepted even
      // when its exact status or media type is absent from the operation contract.
      const sdk = await loadSdk();
      expect(sdk?.createZappClient).toBeTypeOf('function');
      if (sdk === undefined) return;
      const marker = 'upstream-private-marker';
      const client = sdk.createZappClient({
        baseUrl: 'https://api.zapp.test',
        getToken: () => 'token',
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ marker }), {
              status,
              headers: { 'content-type': mediaType },
            }),
          ),
      });

      let error: unknown;
      try {
        await client.request('/v1/runs/{runId}', {
          method: 'GET',
          path: { runId: 'run_1' },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ name: 'ZappProtocolError' });
      expect(String(error)).not.toContain(marker);
    },
  );

  it('decodes all documented no-content operations as undefined', async () => {
    // Break caught: actual route handlers send 204 while generated clients claim
    // a 200/null success contract for the same operation.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 'token',
      fetch,
    });

    await expect(client.request('/v1/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
    await expect(
      client.request('/v1/auth/device/approve', {
        method: 'POST',
        body: { userCode: 'ABCD-EFGH' },
      }),
    ).resolves.toBeUndefined();
    await expect(
      client.request('/v1/auth/device/deny', {
        method: 'POST',
        body: { userCode: 'ABCD-EFGH' },
      }),
    ).resolves.toBeUndefined();
    await expect(
      client.request('/v1/organizations/{orgId}/members/{userId}', {
        method: 'DELETE',
        path: { orgId: 'org_1', userId: 'user_1' },
      }),
    ).resolves.toBeUndefined();
    await expect(
      client.request('/v1/projects/{projectId}/secrets/{secretId}', {
        method: 'DELETE',
        path: { projectId: 'proj_1', secretId: 'secret_1' },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects undocumented media or a body on an exact no-content response', async () => {
    // Break caught: returning early for body === null accepts a media-bearing
    // 204, while an undocumented body can be silently discarded as undefined.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const responses = [
      new Response(null, { status: 204, headers: { 'content-type': 'application/json' } }),
      {
        ok: true,
        status: 204,
        headers: new Headers(),
        body: stream(['private no-content marker']),
        text: () => Promise.resolve('private no-content marker'),
      },
    ];
    const fetch = vi.fn<FetchImplementation>();
    for (const response of responses) fetch.mockResolvedValueOnce(response);
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 'token',
      fetch,
    });

    for (const body of [{ userCode: 'ABCD-EFGH' }, { userCode: 'ABCD-EFGH' }]) {
      let error: unknown;
      try {
        await client.request('/v1/auth/device/approve', { method: 'POST', body });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ name: 'ZappProtocolError' });
      expect(String(error)).not.toContain('private no-content marker');
    }
  });

  it('rejects SSE via generic request and redacts invalid JSON response contents', async () => {
    // Break caught: generic JSON decoding accepts the stream endpoint and leaks
    // an HTML response prefix through JSON.parse's implementation error.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const getToken = vi.fn(() => 'token');
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(
        new Response(eventFrame(1), { headers: { 'content-type': 'text/event-stream' } }),
      );
    const client = sdk.createZappClient({ baseUrl: 'https://api.zapp.test', getToken, fetch });

    await expect(
      client.request(
        '/v1/runs/{runId}/events' as never,
        {
          method: 'GET',
          path: { runId: 'run_1' },
        } as never,
      ),
    ).rejects.toThrow(/event stream|subscribeRunEvents/i);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(
      new Response('<html>secret upstream marker</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
    let error: unknown;
    try {
      await client.request('/v1/runs/{runId}', {
        method: 'GET',
        path: { runId: 'run_1' },
      });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toMatch(/protocol|JSON/i);
    expect(String(error)).not.toContain('secret upstream marker');
    expect(String(error)).not.toContain('<html>');
  });

  it('preserves caller aborts after decoding an exact no-content response', async () => {
    // Break caught: a caller's cancellation is converted into an API failure
    // that UI code cannot recognize after an earlier no-content request.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const abort = new AbortController();
    controllers.push(abort);
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockImplementationOnce((_input, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              const reason: unknown = init.signal?.reason;
              reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      });
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
      eventStreamRetry: { random: () => 0 },
    });

    await expect(
      client.request('/v1/auth/device/approve', {
        method: 'POST',
        body: { userCode: 'ABCD-EFGH' },
      }),
    ).resolves.toBeUndefined();
    const pending = client.request('/v1/runs/{runId}', {
      method: 'GET',
      path: { runId: 'run_1' },
      signal: abort.signal,
    });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    abort.abort(new DOMException('Stopped by caller', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each([
    [
      'null body',
      () =>
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'empty body',
      () =>
        new Response('', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'literal null',
      () =>
        new Response('null', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'missing content type',
      () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: stream(['{"run":{"id":"run_1"}}']),
        text: () => Promise.resolve('{"run":{"id":"run_1"}}'),
      }),
    ],
    [
      'wrong content type',
      () =>
        new Response('{"run":{"id":"run_1"}}', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    ],
  ])('rejects a documented JSON 200 with %s', async (_case, response) => {
    // Break caught: required JSON response content is collapsed into an
    // optional body, allowing a protocol violation to become undefined.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 'token',
      fetch: () => Promise.resolve(response()),
    });

    await expect(
      client.request('/v1/runs/{runId}', {
        method: 'GET',
        path: { runId: 'run_1' },
      }),
    ).rejects.toMatchObject({ name: 'ZappProtocolError' });
  });

  it('reports API status and code without including token-bearing response text', async () => {
    // Break caught: an upstream error body leaks a bearer token through a
    // consumer-visible Error while callers lose the actionable status/code.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 'secret-device-token',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'run_not_found', message: 'secret-device-token must never escape' },
            }),
            {
              status: 404,
              statusText: 'Not Found',
              headers: { 'content-type': 'application/json' },
            },
          ),
        ),
    });

    let error: unknown;
    try {
      await client.request('/v1/runs/{runId}', { method: 'GET', path: { runId: 'run_1' } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ name: 'ZappApiError', status: 404, code: 'run_not_found' });
    expect(String(error)).not.toContain('secret-device-token');
  });
});

describe('subscribeRunEvents', () => {
  it('preserves a CRLF delimiter split across chunks and discards an incomplete EOF frame', async () => {
    // Break caught: a trailing CR is consumed before the next chunk's LF, or a
    // connection drop promotes a frame that never received its blank line.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    vi.useFakeTimers();
    const delivered: number[] = [];
    const errors: Error[] = [];
    const complete = eventFrame(8).replaceAll('\n', '\r\n');
    const splitAt = complete.indexOf('\r\n') + 1;
    const incomplete = eventFrame(9).replace(/\n\n$/, '\n');
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(
        new Response(stream([complete.slice(0, splitAt), complete.slice(splitAt)]), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(stream([incomplete]), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
      eventStreamRetry: { random: () => 0 },
    });
    const subscription = client.subscribeRunEvents('run_1', {
      onEvent(event) {
        delivered.push(Number(event.id));
      },
      onError(error) {
        errors.push(error);
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    subscription.close();
    await subscription.closed;

    expect(delivered).toEqual([8]);
    expect(errors).toEqual([]);
  });

  it('runtime-validates structured event data before delivery', async () => {
    // Break caught: syntactically valid JSON that is not an AgentEvent crosses
    // the SDK boundary and corrupts web or desktop run state.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const errors: Error[] = [];
    const delivered = vi.fn();
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(stream(['id: 8\nevent: task.updated\ndata: {"payload":{}}\n\n']), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
      eventStreamRetry: { random: () => 0 },
    });
    const subscription = client.subscribeRunEvents('run_1', {
      onEvent() {
        delivered();
        subscription.close();
      },
      onError(error) {
        errors.push(error);
        subscription.close();
      },
    });
    await subscription.closed;

    expect(delivered).not.toHaveBeenCalled();
    expect(errors[0]?.message).toMatch(/malformed SSE event/i);
  });

  it('terminates after one non-retryable 404 response', async () => {
    // Break caught: an expired or deleted run drives an infinite authenticated
    // reconnect storm even though another request cannot make the URL valid.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    vi.useFakeTimers();
    const errors: Error[] = [];
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'run_not_found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
      eventStreamRetry: { random: () => 0 },
    });
    const subscription = client.subscribeRunEvents('run_1', {
      onEvent() {},
      onError(error) {
        errors.push(error);
      },
    });

    await vi.advanceTimersByTimeAsync(5_000);
    subscription.close();
    await subscription.closed;

    expect(fetch).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ name: 'ZappApiError', status: 404 });
  });

  it('rejects a successful response whose content type is not text/event-stream', async () => {
    // Break caught: an HTML or JSON intermediary response is fed to the SSE
    // parser and repeatedly retried as if it were a valid event stream.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const errors: Error[] = [];
    const delivered = vi.fn();
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(
        new Response(eventFrame(8), { headers: { 'content-type': 'application/json' } }),
      );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
      eventStreamRetry: { random: () => 0 },
    });
    const subscription = client.subscribeRunEvents('run_1', {
      onEvent() {
        delivered();
        subscription.close();
      },
      onError(error) {
        errors.push(error);
        subscription.close();
      },
    });
    await subscription.closed;

    expect(delivered).not.toHaveBeenCalled();
    expect(errors[0]?.message).toMatch(/content type/i);
  });

  it('honors a bounded valid SSE retry value before reconnecting', async () => {
    // Break caught: the server's retry field is ignored and every disconnect
    // reconnects at the hard-coded one-second cadence.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    vi.useFakeTimers();
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(stream(['retry: 2500\n\n']), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
      eventStreamRetry: { random: () => 0 },
    });
    const subscription = client.subscribeRunEvents('run_1', { onEvent() {} });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    subscription.close();
    await subscription.closed;
  });

  it('preserves delivered cursor and retry state when the reader rejects', async () => {
    // Break caught: state is returned only at clean EOF, so a socket rejection
    // drops Last-Event-ID/retry and escalates backoff after successful delivery.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    vi.useFakeTimers();
    const delivered: string[] = [];
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(
        new Response(failingStream(`${eventFrame(1)}retry: 250\n\n`), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(failingStream(`${eventFrame(1)}retry: 250\n\n`), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
      .mockImplementation((_url, init) =>
        Promise.resolve(
          new Response(neverEndingStream(init.signal ?? new AbortController().signal), {
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
      );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 'token',
      fetch,
      eventStreamRetry: { random: () => 0 },
    });
    const subscription = client.subscribeRunEvents('run_1', {
      onEvent(event) {
        delivered.push(event.id);
      },
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[0]?.[1].headers).get('last-event-id')).toBeNull();
    expect(new Headers(fetch.mock.calls[1]?.[1].headers).get('last-event-id')).toBe('1');
    expect(delivered).toEqual(['1']);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);

    subscription.close();
    await subscription.closed;
  });

  it('aborts a blocked callback, cancels the reader, and closes promptly', async () => {
    // Break caught: close waits forever behind consumer work that never settles,
    // keeping an authenticated reader and its resources alive.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    let callbackStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    const cancel = vi.fn(() => Promise.resolve());
    const encoder = new TextEncoder();
    let read = false;
    const body = {
      getReader() {
        return {
          read() {
            if (read) return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
            read = true;
            return Promise.resolve({ done: false, value: encoder.encode(eventFrame(8)) });
          },
          cancel,
          releaseLock() {},
        };
      },
    } as unknown as ReadableStream<Uint8Array>;
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body,
      text: () => Promise.resolve(''),
    });
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
      eventStreamRetry: { random: () => 0 },
    });
    const subscription = client.subscribeRunEvents('run_1', {
      onEvent() {
        callbackStarted();
        return new Promise<void>(() => {});
      },
    });
    await started;
    subscription.close();
    const closeResult = await Promise.race([
      subscription.closed.then(() => 'closed'),
      new Promise<'timed-out'>((resolve) => {
        setTimeout(() => {
          resolve('timed-out');
        }, 50);
      }),
    ]);
    expect(closeResult).toBe('closed');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not await a non-cooperative reader cancellation during close', async () => {
    // Break caught: reader.cancel is best-effort, but awaiting a promise that
    // never settles prevents closed and final listener cleanup from resolving.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const releaseLock = vi.fn();
    const body = {
      getReader() {
        return {
          read() {
            readStarted();
            return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
          },
          cancel,
          releaseLock,
        };
      },
    } as unknown as ReadableStream<Uint8Array>;
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body,
      text: () => Promise.resolve(''),
    });
    const caller = new AbortController();
    controllers.push(caller);
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
    });
    const subscription = client.subscribeRunEvents('run_1', {
      signal: caller.signal,
      onEvent() {},
    });
    await started;

    subscription.close();

    await expect(closesWithin(subscription.closed)).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('contains a rejecting reader cancellation and completes all close cleanup', async () => {
    // Break caught: a rejected best-effort cancel becomes an unhandled rejection,
    // or prevents lock/listener cleanup and starts another authenticated fetch.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    vi.useFakeTimers();
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let rejectCancellation!: (reason?: unknown) => void;
    const cancellation = new Promise<void>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const handleCancellation = vi.spyOn(cancellation, 'catch');
    const cancel = vi.fn(() => cancellation);
    const releaseLock = vi.fn();
    const body = {
      getReader() {
        return {
          read() {
            readStarted();
            return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
          },
          cancel,
          releaseLock,
        };
      },
    } as unknown as ReadableStream<Uint8Array>;
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body,
      text: () => Promise.resolve(''),
    });
    const caller = new AbortController();
    controllers.push(caller);
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const unhandled: unknown[] = [];
    const captureUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', captureUnhandled);

    try {
      const client = sdk.createZappClient({
        baseUrl: 'https://api.zapp.test',
        getToken: () => 'token',
        fetch,
      });
      const subscription = client.subscribeRunEvents('run_1', {
        signal: caller.signal,
        onEvent() {},
      });
      await started;

      subscription.close();
      const closed = closesWithin(subscription.closed);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(closed).resolves.toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(handleCancellation).toHaveBeenCalledOnce();
      expect(releaseLock).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(fetch).toHaveBeenCalledOnce();
      rejectCancellation(new Error('cancel failed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', captureUnhandled);
    }
  });

  it.each(['getToken', 'fetch'] as const)(
    'closes promptly while a non-cooperative %s promise is pending',
    async (blockedAt) => {
      // Break caught: AbortSignal cannot settle an injected promise that ignores
      // it, so closed hangs before a stream reader even exists.
      const sdk = await loadSdk();
      expect(sdk?.createZappClient).toBeTypeOf('function');
      if (sdk === undefined) return;
      const add = vi.spyOn(AbortSignal.prototype, 'addEventListener');
      const remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
      const getToken = vi.fn(() =>
        blockedAt === 'getToken' ? new Promise<string>(() => {}) : 'token',
      );
      const fetch = vi.fn<FetchImplementation>(() => new Promise<Response>(() => {}));
      const client = sdk.createZappClient({
        baseUrl: 'https://api.zapp.test',
        getToken,
        fetch,
      });
      const subscription = client.subscribeRunEvents('run_1', { onEvent() {} });

      await vi.waitFor(() => {
        expect(blockedAt === 'getToken' ? getToken : fetch).toHaveBeenCalledOnce();
      });
      subscription.close();

      await expect(closesWithin(subscription.closed)).resolves.toBe(true);
      expect(fetch).toHaveBeenCalledTimes(blockedAt === 'fetch' ? 1 : 0);
      const addedAbortListeners = add.mock.calls.filter(([type]) => type === 'abort').length;
      const removedAbortListeners = remove.mock.calls.filter(([type]) => type === 'abort').length;
      expect(removedAbortListeners).toBeGreaterThanOrEqual(addedAbortListeners);
    },
  );

  it('reports callback failures separately from malformed JSON', async () => {
    // Break caught: consumer exceptions are rewritten as parse failures, which
    // sends debugging and retry policy down the wrong path.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const errors: Error[] = [];
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(
        new Response(stream([eventFrame(8)]), { headers: { 'content-type': 'text/event-stream' } }),
      );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
    });
    const subscription = client.subscribeRunEvents('run_1', {
      onEvent() {
        throw new Error('consumer failed');
      },
      onError(error) {
        errors.push(error);
        subscription.close();
      },
    });
    await subscription.closed;

    expect(errors[0]).toMatchObject({ name: 'SseCallbackError' });
    expect(errors[0]?.message).toMatch(/callback/i);
    expect(errors[0]?.message).not.toMatch(/JSON/i);
  });

  it('reconnects and replays an event whose callback rejects without advancing the cursor', async () => {
    // Break caught: callback rejection is reported but stream consumption keeps
    // going, allowing a later event to advance the resume cursor past lost work.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    vi.useFakeTimers();
    const delivered: string[] = [];
    const errors: Error[] = [];
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(
        new Response(stream([eventFrame(1), eventFrame(2)]), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(stream([eventFrame(1)]), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 'token',
      fetch,
      eventStreamRetry: { random: () => 0 },
    });
    let attempts = 0;
    const subscription = client.subscribeRunEvents('run_1', {
      onEvent(event) {
        delivered.push(event.id);
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('consumer failed'));
        return undefined;
      },
      onError(error) {
        errors.push(error);
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    subscription.close();
    await subscription.closed;

    expect(delivered).toEqual(['1', '1']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ name: 'SseCallbackError' });
    expect(new Headers(fetch.mock.calls[1]?.[1].headers).get('last-event-id')).toBeNull();
  });

  it.each([
    ['-1', -1],
    ['1\0', 1],
    ['9007199254740992', 9007199254740992],
    ['9007199254740993', 9007199254740992],
  ])('rejects unsafe SSE id %s without delivery', async (id, sequence) => {
    // Break caught: Number conversion rounds an overflowing textual SSE id to
    // the same unsafe number as AgentEvent.sequence and falsely accepts it.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const delivered = vi.fn();
    const errors: Error[] = [];
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(stream([rawEventFrame(id, sequence)]), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
    });
    const subscription = client.subscribeRunEvents('run_1', {
      onEvent() {
        delivered();
        subscription.close();
      },
      onError(error) {
        errors.push(error);
        subscription.close();
      },
    });
    await subscription.closed;

    expect(delivered).not.toHaveBeenCalled();
    expect(errors[0]?.message).toMatch(/malformed SSE event/i);
  });

  it('accepts and preserves the maximum safe SSE sequence id', async () => {
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const delivered: string[] = [];
    const maxSafe = Number.MAX_SAFE_INTEGER;
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(stream([rawEventFrame(String(maxSafe), maxSafe)]), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
    });
    const subscription = client.subscribeRunEvents('run_1', {
      onEvent(event) {
        delivered.push(event.id);
        subscription.close();
      },
    });
    await subscription.closed;

    expect(delivered).toEqual([String(maxSafe)]);
  });

  it('removes the delay abort listener after a normal timeout', async () => {
    // Break caught: every healthy reconnect leaves an abort listener attached
    // until close, creating unbounded retained callbacks on long subscriptions.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    vi.useFakeTimers();
    const add = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    const remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    let streamSignal: AbortSignal | undefined;
    const fetch = vi.fn<FetchImplementation>().mockImplementation((_url, init) => {
      streamSignal = init.signal;
      return Promise.resolve(
        new Response(stream([]), { headers: { 'content-type': 'text/event-stream' } }),
      );
    });
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
      eventStreamRetry: { random: () => 0 },
    });
    const subscription = client.subscribeRunEvents('run_1', { onEvent() {} });
    await vi.advanceTimersByTimeAsync(1_000);

    const addedToStreamSignal = add.mock.instances.filter((instance) => instance === streamSignal);
    const removedFromStreamSignal = remove.mock.instances.filter(
      (instance) => instance === streamSignal,
    );
    expect(removedFromStreamSignal.length).toBeGreaterThanOrEqual(addedToStreamSignal.length - 1);
    subscription.close();
    await subscription.closed;
  });

  it('parses arbitrarily split multiline events with initial after and bearer headers', async () => {
    // Break caught: a normal TCP chunk boundary or multiline SSE payload loses
    // structured run state, or the authenticated stream opens without its
    // required resume/authentication headers.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const delivered: unknown[] = [];
    let eventDelivered!: () => void;
    const deliveredEvent = new Promise<void>((resolve) => {
      eventDelivered = resolve;
    });
    const data = JSON.stringify(agentEvent(8, 'task.updated', { step: 'one' }));
    const splitAt = data.indexOf('"visibility"');
    const fetch = vi.fn<FetchImplementation>().mockImplementation(() => {
      const response = new Response(
        stream([
          `id: 8\nevent: task.updated\ndata: ${data.slice(0, splitAt)}`,
          `\ndata: ${data.slice(splitAt)}\n\n`,
        ]),
        { headers: { 'content-type': 'text/event-stream' } },
      );
      return Promise.resolve(response);
    });
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 'token-8',
      fetch,
    });
    const subscription = client.subscribeRunEvents('run_1', {
      after: 7,
      onEvent(event) {
        delivered.push(event);
        eventDelivered();
      },
    });
    await deliveredEvent;
    subscription.close();
    await subscription.closed;

    const [input, init] = fetch.mock.calls[0] ?? [];
    expect(new URL(String(input)).href).toBe('https://api.zapp.test/v1/runs/run_1/events?after=7');
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('authorization')).toBe('Bearer token-8');
    expect(delivered).toEqual([
      { id: '8', type: 'task.updated', data: agentEvent(8, 'task.updated', { step: 'one' }) },
    ]);
  });

  it('reconnects with Last-Event-ID and never delivers a repeated event id twice', async () => {
    // Break caught: reconnects use the initial query forever or duplicate a
    // committed run event after a dropped stream.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    vi.useFakeTimers();
    const delivered: string[] = [];
    let completed!: () => void;
    const completedEvent = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(
        new Response(stream([eventFrame(4, 'run.started')]), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(stream([eventFrame(4, 'run.started'), eventFrame(5, 'run.completed')]), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
      eventStreamRetry: { random: () => 0 },
    });
    const subscription = client.subscribeRunEvents('run_1', {
      after: 3,
      onEvent(event) {
        delivered.push(event.id);
        if (event.id === '5') completed();
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await completedEvent;
    subscription.close();
    await subscription.closed;

    expect(delivered).toEqual(['4', '5']);
    const [firstUrl] = fetch.mock.calls[0] ?? [];
    const [secondUrl, secondInit] = fetch.mock.calls[1] ?? [];
    expect(new URL(String(firstUrl)).searchParams.get('after')).toBe('3');
    expect(new URL(String(secondUrl)).search).toBe('');
    expect(new Headers(secondInit?.headers).get('last-event-id')).toBe('4');
  });

  it('reports malformed events and close prevents another reconnect', async () => {
    // Break caught: corrupt SSE JSON reaches UI state, or closing a view still
    // opens an authenticated background connection.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    vi.useFakeTimers();
    const errors: Error[] = [];
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(stream(['id: 9\nevent: task.updated\ndata: not-json\n\n']), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
    });
    const subscription = client.subscribeRunEvents('run_1', {
      onEvent() {
        throw new Error('malformed events must not be delivered');
      },
      onError(error) {
        errors.push(error);
        subscription.close();
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await subscription.closed;

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/malformed SSE event/i);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('stops reconnecting when the caller aborts the subscription signal', async () => {
    // Break caught: navigation aborts a stream but the reconnect loop opens a
    // new bearer-authenticated request after the caller has left.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    vi.useFakeTimers();
    const abort = new AbortController();
    controllers.push(abort);
    const fetch = vi.fn<FetchImplementation>().mockImplementation((_url, init) => {
      void _url;
      return Promise.resolve(
        new Response(neverEndingStream(init.signal ?? new AbortController().signal), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    });
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
    });
    const subscription = client.subscribeRunEvents('run_1', {
      signal: abort.signal,
      onEvent() {},
    });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort(new DOMException('View closed', 'AbortError'));
    await subscription.closed;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetch).toHaveBeenCalledOnce();
  });
});
