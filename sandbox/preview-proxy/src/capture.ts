import type { ServerResponse } from 'node:http';

import { z } from 'zod';

const MAX_CAPTURE_INPUT_CHARS = 60 * 1024;
const MAX_CAPTURE_TEXT_CHARS = 4_096;
const MAX_CAPTURE_URL_CHARS = 2_048;
const REDACTED = '[REDACTED]';
const SECRET_NAME_PATTERN = /authorization|cookie|pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|credential|session|signature|code/i;
const SECRET_ASSIGNMENT_PATTERN = /\b(authorization|cookie|pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|credential|session|signature|code)\b(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;
const CAPTURED_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

const CapturedTextSchema = z
  .string()
  .max(MAX_CAPTURE_INPUT_CHARS)
  .transform((value) => sanitizeCapturedText(value));
const CapturedUrlSchema = z
  .string()
  .max(MAX_CAPTURE_INPUT_CHARS)
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  })
  .transform((value) => sanitizeCapturedUrl(value));
const CapturedMethodSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
  .transform((value) => sanitizeCapturedText(value));

const ConsoleEventSchema = z
  .object({
    type: z.literal('console'),
    payload: z
      .object({
        level: z.enum(['log', 'warn', 'error']),
        message: CapturedTextSchema,
        stack: CapturedTextSchema,
      })
      .strict(),
  })
  .strict();

const NetworkEventSchema = z
  .object({
    type: z.literal('network'),
    payload: z
      .object({
        durationMs: z.number().finite().nonnegative(),
        method: CapturedMethodSchema,
        status: z.number().int().min(0).max(599),
        transport: z.enum(['fetch', 'xhr']),
        url: CapturedUrlSchema,
      })
      .strict(),
  })
  .strict();

const RouteChangeEventSchema = z
  .object({
    type: z.literal('route_change'),
    payload: z.object({ url: CapturedUrlSchema }).strict(),
  })
  .strict();

const RuntimeErrorEventSchema = z
  .object({
    type: z.literal('runtime_error'),
    payload: z
      .object({
        message: CapturedTextSchema,
        stack: CapturedTextSchema,
      })
      .strict(),
  })
  .strict();

export const BrowserEventSchema = z.discriminatedUnion('type', [
  ConsoleEventSchema,
  NetworkEventSchema,
  RouteChangeEventSchema,
  RuntimeErrorEventSchema,
]);

export type BrowserEvent = z.infer<typeof BrowserEventSchema>;

interface CapturedEvent {
  readonly event: BrowserEvent;
  readonly idempotencyKey?: string;
}

interface SseClient {
  blocked: boolean;
  readonly onDrain: () => void;
  readonly queue: string[];
  readonly response: ServerResponse;
}

function truncate(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }

  const suffix = '…[TRUNCATED]';
  return `${value.slice(0, maxCharacters - suffix.length)}${suffix}`;
}

function isSensitiveName(value: string): boolean {
  return SECRET_NAME_PATTERN.test(value);
}

function sanitizeCapturedUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (isSensitiveName(name)) {
      url.searchParams.set(name, REDACTED);
    }
  }

  return truncate(url.href, MAX_CAPTURE_URL_CHARS);
}

function sanitizeCapturedText(value: string): string {
  const sanitizedUrls = value.replace(CAPTURED_URL_PATTERN, (candidate) => {
    const trailing = candidate.match(/[),.;!?]+$/)?.[0] ?? '';
    const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
    try {
      return `${sanitizeCapturedUrl(url)}${trailing}`;
    } catch {
      return REDACTED;
    }
  });
  const sanitizedCredentials = sanitizedUrls.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, `$1 ${REDACTED}`);
  const sanitizedAssignments = sanitizedCredentials.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
  );
  return truncate(sanitizedAssignments, MAX_CAPTURE_TEXT_CHARS);
}

export class CaptureStore {
  readonly #events: CapturedEvent[] = [];
  readonly #idempotencyKeys = new Set<string>();
  readonly #clients = new Map<ServerResponse, SseClient>();
  readonly #maxRetainedEvents: number;
  readonly #maxSseClients: number;

  constructor(maxRetainedEvents: number, maxSseClients: number) {
    this.#maxRetainedEvents = maxRetainedEvents;
    this.#maxSseClients = maxSseClients;
  }

  add(event: BrowserEvent, idempotencyKey?: string): boolean {
    if (idempotencyKey !== undefined && this.#idempotencyKeys.has(idempotencyKey)) {
      return false;
    }

    this.#events.push(idempotencyKey === undefined ? { event } : { event, idempotencyKey });
    if (idempotencyKey !== undefined) {
      this.#idempotencyKeys.add(idempotencyKey);
    }

    if (this.#events.length > this.#maxRetainedEvents) {
      const evicted = this.#events.splice(0, this.#events.length - this.#maxRetainedEvents);
      for (const entry of evicted) {
        if (entry.idempotencyKey !== undefined) {
          this.#idempotencyKeys.delete(entry.idempotencyKey);
        }
      }
    }

    for (const client of this.#clients.values()) {
      this.#enqueue(client, event);
    }

    return true;
  }

  canOpen(): boolean {
    return this.#clients.size < this.#maxSseClients;
  }

  open(response: ServerResponse): boolean {
    if (!this.canOpen()) {
      return false;
    }

    const client: SseClient = {
      blocked: false,
      onDrain: () => {
        client.blocked = false;
        this.#flush(client);
      },
      queue: [],
      response,
    };
    this.#clients.set(response, client);
    const cleanup = () => {
      this.#remove(client);
    };
    response.once('close', cleanup);
    response.once('error', cleanup);

    for (const { event } of this.#events) {
      this.#queue(client, event);
    }
    this.#flush(client);

    return true;
  }

  close(): void {
    for (const client of this.#clients.values()) {
      this.#remove(client);
      if (!client.response.destroyed && !client.response.writableEnded) {
        client.response.end();
      }
    }

    this.#clients.clear();
  }

  #enqueue(client: SseClient, event: BrowserEvent): void {
    this.#queue(client, event);
    this.#flush(client);
  }

  #queue(client: SseClient, event: BrowserEvent): void {
    if (client.queue.length >= this.#maxRetainedEvents) {
      client.queue.shift();
    }
    client.queue.push(`data: ${JSON.stringify(event)}\n\n`);
  }

  #flush(client: SseClient): void {
    const { response } = client;
    if (client.blocked || !this.#clients.has(response)) {
      return;
    }
    if (response.destroyed || response.writableEnded) {
      this.#remove(client);
      return;
    }

    while (client.queue.length > 0) {
      const frame = client.queue.shift();
      if (frame === undefined) {
        return;
      }

      try {
        if (!response.write(frame)) {
          client.blocked = true;
          response.once('drain', client.onDrain);
          return;
        }
      } catch {
        this.#remove(client);
        return;
      }
    }
  }

  #remove(client: SseClient): void {
    client.response.off('drain', client.onDrain);
    this.#clients.delete(client.response);
  }
}
