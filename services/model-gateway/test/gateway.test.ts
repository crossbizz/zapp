import type { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';

import { createServiceTokenSigner, type ServiceAudience, type ServiceName } from '@zapp/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildApp,
  CompleteRequestSchema,
  type CompleteRequest,
  type CompletionBackend,
  type GatewayStreamEvent,
} from '../src/app.js';
import { GatewayStreamEventSchema } from '../src/schemas.js';
import { loadModelsConfig } from '../src/models.js';
import { createAnthropicAdapter } from '../src/providers/anthropic.js';
import { createCompatibleAdapter } from '../src/providers/compatible.js';
import { configureProviders } from '../src/providers/configure.js';
import { createGoogleAdapter } from '../src/providers/google.js';
import { createOpenAIAdapter } from '../src/providers/openai.js';
import type {
  AiSdkDependencies,
  AiSdkStreamOptions,
  ProviderAdapter,
  ProviderInput,
} from '../src/providers/types.js';

const SERVICE_TOKEN_SECRET = 's'.repeat(64);
const serviceTokens = createServiceTokenSigner({ secret: SERVICE_TOKEN_SECRET });
const openApps: Array<ReturnType<typeof buildApp>> = [];

const validRequest = {
  organizationId: 'org_1',
  projectId: 'project_1',
  runId: 'run_1',
  taskId: 'task_1',
  agentRole: 'builder',
  messages: [{ role: 'user', content: 'Build the requested feature.' }],
  tools: [
    {
      name: 'read_file',
      description: 'Read a UTF-8 file from the workspace.',
      inputJsonSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  ],
  maxOutputTokens: 2048,
  budget: { remainingCredits: 125.5 },
} satisfies CompleteRequest;

function asyncEvents(events: readonly GatewayStreamEvent[]): AsyncIterable<GatewayStreamEvent> {
  return (async function* () {
    await Promise.resolve();
    yield* events;
  })();
}

function backend(events: readonly GatewayStreamEvent[] = []): CompletionBackend {
  return { stream: vi.fn(() => asyncEvents(events)) };
}

function appFor(completion: CompletionBackend, logger: Parameters<typeof buildApp>[0]['logger'] = false) {
  const app = buildApp({ serviceTokens, completion, logger });
  openApps.push(app);
  return app;
}

async function token(service: ServiceName, aud: ServiceAudience = 'model-gateway') {
  return (await serviceTokens.signServiceToken({ service, aud })).token;
}

async function authorizedHeaders() {
  return { 'x-zapp-service-token': await token('orchestrator-worker') };
}

function parseSse(payload: string): unknown[] {
  return payload
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      expect(frame.startsWith('data: ')).toBe(true);
      return JSON.parse(frame.slice('data: '.length)) as unknown;
    });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function blockFirstResponseWrite(app: ReturnType<typeof buildApp>) {
  const blocked = deferred<ServerResponse>();
  app.addHook('onRequest', (_request, reply, done) => {
    const originalWrite = reply.raw.write.bind(reply.raw) as (...args: unknown[]) => boolean;
    let writeCount = 0;
    reply.raw.write = ((...args: unknown[]) => {
      const accepted = originalWrite(...args);
      writeCount += 1;
      if (writeCount === 1) {
        blocked.resolve(reply.raw);
        return false;
      }
      return accepted;
    }) as typeof reply.raw.write;
    done();
  });
  return blocked.promise;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  vi.restoreAllMocks();
});

