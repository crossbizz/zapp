import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('createZappClient', () => {
  it('adds a fetched bearer token and encodes path query, body, and caller headers', async () => {
    // Break caught: a client silently drops query/body/authentication fields and
    // requests a different public API contract than its caller specified.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
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
      client.request<{ project: { id: string } }>('/v1/projects', {
        method: 'POST',
        query: { includeArchived: false, tag: ['first', 'second'], ignored: undefined },
        body: { name: 'Checkout' },
        headers: { 'x-request-id': 'request-1' },
      }),
    ).resolves.toEqual({ project: { id: 'proj_1' } });

    expect(fetch).toHaveBeenCalledOnce();
    const [input, init] = fetch.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.href).toBe(
      'https://api.zapp.test/v1/projects?includeArchived=false&tag=first&tag=second',
    );
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ name: 'Checkout' }) });
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer device-token');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-request-id')).toBe('request-1');
  });

  it('decodes an empty successful response and preserves caller aborts', async () => {
    // Break caught: DELETE-like endpoints throw while a caller's cancellation
    // is converted into an API failure that UI code cannot recognize.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const abort = new AbortController();
    controllers.push(abort);
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
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
    const client = sdk.createZappClient({ baseUrl: 'https://api.zapp.test', getToken: () => 't', fetch });

    await expect(client.request('/v1/projects/proj_1', { method: 'DELETE' })).resolves.toBeUndefined();
    await expect(client.request('/v1/projects/proj_1', { method: 'GET' })).resolves.toBeUndefined();
    const pending = client.request('/v1/projects/proj_1', { method: 'GET', signal: abort.signal });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(3);
    });
    abort.abort(new DOMException('Stopped by caller', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
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
        Promise.resolve(new Response(
          JSON.stringify({
            error: { code: 'run_not_found', message: 'secret-device-token must never escape' },
          }),
          { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } },
        )),
    });

    let error: unknown;
    try {
      await client.request('/v1/runs/run_1', { method: 'GET' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ name: 'ZappApiError', status: 404, code: 'run_not_found' });
    expect(String(error)).not.toContain('secret-device-token');
  });
});

describe('subscribeRunEvents', () => {
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
    const fetch = vi.fn<FetchImplementation>().mockImplementation(() => {
      const response = new Response(
        stream(['id: 8\nevent: task.updated\ndata: {"step":', '\ndata: "one"}\n\n']),
        { headers: { 'content-type': 'text/event-stream' } },
      );
      return Promise.resolve(response);
    });
    const client = sdk.createZappClient({ baseUrl: 'https://api.zapp.test', getToken: () => 'token-8', fetch });
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
      { id: '8', type: 'task.updated', data: { step: 'one' } },
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
      .mockResolvedValueOnce(new Response(stream(['id: 4\nevent: run.started\ndata: {}\n\n'])))
      .mockResolvedValueOnce(
        new Response(stream(['id: 4\nevent: run.started\ndata: {}\n\nid: 5\nevent: run.completed\ndata: {}\n\n'])),
      );
    const client = sdk.createZappClient({ baseUrl: 'https://api.zapp.test', getToken: () => 't', fetch });
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
      new Response(stream(['id: 9\nevent: task.updated\ndata: not-json\n\n'])),
    );
    const client = sdk.createZappClient({ baseUrl: 'https://api.zapp.test', getToken: () => 't', fetch });
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
      return Promise.resolve(new Response(neverEndingStream(init.signal ?? new AbortController().signal)));
    });
    const client = sdk.createZappClient({ baseUrl: 'https://api.zapp.test', getToken: () => 't', fetch });
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
