import { readFile } from 'node:fs/promises';
import {
  type ClientRequest,
  createServer,
  ServerResponse,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createConnection } from 'node:net';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { ExecutionContractSchema } from '@zapp/contracts';
import httpProxy from 'http-proxy';
import { RewritingStream } from 'parse5-html-rewriting-stream';
import { chromium, type ConnectOverCDPTransport } from 'playwright-core';
import { WebSocket } from 'ws';
import { z } from 'zod';

import { BrowserEventSchema, CaptureStore } from './capture.js';

const CLIENT_PATH = '/__zapp/client.js';
const EVENTS_PATH = '/__zapp/events';
const HEALTH_PATH = '/__zapp/healthz';
const SCREENSHOT_PATH = '/__zapp/screenshot';
const ZAPP_PATH_PREFIX = '/__zapp/';
const DEGRADED_CAPTURE_HEADER = 'x-zapp-capture-degraded';
const DEFAULT_PROBE_PORTS = [3000, 5173, 4321, 8000];
const DEFAULT_MAX_RETAINED_EVENTS = 100;
const DEFAULT_MAX_SSE_CLIENTS = 16;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 10_000;
const DEFAULT_UPSTREAM_RESPONSE_HEADER_TIMEOUT_MS = 10_000;
const DEFAULT_WEBSOCKET_UPGRADE_TIMEOUT_MS = 10_000;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const RequestShapeSchema = z
  .object({
    contentType: z.string().optional(),
    hasBody: z.boolean(),
    idempotencyKey: z.string().optional(),
    method: z.string(),
    queryEntries: z.array(z.tuple([z.string(), z.string()])),
    queryPresent: z.boolean(),
  })
  .strict();

const GetMethodSchema = z.literal('GET');
const PostMethodSchema = z.literal('POST');
const EventsMethodSchema = z.enum(['GET', 'POST']);

const EmptyEndpointRequestSchema = z
  .object({
    contentType: z.undefined(),
    hasBody: z.literal(false),
    idempotencyKey: z.undefined(),
    queryEntries: z.tuple([]),
    queryPresent: z.literal(false),
  })
  .strict();

const HealthRequestSchema = EmptyEndpointRequestSchema.extend({ method: GetMethodSchema }).strict();
const ClientRequestSchema = RequestShapeSchema.extend({
  contentType: z.undefined(),
  hasBody: z.literal(false),
  idempotencyKey: z.undefined(),
  method: GetMethodSchema,
}).strict();
const EventsGetRequestSchema = EmptyEndpointRequestSchema.extend({
  method: GetMethodSchema,
}).strict();
const EventsPostRequestSchema = z
  .object({
    contentType: z.string().regex(/^\s*application\/json\s*(?:;\s*charset=utf-8\s*)*$/i),
    hasBody: z.boolean(),
    idempotencyKey: z.string().uuid(),
    method: PostMethodSchema,
    queryEntries: z.tuple([]),
    queryPresent: z.literal(false),
  })
  .strict();
const ScreenshotRequestSchema = EmptyEndpointRequestSchema.extend({
  method: PostMethodSchema,
}).strict();

const HealthResponseSchema = z.object({ status: z.literal('ok') }).strict();
const ScreenshotCaptureResultSchema = z
  .object({
    contentType: z.literal('image/png'),
    image: z
      .instanceof(Buffer)
      .refine((image) => image.length <= MAX_SCREENSHOT_BYTES, 'Screenshot exceeds byte limit')
      .refine(
        (image) =>
          image.length >= PNG_SIGNATURE.length &&
          image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
        'Expected PNG screenshot bytes',
      ),
  })
  .strict();

type ScreenshotCaptureResult = z.infer<typeof ScreenshotCaptureResultSchema>;
type RequestShape = z.infer<typeof RequestShapeSchema>;

export type ScreenshotCapture = (signal: AbortSignal) => Promise<ScreenshotCaptureResult>;

const PortSchema = z.number().int().min(0).max(65_535);
const ProductionPortSchema = z.number().int().min(1).max(65_535);
const ProbePortSchema = z.number().int().min(1).max(65_535);
const PositiveIntegerSchema = z.number().int().positive();
const HttpEndpointSchema = z
  .string()
  .url()
  .max(2_048)
  .refine(
    (value) => ['http:', 'https:'].includes(new URL(value).protocol),
    'Expected an HTTP(S) URL',
  );
const CdpEndpointSchema = z
  .string()
  .url()
  .max(2_048)
  .refine(
    (value) => ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(value).protocol),
    'Expected an HTTP(S) or WebSocket CDP URL',
  );
const CdpWebSocketEndpointSchema = z
  .string()
  .url()
  .max(2_048)
  .refine(
    (value) => ['ws:', 'wss:'].includes(new URL(value).protocol),
    'Expected a WebSocket CDP URL',
  );
const CdpVersionResponseSchema = z
  .object({ webSocketDebuggerUrl: CdpWebSocketEndpointSchema })
  .passthrough();
const HeartbeatSendSchema = z.custom<(signal: AbortSignal) => Promise<void>>(
  (value) => typeof value === 'function',
);
const ScreenshotCaptureSchema = z.custom<ScreenshotCapture>((value) => typeof value === 'function');

const PreviewProxyOptionsSchema = z
  .object({
    captureScreenshot: ScreenshotCaptureSchema.optional(),
    cdpEndpoint: CdpEndpointSchema.optional(),
    executionContract: ExecutionContractSchema.optional(),
    heartbeat: z
      .object({
        intervalMs: PositiveIntegerSchema.max(86_400_000).optional(),
        send: HeartbeatSendSchema,
        timeoutMs: PositiveIntegerSchema.max(300_000).optional(),
      })
      .strict()
      .optional(),
    htmlInspectionCapBytes: PositiveIntegerSchema.max(1024 * 1024).optional(),
    maxRetainedEvents: PositiveIntegerSchema.max(10_000).optional(),
    maxSseClients: PositiveIntegerSchema.max(256).optional(),
    parentOrigin: z.string().min(1).max(2_048).optional(),
    port: PortSchema.optional(),
    probePorts: z.array(ProbePortSchema).max(32).optional(),
    screenshotTimeoutMs: PositiveIntegerSchema.max(300_000).optional(),
    target: HttpEndpointSchema.optional(),
    upstreamResponseHeaderTimeoutMs: PositiveIntegerSchema.max(300_000).optional(),
    webSocketUpgradeTimeoutMs: PositiveIntegerSchema.max(300_000).optional(),
  })
  .strict();

const JsonExecutionContractSchema = z
  .string()
  .transform((value, context): unknown => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expected JSON execution contract',
      });
      return z.NEVER;
    }
  })
  .pipe(ExecutionContractSchema);
const EnvironmentPortSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(ProductionPortSchema);
const EnvironmentProbePortsSchema = z
  .string()
  .min(1)
  .transform((value) => value.split(',').map((port) => Number(port.trim())))
  .pipe(z.array(ProbePortSchema).min(1).max(32));
