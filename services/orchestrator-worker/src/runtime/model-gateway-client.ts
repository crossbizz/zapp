import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import {
  CompleteRequestSchema,
  GatewayStreamEventSchema,
  type CompleteRequest,
  type GatewayStreamEvent,
} from '@zapp/model-gateway';
import { z } from 'zod';

import {
  SessionCompletionRetryableError,
  type SessionGateway,
} from '../session/loop.js';

export interface ModelGatewaySessionClientOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: typeof fetch;
}

export class ModelGatewayRequestError extends Error {
  public constructor(public readonly statusCode: number) {
    super(`Model gateway request failed with status ${String(statusCode)}`);
    this.name = 'ModelGatewayRequestError';
  }
}

export class ModelGatewayStreamError extends Error {
  public constructor(message = 'Model gateway returned an invalid event stream') {
    super(message);
    this.name = 'ModelGatewayStreamError';
  }
}

export class ModelGatewayCancelledError extends Error {
  public constructor() {
    super('Model gateway request was cancelled');
    this.name = 'ModelGatewayCancelledError';
  }
}

function isRetryableGatewayStatus(statusCode: number): boolean {
  return (
    statusCode === 404 ||
    statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500
  );
}

function parseSseEvent(frame: string): GatewayStreamEvent | undefined {
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line === '' || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    if (field !== 'data') continue;
    const raw = separator === -1 ? '' : line.slice(separator + 1);
    data.push(raw.startsWith(' ') ? raw.slice(1) : raw);
  }
  if (data.length === 0) return undefined;
  try {
    return GatewayStreamEventSchema.parse(JSON.parse(data.join('\n')));
  } catch {
    throw new ModelGatewayStreamError();
  }
}

async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<GatewayStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal: GatewayStreamEvent | undefined;
  try {
    for (;;) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      for (;;) {
        const boundary = /\r?\n\r?\n/u.exec(buffer);
        if (boundary === null) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseSseEvent(frame);
        if (event === undefined) continue;
        if (terminal !== undefined) throw new ModelGatewayStreamError();
        if (event.type === 'done' || event.type === 'error') terminal = event;
        else yield event;
      }
      if (next.done) break;
    }
    if (buffer.trim().length > 0) throw new ModelGatewayStreamError();
    if (terminal === undefined) throw new ModelGatewayStreamError();
    yield terminal;
  } catch (error: unknown) {
    if (signal.aborted) throw new ModelGatewayCancelledError();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function createModelGatewaySessionGateway(
  optionsValue: ModelGatewaySessionClientOptions,
): SessionGateway {
  const options = {
    ...optionsValue,
    baseUrl: z.string().url().parse(optionsValue.baseUrl).replace(/\/$/u, ''),
  };
  const fetchImpl = options.fetch ?? fetch;
  const serviceTokens = createServiceTokenSigner(options.serviceTokens);

  return {
    async *stream(requestValue: CompleteRequest, signal: AbortSignal) {
      const request = CompleteRequestSchema.parse(requestValue);
      try {
        const issued = await serviceTokens.signServiceToken({
          service: 'orchestrator-worker',
          aud: 'model-gateway',
        });
        const response = await fetchImpl(`${options.baseUrl}/internal/v1/complete`, {
          method: 'POST',
          headers: {
            accept: 'text/event-stream',
            'content-type': 'application/json',
            'x-zapp-service-token': issued.token,
          },
          body: JSON.stringify(request),
          signal,
        });
        if (!response.ok) {
          if (isRetryableGatewayStatus(response.status)) {
            throw new SessionCompletionRetryableError('gateway_unavailable');
          }
          throw new ModelGatewayRequestError(response.status);
        }
        if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
          throw new ModelGatewayStreamError();
        }
        if (response.body === null) throw new ModelGatewayStreamError();
        yield* parseEventStream(response.body, signal);
      } catch (error: unknown) {
        if (signal.aborted) throw new ModelGatewayCancelledError();
        throw error;
      }
    },
  };
}
