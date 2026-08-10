import { AgentEventSchema, GatewayStreamEventSchema } from '@zapp/contracts';
import { createParser, type EventSourceMessage } from 'eventsource-parser';

import { PUBLIC_API_OPERATIONS } from './generated-operations.js';
import type { paths } from './generated.js';

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MIN_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_JITTER_RATIO = 0.2;
type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';
export type PublicApiPath = keyof paths;
type PathOperation<Path extends PublicApiPath, Method extends HttpMethod> = Exclude<
  paths[Path][Method],
  undefined
>;
type ResponseMediaTypes<Value> = Value extends { content: infer Content } ? keyof Content : never;
type SuccessfulMediaTypes<Value> = Value extends { responses: infer Responses }
  ? {
      [Status in keyof Responses]: `${Status & (string | number)}` extends `2${string}`
        ? ResponseMediaTypes<Responses[Status]>
        : never;
    }[keyof Responses]
  : never;
export type PublicApiMethod<Path extends PublicApiPath> = {
  [Method in HttpMethod]: [PathOperation<Path, Method>] extends [never]
    ? never
    : 'text/event-stream' extends SuccessfulMediaTypes<PathOperation<Path, Method>>
      ? never
      : Uppercase<Method>;
}[HttpMethod];
type Operation<Path extends PublicApiPath, Method extends PublicApiMethod<Path>> = Exclude<
  paths[Path][Lowercase<Method> & HttpMethod],
  undefined
>;
type OperationParameters<Value> = Value extends { parameters: infer Parameters }
  ? Parameters
  : never;
type OperationParameter<
  Value,
  Name extends PropertyKey,
> = Name extends keyof OperationParameters<Value>
  ? Exclude<OperationParameters<Value>[Name], undefined>
  : never;
type PathOption<Value> = [OperationParameter<Value, 'path'>] extends [never]
  ? { readonly path?: never }
  : OperationParameters<Value> extends { path: unknown }
    ? { readonly path: OperationParameter<Value, 'path'> }
    : { readonly path?: OperationParameter<Value, 'path'> };
type QueryOption<Value> = [OperationParameter<Value, 'query'>] extends [never]
  ? { readonly query?: never }
  : OperationParameters<Value> extends { query: unknown }
    ? { readonly query: OperationParameter<Value, 'query'> }
    : { readonly query?: OperationParameter<Value, 'query'> };
type HeaderOption<Value> = [OperationParameter<Value, 'header'>] extends [never]
  ? { readonly headers?: ClientHeaders }
  : OperationParameters<Value> extends { header: unknown }
    ? { readonly headers: ClientHeaders & OperationParameter<Value, 'header'> }
    : { readonly headers?: ClientHeaders & OperationParameter<Value, 'header'> };
type RequestBody<Value> = Value extends { requestBody?: infer Body }
  ? Exclude<Body, undefined> extends { content: infer Content }
    ? Content extends { 'application/json': infer Json }
      ? Json
      : Content extends object
        ? Content[keyof Content]
        : never
    : never
  : never;
type BodyOption<Value> = [RequestBody<Value>] extends [never]
  ? { readonly body?: never }
  : Value extends { requestBody: unknown }
    ? { readonly body: RequestBody<Value> }
    : { readonly body?: RequestBody<Value> };
type NumericStatus<Status> = Status extends number
  ? Status
  : Status extends `${infer Value extends number}`
    ? Value
    : never;
type ResponseContent<Status, Value> = Value extends { content: infer Content }
  ? Content extends object
    ? Content[keyof Content]
    : undefined
  : Value extends { headers: { Location: infer Location } }
    ? {
        readonly status: NumericStatus<Status>;
        readonly headers: { readonly Location: Location };
      }
    : undefined;
type SuccessfulResponse<Value> = Value extends { responses: infer Responses }
  ? {
      [Status in keyof Responses]: `${Status & (string | number)}` extends `${2 | 3}${string}`
        ? ResponseContent<Status, Responses[Status]>
        : never;
    }[keyof Responses]
  : never;