const ParentOriginEnvironmentSchema = z.string().transform((value, context) => {
  try {
    return canonicalParentOrigin(value);
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expected an exact HTTP(S) parent origin',
    });
    return z.NEVER;
  }
});
const PreviewProxyEnvironmentSchema = z
  .object({
    PORT: EnvironmentPortSchema.default('8080'),
    ZAPP_AGENT_TOKEN: z.string().min(1).max(16_384).optional(),
    ZAPP_CDP_ENDPOINT: CdpEndpointSchema.optional(),
    ZAPP_EXECUTION_CONTRACT: JsonExecutionContractSchema.optional(),
    ZAPP_PARENT_ORIGIN: ParentOriginEnvironmentSchema.optional(),
    ZAPP_PREVIEW_PROBE_PORTS: EnvironmentProbePortsSchema.optional(),
    ZAPP_PREVIEW_TARGET: HttpEndpointSchema.optional(),
    ZAPP_SANDBOX_HEARTBEAT_URL: HttpEndpointSchema.optional(),
  })
  .strict();

export type PreviewProxyOptions = z.infer<typeof PreviewProxyOptionsSchema>;

export interface PreviewProxy {
  close(): Promise<void>;
  readonly url: string;
}

interface TargetResolver {
  invalidate(target: string): void;
  resolve(): Promise<string | undefined>;
}

interface ScreenshotCoordinator {
  capture(requestSignal: AbortSignal): Promise<ScreenshotCaptureResult | 'busy' | 'unavailable'>;
  close(): void;
}

interface OwnedCdpTransport extends ConnectOverCDPTransport {
  closeAndWait(): Promise<void>;
}

interface RequestDependencies {
  readonly capture: CaptureStore;
  readonly clientSource: Buffer;
  readonly proxy: ReturnType<typeof httpProxy.createProxyServer>;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly screenshotCoordinator: ScreenshotCoordinator;
  readonly targetForRequest: WeakMap<IncomingMessage, string>;
  readonly targetResolver: TargetResolver;
}

const HEAD_CONTENT_ELEMENTS = new Set([
  'base',
  'basefont',
  'bgsound',
  'link',
  'meta',
  'noframes',
  'noscript',
  'script',
  'style',
  'template',
  'title',
]);
const HEAD_TEXT_CONTAINERS = new Set(['noscript', 'script', 'style', 'template', 'title']);

interface HtmlStartTag {
  attrs: Array<{ name: string; namespace?: string; prefix?: string; value: string }>;
  tagName: string;
}

class PreviewHtmlRewriter extends RewritingStream {
  #activeBaseUrl: URL;
  #baseSeen = false;
  #bodyStarted = false;
  #clientPresent = false;
  readonly #documentUrl: URL;
  #headTextDepth = 0;

  constructor(documentUrl: URL) {
    super();
    this.#activeBaseUrl = documentUrl;
    this.#documentUrl = documentUrl;

    this.on('startTag', (startTag, rawHtml) => {
      const tagName = startTag.tagName;
      const isClient =
        tagName === 'script' &&
        isProtectedClientSource(
          htmlAttribute(startTag, 'src'),
          this.#activeBaseUrl,
          this.#documentUrl,
        );

      if (isClient) {
        if (this.#clientPresent) {
          neutralizeClientStartTag(startTag);
          this.emitStartTag(startTag);
          return;
        }
        this.#clientPresent = true;
      } else if (!this.#clientPresent && this.#shouldInjectBefore(tagName)) {
        this.#emitClient();
      }

      this.emitRaw(rawHtml);

      if (tagName === 'body' || this.#isBodyElement(tagName)) this.#bodyStarted = true;
      if (HEAD_TEXT_CONTAINERS.has(tagName) && !this.#bodyStarted) this.#headTextDepth += 1;
      if (tagName === 'base' && !this.#baseSeen) {
        this.#baseSeen = true;
        const href = htmlAttribute(startTag, 'href');
        if (href !== undefined) this.#activeBaseUrl = resolveDocumentBaseUrl(href, this.#documentUrl);
      }
    });

    this.on('endTag', (endTag, rawHtml) => {
      if (!this.#clientPresent && (endTag.tagName === 'head' || endTag.tagName === 'body')) {
        this.#emitClient();
      }
      this.emitRaw(rawHtml);
      if (HEAD_TEXT_CONTAINERS.has(endTag.tagName) && this.#headTextDepth > 0) {
        this.#headTextDepth -= 1;
      }
    });

    this.on('text', (text, rawHtml) => {
      if (
        !this.#clientPresent &&
        this.#headTextDepth === 0 &&
        text.text.trim().length > 0
      ) {
        this.#emitClient();
        this.#bodyStarted = true;
      }
      this.emitRaw(rawHtml);
    });
  }

  override _final(callback: (error?: Error | null, data?: string) => void): void {
    super._final((error, data) => {
      if (error) {
        callback(error);
        return;
      }
      if (!this.#clientPresent) this.#emitClient();
      callback(null, data);
    });
  }

  #emitClient(): void {
    this.emitRaw(`<script src="${CLIENT_PATH}"></script>`);
    this.#clientPresent = true;
  }

  #isBodyElement(tagName: string): boolean {
    return tagName !== 'html' && tagName !== 'head' && !HEAD_CONTENT_ELEMENTS.has(tagName);
  }

  #shouldInjectBefore(tagName: string): boolean {
    return (
      tagName === 'base' ||
      tagName === 'body' ||
      tagName === 'template' ||
      this.#bodyStarted ||
      this.#isBodyElement(tagName)
    );
  }
}

class ServerResponseSink extends Writable {
  readonly #response: ServerResponse;

  constructor(response: ServerResponse) {
    super();
    this.#response = response;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.#response.destroyed || this.#response.writableEnded) {
      callback(new Error('Proxy response closed before transformed body could be written'));
      return;
    }
    if (this.#response.write(chunk)) {
      callback();
      return;
    }

    const cleanup = () => {
      this.#response.off('close', onClose);
      this.#response.off('drain', onDrain);
      this.#response.off('error', onError);
    };
    const onClose = () => {
      cleanup();
      callback(new Error('Proxy response closed before transformed body drained'));
    };
    const onDrain = () => {
      cleanup();
      callback();
    };
    const onError = (error: Error) => {
      cleanup();
      callback(error);
    };
    this.#response.once('close', onClose);
    this.#response.once('drain', onDrain);
    this.#response.once('error', onError);
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.#response.destroyed || this.#response.writableEnded) {
      callback(new Error('Proxy response closed before transformed body completed'));
      return;
    }
    this.#response.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (error && this.#response.headersSent && !this.#response.writableEnded) {
      this.#response.destroy(error);
    }
    callback();
  }
}

function htmlAttribute(startTag: HtmlStartTag, name: string): string | undefined {
  return startTag.attrs.find((attribute) => attribute.name === name)?.value;
}

function resolveDocumentBaseUrl(href: string, documentUrl: URL): URL {
  try {
    return new URL(href, documentUrl);
  } catch {
    return documentUrl;
  }
}

function isProtectedClientSource(source: string | undefined, baseUrl: URL, documentUrl: URL): boolean {
  if (source === undefined) return false;
  try {
    const candidate = new URL(source, baseUrl);
    const protectedClient = new URL(CLIENT_PATH, documentUrl);
    return (
      candidate.origin === protectedClient.origin && candidate.pathname === protectedClient.pathname
    );
  } catch {
    return false;
  }
}