describe('strict request schemas', () => {
  it('accepts the complete neutral message and tool vocabulary', () => {
    expect(
      CompleteRequestSchema.parse({
        ...validRequest,
        messages: [
          { role: 'system', content: 'Follow the approved plan.' },
          { role: 'user', content: [{ type: 'text', text: 'Implement task AR-1.' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will inspect the file.' },
              {
                type: 'tool-call',
                toolCallId: 'call_1',
                toolName: 'read_file',
                input: { path: 'README.md' },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call_1',
                toolName: 'read_file',
                output: { type: 'json', value: { text: '# zapp' } },
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ agentRole: 'builder', maxOutputTokens: 2048 });
  });

  it.each([
    ['unknown request key', { ...validRequest, provider: 'anthropic' }],
    [
      'unknown message key',
      { ...validRequest, messages: [{ role: 'user', content: 'hello', provider: 'openai' }] },
    ],
    [
      'unknown tool key',
      {
        ...validRequest,
        tools: [{ ...validRequest.tools[0], providerOptions: { anthropic: {} } }],
      },
    ],
    [
      'malformed JSON Schema',
      {
        ...validRequest,
        tools: [
          {
            ...validRequest.tools[0],
            inputJsonSchema: { type: 'object', properties: { path: { type: 'not-a-type' } } },
          },
        ],
      },
    ],
    [
      'unknown JSON Schema keyword',
      {
        ...validRequest,
        tools: [
          {
            ...validRequest.tools[0],
            inputJsonSchema: {
              type: 'object',
              properties: {},
              providerSpecificKeyword: true,
            },
          },
        ],
      },
    ],
    ['non-positive output limit', { ...validRequest, maxOutputTokens: 0 }],
    ['unknown budget key', { ...validRequest, budget: { remainingCredits: 5, currency: 'USD' } }],
  ])('rejects %s', (_name, input) => {
    expect(CompleteRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe('strict gateway stream event schema', () => {
  const terminalEvents = [
    { type: 'done' },
    {
      type: 'error',
      code: 'provider_error',
      message: 'The model provider request failed.',
    },
  ] as const satisfies readonly GatewayStreamEvent[];

  it.each(terminalEvents)('accepts the terminal $type event', (event) => {
    expect(GatewayStreamEventSchema.parse(event)).toEqual(event);
  });

  it('parses every event before writing successful and failed streams', async () => {
    const parse = vi.spyOn(GatewayStreamEventSchema, 'parse');
    const success = await appFor(backend([{ type: 'text-delta', text: 'complete' }])).inject({
      method: 'POST',
      url: '/internal/v1/complete',
      headers: await authorizedHeaders(),
      payload: validRequest,
    });
    const failure = await appFor({
      stream: () => {
        throw new Error('private provider failure');
      },
    }).inject({
      method: 'POST',
      url: '/internal/v1/complete',
      headers: await authorizedHeaders(),
      payload: validRequest,
    });
    const emitted = [...parseSse(success.payload), ...parseSse(failure.payload)];

    expect(parse.mock.calls.map(([event]) => event)).toEqual(emitted);
  });
});

describe('POST /internal/v1/complete authorization and validation', () => {
  it.each([
    ['a missing service token', () => Promise.resolve({})],
    [
      'a token for another audience',
      async () => ({ 'x-zapp-service-token': await token('orchestrator-worker', 'git-service') }),
    ],
    [
      'a token from another service',
      async () => ({ 'x-zapp-service-token': await token('sandbox-service') }),
    ],
    [
      'a browser session credential',
      async () => ({
        ...(await authorizedHeaders()),
        cookie: 'zapp_session=browser-session',
      }),
    ],
    [
      'a bearer user credential',
      async () => ({
        ...(await authorizedHeaders()),
        authorization: 'Bearer user-session-token',
      }),
    ],
  ])('rejects %s before touching a provider', async (_name, makeHeaders) => {
    const completion = backend();
    const response = await appFor(completion).inject({
      method: 'POST',
      url: '/internal/v1/complete',
      headers: await makeHeaders(),
      payload: validRequest,
    });

    expect([401, 403]).toContain(response.statusCode);
    expect(completion.stream).not.toHaveBeenCalled();
  });

  it('rejects an invalid body before touching a provider', async () => {
    const completion = backend();
    const response = await appFor(completion).inject({
      method: 'POST',
      url: '/internal/v1/complete',
      headers: await authorizedHeaders(),
      payload: { ...validRequest, unexpected: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_request' });
    expect(completion.stream).not.toHaveBeenCalled();
  });
});

describe('neutral SSE stream', () => {
  it('preserves provider order and emits exactly one terminal done event', async () => {
    const completion = backend([
      { type: 'text-delta', text: 'Hello ' },
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'read_file',
        input: { path: 'README.md' },
      },
      {
        type: 'usage',
        inputTokens: 21,
        outputTokens: 8,
        totalTokens: 29,
        cachedInputTokens: 5,
      },
    ]);
    const response = await appFor(completion).inject({
      method: 'POST',
      url: '/internal/v1/complete',
      headers: await authorizedHeaders(),
      payload: validRequest,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(parseSse(response.payload)).toEqual([
      { type: 'text-delta', text: 'Hello ' },
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'read_file',
        input: { path: 'README.md' },
      },
      {
        type: 'usage',
        inputTokens: 21,
        outputTokens: 8,
        totalTokens: 29,
        cachedInputTokens: 5,
      },
      { type: 'done' },
    ]);
  });

  it('turns provider startup failure into one sanitized terminal error', async () => {
    const completion: CompletionBackend = {
      stream: vi.fn(() => {
        throw new Error('upstream body contains provider-secret-marker');
      }),
    };
    const response = await appFor(completion).inject({
      method: 'POST',
      url: '/internal/v1/complete',
      headers: await authorizedHeaders(),
      payload: validRequest,
    });

    expect(response.statusCode).toBe(200);
    expect(parseSse(response.payload)).toEqual([
      {
        type: 'error',
        code: 'provider_error',
        message: 'The model provider request failed.',
      },
    ]);
    expect(response.payload).not.toContain('provider-secret-marker');
    expect(response.payload).not.toContain('upstream body');
  });

  it('turns a mid-stream throw into one sanitized terminal error without done', async () => {
    const completion: CompletionBackend = {
      stream: vi.fn(() =>
        (async function* () {
          yield { type: 'text-delta', text: 'partial' } as const;
          await Promise.resolve();
          throw new Error('provider raw response: private tool input');
        })(),
      ),
    };
    const response = await appFor(completion).inject({
      method: 'POST',
      url: '/internal/v1/complete',
      headers: await authorizedHeaders(),
      payload: validRequest,
    });

    expect(parseSse(response.payload)).toEqual([
      { type: 'text-delta', text: 'partial' },
      {
        type: 'error',
        code: 'provider_error',
        message: 'The model provider request failed.',
      },
    ]);
    expect(response.payload).not.toContain('private tool input');
    expect(response.payload).not.toContain('provider raw response');
  });

  it('does not log provider errors, request messages, tool inputs, or service tokens', async () => {
    let logs = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logs += String(chunk);
        callback();
      },
    });
    const rawError = 'provider-error-with-private-response';
    const privateMessage = 'request-message-private-value';
    const privateToolInput = 'tool-input-private-value';
    const credential = await token('orchestrator-worker');
    const completion: CompletionBackend = {
      stream: () => {
        throw new Error(rawError);
      },
    };
    const response = await appFor(completion, { level: 'info', stream: destination }).inject({
      method: 'POST',
      url: '/internal/v1/complete',
      headers: { 'x-zapp-service-token': credential },
      payload: {
        ...validRequest,
        messages: [{ role: 'user', content: privateMessage }],
        tools: [
          {
            name: privateToolInput,
            description: 'private description',
            inputJsonSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
    await new Promise<void>((resolve, reject) =>
      destination.write('', (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      }),
    );

    expect(response.statusCode).toBe(200);
    for (const secret of [rawError, privateMessage, privateToolInput, credential]) {
      expect(logs).not.toContain(secret);
    }
  });

  it('flushes the first SSE event before provider completion', async () => {
    const releaseProvider = deferred();
    const completion: CompletionBackend = {
      stream: () =>
        (async function* () {
          yield { type: 'text-delta', text: 'first' } as const;
          await releaseProvider.promise;
          yield { type: 'text-delta', text: 'second' } as const;
        })(),
    };
    const app = appFor(completion);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/internal/v1/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authorizedHeaders()) },
      body: JSON.stringify(validRequest),
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) throw new Error('response body was missing');

    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => {
          reject(new Error('first SSE chunk was buffered'));
        }, 1_000),
      ),
    ]);
    if (!(first.value instanceof Uint8Array)) throw new Error('first SSE chunk was not bytes');
    expect(new TextDecoder().decode(first.value)).toContain(
      'data: {"type":"text-delta","text":"first"}\n\n',
    );

    releaseProvider.resolve();
    await reader.cancel();
  });

  it('aborts provider consumption when the client disconnects', async () => {
    const providerSawAbort = deferred();
    const completion: CompletionBackend = {
      stream: (_request, signal) =>
        (async function* () {
          yield { type: 'text-delta', text: 'started' } as const;
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                providerSawAbort.resolve();
                resolve();
              },
              { once: true },
            );
          });
        })(),
    };
    const app = appFor(completion);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const requestAbort = new AbortController();
    const response = await fetch(`${address}/internal/v1/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authorizedHeaders()) },
      body: JSON.stringify(validRequest),
      signal: requestAbort.signal,
    });
    await response.body?.getReader().read();
    requestAbort.abort();

    await Promise.race([
      providerSawAbort.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => { reject(new Error('provider did not observe client abort')); }, 1_000),
      ),
    ]);
  });

  it('does not advance a completion iterator while an SSE write is backpressured', async () => {
    const events = [
      { type: 'text-delta', text: 'first' },
      { type: 'text-delta', text: 'second' },
    ] as const satisfies readonly GatewayStreamEvent[];
    let nextCalls = 0;
    const completion: CompletionBackend = {
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            next() {
              const value = events[nextCalls];
              nextCalls += 1;
              return Promise.resolve(
                value === undefined
                  ? { done: true as const, value: undefined }
                  : { done: false as const, value },
              );
            },
          };
        },
      }),
    };
    const app = appFor(completion);
    const blockedResponse = blockFirstResponseWrite(app);
    const responsePromise = app.inject({
      method: 'POST',
      url: '/internal/v1/complete',
      headers: await authorizedHeaders(),
      payload: validRequest,
    });

    const raw = await blockedResponse;
    await Promise.resolve();
    expect(nextCalls).toBe(1);

    raw.emit('drain');
    const response = await responsePromise;
    expect(parseSse(response.payload)).toEqual([...events, { type: 'done' }]);
  });

  it('stops a backpressured completion iterator when the client disconnects', async () => {
    let nextCalls = 0;
    const providerReturned = deferred();
    const completion: CompletionBackend = {
      stream: (_request, signal) => ({
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalls += 1;
              if (nextCalls === 1) {
                return Promise.resolve({
                  done: false as const,
                  value: { type: 'text-delta', text: 'first' } as const,
                });
              }
              return new Promise<IteratorResult<GatewayStreamEvent>>((resolve) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    resolve({ done: true, value: undefined });
                  },
                  { once: true },
                );
              });
            },
            return() {
              providerReturned.resolve();
              return Promise.resolve({ done: true as const, value: undefined });
            },
          };
        },
      }),
    };
    const app = appFor(completion);
    const blockedResponse = blockFirstResponseWrite(app);
    const responsePromise = app.inject({
      method: 'POST',
      url: '/internal/v1/complete',
      headers: await authorizedHeaders(),
      payload: validRequest,
    });

    const raw = await blockedResponse;
    try {
      await Promise.resolve();
      expect(nextCalls).toBe(1);

      raw.destroy();
      await providerReturned.promise;
      expect(nextCalls).toBe(1);
    } finally {
      raw.destroy();
      void responsePromise.catch(() => undefined);
    }
  });
});

const providerInput = {
  modelId: 'model-under-test',
  request: {
    ...validRequest,
    messages: [
      { role: 'system', content: 'System instruction.' },
      { role: 'user', content: 'User request.' },
    ],
  },
  signal: new AbortController().signal,
} satisfies ProviderInput;

async function captureAdapter(
  providerName: string,
  create: (dependencies: AiSdkDependencies) => ProviderAdapter,
) {
  const observed: {
    providerSettings?: Record<string, unknown>;
    modelId?: string;
    streamOptions?: AiSdkStreamOptions;
  } = {};
  const dependencies: AiSdkDependencies = {
    createProvider(settings) {
      observed.providerSettings = {
        ...settings,
        ...(settings.apiKey === undefined ? {} : { apiKey: '<configured>' }),
      };
      return (modelId) => {
        observed.modelId = modelId;
        return { provider: providerName, modelId } as never;
      };
    },
    streamText(options) {
      observed.streamOptions = options;
      return { stream: asyncEvents([]) as never };
    },
  };
  const adapter = create(dependencies);
  adapter.stream(providerInput);
  const tools = observed.streamOptions?.tools;
  let normalizedTools: Record<string, unknown> | undefined;
  if (tools !== undefined) {
    normalizedTools = {};
    for (const [name, value] of Object.entries(tools)) {
      normalizedTools[name] = {
        description: value.description,
        inputJsonSchema: await value.inputSchema.jsonSchema,
      };
    }
  }

  return {
    providerSettings: observed.providerSettings,
    modelId: observed.modelId,
    streamOptions: {
      model: observed.streamOptions?.model,
      messages: observed.streamOptions?.messages,
      tools: normalizedTools,
      maxOutputTokens: observed.streamOptions?.maxOutputTokens,
      abortSignal: observed.streamOptions?.abortSignal === providerInput.signal,
    },
  };
}

describe('AI SDK provider adapters', () => {
  it('builds the Anthropic provider-correct model, message, and tool options', async () => {
    expect(
      await captureAdapter('anthropic', (dependencies) =>
        createAnthropicAdapter({ apiKey: 'configured-in-test', dependencies }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "modelId": "model-under-test",
        "providerSettings": {
          "apiKey": "<configured>",
        },
        "streamOptions": {
          "abortSignal": true,
          "maxOutputTokens": 2048,
          "messages": [
            {
              "content": "System instruction.",
              "role": "system",
            },
            {
              "content": "User request.",
              "role": "user",
            },
          ],
          "model": {
            "modelId": "model-under-test",
            "provider": "anthropic",
          },
          "tools": {
            "read_file": {
              "description": "Read a UTF-8 file from the workspace.",
              "inputJsonSchema": {
                "additionalProperties": false,
                "properties": {
                  "path": {
                    "type": "string",
                  },
                },
                "required": [
                  "path",
                ],
                "type": "object",
              },
            },
          },
        },
      }
    `);
  });

  it('builds the OpenAI provider-correct model, message, and tool options', async () => {
    expect(
      await captureAdapter('openai', (dependencies) =>
        createOpenAIAdapter({ apiKey: 'configured-in-test', dependencies }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "modelId": "model-under-test",
        "providerSettings": {
          "apiKey": "<configured>",
        },
        "streamOptions": {
          "abortSignal": true,
          "maxOutputTokens": 2048,
          "messages": [
            {
              "content": "System instruction.",
              "role": "system",
            },
            {
              "content": "User request.",
              "role": "user",
            },
          ],
          "model": {
            "modelId": "model-under-test",
            "provider": "openai",
          },
          "tools": {
            "read_file": {
              "description": "Read a UTF-8 file from the workspace.",
              "inputJsonSchema": {
                "additionalProperties": false,
                "properties": {
                  "path": {
                    "type": "string",
                  },
                },
                "required": [
                  "path",
                ],
                "type": "object",
              },
            },
          },
        },
      }
    `);
  });

  it('builds the Google provider-correct model, message, and tool options', async () => {
    expect(
      await captureAdapter('google', (dependencies) =>
        createGoogleAdapter({ apiKey: 'configured-in-test', dependencies }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "modelId": "model-under-test",
        "providerSettings": {
          "apiKey": "<configured>",
        },
        "streamOptions": {
          "abortSignal": true,
          "maxOutputTokens": 2048,
          "messages": [
            {
              "content": "System instruction.",
              "role": "system",
            },
            {
              "content": "User request.",
              "role": "user",
            },
          ],
          "model": {
            "modelId": "model-under-test",
            "provider": "google",
          },
          "tools": {
            "read_file": {
              "description": "Read a UTF-8 file from the workspace.",
              "inputJsonSchema": {
                "additionalProperties": false,
                "properties": {
                  "path": {
                    "type": "string",
                  },
                },
                "required": [
                  "path",
                ],
                "type": "object",
              },
            },
          },
        },
      }
    `);
  });

  it('builds the configurable OpenAI-compatible provider-correct options', async () => {
    expect(
      await captureAdapter('compatible', (dependencies) =>
        createCompatibleAdapter({
          apiKey: 'configured-in-test',
          baseURL: 'https://models.example.test/v1',
          name: 'compatible',
          dependencies,
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "modelId": "model-under-test",
        "providerSettings": {
          "apiKey": "<configured>",
          "baseURL": "https://models.example.test/v1",
          "includeUsage": true,
          "name": "compatible",
        },
        "streamOptions": {
          "abortSignal": true,
          "maxOutputTokens": 2048,
          "messages": [
            {
              "content": "System instruction.",
              "role": "system",
            },
            {
              "content": "User request.",
              "role": "user",
            },
          ],
          "model": {
            "modelId": "model-under-test",
            "provider": "compatible",
          },
          "tools": {
            "read_file": {
              "description": "Read a UTF-8 file from the workspace.",
              "inputJsonSchema": {
                "additionalProperties": false,
                "properties": {
                  "path": {
                    "type": "string",
                  },
                },
                "required": [
                  "path",
                ],
                "type": "object",
              },
            },
          },
        },
      }
    `);
  });

  it('normalizes AI SDK text, tool call, and finish usage parts in provider order', async () => {
    const adapter = createAnthropicAdapter({
      apiKey: 'configured-in-test',
      dependencies: {
        createProvider: () => (() => ({ provider: 'anthropic', modelId: 'test' }) as never),
        streamText: () => ({
          stream: (async function* () {
            await Promise.resolve();
            yield { type: 'start' };
            yield { type: 'text-delta', id: 'text_1', text: 'hello' };
            yield {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'read_file',
              input: { path: 'README.md' },
            };
            yield {
              type: 'finish',
              finishReason: 'stop',
              rawFinishReason: 'end_turn',
              totalUsage: {
                inputTokens: 12,
                inputTokenDetails: {
                  noCacheTokens: 9,
                  cacheReadTokens: 3,
                  cacheWriteTokens: 0,
                },
                outputTokens: 4,
                outputTokenDetails: { textTokens: 4, reasoningTokens: 0 },
                totalTokens: 16,
              },
            };
          })() as never,
        }),
      },
    });

    const events: GatewayStreamEvent[] = [];
    for await (const event of adapter.stream(providerInput)) events.push(event);

    expect(events).toEqual([
      { type: 'text-delta', text: 'hello' },
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'read_file',
        input: { path: 'README.md' },
      },
      {
        type: 'usage',
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
        cachedInputTokens: 3,
      },
    ]);
  });

  it('throws an AI SDK error part for the gateway to sanitize', async () => {
    const providerFailure = new Error('raw provider response');
    const adapter = createOpenAIAdapter({
      apiKey: 'configured-in-test',
      dependencies: {
        createProvider: () => (() => ({ provider: 'openai', modelId: 'test' }) as never),
        streamText: () => ({
          stream: (async function* () {
            await Promise.resolve();
            yield { type: 'error', error: providerFailure };
          })() as never,
        }),
      },
    });

    await expect(async () => {
      for await (const event of adapter.stream(providerInput)) {
        throw new Error(`unexpected neutral event: ${event.type}`);
      }
    }).rejects.toBe(providerFailure);
  });
});

describe('model and provider configuration', () => {
  it('validates role defaults and keeps alternates in configuration', () => {
    const config = loadModelsConfig({
      roles: {
        planner: {
          primary: 'anthropic/claude-sonnet-5',
          fallbacks: ['openai/gpt-5', 'google/gemini-2.5-pro'],
        },
        builder: {
          primary: 'anthropic/claude-sonnet-5',
          fallbacks: ['openai/gpt-5', 'google/gemini-2.5-pro'],
        },
        verifier: {
          primary: 'anthropic/claude-opus-5',
          fallbacks: ['openai/gpt-5', 'google/gemini-2.5-pro'],
        },
        summarizer: {
          primary: 'anthropic/claude-haiku-4-5',
          fallbacks: ['openai/gpt-5-mini', 'google/gemini-2.5-flash'],
        },
      },
      providers: {
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
        openai: { apiKeyEnv: 'OPENAI_API_KEY' },
        google: { apiKeyEnv: 'GEMINI_API_KEY' },
        compatible: {
          apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
          baseUrlEnv: 'OPENAI_COMPATIBLE_BASE_URL',
          name: 'compatible',
        },
      },
    });

    expect(config.roles).toMatchInlineSnapshot(`
      {
        "builder": {
          "fallbacks": [
            "openai/gpt-5",
            "google/gemini-2.5-pro",
          ],
          "primary": "anthropic/claude-sonnet-5",
        },
        "planner": {
          "fallbacks": [
            "openai/gpt-5",
            "google/gemini-2.5-pro",
          ],
          "primary": "anthropic/claude-sonnet-5",
        },
        "summarizer": {
          "fallbacks": [
            "openai/gpt-5-mini",
            "google/gemini-2.5-flash",
          ],
          "primary": "anthropic/claude-haiku-4-5",
        },
        "verifier": {
          "fallbacks": [
            "openai/gpt-5",
            "google/gemini-2.5-pro",
          ],
          "primary": "anthropic/claude-opus-5",
        },
      }
    `);
  });

  it('rejects an unknown provider or config key at startup', () => {
    expect(() =>
      loadModelsConfig({
        roles: {
          planner: { primary: 'unknown/model', fallbacks: [] },
          builder: { primary: 'anthropic/model', fallbacks: [] },
          verifier: { primary: 'anthropic/model', fallbacks: [] },
          summarizer: { primary: 'anthropic/model', fallbacks: [] },
        },
        providers: {
          anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', inlineApiKey: 'forbidden' },
          openai: { apiKeyEnv: 'OPENAI_API_KEY' },
          google: { apiKeyEnv: 'GEMINI_API_KEY' },
          compatible: {
            apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
            baseUrlEnv: 'OPENAI_COMPATIBLE_BASE_URL',
            name: 'compatible',
          },
        },
      }),
    ).toThrow();
  });

  it('reports missing provider credentials as typed disabled outcomes', () => {
    const config = loadModelsConfig({
      roles: {
        planner: { primary: 'anthropic/model', fallbacks: [] },
        builder: { primary: 'anthropic/model', fallbacks: [] },
        verifier: { primary: 'anthropic/model', fallbacks: [] },
        summarizer: { primary: 'anthropic/model', fallbacks: [] },
      },
      providers: {
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
        openai: { apiKeyEnv: 'OPENAI_API_KEY' },
        google: { apiKeyEnv: 'GEMINI_API_KEY' },
        compatible: {
          apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
          baseUrlEnv: 'OPENAI_COMPATIBLE_BASE_URL',
          name: 'compatible',
        },
      },
    });

    expect(configureProviders(config.providers, {})).toEqual({
      enabled: {},
      disabled: [
        { provider: 'anthropic', code: 'missing_configuration', missing: ['ANTHROPIC_API_KEY'] },
        { provider: 'openai', code: 'missing_configuration', missing: ['OPENAI_API_KEY'] },
        {
          provider: 'google',
          code: 'missing_configuration',
          missing: ['GEMINI_API_KEY'],
        },
        {
          provider: 'compatible',
          code: 'missing_configuration',
          missing: ['OPENAI_COMPATIBLE_API_KEY', 'OPENAI_COMPATIBLE_BASE_URL'],
        },
      ],
    });
  });
});
