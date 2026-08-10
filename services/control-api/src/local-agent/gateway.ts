import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import {
  CompleteRequestSchema,
  GatewayStreamEventSchema,
  type GatewayStreamEvent,
} from '@zapp/model-gateway';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { z } from 'zod';

import type { LocalAgentCompletionGateway } from './port.js';

export interface ModelGatewayLocalAgentClientOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

function protocolError(): Error {
  return new Error('The model gateway returned an invalid completion stream.');
}

async function readCompletionAttempt(input: {
  readonly baseUrl: string;
  readonly body: z.infer<typeof CompleteRequestSchema>;
  readonly doFetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly signal: AbortSignal;
  readonly token: string;
}): Promise<GatewayStreamEvent[]> {
  let response: Response;
  try {
    response = await input.doFetch(new URL('/internal/v1/complete', input.baseUrl).toString(), {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'x-zapp-service-token': input.token,
      },
      body: JSON.stringify(input.body),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    throw new Error('The model gateway could not be reached.', { cause: error });
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`The model gateway refused the request (${String(response.status)}).`);
  }
  if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream')) {
    await response.body?.cancel();
    throw protocolError();
  }
  if (response.body === null) throw protocolError();

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const events: GatewayStreamEvent[] = [];
  const streamState = { invalid: false, terminal: false };
  const parser = createParser({
    onEvent(message: EventSourceMessage) {
      if (streamState.terminal) {
        streamState.invalid = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data) as unknown;
      } catch {
        streamState.invalid = true;
        return;
      }
      const event = GatewayStreamEventSchema.safeParse(parsed);
      if (!event.success) {
        streamState.invalid = true;
        return;
      }
      streamState.terminal = event.data.type === 'done' || event.data.type === 'error';
      events.push(event.data);
    },
    onError() {
      streamState.invalid = true;
    },
  });

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      try {
        parser.feed(decoder.decode(next.value, { stream: true }));
      } catch {
        throw protocolError();
      }
      if (streamState.invalid) throw protocolError();
    }
    try {
      parser.feed(decoder.decode());
      parser.reset({ consume: true });
    } catch {
      throw protocolError();
    }
    if (streamState.invalid || !streamState.terminal) throw protocolError();
    return events;
  } finally {
    await reader.cancel(input.signal.aborted ? input.signal.reason : undefined).catch(() => undefined);
    reader.releaseLock();
  }
}

export function createModelGatewayLocalAgentClient(
  options: ModelGatewayLocalAgentClientOptions,
): LocalAgentCompletionGateway {
  const baseUrl = z
    .string()
    .url()
    .refine((value) => /^https?:\/\//u.test(value), 'Model gateway URL must use HTTP(S)')
    .parse(options.baseUrl);
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  return {
    async *stream(inputValue, signal) {
      const input = CompleteRequestSchema.parse(inputValue);
      const { token } = await signer.signServiceToken({
        service: 'control-api',
        aud: 'model-gateway',
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const events = await readCompletionAttempt({
            baseUrl,
            body: input,
            doFetch,
            signal,
            token,
          });
          yield* events;
          return;
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (attempt === 1) throw error;
        }
      }
    },
  };
}