function neutralizeClientStartTag(startTag: HtmlStartTag): void {
  startTag.attrs = startTag.attrs.filter(
    (attribute) => attribute.name !== 'src' && attribute.name !== 'type',
  );
  startTag.attrs.push({ name: 'type', value: 'application/x-zapp-neutralized' });
}

export function createCdpScreenshotCapture(cdpEndpoint: string): ScreenshotCapture {
  return async (signal) => {
    throwIfAborted(signal);
    const transport = await createCdpTransport(cdpEndpoint, signal);
    const closeTransport = () => {
      transport.close();
    };
    signal.addEventListener('abort', closeTransport, { once: true });
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
    try {
      browser = await chromium.connectOverCDP(transport);
    } catch (error) {
      await transport.closeAndWait();
      throw error;
    } finally {
      signal.removeEventListener('abort', closeTransport);
    }
    if (signal.aborted) {
      await browser.close().catch(() => undefined);
      await transport.closeAndWait();
      throw abortError();
    }
    const closeBrowser = () => {
      void browser.close().catch(() => undefined);
    };
    signal.addEventListener('abort', closeBrowser, { once: true });

    try {
      const page = browser.contexts().flatMap((context) => context.pages())[0];

      if (!page) {
        throw new Error('CDP browser has no page to capture');
      }

      return {
        contentType: 'image/png',
        image: await abortable(page.screenshot({ type: 'png' }), signal),
      };
    } finally {
      signal.removeEventListener('abort', closeBrowser);
      await browser.close().catch(() => undefined);
      await transport.closeAndWait();
    }
  };
}

async function createCdpTransport(
  cdpEndpoint: string,
  signal: AbortSignal,
): Promise<OwnedCdpTransport> {
  const endpoint = new URL(cdpEndpoint);
  let webSocketEndpoint: string;
  if (endpoint.protocol === 'http:' || endpoint.protocol === 'https:') {
    if (!endpoint.pathname.endsWith('/')) {
      endpoint.pathname += '/';
    }
    endpoint.pathname += 'json/version/';
    webSocketEndpoint = await discoverCdpWebSocketEndpoint(endpoint, signal);
  } else {
    webSocketEndpoint = CdpWebSocketEndpointSchema.parse(cdpEndpoint);
  }

  return openCdpWebSocketTransport(webSocketEndpoint, signal);
}

async function discoverCdpWebSocketEndpoint(endpoint: URL, signal: AbortSignal): Promise<string> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let responseBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
      } else if (value !== undefined) {
        resolve(value);
      } else {
        reject(new Error('CDP endpoint discovery returned no WebSocket URL'));
      }
    };
    const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(
      endpoint,
      { agent: false },
      (response) => {
        if (
          response.statusCode === undefined ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          response.resume();
          finish(
            new Error(
              `CDP endpoint discovery failed with status ${String(response.statusCode ?? 0)}`,
            ),
          );
          return;
        }
        response.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseBytes > MAX_EVENT_BYTES) {
            response.destroy(new Error('CDP endpoint discovery response exceeded byte limit'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once('end', () => {
          try {
            const parsed = CdpVersionResponseSchema.parse(
              JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
            );
            finish(undefined, parsed.webSocketDebuggerUrl);
          } catch (error) {
            finish(asError(error));
          }
        });
        response.once('error', (error) => {
          finish(error);
        });
      },
    );
    const onAbort = () => {
      request.destroy(abortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    request.once('error', (error) => {
      finish(error);
    });
    request.end();
  });
}

async function openCdpWebSocketTransport(
  endpoint: string,
  signal: AbortSignal,
): Promise<OwnedCdpTransport> {
  throwIfAborted(signal);
  const socket = new WebSocket(endpoint);

  return new Promise((resolve, reject) => {
    let openingError: Error | undefined;
    const cleanupOpeningListeners = () => {
      signal.removeEventListener('abort', onAbort);
      socket.off('close', onOpeningClose);
      socket.off('error', onError);
      socket.off('open', onOpen);
    };
    const terminateSocket = () => {
      try {
        socket.terminate();
      } catch {
        // A failed socket can already have completed its close event.
      }
    };
    const onAbort = () => {
      openingError = abortError();
      terminateSocket();
    };
    const onError = () => {
      openingError ??= new Error('CDP WebSocket connection failed');
      terminateSocket();
    };
    const onOpeningClose = () => {
      const error = openingError ?? new Error('CDP WebSocket connection closed before opening');
      cleanupOpeningListeners();
      reject(error);
    };
    const onOpen = () => {
      cleanupOpeningListeners();
      let closed = false;
      let resolveClosed!: () => void;
      const closedPromise = new Promise<void>((resolveClosedPromise) => {
        resolveClosed = resolveClosedPromise;
      });
      const close = () => {
        if (closed) {
          return;
        }
        signal.removeEventListener('abort', close);
        terminateSocket();
      };
      const transport: OwnedCdpTransport = {
        close,
        async closeAndWait(): Promise<void> {
          close();
          await closedPromise;
        },
        open: () => undefined,
        send(message): void {
          socket.send(JSON.stringify(message));
        },
      };
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          close();
          transport.onclose?.('CDP WebSocket sent a non-text message');
          return;
        }
        try {
          const text = Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Array.isArray(data)
              ? Buffer.concat(data).toString('utf8')
              : Buffer.from(data).toString('utf8');
          transport.onmessage?.(JSON.parse(text) as object);
        } catch {
          close();
          transport.onclose?.('CDP WebSocket sent malformed JSON');
        }
      });
      socket.once('close', (_code, reason) => {
        signal.removeEventListener('abort', close);
        closed = true;
        resolveClosed();
        transport.onclose?.(reason.toString());
      });
      socket.once('error', () => {
        transport.onclose?.('CDP WebSocket transport failed');
      });
      signal.addEventListener('abort', close, { once: true });
      resolve(transport);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('close', onOpeningClose);
    socket.once('error', onError);
    socket.once('open', onOpen);
  });
}

export function createHeartbeatSender(
  heartbeatUrl: string,
  heartbeatToken: string | undefined,
): (signal: AbortSignal) => Promise<void> {
  return async (signal) => {
    const request: RequestInit = {
      method: 'POST',
      signal,
    };
    if (heartbeatToken) {
      request.headers = { authorization: `Bearer ${heartbeatToken}` };
    }
    const response = await fetch(heartbeatUrl, request);

    if (!response.ok) {
      throw new Error(`Sandbox heartbeat request failed with status ${String(response.status)}`);
    }
  };
}