export type QueryValue =
  string | number | boolean | readonly (string | number | boolean)[] | null | undefined;

/** The portable subset of a Fetch response the SDK consumes. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/** Injectable to make client and streaming behavior deterministic in tests. */
export type FetchImplementation = (
  input: URL,
  init: {
    readonly method?: string;
    readonly headers?: Headers;
    readonly body?: string | FormData;
    readonly signal?: AbortSignal;
    readonly credentials?: RequestCredentials;
    readonly redirect?: RequestRedirect;
  },
) => Promise<FetchResponse>;

export type ClientHeaders = Headers | Readonly<Record<string, string>>;

export interface EventStreamRetryOptions {
  /** Injectable random source. Return `0` for deterministic no-jitter tests. */
  readonly random?: () => number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface ZappClientOptions {
  readonly baseUrl: string;
  readonly getToken: () => string | Promise<string>;
  readonly fetch?: FetchImplementation;
  readonly eventStreamRetry?: EventStreamRetryOptions;
}

export type RequestOptions<Path extends PublicApiPath, Method extends PublicApiMethod<Path>> = {
  readonly method: Method;
  readonly signal?: AbortSignal;
} & PathOption<Operation<Path, Method>> &
  QueryOption<Operation<Path, Method>> &
  HeaderOption<Operation<Path, Method>> &
  BodyOption<Operation<Path, Method>>;

export type RunEventData =
  paths['/v1/runs/{runId}/events']['get']['responses'][200]['content']['text/event-stream'];

export interface RunEvent {
  readonly id: string;
  readonly type: RunEventData['type'];
  readonly data: RunEventData;
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
  request<Path extends PublicApiPath, Method extends PublicApiMethod<Path>>(
    path: Path,
    options: RequestOptions<Path, Method>,
  ): Promise<SuccessfulResponse<Operation<Path, Method>>>;
  subscribeRunEvents(runId: string, options: SubscribeRunEventsOptions): EventSubscription;
  streamLocalAgentCompletion(
    sessionId: string,
    body: LocalAgentCompletionRequest,
    options: LocalAgentCompletionOptions,
  ): AsyncIterable<LocalAgentCompletionEvent>;
}

export type LocalAgentCompletionRequest =
  paths['/v1/local-agent/sessions/{sessionId}/completions']['post']['requestBody']['content']['application/json'];
export type LocalAgentCompletionEvent =
  paths['/v1/local-agent/sessions/{sessionId}/completions']['post']['responses'][200]['content']['text/event-stream'];

export interface LocalAgentCompletionOptions {
  readonly organizationId: string;
  readonly signal?: AbortSignal;
}

/** A public API failure with safe-to-display machine-readable context only. */
export class ZappApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined) {
    super(
      `API request failed with status ${String(status)}${code === undefined ? '' : ` (${code})`}.`,
    );
    this.name = 'ZappApiError';
    this.status = status;
    this.code = code;
  }
}

/** A safe response-shape failure that never includes response contents. */
export class ZappProtocolError extends Error {
  constructor() {
    super('API response did not match the generated operation contract.');
    this.name = 'ZappProtocolError';
  }
}

class SseParseError extends Error {
  constructor(message: string) {
    super(`Malformed SSE event: ${message}`);
    this.name = 'SseParseError';
  }
}

class SseProtocolError extends Error {
  constructor(message: string) {
    super(`Invalid SSE response: ${message}`);
    this.name = 'SseProtocolError';
  }
}

class SseCallbackError extends Error {
  constructor() {
    super('Run event callback failed.');
    this.name = 'SseCallbackError';
  }
}

interface RuntimeRequestOptions {
  readonly method: string;
  readonly path?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
  readonly headers?: ClientHeaders;
  readonly signal?: AbortSignal;
}

interface ResponseMetadata {
  readonly body: 'required' | 'forbidden';
  readonly mediaTypes: readonly string[];
  readonly requiredHeaders: readonly string[];
}

