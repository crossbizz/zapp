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

function agentEvent(sequence: number, type = 'task.updated', payload: Record<string, unknown> = {}) {
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

describe('createZappClient', () => {
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

    await expect(
      client.request(path as never, { method: 'GET' } as never),
    ).rejects.toThrow(/public API path|supported operation/i);
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ project: { id: 'proj_1' } }), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], nextCursor: null }), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ project: { id: 'proj_1' } }), {
        headers: { 'content-type': 'application/json' },
      }));
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
      path: { projectId: 'proj/slash' },
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
    expect(new URL(String(fetch.mock.calls[2]?.[0])).pathname).toBe('/v1/projects/proj%2Fslash');
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
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 't',
      fetch,
      eventStreamRetry: { random: () => 0 },
    });

    await expect(client.request('/v1/auth/device/approve', {
      method: 'POST',
      body: { userCode: 'ABCD-EFGH' },
    })).resolves.toBeUndefined();
    await expect(client.request('/v1/runs/{runId}', {
      method: 'GET',
      path: { runId: 'run_1' },
    })).resolves.toBeUndefined();
    const pending = client.request('/v1/runs/{runId}', {
      method: 'GET',
      path: { runId: 'run_1' },
      signal: abort.signal,
    });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(3);
    });
    abort.abort(new DOMException('Stopped by caller', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('accepts a streamed empty 200 response without a content-length header', async () => {
    // Break caught: a portable fetch response has a non-null empty stream, so
    // calling json() reports a syntax error for a successful no-content call.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const client = sdk.createZappClient({
      baseUrl: 'https://api.zapp.test',
      getToken: () => 'token',
      fetch: () => Promise.resolve(new Response(stream([]), { status: 200 })),
    });

    await expect(
      client.request('/v1/runs/{runId}', { method: 'GET', path: { runId: 'run_1' } }),
    ).resolves.toBeUndefined();
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
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
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

  it('reports callback failures separately from malformed JSON', async () => {
    // Break caught: consumer exceptions are rewritten as parse failures, which
    // sends debugging and retry policy down the wrong path.
    const sdk = await loadSdk();
    expect(sdk?.createZappClient).toBeTypeOf('function');
    if (sdk === undefined) return;
    const errors: Error[] = [];
    const fetch = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response(stream([eventFrame(8)]), { headers: { 'content-type': 'text/event-stream' } }),
    );
    const client = sdk.createZappClient({ baseUrl: 'https://api.zapp.test', getToken: () => 't', fetch });
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
    const removedFromStreamSignal = remove.mock.instances.filter((instance) => instance === streamSignal);
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
      return Promise.resolve(
        new Response(neverEndingStream(init.signal ?? new AbortController().signal), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
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