export async function createPreviewProxy(
  untrustedOptions: PreviewProxyOptions,
): Promise<PreviewProxy> {
  const options = PreviewProxyOptionsSchema.parse(untrustedOptions);
  const targetResolver = createTargetResolver(options);
  const parentOrigin =
    options.parentOrigin === undefined ? undefined : canonicalParentOrigin(options.parentOrigin);
  const clientSource = configureClientSource(
    await readFile(fileURLToPath(new URL('./inject/zapp-client.js', import.meta.url))),
    parentOrigin,
  );
  const capture = new CaptureStore(
    options.maxRetainedEvents ?? DEFAULT_MAX_RETAINED_EVENTS,
    options.maxSseClients ?? DEFAULT_MAX_SSE_CLIENTS,
  );
  const screenshotCapture =
    options.captureScreenshot ??
    (options.cdpEndpoint ? createCdpScreenshotCapture(options.cdpEndpoint) : undefined);
  const screenshotCoordinator = createScreenshotCoordinator(
    screenshotCapture,
    options.screenshotTimeoutMs ?? DEFAULT_SCREENSHOT_TIMEOUT_MS,
  );
  const proxy = httpProxy.createProxyServer({ selfHandleResponse: true, ws: true });
  const targetForRequest = new WeakMap<IncomingMessage, string>();
  const upstreamResponseHeaderTimeoutMs =
    options.upstreamResponseHeaderTimeoutMs ?? DEFAULT_UPSTREAM_RESPONSE_HEADER_TIMEOUT_MS;
  const webSocketUpgradeTimeoutMs =
    options.webSocketUpgradeTimeoutMs ?? DEFAULT_WEBSOCKET_UPGRADE_TIMEOUT_MS;
  const server = createServer((request, response) => {
    void handleRequest({
      capture,
      clientSource,
      proxy,
      request,
      response,
      screenshotCoordinator,
      targetForRequest,
      targetResolver,
    }).catch(() => {
      failRequest(response);
    });
  });
  const sockets = new Set<import('node:net').Socket>();
  const proxiedSockets = new Set<import('node:net').Socket>();
  const heartbeatOperations = new Set<Promise<void>>();
  const preResponseRequests = new Map<ClientRequest, () => void>();
  let closed = false;
  let heartbeatAbortController: AbortController | undefined;
  let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;

  const bindPreResponseRequest = (
    proxyRequest: ClientRequest,
    request: IncomingMessage,
    downstream: ServerResponse | import('node:net').Socket,
    timeoutMs: number,
  ) => {
    let active = true;
    const destroyProxyRequest = () => {
      proxyRequest.socket?.resetAndDestroy();
      proxyRequest.destroy();
    };
    const timeout = setTimeout(() => {
      const failedTarget = targetForRequest.get(request);
      if (failedTarget) {
        targetResolver.invalidate(failedTarget);
      }
      cleanup();
      destroyProxyRequest();
      if (downstream instanceof ServerResponse) {
        failProxiedResponse(downstream, new Error('Upstream response header timed out'));
      } else {
        downstream.destroy();
      }
    }, timeoutMs);
    const cleanup = () => {
      if (!active) {
        return;
      }
      active = false;
      clearTimeout(timeout);
      preResponseRequests.delete(proxyRequest);
      request.off('aborted', cancel);
      downstream.off('close', onDownstreamClose);
      downstream.off('error', cancel);
      proxyRequest.off('close', cleanup);
      proxyRequest.off('error', cleanup);
      proxyRequest.off('response', cleanup);
      proxyRequest.off('upgrade', cleanup);
    };
    const cancel = () => {
      cleanup();
      destroyProxyRequest();
    };
    const onDownstreamClose = () => {
      if (!(downstream instanceof ServerResponse) || !downstream.writableEnded) {
        cancel();
      }
    };

    preResponseRequests.set(proxyRequest, cleanup);
    request.once('aborted', cancel);
    downstream.once('close', onDownstreamClose);
    downstream.once('error', cancel);
    proxyRequest.once('close', cleanup);
    proxyRequest.once('error', cleanup);
    proxyRequest.once('response', cleanup);
    proxyRequest.once('upgrade', cleanup);
  };

  const sendHeartbeat = () => {
    const heartbeat = options.heartbeat;

    if (closed || !heartbeat || heartbeatAbortController || heartbeatOperations.size >= 2) {
      return;
    }

    const controller = new AbortController();
    heartbeatAbortController = controller;
    heartbeatTimeout = setTimeout(() => {
      controller.abort();
    }, heartbeat.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS);
    const operation = callAsPromise(() => heartbeat.send(controller.signal));
    heartbeatOperations.add(operation);
    void operation.then(
      () => {
        heartbeatOperations.delete(operation);
      },
      () => {
        heartbeatOperations.delete(operation);
      },
    );
    void abortable(operation, controller.signal)
      .catch(() => {
        // A later interval retries heartbeat failures; this avoids an unhandled rejection.
      })
      .finally(() => {
        if (heartbeatAbortController === controller) {
          heartbeatAbortController = undefined;
          if (heartbeatTimeout) {
            clearTimeout(heartbeatTimeout);
            heartbeatTimeout = undefined;
          }
        }
      });
  };

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://preview-proxy').pathname;
    if (isZappPath(pathname)) {
      socket.destroy();
      return;
    }

    void targetResolver
      .resolve()
      .then((target) => {
        if (!target || socket.destroyed) {
          socket.destroy();
          return;
        }

        targetForRequest.set(request, target);
        proxy.ws(request, socket, head, { target });
      })
      .catch(() => {
        socket.destroy();
      });
  });
  proxy.on('proxyReq', (proxyRequest, request, response) => {
    proxyRequest.setHeader('accept-encoding', 'identity');
    if (response instanceof ServerResponse) {
      bindPreResponseRequest(proxyRequest, request, response, upstreamResponseHeaderTimeoutMs);
    }
  });
  proxy.on('proxyReqWs', (proxyRequest, request, socket) => {
    bindPreResponseRequest(proxyRequest, request, socket, webSocketUpgradeTimeoutMs);
  });
  proxy.on('open', (socket) => {
    proxiedSockets.add(socket);
    socket.once('close', () => proxiedSockets.delete(socket));
  });
  proxy.on('proxyRes', (proxyResponse, request, response) => {
    if (!(response instanceof ServerResponse)) {
      return;
    }

    void writeProxiedResponse(proxyResponse, request, response).catch((error: unknown) => {
      failProxiedResponse(response, error);
    });
  });
  proxy.on('error', (error, request, response) => {
    const failedTarget = targetForRequest.get(request);
    if (failedTarget) {
      targetResolver.invalidate(failedTarget);
    }
    if (response instanceof ServerResponse) {
      failProxiedResponse(response, error);
      return;
    }

    response.destroy();
  });

  await listen(server, options.port ?? 8080);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 8080);
  const heartbeatInterval = options.heartbeat
    ? setInterval(sendHeartbeat, options.heartbeat.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS)
    : undefined;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = undefined;
      }
      heartbeatAbortController?.abort();
      screenshotCoordinator.close();
      capture.close();
      const closingPreResponseRequests = [...preResponseRequests].map(([proxyRequest, cleanup]) => {
        const requestClosed = proxyRequest.destroyed
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              proxyRequest.once('close', resolve);
            });
        cleanup();
        proxyRequest.socket?.resetAndDestroy();
        proxyRequest.destroy();
        return requestClosed;
      });
      proxy.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      for (const socket of proxiedSockets) {
        socket.destroy();
      }
      await Promise.all(closingPreResponseRequests);
      await closeServer(server);
    },
  };
}