interface OperationMetadata {
  readonly security: readonly Readonly<Record<string, readonly string[]>>[];
  readonly successResponses: Readonly<Record<string, ResponseMetadata | undefined>>;
}

/** Creates an authenticated client for zapp.build's generated public `/v1` API. */
export function createZappClient(options: ZappClientOptions): ZappClient {
  const baseUrl = new URL(options.baseUrl);
  const fetch: FetchImplementation =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  return {
    async request<Path extends PublicApiPath, Method extends PublicApiMethod<Path>>(
      path: Path,
      requestOptions: RequestOptions<Path, Method>,
    ): Promise<SuccessfulResponse<Operation<Path, Method>>> {
      const runtimeOptions = requestOptions as RuntimeRequestOptions;
      const operation = publicOperation(path, runtimeOptions.method);
      if (operationHasMediaType(operation, 'text/event-stream')) {
        throw new RangeError('Event stream operations must use subscribeRunEvents.');
      }
      const url = requestUrl(baseUrl, path, runtimeOptions.path, runtimeOptions.query);
      const headers = await requestHeaders(
        options.getToken,
        runtimeOptions.headers,
        runtimeOptions.body,
        operation,
        runtimeOptions.signal,
      );
      const responsePromise = fetch(url, {
        method: runtimeOptions.method,
        headers,
        ...(runtimeOptions.body === undefined
          ? {}
          : {
              body: isFormData(runtimeOptions.body)
                ? runtimeOptions.body
                : JSON.stringify(runtimeOptions.body),
            }),
        ...(runtimeOptions.signal === undefined ? {} : { signal: runtimeOptions.signal }),
        ...(operationUsesCookies(operation) || operationHasRedirect(operation)
          ? { credentials: 'include' }
          : {}),
        ...(operationHasRedirect(operation) ? { redirect: 'manual' } : {}),
      });
      const response =
        runtimeOptions.signal === undefined
          ? await responsePromise
          : await raceAbort(responsePromise, runtimeOptions.signal);

      const responseMetadata = operation.successResponses[String(response.status)];
      if (responseMetadata === undefined) {
        if (response.status >= 400) throw await apiError(response);
        throw new ZappProtocolError();
      }
      const contentTypeHeader = response.headers.get('content-type');
      if (responseMetadata.body === 'forbidden') {
        if (response.body !== null || contentTypeHeader !== null) throw new ZappProtocolError();
        const requiredHeaders = responseHeaders(response, responseMetadata.requiredHeaders);
        return (
          responseMetadata.requiredHeaders.length === 0
            ? undefined
            : { status: response.status, headers: requiredHeaders }
        ) as SuccessfulResponse<Operation<Path, Method>>;
      }
      if (response.body === null) throw new ZappProtocolError();
      const mediaType = contentTypeHeader?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType === undefined || !responseMetadata.mediaTypes.includes(mediaType)) {
        throw new ZappProtocolError();
      }
      const payload = await response.text();
      if (payload.trim().length === 0) throw new ZappProtocolError();
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch {
        throw new ZappProtocolError();
      }
      if (parsed === null) throw new ZappProtocolError();
      return parsed as SuccessfulResponse<Operation<Path, Method>>;
    },

    subscribeRunEvents(
      runId: string,
      subscribeOptions: SubscribeRunEventsOptions,
    ): EventSubscription {
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
        retry: options.eventStreamRetry,
        signal: controller.signal,
        operation: publicOperation('/v1/runs/{runId}/events', 'GET'),
      }).finally(() => {
        subscribeOptions.signal?.removeEventListener('abort', abortFromCaller);
      });

      return { close, closed };
    },

    streamLocalAgentCompletion(sessionId, body, streamOptions) {
      return localAgentCompletionStream({
        baseUrl,
        fetch,
        getToken: options.getToken,
        sessionId,
        body,
        options: streamOptions,
        operation: publicOperation(
          '/v1/local-agent/sessions/{sessionId}/completions',
          'POST',
        ),
      });
    },
  };
}

