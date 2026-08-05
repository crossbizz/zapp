const RECONNECT_DELAY_MS = 1_000;

export type QueryValue = string | number | boolean | readonly (string | number | boolean)[] | null | undefined;

/** The portable subset of a Fetch response the SDK consumes. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}

/** Injectable to make client and streaming behavior deterministic in tests. */
export type FetchImplementation = (
  input: URL,
  init: { readonly method?: string; readonly headers?: Headers; readonly body?: string; readonly signal?: AbortSignal },
) => Promise<FetchResponse>;

export type ClientHeaders = Headers | Readonly<Record<string, string>>;

export interface ZappClientOptions {
  readonly baseUrl: string;
  readonly getToken: () => string | Promise<string>;
  readonly fetch?: FetchImplementation;
}

export interface RequestOptions {
  readonly method: string;
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
  readonly headers?: ClientHeaders;
  readonly signal?: AbortSignal;
}

export interface RunEvent {
  readonly id: string;
  readonly type: string;
  readonly data: unknown;
}

export interface SubscribeRunEventsOptions {
  readonly after?: number;
  readonly onEvent: (event: RunEvent) => void | Promise<void>;
  readonly onError?: (error: Error) => void;
  readonly signal?: AbortSignal;
}

export interface EventSubscription {
  close(): void;
  readonly closed: Promise<void>;
}

export interface ZappClient {
  request<T>(path: string, options: RequestOptions): Promise<T | undefined>;
  subscribeRunEvents(runId: string, options: SubscribeRunEventsOptions): EventSubscription;
}

/** A public API failure with safe-to-display machine-readable context only. */
export class ZappApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined) {
    super(`API request failed with status ${String(status)}${code === undefined ? '' : ` (${code})`}.`);
    this.name = 'ZappApiError';
    this.status = status;
    this.code = code;
  }
}

class SseParseError extends Error {
  constructor(message: string) {
    super(`Malformed SSE event: ${message}`);
    this.name = 'SseParseError';
  }
}

/**
 * Creates a client for zapp.build's public `/v1` API. Authentication happens
 * per request so a rotated device/session token never becomes stale in a long-
 * lived desktop or browser client.
 */
export function createZappClient(options: ZappClientOptions): ZappClient {
  const baseUrl = new URL(options.baseUrl);
  const fetch: FetchImplementation =
    options.fetch ??
    ((input, init) => globalThis.fetch(input, init));

  return {
    async request<T>(path: string, requestOptions: RequestOptions): Promise<T | undefined> {
      const url = requestUrl(baseUrl, path, requestOptions.query);
      const response = await fetch(url, {
        method: requestOptions.method,
        headers: await requestHeaders(options.getToken, requestOptions.headers, requestOptions.body),
        ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      });

      if (!response.ok) throw await apiError(response);
      if (
        response.status === 204 ||
        response.status === 205 ||
        response.body === null ||
        response.headers.get('content-length') === '0'
      ) {
        return undefined;
      }
      return (await response.json()) as T;
    },

    subscribeRunEvents(runId: string, subscribeOptions: SubscribeRunEventsOptions): EventSubscription {
      const controller = new AbortController();
      const close = (): void => {
        controller.abort();
      };
      const abortFromCaller = (): void => {
        controller.abort(subscribeOptions.signal?.reason);
      };
      subscribeOptions.signal?.addEventListener('abort', abortFromCaller, { once: true });
      if (subscribeOptions.signal?.aborted) abortFromCaller();

      const closed = runEventSubscription({
        baseUrl,
        fetch,
        getToken: options.getToken,
        runId,
        options: subscribeOptions,
        signal: controller.signal,
      }).finally(() => {
        subscribeOptions.signal?.removeEventListener('abort', abortFromCaller);
      });

      return { close, closed };
    },
  };
}

function requestUrl(baseUrl: URL, path: string, query: RequestOptions['query']): URL {
  const url = new URL(path, baseUrl);
  if (query === undefined) return url;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) url.searchParams.append(key, String(item));
  }
  return url;
}

async function requestHeaders(
  getToken: ZappClientOptions['getToken'],
  headers: ClientHeaders | undefined,
  body: unknown,
): Promise<Headers> {
  const token = await getToken();
  if (token.length === 0) throw new Error('A non-empty zapp API token is required.');
  const result =
    headers === undefined
      ? new Headers()
      : headers instanceof Headers
        ? new Headers(headers)
        : new Headers(Object.entries(headers));
  result.set('authorization', `Bearer ${token}`);
  if (body !== undefined && !result.has('content-type')) result.set('content-type', 'application/json');
  return result;
}