export function canonicalParentOrigin(value: string): string {
  try {
    const origin = new URL(value);
    if (
      (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    ) {
      throw new Error('not an exact http(s) origin');
    }

    return origin.origin;
  } catch {
    throw new Error('ZAPP_PARENT_ORIGIN must be an exact http(s) origin');
  }
}

function configureClientSource(source: Buffer, parentOrigin: string | undefined): Buffer {
  const placeholder = '/*__ZAPP_PARENT_ORIGIN__*/ null';
  const clientSource = source.toString('utf8');
  const placeholderIndex = clientSource.indexOf(placeholder);

  if (
    placeholderIndex < 0 ||
    clientSource.indexOf(placeholder, placeholderIndex + placeholder.length) >= 0
  ) {
    throw new Error('zapp client must contain exactly one parent-origin placeholder');
  }

  return Buffer.from(clientSource.replace(placeholder, JSON.stringify(parentOrigin ?? null)));
}

async function handleRequest(dependencies: RequestDependencies): Promise<void> {
  const { proxy, request, response, targetForRequest, targetResolver } = dependencies;
  const pathname = new URL(request.url ?? '/', 'http://preview-proxy').pathname;

  if (isZappPath(pathname)) {
    await handleZappRequest(pathname, dependencies);
    return;
  }

  let target: string | undefined;
  try {
    target = await targetResolver.resolve();
  } catch {
    sendResponse(response, 502);
    return;
  }

  if (!target) {
    sendResponse(response, 502);
    return;
  }

  try {
    targetForRequest.set(request, target);
    proxy.web(request, response, { target });
  } catch (error) {
    targetResolver.invalidate(target);
    failProxiedResponse(response, error);
  }
}

async function handleZappRequest(
  pathname: string,
  dependencies: RequestDependencies,
): Promise<void> {
  const { capture, clientSource, request, response, screenshotCoordinator } = dependencies;

  switch (pathname) {
    case HEALTH_PATH:
      if (!parseOwnedRequest(request, response, GetMethodSchema, 'GET', HealthRequestSchema)) {
        return;
      }
      sendResponse(
        response,
        200,
        { 'content-type': 'application/json' },
        JSON.stringify(HealthResponseSchema.parse({ status: 'ok' })),
      );
      return;
    case CLIENT_PATH:
      if (!parseOwnedRequest(request, response, GetMethodSchema, 'GET', ClientRequestSchema)) {
        return;
      }
      sendResponse(
        response,
        200,
        {
          'content-length': String(clientSource.length),
          'content-type': 'text/javascript; charset=utf-8',
        },
        clientSource,
      );
      return;
    case EVENTS_PATH: {
      const requestShape = requestShapeFrom(request);
      const method = parseOwnedMethod(
        request,
        response,
        requestShape,
        EventsMethodSchema,
        'GET, POST',
      );
      if (!method) {
        return;
      }
      if (method === 'GET') {
        if (!parseOwnedRequestShape(request, response, requestShape, EventsGetRequestSchema)) {
          return;
        }
        if (!capture.canOpen()) {
          sendResponse(response, 429);
          return;
        }

        if (
          !startResponse(response, 200, {
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'content-type': 'text/event-stream; charset=utf-8',
          })
        )
          return;
        response.flushHeaders();
        capture.open(response);
        return;
      }
      const eventRequest = parseOwnedRequestShape(
        request,
        response,
        requestShape,
        EventsPostRequestSchema,
      );
      if (!eventRequest) {
        return;
      }

      const event = await readBrowserEvent(request);
      if (!event) {
        sendResponse(response, 400);
        return;
      }

      capture.add(event, eventRequest.idempotencyKey);
      sendResponse(response, 204);
      return;
    }
    case SCREENSHOT_PATH:
      if (
        !parseOwnedRequest(request, response, PostMethodSchema, 'POST', ScreenshotRequestSchema)
      ) {
        return;
      }

      const requestCancellation = abortOnDownstreamClose(request, response);
      try {
        const screenshot = await screenshotCoordinator.capture(requestCancellation.signal);
        if (screenshot === 'unavailable') {
          sendResponse(response, 501);
          return;
        }
        if (screenshot === 'busy') {
          sendResponse(response, 503);
          return;
        }

        sendResponse(
          response,
          200,
          {
            'content-length': String(screenshot.image.length),
            'content-type': screenshot.contentType,
          },
          screenshot.image,
        );
      } catch {
        sendResponse(response, 503);
      } finally {
        requestCancellation.cleanup();
      }
      return;
    default:
      sendResponse(response, 404);
  }
}

function isZappPath(pathname: string): boolean {
  return pathname === '/__zapp' || pathname.startsWith(ZAPP_PATH_PREFIX);
}

function parseOwnedRequest<Output>(
  request: IncomingMessage,
  response: ServerResponse,
  methodSchema: z.ZodType<string>,
  allow: string,
  schema: z.ZodType<Output>,
): Output | undefined {
  const requestShape = requestShapeFrom(request);
  if (!parseOwnedMethod(request, response, requestShape, methodSchema, allow)) {
    return undefined;
  }

  return parseOwnedRequestShape(request, response, requestShape, schema);
}

function parseOwnedMethod<Method extends string>(
  request: IncomingMessage,
  response: ServerResponse,
  requestShape: RequestShape,
  methodSchema: z.ZodType<Method>,
  allow: string,
): Method | undefined {
  const parsed = methodSchema.safeParse(requestShape.method);
  if (parsed.success) {
    return parsed.data;
  }

  discardRequest(request);
  sendResponse(response, 405, { allow });
  return undefined;
}

function parseOwnedRequestShape<Output>(
  request: IncomingMessage,
  response: ServerResponse,
  requestShape: RequestShape,
  schema: z.ZodType<Output>,
): Output | undefined {
  const parsed = schema.safeParse(requestShape);
  if (parsed.success) {
    return parsed.data;
  }

  discardRequest(request);
  const status = parsed.error.issues.some((issue) => issue.path[0] !== 'contentType') ? 400 : 415;
  sendResponse(response, status);
  return undefined;
}

function requestShapeFrom(request: IncomingMessage): RequestShape {
  const requestUrl = request.url ?? '/';
  const url = new URL(requestUrl, 'http://preview-proxy');
  const contentLength = request.headers['content-length'];
  const idempotencyKey = request.headers['idempotency-key'];

  return RequestShapeSchema.parse({
    contentType: request.headers['content-type'] || undefined,
    hasBody:
      request.headers['transfer-encoding'] !== undefined ||
      (contentLength !== undefined && contentLength !== '0'),
    idempotencyKey: Array.isArray(idempotencyKey) ? idempotencyKey.join(',') : idempotencyKey,
    method: request.method ?? '',
    queryEntries: [...url.searchParams.entries()],
    queryPresent: requestUrl.includes('?'),
  });
}

function discardRequest(request: IncomingMessage): void {
  request.resume();
}

async function readBrowserEvent(
  request: IncomingMessage,
): Promise<ReturnType<typeof BrowserEventSchema.parse> | undefined> {
  let bytes = 0;
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_EVENT_BYTES) {
      request.destroy();
      return undefined;
    }
    chunks.push(buffer);
  }

  try {
    return BrowserEventSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return undefined;
  }
}

async function writeProxiedResponse(
  proxyResponse: IncomingMessage,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const removeDownstreamCancellation = cancelOriginOnDownstreamClose(
    proxyResponse,
    request,
    response,
  );

  try {
    await writeProxiedResponseBody(proxyResponse, response, protectedDocumentUrl(request));
  } finally {
    removeDownstreamCancellation();
  }
}