interface LocalAgentCompletionStreamInput {
  readonly baseUrl: URL;
  readonly fetch: FetchImplementation;
  readonly getToken: ZappClientOptions['getToken'];
  readonly sessionId: string;
  readonly body: LocalAgentCompletionRequest;
  readonly options: LocalAgentCompletionOptions;
  readonly operation: OperationMetadata;
}

async function* localAgentCompletionStream(
  input: LocalAgentCompletionStreamInput,
): AsyncGenerator<LocalAgentCompletionEvent> {
  const url = requestUrl(
    input.baseUrl,
    '/v1/local-agent/sessions/{sessionId}/completions',
    { sessionId: input.sessionId },
  );
  const headers = await requestHeaders(
    input.getToken,
    { accept: 'text/event-stream', 'x-organization-id': input.options.organizationId },
    input.body,
    input.operation,
    input.options.signal,
  );
  const responsePromise = input.fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(input.body),
    ...(input.options.signal === undefined ? {} : { signal: input.options.signal }),
    ...(operationUsesCookies(input.operation) ? { credentials: 'include' } : {}),
  });
  const response =
    input.options.signal === undefined
      ? await responsePromise
      : await raceAbort(responsePromise, input.options.signal);
  if (!response.ok) throw await apiError(response);
  assertEventStreamResponse(response);
  if (response.body === null) throw new SseProtocolError('the stream response has no body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const pending: LocalAgentCompletionEvent[] = [];
  const streamState = { invalid: false, terminal: false };
  const parser = createParser({
    onEvent(message: EventSourceMessage) {
      if (streamState.terminal) {
        streamState.invalid = true;
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(message.data) as unknown;
      } catch {
        streamState.invalid = true;
        return;
      }
      const event = GatewayStreamEventSchema.safeParse(value);
      if (!event.success) {
        streamState.invalid = true;
        return;
      }
      streamState.terminal = event.data.type === 'done' || event.data.type === 'error';
      pending.push(event.data as LocalAgentCompletionEvent);
    },
    onError() {
      streamState.invalid = true;
    },
  });

  const emitPending = function* (): Generator<LocalAgentCompletionEvent> {
    while (pending.length > 0) yield pending.shift() as LocalAgentCompletionEvent;
  };

  try {
    for (;;) {
      const next =
        input.options.signal === undefined
          ? await reader.read()
          : await raceAbort(reader.read(), input.options.signal);
      if (next.done) break;
      try {
        parser.feed(decoder.decode(next.value, { stream: true }));
      } catch {
        throw new SseProtocolError('completion event framing is invalid.');
      }
      if (streamState.invalid) {
        throw new SseProtocolError('completion event data is invalid.');
      }
      yield* emitPending();
    }
    try {
      parser.feed(decoder.decode());
      parser.reset({ consume: true });
    } catch {
      throw new SseProtocolError('completion event framing is invalid.');
    }
    if (streamState.invalid || !streamState.terminal) {
      throw new SseProtocolError('completion stream ended without one terminal event.');
    }
    yield* emitPending();
  } finally {
    try {
      const cancellation = reader.cancel(
        input.options.signal?.aborted === true
          ? abortError(input.options.signal)
          : undefined,
      );
      void cancellation.catch(() => undefined);
    } catch {
      // Cancellation is best-effort after the stream has already settled.
    }
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative stream cannot retain the SDK reader lock.
    }
  }
}

function publicOperation(path: string, method: unknown): OperationMetadata {
  if (!Object.hasOwn(PUBLIC_API_OPERATIONS, path)) {
    throw new RangeError('Request path must be a generated public API path.');
  }
  if (typeof method !== 'string') {
    throw new RangeError('Request method is not a supported operation for this public API path.');
  }
  const operations = PUBLIC_API_OPERATIONS[path as keyof typeof PUBLIC_API_OPERATIONS];
  const operation = (
    operations as unknown as Readonly<Record<string, OperationMetadata | undefined>>
  )[method.toLowerCase()];
  if (operation === undefined) {
    throw new RangeError('Request method is not a supported operation for this public API path.');
  }
  return operation;
}