async function apiError(response: FetchResponse): Promise<ZappApiError> {
  let code: string | undefined;
  try {
    const parsed = (await response.json()) as { error?: { code?: unknown } };
    if (typeof parsed.error?.code === 'string') code = parsed.error.code;
  } catch {
    // An invalid error body is not a reason to disclose it to a caller.
  }
  return new ZappApiError(response.status, code);
}

interface RunEventSubscriptionInput {
  readonly baseUrl: URL;
  readonly fetch: FetchImplementation;
  readonly getToken: ZappClientOptions['getToken'];
  readonly runId: string;
  readonly options: SubscribeRunEventsOptions;
  readonly signal: AbortSignal;
}

async function runEventSubscription(input: RunEventSubscriptionInput): Promise<void> {
  const after = input.options.after;
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
    throw new RangeError('SSE after must be a non-negative integer.');
  }

  let initial = true;
  let latestId = after === undefined ? undefined : String(after);

  while (!input.signal.aborted) {
    try {
      const url = requestUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}/events`,
        initial && after !== undefined ? { after } : undefined);
      const headers = await requestHeaders(input.getToken, { accept: 'text/event-stream' }, undefined);
      if (!initial && latestId !== undefined) headers.set('last-event-id', latestId);
      initial = false;

      const response = await input.fetch(url, { headers, signal: input.signal });
      if (!response.ok) throw await apiError(response);
      if (response.body === null) throw new SseParseError('the stream response has no body.');

      latestId = await consumeEventStream(response.body, latestId, input.options.onEvent, (error) => {
        reportSseError(input.options, error);
      });
    } catch (error) {
      if (isAborted(input.signal)) return;
      reportSseError(input.options, safeError(error));
    }

    if (isAborted(input.signal)) return;
    try {
      await delay(RECONNECT_DELAY_MS, input.signal);
    } catch {
      return;
    }
  }
}

async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  latestId: string | undefined,
  onEvent: SubscribeRunEventsOptions['onEvent'],
  onError: (error: Error) => void,
): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let current: { id?: string; type?: string; data: string[] } = { data: [] };

  const dispatch = async (): Promise<void> => {
    if (current.id === undefined && current.type === undefined && current.data.length === 0) return;
    const event = current;
    current = { data: [] };
    try {
      if (event.id === undefined || !/^\d+$/.test(event.id)) {
        throw new SseParseError('id must be a non-negative integer.');
      }
      if (event.type === undefined || event.type.length === 0) {
        throw new SseParseError('event type is required.');
      }
      if (event.data.length === 0) throw new SseParseError('data is required.');
      if (latestId !== undefined && Number(event.id) <= Number(latestId)) return;
      const data = JSON.parse(event.data.join('\n')) as unknown;
      await onEvent({ id: event.id, type: event.type, data });
      latestId = event.id;
    } catch (error) {
      onError(error instanceof SseParseError ? error : new SseParseError('data is not valid JSON.'));
    }
  };

  const line = async (value: string): Promise<void> => {
    if (value === '') {
      await dispatch();
      return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon === -1 ? value : value.slice(0, colon);
    const raw = colon === -1 ? '' : value.slice(colon + 1);
    const data = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'id') current.id = data;
    else if (field === 'event') current.type = data;
    else if (field === 'data') current.data.push(data);
  };

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      for (;;) {
        const separator = buffered.match(/\r\n|\r|\n/);
        if (separator?.index === undefined) break;
        const value = buffered.slice(0, separator.index);
        buffered = buffered.slice(separator.index + separator[0].length);
        await line(value);
      }
    }
    buffered += decoder.decode();
    if (buffered.length > 0) await line(buffered);
    await dispatch();
  } finally {
    reader.releaseLock();
  }
  return latestId;
}

function reportSseError(options: SubscribeRunEventsOptions, error: Error): void {
  try {
    options.onError?.(error);
  } catch {
    // Consumer callbacks must not keep an authenticated reconnect loop alive.
  }
}

function safeError(error: unknown): Error {
  return error instanceof ZappApiError || error instanceof SseParseError
    ? error
    : new Error('Run event stream disconnected.');
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(abortError(signal));
      },
      { once: true },
    );
  });
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}
