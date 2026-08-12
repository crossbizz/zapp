import { createServiceTokenSigner } from '@zapp/config';
import { newId } from '@zapp/contracts';
import { CompleteRequestSchema, type GatewayStreamEvent } from '@zapp/model-gateway';
import { describe, expect, it, vi } from 'vitest';

import {
  createModelGatewaySessionGateway,
  ModelGatewayStreamError,
} from '../src/runtime/model-gateway-client.js';

const SERVICE_TOKENS = { secret: 'g'.repeat(32) };

function request() {
  return CompleteRequestSchema.parse({
    completionId: `cmp_${'a'.repeat(64)}`,
    organizationId: newId('org'),
    projectId: newId('proj'),
    runId: newId('run'),
    taskId: 'm1-builder',
    agentRole: 'builder',
    messages: [{ role: 'user', content: 'Build a landing page.' }],
    tools: [],
    cacheBreakpointMessageIndexes: [],
    maxInputTokens: 4_000,
    maxOutputTokens: 2_000,
  });
}

function sseResponse(events: readonly unknown[], chunks?: readonly string[]): Response {
  const encoded = chunks ?? events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of encoded) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

async function collect(stream: AsyncIterable<GatewayStreamEvent>): Promise<GatewayStreamEvent[]> {
  const events: GatewayStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('model-gateway session client', () => {
  it('authenticates, posts the strict request, and parses chunked SSE through one terminal', async () => {
    const input = request();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const token = new Headers(init?.headers).get('x-zapp-service-token') ?? '';
      const verdict = await createServiceTokenSigner(SERVICE_TOKENS).verifyServiceToken(
        token,
        'model-gateway',
      );
      expect(verdict).toMatchObject({
        ok: true,
        claims: { service: 'orchestrator-worker' },
      });
      expect(init).toMatchObject({ method: 'POST', body: JSON.stringify(input) });
      expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream');
      return sseResponse([], [
        'data: {"type":"text-',
        'delta","text":"hello"}\r\n\r\n',
        'data: {"type":"done"}\n\n',
      ]);
    });
    const gateway = createModelGatewaySessionGateway({
      baseUrl: 'http://model-gateway.test/',
      serviceTokens: SERVICE_TOKENS,
      fetch: fetchImpl,
    });

    await expect(collect(gateway.stream(input, new AbortController().signal))).resolves.toEqual([
      { type: 'text-delta', text: 'hello' },
      { type: 'done' },
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'http://model-gateway.test/internal/v1/complete',
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['malformed JSON', ['data: not-json\n\n']],
    ['invalid event', ['data: {"type":"mystery"}\n\n']],
    ['missing terminal', ['data: {"type":"text-delta","text":"hello"}\n\n']],
    [
      'event after terminal',
      [
        'data: {"type":"done"}\n\n',
        'data: {"type":"text-delta","text":"late"}\n\n',
      ],
    ],
    ['duplicate terminal', ['data: {"type":"done"}\n\ndata: {"type":"done"}\n\n']],
  ])('fails closed for %s', async (_case, chunks) => {
    const gateway = createModelGatewaySessionGateway({
      baseUrl: 'http://model-gateway.test',
      serviceTokens: SERVICE_TOKENS,
      fetch: vi.fn(() => Promise.resolve(sseResponse([], chunks))),
    });

    await expect(collect(gateway.stream(request(), new AbortController().signal))).rejects.toBeInstanceOf(
      ModelGatewayStreamError,
    );
  });

  it('forwards cancellation to the model-gateway request', async () => {
    let resolveRequestStarted: ((signal: AbortSignal) => void) | undefined;
    const requestStarted = new Promise<AbortSignal>((resolve) => {
      resolveRequestStarted = resolve;
    });
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal as AbortSignal;
        resolveRequestStarted?.(signal);
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        });
      },
    );
    const gateway = createModelGatewaySessionGateway({
      baseUrl: 'http://model-gateway.test',
      serviceTokens: SERVICE_TOKENS,
      fetch: fetchImpl,
    });
    const controller = new AbortController();
    const reading = collect(gateway.stream(request(), controller.signal));
    const forwarded = await requestStarted;

    controller.abort(new Error('user cancelled'));

    await expect(reading).rejects.toMatchObject({ name: 'ModelGatewayCancelledError' });
    expect(forwarded.aborted).toBe(true);
  });
});