function requestUrl(
  baseUrl: URL,
  path: PublicApiPath,
  pathParameters?: Readonly<Record<string, unknown>>,
  query?: Readonly<Record<string, unknown>>,
): URL {
  const expanded = path.replaceAll(/\{([^}]+)\}/g, (_placeholder, name: string) => {
    const value = pathParameters?.[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new RangeError(`A non-empty ${name} path parameter is required.`);
    }
    assertSafePathParameter(value);
    return encodeURIComponent(value);
  });
  const url = new URL(expanded, baseUrl);
  if (query === undefined) return url;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) url.searchParams.append(key, String(item));
  }
  return url;
}

function assertSafePathParameter(value: string): void {
  let decoded = value;
  for (let depth = 0; depth <= value.length; depth += 1) {
    if (decoded === '.' || decoded === '..' || /[/\\\u0000-\u001f\u007f]/.test(decoded)) {
      throw new RangeError('Path parameter contains an unsafe segment.');
    }
    if (!decoded.includes('%')) return;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new RangeError('Path parameter contains invalid encoding.');
    }
    if (next === decoded) return;
    decoded = next;
  }
  throw new RangeError('Path parameter contains excessive encoding.');
}

async function requestHeaders(
  getToken: ZappClientOptions['getToken'],
  headers: ClientHeaders | undefined,
  body: unknown,
  operation: OperationMetadata,
  signal?: AbortSignal,
): Promise<Headers> {
  const result =
    headers === undefined
      ? new Headers()
      : headers instanceof Headers
        ? new Headers(headers)
        : new Headers(Object.entries(headers));
  const bearerAllowed = operationAllowsScheme(operation, 'bearerAuth');
  result.delete('authorization');
  if (bearerAllowed) {
    const tokenPromise = Promise.resolve().then(getToken);
    let token: string | undefined;
    try {
      token = signal === undefined ? await tokenPromise : await raceAbort(tokenPromise, signal);
    } catch (error) {
      if (operationRequiresScheme(operation, 'bearerAuth') || signal?.aborted === true) throw error;
    }
    if (token !== undefined && token.length > 0) {
      result.set('authorization', `Bearer ${token}`);
    } else if (operationRequiresScheme(operation, 'bearerAuth')) {
      throw new Error('A non-empty zapp API token is required.');
    }
  }
  if (body !== undefined && !isFormData(body) && !result.has('content-type'))
    result.set('content-type', 'application/json');
  return result;
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== 'undefined' && value instanceof FormData;
}

async function apiError(response: FetchResponse): Promise<ZappApiError> {
  let code: string | undefined;
  try {
    const parsed = JSON.parse(await response.text()) as { error?: { code?: unknown } };
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
  readonly retry: EventStreamRetryOptions | undefined;
  readonly signal: AbortSignal;
  readonly operation: OperationMetadata;
}

interface EventStreamState {
  latestId: string | undefined;
  retryMs: number;
}

async function runEventSubscription(input: RunEventSubscriptionInput): Promise<void> {
  const after = input.options.after;
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
    throw new RangeError('SSE after must be a non-negative integer.');
  }

  let initial = true;
  const state: EventStreamState = {
    latestId: after === undefined ? undefined : String(after),
    retryMs: boundedDelay(input.retry?.initialDelayMs ?? INITIAL_RECONNECT_DELAY_MS),
  };
  const maxDelayMs = boundedMaximum(input.retry?.maxDelayMs ?? MAX_RECONNECT_DELAY_MS);
  const random = input.retry?.random ?? Math.random;
  let failures = 0;

  while (!input.signal.aborted) {
    const latestIdAtAttemptStart = state.latestId;
    try {
      const url = requestUrl(
        input.baseUrl,
        '/v1/runs/{runId}/events',
        { runId: input.runId },
        initial && after !== undefined ? { after } : undefined,
      );
      const headers = await requestHeaders(
        input.getToken,
        { accept: 'text/event-stream' },
        undefined,
        input.operation,
        input.signal,
      );
      if (!initial && state.latestId !== undefined) headers.set('last-event-id', state.latestId);
      initial = false;

      const response = await raceAbort(
        input.fetch(url, {
          headers,
          signal: input.signal,
          ...(operationUsesCookies(input.operation) ? { credentials: 'include' } : {}),
        }),
        input.signal,
      );
      if (!response.ok) throw await apiError(response);
      assertEventStreamResponse(response);
      if (response.body === null) throw new SseProtocolError('the stream response has no body.');
      await consumeEventStream(
        response.body,
        state,
        input.options.onEvent,
        (error) => {
          reportSseError(input.options, error);
        },
        input.signal,
      );
    } catch (error) {
      if (isAborted(input.signal)) return;
      const safe = safeError(error);
      reportSseError(input.options, safe);
      if (safe instanceof ZappApiError && !isRetryableStatus(safe.status)) return;
    }

    if (isAborted(input.signal)) return;
    if (state.latestId !== latestIdAtAttemptStart) failures = 0;
    try {
      await delay(reconnectDelay(state.retryMs, failures, maxDelayMs, random), input.signal);
      failures += 1;
    } catch {
      return;
    }
  }
}

