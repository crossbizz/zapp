import { describe, expect, it } from 'vitest';

import { createModelGatewayLocalAgentClient } from '../src/local-agent/gateway.js';

const REQUEST = {
  completionId: `cmp_${'a'.repeat(64)}`,
  organizationId: 'org_01K1M6N8P0QRSTUVWX23456789',
  projectId: 'proj_01K1M6N8P0QRSTUVWX23456789',
  runId: 'run_01K1M6N8P0QRSTUVWX23456789',
  taskId: 'task_01K1M6N8P0QRSTUVWX23456789',
  agentRole: 'builder' as const,
  messages: [{ role: 'user' as const, content: 'Change the heading' }],
  cacheBreakpointMessageIndexes: [],
  maxInputTokens: 8,
  maxOutputTokens: 64,
};

describe('control-plane model-gateway client', () => {
  it('authenticates the service hop and parses split SSE frames strictly', async () => {
    const calls: { input: string; init: RequestInit }[] = [];
    const encoder = new TextEncoder();
    const client = createModelGatewayLocalAgentClient({
      baseUrl: 'http://model-gateway.test:4100',
      serviceTokens: { secret: 'a'.repeat(64) },
      fetch: (input, init) => {
        calls.push({ input, init });
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('data: {"type":"text-delta","text":"hel'));
                controller.enqueue(encoder.encode('lo"}\n\ndata: {"type":"done"}\n\n'));
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
          ),
        );
      },
    });

    const events = [];
    for await (const event of client.stream(REQUEST, new AbortController().signal)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text-delta', text: 'hello' },
      { type: 'done' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('http://model-gateway.test:4100/internal/v1/complete');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      body: JSON.stringify(REQUEST),
    });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(calls[0]?.init.headers).get('x-zapp-service-token')).toMatch(/^ey/u);
  });

  it('replays the same completion after a partial service-hop stream without exposing duplicate output', async () => {
    const bodies: string[] = [];
    const encoder = new TextEncoder();
    let attempt = 0;
    const client = createModelGatewayLocalAgentClient({
      baseUrl: 'http://model-gateway.test:4100',
      serviceTokens: { secret: 'a'.repeat(64) },
      fetch: (_input, init) => {
        bodies.push(typeof init.body === 'string' ? init.body : '');
        attempt += 1;
        const payload =
          attempt === 1
            ? 'data: {"type":"text-delta","text":"partial"}\n\n'
            : 'data: {"type":"text-delta","text":"recovered"}\n\ndata: {"type":"done"}\n\n';
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode(payload));
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      },
    });

    const events = [];
    for await (const event of client.stream(REQUEST, new AbortController().signal)) {
      events.push(event);
    }

    expect(bodies).toEqual([JSON.stringify(REQUEST), JSON.stringify(REQUEST)]);
    expect(events).toEqual([
      { type: 'text-delta', text: 'recovered' },
      { type: 'done' },
    ]);
  });
});