async function writeProxiedResponseBody(
  proxyResponse: IncomingMessage,
  response: ServerResponse,
  documentUrl: URL | undefined,
): Promise<void> {
  const contentType = proxyResponse.headersDistinct['content-type']?.[0] ?? '';
  const upstreamHeaders = withoutProxyOwnedHeaders(proxyResponse.headers);

  if (!isHtmlMediaType(contentType) || isPartialResponse(proxyResponse)) {
    if (!startResponse(response, proxyResponse.statusCode ?? 502, upstreamHeaders)) return;
    await pipeline(proxyResponse, response);
    return;
  }

  if (!hasSupportedHtmlCharset(contentType)) {
    if (
      !startResponse(
        response,
        proxyResponse.statusCode ?? 502,
        withDegradedCapture(upstreamHeaders, 'html-charset'),
      )
    )
      return;
    await pipeline(proxyResponse, response);
    return;
  }

  if (!hasIdentityEncoding(upstreamHeaders)) {
    if (
      !startResponse(
        response,
        proxyResponse.statusCode ?? 502,
        withDegradedCapture(upstreamHeaders, 'html-content-encoding'),
      )
    )
      return;
    await pipeline(proxyResponse, response);
    return;
  }

  if (documentUrl === undefined) {
    if (
      !startResponse(
        response,
        proxyResponse.statusCode ?? 502,
        withDegradedCapture(upstreamHeaders, 'html-no-origin'),
      )
    )
      return;
    await pipeline(proxyResponse, response);
    return;
  }

  const cspPolicies = proxyResponse.headersDistinct['content-security-policy'];
  if (!cspAuthorizesClient(cspPolicies, [], documentUrl, [])) {
    if (
      !startResponse(
        response,
        proxyResponse.statusCode ?? 502,
        withDegradedCapture(upstreamHeaders, 'csp'),
      )
    )
      return;
    await pipeline(proxyResponse, response);
    return;
  }

  const rewriter = new PreviewHtmlRewriter(documentUrl);
  const responseStart = createResponseStartTransform(
    response,
    proxyResponse.statusCode ?? 502,
    streamingHtmlHeaders(upstreamHeaders),
  );
  proxyResponse.setEncoding('utf8');
  await pipeline(proxyResponse, rewriter, responseStart, new ServerResponseSink(response));
}

function createResponseStartTransform(
  response: ServerResponse,
  statusCode: number,
  headers: IncomingHttpHeaders,
): Transform {
  let started = false;
  const start = (): boolean => {
    if (started) return true;
    started = startResponse(response, statusCode, headers);
    return started;
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!start()) {
        callback(new Error('Proxy response closed before transformed headers could be sent'));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (!start()) {
        callback(new Error('Proxy response closed before transformed headers could be sent'));
        return;
      }
      callback();
    },
  });
}

function cancelOriginOnDownstreamClose(
  proxyResponse: IncomingMessage,
  request: IncomingMessage,
  response: ServerResponse,
): () => void {
  let listening = true;
  const cleanup = () => {
    if (!listening) {
      return;
    }
    listening = false;
    request.off('aborted', cancel);
    response.off('close', onResponseClose);
    response.off('error', cancel);
  };
  const cancel = () => {
    cleanup();
    if (!proxyResponse.destroyed && !proxyResponse.complete) {
      proxyResponse.destroy();
    }
  };
  const onResponseClose = () => {
    if (!response.writableEnded) {
      cancel();
    }
  };

  request.once('aborted', cancel);
  response.once('close', onResponseClose);
  response.once('error', cancel);
  return cleanup;
}

function abortOnDownstreamClose(
  request: IncomingMessage,
  response: ServerResponse,
): { cleanup(): void; readonly signal: AbortSignal } {
  const controller = new AbortController();
  let listening = true;
  const cleanup = () => {
    if (!listening) {
      return;
    }
    listening = false;
    request.off('aborted', abort);
    response.off('close', onResponseClose);
    response.off('error', abort);
  };
  const abort = () => {
    controller.abort();
  };
  const onResponseClose = () => {
    if (!response.writableEnded) {
      abort();
    }
  };

  request.once('aborted', abort);
  response.once('close', onResponseClose);
  response.once('error', abort);
  return { cleanup, signal: controller.signal };
}

function isHtmlMediaType(contentType: string): boolean {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/html';
}

function hasSupportedHtmlCharset(contentType: string): boolean {
  for (const parameter of contentType.split(';').slice(1)) {
    const [rawName, ...rawValue] = parameter.split('=');
    if (rawName?.trim().toLowerCase() !== 'charset') {
      continue;
    }

    let charset = rawValue.join('=').trim().toLowerCase();
    if (
      charset.length >= 2 &&
      ((charset.startsWith('"') && charset.endsWith('"')) ||
        (charset.startsWith("'") && charset.endsWith("'")))
    ) {
      charset = charset.slice(1, -1).trim();
    }
    if (charset !== 'utf-8' && charset !== 'utf8') {
      return false;
    }
  }

  return true;
}

function isPartialResponse(response: IncomingMessage): boolean {
  return response.statusCode === 206 || response.headers['content-range'] !== undefined;
}

function hasIdentityEncoding(headers: IncomingHttpHeaders): boolean {
  const encoding = headers['content-encoding'];
  const values: readonly string[] = Array.isArray(encoding) ? encoding : encoding ? [encoding] : [];
  return values.every((value) => value.trim().toLowerCase() === 'identity');
}

function cspAuthorizesClient(
  policies: readonly string[] | undefined,
  nonceCandidates: readonly string[],
  documentUrl: URL | undefined,
  integrityHashes: readonly string[],
): boolean {
  return selectCspAuthorization(policies, nonceCandidates, documentUrl, integrityHashes).authorized;
}

function selectCspAuthorization(
  policies: readonly string[] | undefined,
  nonceCandidates: readonly string[],
  documentUrl: URL | undefined,
  integrityHashes: readonly string[],
): { authorized: boolean; nonce?: string } {
  const values = (policies ?? [])
    .flatMap((policy) => policy.split(','))
    .map((policy) => policy.trim())
    .filter((policy) => policy.length > 0);
  for (const nonce of [undefined, ...nonceCandidates]) {
    if (
      values.every((policy) =>
        cspPolicyAuthorizesClient(policy, nonce, documentUrl, integrityHashes),
      )
    ) {
      return nonce === undefined ? { authorized: true } : { authorized: true, nonce };
    }
  }
  return { authorized: false };
}