async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  state: EventStreamState,
  onEvent: SubscribeRunEventsOptions['onEvent'],
  onError: (error: Error) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let current: { id?: string; type?: string; data: string[] } = { data: [] };

  const dispatch = async (): Promise<void> => {
    if (current.id === undefined && current.type === undefined && current.data.length === 0) return;
    const event = current;
    current = { data: [] };
    if (event.id === undefined) {
      onError(new SseParseError('id must be a non-negative safe integer.'));
      return;
    }
    const eventId = event.id;
    const eventSequence = parseEventSequence(eventId);
    if (eventSequence === undefined) {
      onError(new SseParseError('id must be a non-negative safe integer.'));
      return;
    }
    if (event.type === undefined || event.type.length === 0) {
      onError(new SseParseError('event type is required.'));
      return;
    }
    if (event.data.length === 0) {
      onError(new SseParseError('data is required.'));
      return;
    }
    const latestSequence =
      state.latestId === undefined ? undefined : parseEventSequence(state.latestId);
    if (latestSequence !== undefined && eventSequence <= latestSequence) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data.join('\n')) as unknown;
    } catch {
      onError(new SseParseError('data is not valid JSON.'));
      return;
    }
    const validated = AgentEventSchema.safeParse(parsed);
    if (!validated.success) {
      onError(new SseParseError('data does not match the AgentEvent contract.'));
      return;
    }
    // Zod 3 includes `undefined` in inferred optional properties, while the
    // generated OpenAPI type models those properties as absent. Parsing strips
    // absent optionals at runtime, so this bridges that representational gap.
    const data = validated.data as unknown as RunEventData;
    if (
      !Number.isSafeInteger(data.sequence) ||
      data.sequence < 0 ||
      data.type !== event.type ||
      data.sequence !== eventSequence
    ) {
      onError(new SseParseError('id and event fields must match the AgentEvent data.'));
      return;
    }
    try {
      await raceAbort(Promise.resolve(onEvent({ id: eventId, type: data.type, data })), signal);
    } catch {
      if (signal.aborted) throw abortError(signal);
      throw new SseCallbackError();
    }
    state.latestId = eventId;
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
    else if (field === 'retry') {
      const parsedRetry = parseRetry(data);
      if (parsedRetry !== undefined) state.retryMs = parsedRetry;
    }
  };

  try {
    for (;;) {
      const next = await raceAbort(reader.read(), signal);
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      let token = takeLine(buffered, false);
      while (token !== undefined) {
        buffered = token.rest;
        await line(token.value);
        token = takeLine(buffered, false);
      }
    }
    buffered += decoder.decode();
    let token = takeLine(buffered, true);
    while (token !== undefined) {
      buffered = token.rest;
      await line(token.value);
      token = takeLine(buffered, true);
    }
    // A partial EOF frame is discarded and replayed from Last-Event-ID.
  } finally {
    try {
      const cancellation = reader.cancel(signal.aborted ? abortError(signal) : undefined);
      void cancellation.catch(() => {
        // Cancellation is best-effort after the stream has already failed.
      });
    } catch {
      // Cancellation is best-effort after the stream has already failed.
    }
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative reader must not prevent subscription cleanup.
    }
  }
}

