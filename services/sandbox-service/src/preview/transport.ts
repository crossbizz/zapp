import { z } from 'zod';
import WebSocket, { type RawData } from 'ws';

const ProviderWorkspaceIdSchema = z.string().trim().min(1);
const PreviewPathSchema = z
  .string()
  .startsWith('/')
  .refine((value) => !value.startsWith('//') && !value.includes('\\'), {
    message: 'Preview path must be origin-relative',
  });

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const INFRASTRUCTURE_REQUEST_HEADERS = new Set(['cookie', 'host']);

export type PreviewHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.join(', ');
}

function isZappHeader(name: string): boolean {
  return name.startsWith('x-zapp-');
}

function applicationCookieOnly(rawCookie: string | undefined): string | undefined {
  if (rawCookie === undefined || rawCookie === '') return undefined;
  if (rawCookie.includes('\r') || rawCookie.includes('\n')) {
    throw new Error('Preview application cookie is invalid');
  }
  const kept = rawCookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const separator = part.indexOf('=');
      if (separator < 1) return false;
      const name = part.slice(0, separator).toLowerCase();
      return (
        !name.startsWith('__host-zapp') &&
        !name.startsWith('__secure-zapp') &&
        !name.startsWith('zapp_')
      );
    });
  return kept.length === 0 ? undefined : kept.join('; ');
}

export function sanitizePreviewRequestHeaders(
  headers: PreviewHeaders,
  applicationCookie?: string,
  publicOrigin?: URL,
): Readonly<Record<string, string>> {
  const sanitized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    const value = headerValue(rawValue);
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(name) ||
      INFRASTRUCTURE_REQUEST_HEADERS.has(name) ||
      isZappHeader(name)
    ) {
      continue;
    }
    sanitized[name] = value;
  }
  const cookie = applicationCookieOnly(applicationCookie);
  if (cookie !== undefined) sanitized.cookie = cookie;
  if (publicOrigin !== undefined) {
    if (publicOrigin.protocol !== 'https:') throw new Error('Preview public origin must use HTTPS');
    sanitized['x-forwarded-host'] = publicOrigin.host;
    sanitized['x-forwarded-proto'] = 'https';
  }
  return sanitized;
}

export function sanitizePreviewResponseHeaders(
  headers: PreviewHeaders,
  providerOrigin?: URL,
  publicOrigin?: URL,
): Readonly<Record<string, string>> {
  const sanitized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    const value = headerValue(rawValue);
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || isZappHeader(name)) continue;
    sanitized[name] =
      providerOrigin === undefined || publicOrigin === undefined
        ? value
        : value.replaceAll(providerOrigin.origin, publicOrigin.origin);
  }
  return sanitized;
}

export interface PreviewTunnelRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface PreviewTunnelResponse {
  readonly statusCode: number;
  readonly headers: PreviewHeaders;
  readonly body: AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
}

export interface PreviewTunnelConnection {
  /** Internal-only provider origin. It is validated but never returned by the transport. */
  readonly origin: URL;
  request(input: PreviewTunnelRequest): Promise<PreviewTunnelResponse>;
  openWebSocket?(input: Omit<PreviewTunnelRequest, 'body'>): Promise<PreviewSocket>;
}

export interface PreviewTunnelResolver {
  resolve(providerWorkspaceId: string): Promise<PreviewTunnelConnection>;
}

export interface PreviewTunnelOriginResolver {
  resolvePreviewTunnel(providerWorkspaceId: string): Promise<URL>;
}

export interface PreviewTransportRequest {
  readonly providerWorkspaceId: string;
  readonly method: string;
  readonly path: string;
  readonly publicOrigin: URL;
  readonly headers: PreviewHeaders;
  readonly applicationCookie?: string;
  readonly body?: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface PreviewTransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
}

export interface PreviewTransport {
  request(input: PreviewTransportRequest): Promise<PreviewTransportResponse>;
  openWebSocket(
    input: Omit<PreviewTransportRequest, 'body'>,
    downstream: PreviewSocket,
  ): Promise<void>;
}

export interface PreviewSocket {
  send(data: string | Uint8Array): void;
  close(): void;
  onMessage(handler: (data: string | Uint8Array) => void): void;
  onClose(handler: () => void): void;
  onError(handler: () => void): void;
}

export function bridgePreviewWebSockets(downstream: PreviewSocket, upstream: PreviewSocket): void {
  let closed = false;
  const closeBoth = (): void => {
    if (closed) return;
    closed = true;
    downstream.close();
    upstream.close();
  };
  downstream.onMessage((data) => {
    if (!closed) upstream.send(data);
  });
  upstream.onMessage((data) => {
    if (!closed) downstream.send(data);
  });
  downstream.onClose(closeBoth);
  upstream.onClose(closeBoth);
  downstream.onError(closeBoth);
  upstream.onError(closeBoth);
}

function targetFor(path: string, origin: URL): URL {
  const parsedPath = PreviewPathSchema.safeParse(path);
  if (!parsedPath.success) throw new Error('Preview path must be origin-relative');
  const target = new URL(parsedPath.data, origin);
  if (target.origin !== origin.origin) throw new Error('Preview path must be origin-relative');
  return target;
}