function cspPolicyAuthorizesClient(
  policy: string,
  nonce: string | undefined,
  documentUrl: URL | undefined,
  integrityHashes: readonly string[],
): boolean {
  const directives = parseCspDirectives(policy);
  const sandboxTokens = directives.get('sandbox');
  if (
    sandboxTokens !== undefined &&
    !sandboxTokens.some((token) => token.toLowerCase() === 'allow-scripts')
  ) {
    return false;
  }

  const sources =
    directives.get('script-src-elem') ??
    directives.get('script-src') ??
    directives.get('default-src');
  if (!sources) {
    return true;
  }

  const effectiveSources = sources.filter((source) => source.toLowerCase() !== "'none'");
  if (effectiveSources.length === 0) {
    return false;
  }
  const hashSources = new Set(
    effectiveSources.flatMap((source) => {
      if (!source.startsWith("'") || !source.endsWith("'")) return [];
      const hash = normalizeCspHash(source.slice(1, -1));
      return hash === undefined ? [] : [hash];
    }),
  );
  const hashAuthorized =
    integrityHashes.length > 0 && integrityHashes.every((hash) => hashSources.has(hash));
  const nonceAuthorized =
    nonce !== undefined &&
    effectiveSources.some((source) => /^'nonce-(.*)'$/i.exec(source)?.[1] === nonce);
  const hasStrictDynamic = effectiveSources.some(
    (source) => source.toLowerCase() === "'strict-dynamic'",
  );
  const hasNonceOrHashSource =
    hashSources.size > 0 || effectiveSources.some((source) => /^'nonce-.*'$/i.test(source));
  if (hasStrictDynamic && hasNonceOrHashSource) {
    return nonceAuthorized || hashAuthorized;
  }
  if (hashAuthorized) {
    return true;
  }
  return effectiveSources.some((source) => {
    const normalizedSource = source.toLowerCase();
    if (normalizedSource === "'self'" || normalizedSource === '*') {
      return true;
    }
    const nonceSource = /^'nonce-(.*)'$/i.exec(source);
    if (nonce !== undefined && nonceSource?.[1] === nonce) {
      return true;
    }
    if (
      source.startsWith("'") &&
      source.endsWith("'") &&
      normalizeCspHash(source.slice(1, -1)) !== undefined
    )
      return false;
    if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) {
      return (
        documentUrl !== undefined &&
        cspSchemeMatches(normalizedSource.slice(0, -1), documentUrl.protocol.slice(0, -1))
      );
    }
    return cspHostSourceAuthorizesClient(source, documentUrl);
  });
}

function parseCspDirectives(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const directive of policy.split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) {
      directives.set(name.toLowerCase(), sources);
    }
  }
  return directives;
}

function normalizeCspHash(value: string): string | undefined {
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  return match?.[1] && match[2] ? `${match[1].toLowerCase()}-${match[2]}` : undefined;
}

function cspHostSourceAuthorizesClient(source: string, documentUrl: URL | undefined): boolean {
  if (documentUrl === undefined || source.startsWith("'") || source.startsWith('//')) {
    return false;
  }

  const clientUrl = new URL(CLIENT_PATH, documentUrl);
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(source);
  const sourceScheme = schemeMatch?.[1]?.toLowerCase();
  const hostSource = schemeMatch?.[2] ?? source;
  const match = /^(\*|\*\.[^/:]+|\[[^\]]+\]|[^/:]+)(?::(\*|\d+))?(\/[^?#]*)?$/i.exec(hostSource);
  if (!match) {
    return false;
  }

  const clientScheme = clientUrl.protocol.slice(0, -1).toLowerCase();
  if (sourceScheme !== undefined && !cspSchemeMatches(sourceScheme, clientScheme)) {
    return false;
  }
  if (sourceScheme === undefined && clientUrl.protocol !== documentUrl.protocol) {
    return false;
  }

  const sourceHostname = match[1]?.toLowerCase();
  const clientHostname = clientUrl.hostname.toLowerCase();
  if (
    !sourceHostname ||
    !(
      sourceHostname === '*' ||
      sourceHostname === clientHostname ||
      (sourceHostname.startsWith('*.') &&
        clientHostname !== sourceHostname.slice(2) &&
        clientHostname.endsWith(sourceHostname.slice(1)))
    )
  ) {
    return false;
  }

  const sourcePort = match[2];
  const clientPort = clientUrl.port || defaultPortForScheme(clientScheme);
  const upgradesHttp = sourceScheme === 'http' && clientScheme === 'https';
  if (sourcePort === undefined) {
    if (upgradesHttp) return clientPort === '443';
    const defaultSourcePort = defaultPortForScheme(sourceScheme ?? clientScheme);
    if (clientPort !== defaultSourcePort) return false;
  } else if (sourcePort !== '*') {
    if (upgradesHttp) {
      if (clientPort !== '443' || (sourcePort !== '80' && sourcePort !== '443')) return false;
    } else if (sourcePort !== clientPort) {
      return false;
    }
  }

  const sourcePath = match[3];
  if (sourcePath === undefined) {
    return true;
  }
  const decodedSourcePath = decodeCspPath(sourcePath);
  const decodedClientPath = decodeCspPath(clientUrl.pathname);
  if (decodedSourcePath === undefined || decodedClientPath === undefined) {
    return false;
  }
  return decodedSourcePath.endsWith('/')
    ? decodedClientPath.startsWith(decodedSourcePath)
    : decodedClientPath === decodedSourcePath;
}

function cspSchemeMatches(sourceScheme: string, clientScheme: string): boolean {
  return sourceScheme === clientScheme || (sourceScheme === 'http' && clientScheme === 'https');
}

function defaultPortForScheme(scheme: string): string {
  if (scheme === 'http') return '80';
  if (scheme === 'https') return '443';
  return '';
}

function decodeCspPath(path: string): string | undefined {
  try {
    return path
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return undefined;
  }
}

function protectedDocumentUrl(request: IncomingMessage): URL | undefined {
  const rawForwardedProtocol = request.headers['x-forwarded-proto'];
  const forwardedProtocol = (
    Array.isArray(rawForwardedProtocol) ? rawForwardedProtocol[0] : rawForwardedProtocol
  )
    ?.split(',')[0]
    ?.trim()
    .toLowerCase();
  const protocol =
    forwardedProtocol === 'http' || forwardedProtocol === 'https' ? forwardedProtocol : 'http';
  const host = request.headers.host;
  if (!host) {
    return undefined;
  }

  try {
    return new URL(request.url ?? '/', `${protocol}://${host}`);
  } catch {
    return undefined;
  }
}

function streamingHtmlHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const transformed = withoutProxyOwnedHeaders(headers);
  delete transformed['accept-ranges'];
  delete transformed['content-digest'];
  delete transformed['content-encoding'];
  delete transformed['content-length'];
  delete transformed['content-md5'];
  delete transformed['content-range'];
  delete transformed.digest;
  delete transformed.etag;
  delete transformed['last-modified'];
  delete transformed['repr-digest'];
  delete transformed['transfer-encoding'];
  return transformed;
}

function withDegradedCapture(headers: IncomingHttpHeaders, reason: string): IncomingHttpHeaders {
  return { ...withoutProxyOwnedHeaders(headers), [DEGRADED_CAPTURE_HEADER]: reason };
}

function withoutProxyOwnedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const filtered = { ...headers };
  delete filtered['x-zapp-capture-degraded'];
  return filtered;
}

function startResponse(
  response: ServerResponse,
  statusCode: number,
  headers?: IncomingHttpHeaders,
): boolean {
  if (response.destroyed || response.writableEnded || response.headersSent) {
    return false;
  }
  try {
    response.writeHead(statusCode, headers);
    return true;
  } catch {
    return false;
  }
}

function safeEndResponse(response: ServerResponse, body?: string | Buffer): boolean {
  if (response.destroyed || response.writableEnded) {
    return false;
  }
  try {
    response.end(body);
    return true;
  } catch {
    return false;
  }
}