function operationHasMediaType(operation: OperationMetadata, expected: string): boolean {
  return Object.values(operation.successResponses).some((response) =>
    response?.mediaTypes.includes(expected),
  );
}

function operationHasRedirect(operation: OperationMetadata): boolean {
  return Object.keys(operation.successResponses).some((status) => /^3\d\d$/.test(status));
}

function operationAllowsScheme(operation: OperationMetadata, scheme: string): boolean {
  return operation.security.some((requirement) => Object.hasOwn(requirement, scheme));
}

function operationRequiresScheme(operation: OperationMetadata, scheme: string): boolean {
  return (
    operation.security.length > 0 &&
    operation.security.every((requirement) => Object.hasOwn(requirement, scheme))
  );
}

function operationUsesCookies(operation: OperationMetadata): boolean {
  return (
    operationAllowsScheme(operation, 'sessionCookie') ||
    operationAllowsScheme(operation, 'refreshCookie')
  );
}

function responseHeaders(
  response: FetchResponse,
  requiredHeaders: readonly string[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of requiredHeaders) {
    const value = response.headers.get(name);
    if (value === null) throw new ZappProtocolError();
    result[name] = value;
  }
  return result;
}

function parseEventSequence(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function takeLine(buffer: string, endOfFile: boolean): { value: string; rest: string } | undefined {
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (character === '\n') {
      return { value: buffer.slice(0, index), rest: buffer.slice(index + 1) };
    }
    if (character !== '\r') continue;
    if (index + 1 === buffer.length && !endOfFile) return undefined;
    const delimiterLength = buffer[index + 1] === '\n' ? 2 : 1;
    return { value: buffer.slice(0, index), rest: buffer.slice(index + delimiterLength) };
  }
  return undefined;
}

function parseRetry(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = value.length > 10 ? MAX_RECONNECT_DELAY_MS : Number(value);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return boundedDelay(parsed);
}

function assertEventStreamResponse(response: FetchResponse): void {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'text/event-stream') {
    throw new SseProtocolError('content type must be text/event-stream.');
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function reportSseError(options: SubscribeRunEventsOptions, error: Error): void {
  try {
    options.onError?.(error);
  } catch {
    // Consumer callbacks must not keep an authenticated reconnect loop alive.
  }
}

function safeError(error: unknown): Error {
  return error instanceof ZappApiError ||
    error instanceof SseParseError ||
    error instanceof SseProtocolError ||
    error instanceof SseCallbackError
    ? error
    : new Error('Run event stream disconnected.');
}

function reconnectDelay(
  baseDelayMs: number,
  failures: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const withoutJitter = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(failures, 30));
  const randomValue = Math.min(1, Math.max(0, random()));
  return Math.min(maxDelayMs, Math.round(withoutJitter * (1 + randomValue * MAX_JITTER_RATIO)));
}

function boundedDelay(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) return INITIAL_RECONNECT_DELAY_MS;
  return Math.min(
    MAX_RECONNECT_DELAY_MS,
    Math.max(MIN_RECONNECT_DELAY_MS, Math.round(milliseconds)),
  );
}

function boundedMaximum(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) return MAX_RECONNECT_DELAY_MS;
  return Math.min(
    MAX_RECONNECT_DELAY_MS,
    Math.max(MIN_RECONNECT_DELAY_MS, Math.round(milliseconds)),
  );
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function raceAbort<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) throw abortError(signal);
  return await new Promise<Value>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error('Asynchronous operation failed.'));
      },
    );
  });
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}