export function createPreviewTransport(resolver: PreviewTunnelResolver): PreviewTransport {
  return {
    async request(untrustedInput) {
      const providerWorkspaceId = ProviderWorkspaceIdSchema.parse(
        untrustedInput.providerWorkspaceId,
      );
      const targetPath = PreviewPathSchema.safeParse(untrustedInput.path);
      if (!targetPath.success) throw new Error('Preview path must be origin-relative');
      const connection = await resolver.resolve(providerWorkspaceId);
      if (connection.origin.protocol !== 'https:') {
        throw new Error('Preview tunnel must use encrypted transport');
      }
      const target = targetFor(targetPath.data, connection.origin);
      const response = await connection.request({
        method: z.string().trim().min(1).parse(untrustedInput.method).toUpperCase(),
        path: `${target.pathname}${target.search}`,
        headers: sanitizePreviewRequestHeaders(
          untrustedInput.headers,
          untrustedInput.applicationCookie,
          untrustedInput.publicOrigin,
        ),
        ...(untrustedInput.body === undefined ? {} : { body: untrustedInput.body }),
        ...(untrustedInput.signal === undefined ? {} : { signal: untrustedInput.signal }),
      });
      let cancelled = false;
      const cancel = async (): Promise<void> => {
        if (cancelled) return;
        cancelled = true;
        await response.cancel();
      };
      if (untrustedInput.signal?.aborted === true) await cancel();
      else untrustedInput.signal?.addEventListener('abort', () => void cancel(), { once: true });
      return {
        statusCode: z.number().int().min(100).max(599).parse(response.statusCode),
        headers: sanitizePreviewResponseHeaders(
          response.headers,
          connection.origin,
          untrustedInput.publicOrigin,
        ),
        body: response.body,
        cancel,
      };
    },
    async openWebSocket(untrustedInput, downstream) {
      const providerWorkspaceId = ProviderWorkspaceIdSchema.parse(
        untrustedInput.providerWorkspaceId,
      );
      const connection = await resolver.resolve(providerWorkspaceId);
      if (connection.origin.protocol !== 'https:') {
        throw new Error('Preview tunnel must use encrypted transport');
      }
      const target = targetFor(untrustedInput.path, connection.origin);
      if (connection.openWebSocket === undefined) {
        throw new Error('Preview tunnel does not support WebSocket transport');
      }
      const upstream = await connection.openWebSocket({
        method: 'GET',
        path: `${target.pathname}${target.search}`,
        headers: sanitizePreviewRequestHeaders(
          untrustedInput.headers,
          untrustedInput.applicationCookie,
          untrustedInput.publicOrigin,
        ),
        ...(untrustedInput.signal === undefined ? {} : { signal: untrustedInput.signal }),
      });
      bridgePreviewWebSockets(downstream, upstream);
    },
  };
}

function responseHeaders(headers: Headers): Readonly<Record<string, string | readonly string[]>> {
  const values: Record<string, string | readonly string[]> = Object.fromEntries(headers.entries());
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) values['set-cookie'] = cookies;
  return values;
}

/**
 * Production HTTP transport. The provider origin remains inside this closure and is never
 * represented in a route response, event, audit record, or durable row.
 */
export function createFetchPreviewTransport(
  resolver: PreviewTunnelOriginResolver,
  fetchImplementation: typeof fetch = fetch,
): PreviewTransport {
  return createPreviewTransport({
    async resolve(providerWorkspaceId) {
      const origin = await resolver.resolvePreviewTunnel(providerWorkspaceId);
      return {
        origin,
        async request(input) {
          const target = new URL(input.path, origin);
          const init: RequestInit & { duplex?: 'half' } = {
            method: input.method,
            headers: input.headers,
            ...(input.body === undefined
              ? {}
              : { body: input.body as never, duplex: 'half' as const }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            redirect: 'manual',
          };
          const response = await fetchImplementation(target, init);
          const body = response.body;
          return {
            statusCode: response.status,
            headers: responseHeaders(response.headers),
            body:
              body === null
                ? (async function* () {
                    await Promise.resolve();
                  })()
                : (body as unknown as AsyncIterable<Uint8Array>),
            async cancel() {
              await body?.cancel();
            },
          };
        },
        async openWebSocket(input) {
          const target = new URL(input.path, origin);
          target.protocol = 'wss:';
          const { 'sec-websocket-protocol': rawProtocols, ...headers } = input.headers;
          const protocols = rawProtocols
            ?.split(',')
            .map((value) => value.trim())
            .filter((value) => value !== '') ?? [];
          const socket =
            protocols.length === 0
              ? new WebSocket(target, { headers, perMessageDeflate: false })
              : new WebSocket(target, protocols, { headers, perMessageDeflate: false });
          if (input.signal?.aborted === true) socket.terminate();
          const abort = (): void => {
            socket.terminate();
          };
          input.signal?.addEventListener('abort', abort, { once: true });
          try {
            await new Promise<void>((resolve, reject) => {
              socket.once('open', resolve);
              socket.once('error', reject);
            });
          } finally {
            input.signal?.removeEventListener('abort', abort);
          }
          return adaptWebSocket(socket);
        },
      };
    },
  });
}

function socketBytes(data: RawData): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function socketData(data: RawData, isBinary: boolean): string | Uint8Array {
  const bytes = socketBytes(data);
  return isBinary ? bytes : bytes.toString('utf8');
}

export function adaptWebSocket(socket: WebSocket): PreviewSocket {
  return {
    send(data) {
      socket.send(data);
    },
    close() {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    },
    onMessage(handler) {
      socket.on('message', (data, isBinary) => {
        handler(socketData(data, isBinary));
      });
    },
    onClose(handler) {
      socket.on('close', handler);
    },
    onError(handler) {
      socket.on('error', handler);
    },
  };
}