function sendResponse(
  response: ServerResponse,
  statusCode: number,
  headers?: IncomingHttpHeaders,
  body?: string | Buffer,
): boolean {
  return startResponse(response, statusCode, headers) && safeEndResponse(response, body);
}

function failProxiedResponse(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  if (!response.headersSent) {
    sendResponse(response, 502);
    return;
  }

  response.destroy(error instanceof Error ? error : new Error('Proxy response failed'));
}

function failRequest(response: ServerResponse): void {
  if (response.destroyed || response.writableEnded || response.headersSent) {
    return;
  }

  sendResponse(response, 400);
}

function createTargetResolver(options: PreviewProxyOptions): TargetResolver {
  if (options.target) {
    const target = normalizeTarget(options.target);
    return { invalidate: () => undefined, resolve: () => Promise.resolve(target) };
  }
  if (options.executionContract) {
    const target = `http://127.0.0.1:${String(ExecutionContractSchema.parse(options.executionContract).develop.port)}`;
    return { invalidate: () => undefined, resolve: () => Promise.resolve(target) };
  }

  let cachedTarget: string | undefined;
  const cooldownUntil = new Map<string, number>();
  let nextProbeIndex = 0;
  let probing: Promise<string | undefined> | undefined;
  const probePorts = options.probePorts ?? DEFAULT_PROBE_PORTS;

  return {
    invalidate(target: string): void {
      if (cachedTarget === target) {
        cachedTarget = undefined;
      }
      const failedPort = Number(new URL(target).port);
      const failedIndex = probePorts.indexOf(failedPort);
      if (failedIndex >= 0 && probePorts.length > 0) {
        nextProbeIndex = (failedIndex + 1) % probePorts.length;
        cooldownUntil.set(target, Date.now() + 1_000);
      }
    },
    async resolve(): Promise<string | undefined> {
      if (cachedTarget) {
        return cachedTarget;
      }
      if (!probing) {
        probing = probeTarget(probePorts, nextProbeIndex, cooldownUntil)
          .then((result) => {
            cachedTarget = result?.target;
            if (result && probePorts.length > 0) {
              nextProbeIndex = (result.index + 1) % probePorts.length;
            }
            return result?.target;
          })
          .finally(() => {
            probing = undefined;
          });
      }

      return probing;
    },
  };
}

async function probeTarget(
  probePorts: number[],
  startIndex: number,
  cooldownUntil: ReadonlyMap<string, number>,
): Promise<{ index: number; target: string } | undefined> {
  for (let offset = 0; offset < probePorts.length; offset += 1) {
    const index = (startIndex + offset) % probePorts.length;
    const port = probePorts[index];
    if (port === undefined) {
      continue;
    }
    const target = `http://127.0.0.1:${String(port)}`;
    if ((cooldownUntil.get(target) ?? 0) > Date.now()) {
      continue;
    }
    if (await isListening(port)) {
      return { index, target };
    }
  }

  return undefined;
}

function normalizeTarget(target: string): string {
  const parsed = new URL(target);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Preview target must use HTTP or HTTPS');
  }
  return parsed.toString().replace(/\/$/, '');
}

async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (listening: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
    socket.setTimeout(1_000, () => {
      finish(false);
    });
  });
}

function createScreenshotCoordinator(
  screenshotCapture: ScreenshotCapture | undefined,
  timeoutMs: number,
): ScreenshotCoordinator {
  let controller: AbortController | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  return {
    async capture(
      requestSignal: AbortSignal,
    ): Promise<ScreenshotCaptureResult | 'busy' | 'unavailable'> {
      if (!screenshotCapture) {
        return 'unavailable';
      }
      if (controller) {
        return 'busy';
      }
      throwIfAborted(requestSignal);

      const captureController = new AbortController();
      controller = captureController;
      const abortFromRequest = () => {
        captureController.abort();
      };
      requestSignal.addEventListener('abort', abortFromRequest, { once: true });
      timeout = setTimeout(() => {
        captureController.abort();
      }, timeoutMs);
      const operation = callAsPromise(() => screenshotCapture(captureController.signal));
      const release = () => {
        if (controller === captureController) {
          controller = undefined;
          if (timeout !== undefined) {
            clearTimeout(timeout);
            timeout = undefined;
          }
        }
        requestSignal.removeEventListener('abort', abortFromRequest);
      };
      void operation.then(release, release);
      try {
        return ScreenshotCaptureResultSchema.parse(
          await abortable(operation, captureController.signal),
        );
      } finally {
        requestSignal.removeEventListener('abort', abortFromRequest);
        if (controller === captureController) {
          clearTimeout(timeout);
          timeout = undefined;
        }
      }
    },
    close(): void {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      controller?.abort();
    },
  };
}

function abortable<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(asError(error));
      },
    );
  });
}

function callAsPromise<Value>(operation: () => Promise<Value>): Promise<Value> {
  return Promise.resolve().then(operation);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function abortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unexpected non-Error rejection');
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function previewProxyOptionsFromEnvironment(): PreviewProxyOptions {
  const environment = PreviewProxyEnvironmentSchema.parse({
    PORT: process.env.PORT,
    ZAPP_AGENT_TOKEN: process.env.ZAPP_AGENT_TOKEN,
    ZAPP_CDP_ENDPOINT: process.env.ZAPP_CDP_ENDPOINT,
    ZAPP_EXECUTION_CONTRACT: process.env.ZAPP_EXECUTION_CONTRACT,
    ZAPP_PARENT_ORIGIN: process.env.ZAPP_PARENT_ORIGIN,
    ZAPP_PREVIEW_PROBE_PORTS: process.env.ZAPP_PREVIEW_PROBE_PORTS,
    ZAPP_PREVIEW_TARGET: process.env.ZAPP_PREVIEW_TARGET,
    ZAPP_SANDBOX_HEARTBEAT_URL: process.env.ZAPP_SANDBOX_HEARTBEAT_URL,
  });
  const options: PreviewProxyOptions = {
    port: environment.PORT,
  };

  if (environment.ZAPP_CDP_ENDPOINT) {
    options.cdpEndpoint = environment.ZAPP_CDP_ENDPOINT;
  }
  if (environment.ZAPP_EXECUTION_CONTRACT) {
    options.executionContract = environment.ZAPP_EXECUTION_CONTRACT;
  }
  if (environment.ZAPP_SANDBOX_HEARTBEAT_URL) {
    options.heartbeat = {
      intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      send: createHeartbeatSender(
        environment.ZAPP_SANDBOX_HEARTBEAT_URL,
        environment.ZAPP_AGENT_TOKEN,
      ),
    };
  }
  if (environment.ZAPP_PREVIEW_TARGET) {
    options.target = environment.ZAPP_PREVIEW_TARGET;
  }
  if (environment.ZAPP_PARENT_ORIGIN) {
    options.parentOrigin = environment.ZAPP_PARENT_ORIGIN;
  }
  if (environment.ZAPP_PREVIEW_PROBE_PORTS) {
    options.probePorts = environment.ZAPP_PREVIEW_PROBE_PORTS;
  }

  return PreviewProxyOptionsSchema.parse(options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void createPreviewProxy(previewProxyOptionsFromEnvironment()).catch(() => {
    process.exitCode = 1;
  });
}
