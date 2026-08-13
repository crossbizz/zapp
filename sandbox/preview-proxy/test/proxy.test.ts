import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, ServerResponse, type Server } from 'node:http';
import {
  createConnection,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from 'node:net';

import express, { type Express } from 'express';
import { JSDOM } from 'jsdom';
import { chromium } from 'playwright-core';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createPreviewProxy,
  previewProxyOptionsFromEnvironment,
  type PreviewProxy,
  type PreviewProxyOptions,
  type ScreenshotCapture,
} from '../src/main.js';
import { CaptureStore } from '../src/capture.js';

interface RunningOrigin {
  port: number;
  server: Server;
  upgradePaths: string[];
  url: string;
}

interface SilentTcpOrigin {
  port: number;
  sockets: Set<Socket>;
}

interface NoHeaderOrigin extends SilentTcpOrigin {
  reached: Promise<void>;
}

interface SseConnection {
  next(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

interface ParentMessage {
  data: Record<string, unknown>;
  targetOrigin: string;
}

interface ParentWindow {
  postMessage(data: Record<string, unknown>, targetOrigin: string): void;
}

type ClientWindow = Window & { console: Console; fetch: typeof fetch };

const PNG_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

interface ClientDomOptions {
  beforeClientEval?: (clientWindow: ClientWindow) => void;
  parent?: ParentWindow;
  referrer?: string;
}

function anyString(): unknown {
  return expect.any(String);
}

function anyNumber(): unknown {
  return expect.any(Number);
}

function anyObject(): unknown {
  return expect.any(Object);
}

function anyValue(): unknown {
  return expect.anything();
}

function fixtureCredentialUrl(hostname: string, path: string): string {
  const url = new URL(path, `https://${hostname}`);
  url.username = 'fixture-user';
  url.password = 'fixture-password';
  return url.toString();
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();

  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startOrigin(
  configure: (app: Express) => void,
  withWebSocket = false,
  listenPort = 0,
): Promise<RunningOrigin> {
  const app = express();
  configure(app);
  const server = createServer(app);
  const webSocketServer = withWebSocket ? new WebSocketServer({ noServer: true }) : undefined;
  const upgradePaths: string[] = [];

  if (webSocketServer) {
    server.on('upgrade', (request, socket, head) => {
      upgradePaths.push(request.url ?? '');
      webSocketServer.handleUpgrade(request, socket, head, (client) => {
        webSocketServer.emit('connection', client, request);
      });
    });

    webSocketServer.on('connection', (client, request) => {
      if (request.url !== '/socket') {
        client.close();
        return;
      }
      client.on('message', (message) => {
        client.send(message);
      });
    });
  }

  server.listen(listenPort, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  cleanups.push(async () => {
    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
  });

  return { port, server, upgradePaths, url: `http://127.0.0.1:${String(port)}` };
}

async function findUnavailablePort(): Promise<number> {
  for (let port = 18_000; port < 18_100; port += 1) {
    const server = createServer();
    const available = await new Promise<boolean>((resolve) => {
      server.once('error', () => {
        resolve(false);
      });
      server.once('listening', () => {
        resolve(true);
      });
      server.listen(port, '127.0.0.1');
    });

    if (available) {
      await closeServer(server);
      return port;
    }
  }

  throw new Error('could not reserve an unavailable auto-probe fixture port');
}

async function startSilentTcpOrigin(): Promise<SilentTcpOrigin> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.resume();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
  return { port, sockets };
}

async function startNoHeaderOrigin(): Promise<NoHeaderOrigin> {
  const reached = deferred<undefined>();
  const sockets = new Set<Socket>();
  const server = createServer(() => {
    reached.resolve(undefined);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await closeServer(server);
  });
  return { port, reached: reached.promise, sockets };
}

async function startProxy(options: PreviewProxyOptions): Promise<PreviewProxy | undefined> {
  const proxy = await createPreviewProxy({ port: 0, ...options });

  expect(
    proxy,
    'preview proxy must start before its public behavior can be asserted',
  ).toBeDefined();

  cleanups.push(() => proxy.close());

  return proxy;
}

async function expectInvalidPreviewProxyOptions(options: Record<string, unknown>): Promise<void> {
  let created: PreviewProxy | undefined;
  let failure: unknown;

  try {
    created = await createPreviewProxy({ port: 0, probePorts: [], ...options });
  } catch (error) {
    failure = error;
  } finally {
    await created?.close();
  }

  expect(failure).toBeInstanceOf(Error);
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

async function closeWebSocketServer(server: WebSocketServer | undefined): Promise<void> {
  if (!server) {
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

async function openSse(baseUrl: string): Promise<SseConnection> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/__zapp/events`, { signal: controller.signal });

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(response.body).not.toBeNull();

  const body = response.body;
  if (body === null) {
    throw new Error('SSE response did not expose a readable body');
  }
  const reader = body.getReader();
  let pending = '';

  return {
    async next(): Promise<Record<string, unknown>> {
      for (;;) {
        const boundary = pending.indexOf('\n\n');

        if (boundary >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice('data:'.length).trimStart())
            .join('\n');

          if (data) {
            return JSON.parse(data) as Record<string, unknown>;
          }
        }

        const { done, value } = await reader.read();

        if (done) {
          throw new Error('SSE stream ended before it delivered an event');
        }

        pending += new TextDecoder().decode(value, { stream: true });
      }
    },
    async close(): Promise<void> {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

async function waitForSseEvent(
  connection: SseConnection,
  predicate: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const event = await connection.next();

    if (predicate(event)) {
      return event;
    }
  }

  throw new Error('SSE stream did not deliver the expected event');
}

async function requestBrowserEvent(
  baseUrl: string,
  event: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/__zapp/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify(event),
  });
}

async function postBrowserEvent(baseUrl: string, event: Record<string, unknown>): Promise<void> {
  const response = await requestBrowserEvent(baseUrl, event);

  expect(response.ok).toBe(true);
}

async function loadServedClient(
  proxy: PreviewProxy,
  options: ClientDomOptions = {},
): Promise<JSDOM> {
  const response = await fetch(`${proxy.url}/__zapp/client.js`);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('javascript');

  const clientSource = await response.text();
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    referrer: options.referrer,
    runScripts: 'outside-only',
    url: `${proxy.url}/fixture`,
  });
  const browserFetch = (input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    return fetch(new URL(requestUrl, proxy.url), init);
  };

  Object.assign(dom.window, {
    AbortController,
    Headers,
    Request,
    Response,
    fetch: browserFetch,
  });
  Object.defineProperty(dom.window, 'CSS', {
    configurable: true,
    value: {
      escape(value: string): string {
        return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
      },
    },
  });
  if (options.parent) {
    Object.defineProperty(dom.window, 'parent', { configurable: true, value: options.parent });
  }
  options.beforeClientEval?.(dom.window as unknown as ClientWindow);
  dom.window.eval(clientSource);

  cleanups.push(() => {
    dom.window.close();
    return Promise.resolve();
  });
  return dom;
}

function createParentWindow(): { messages: ParentMessage[]; parent: ParentWindow } {
  const messages: ParentMessage[] = [];

  return {
    messages,
    parent: {
      postMessage(data, targetOrigin) {
        messages.push({ data, targetOrigin });
      },
    },
  };
}

function dispatchParentMessage(
  dom: JSDOM,
  source: ParentWindow,
  origin: string,
  data: Record<string, unknown>,
): void {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data,
      origin,
      source: source as unknown as MessageEventSource,
    }),
  );
}

function selectedPayload(messages: ParentMessage[]): Record<string, unknown> {
  const selection = messages.find((message) => message.data.type === 'zapp:element-selected');

  if (!selection) {
    throw new Error('the parent did not receive an element selection');
  }

  return selection.data.payload as Record<string, unknown>;
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let failure: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw failure;
}

function deferred<Value>(): {
  promise: Promise<Value>;
  reject(reason?: unknown): void;
  resolve(value: Value): void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function expectWebSocketRejected(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`WebSocket upgrade was not rejected: ${url}`));
    }, 500);
    socket.once('open', () => {
      clearTimeout(timeout);
      socket.terminate();
      reject(new Error(`WebSocket upgrade unexpectedly opened: ${url}`));
    });
    socket.once('error', () => undefined);
    socket.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function abortBrowserEventUpload(proxy: PreviewProxy): Promise<void> {
  const proxyUrl = new URL(proxy.url);
  const socket = createConnection({ host: '127.0.0.1', port: Number(proxyUrl.port) });

  await once(socket, 'connect');
  socket.write(
    [
      'POST /__zapp/events HTTP/1.1',
      `Host: ${proxyUrl.host}`,
      'Content-Type: application/json',
      `Idempotency-Key: ${randomUUID()}`,
      'Content-Length: 128',
      '',
      '{"type":"console",',
    ].join('\r\n'),
  );
  await wait(10);

  const closed = once(socket, 'close');
  socket.destroy();
  await closed;
}

describe('preview proxy acceptance contract', () => {
  test('keeps the browser-heavy cold-gate proof serialized with CI headroom', async () => {
    const [manifestText, configText] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../vitest.config.ts', import.meta.url), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };

    expect(manifest.scripts?.['test']).toBe('vitest run --maxWorkers=1');
    expect(configText).toContain('hookTimeout: 60_000');
    expect(configText).toContain('testTimeout: 30_000');
  });

  test('serves the built client as a classic script with capture hooks installed', async () => {
    const builtModuleUrl = new URL('../dist/main.js', import.meta.url);
    const builtModule = (await import(builtModuleUrl.href)) as {
      createPreviewProxy(options: PreviewProxyOptions): Promise<PreviewProxy>;
    };
    const proxy = await builtModule.createPreviewProxy({ port: 0, probePorts: [] });
    cleanups.push(() => proxy.close());
    const uploads: Record<string, unknown>[] = [];
    const dom = await loadServedClient(proxy, {
      beforeClientEval(clientWindow) {
        clientWindow.console.error = vi.fn();
        clientWindow.fetch = (_input: string | URL | Request, init?: RequestInit) => {
          if (init?.method === 'POST' && typeof init.body === 'string') {
            uploads.push(JSON.parse(init.body) as Record<string, unknown>);
          }
          return Promise.resolve(new Response(null, { status: 204 }));
        };
      },
    });

    (dom.window.console as unknown as Console).error('built classic capture');

    await eventually(() => {
      expect(uploads).toHaveLength(1);
    });
    expect(uploads[0]).toMatchObject({
      payload: { level: 'error', message: 'built classic capture' },
      type: 'console',
    });
  });

  test('injects one client into an explicit head and invalidates transformed validators', async () => {
    const original =
      '<!doctype html><html><head><title>Fixture</title></head><body>ready</body></html>';
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => {
        response.status(200).set({
          'content-length': Buffer.byteLength(original),
          'content-md5': 'fixture-md5',
          'content-type': 'text/html; charset=utf-8',
          etag: '"fixture-etag"',
          'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        });
        response.end(original);
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const response = await fetch(`${proxy.url}/`);
    const dom = new JSDOM(await response.text());
    cleanups.push(() => {
      dom.window.close();
      return Promise.resolve();
    });

    expect(response.status).toBe(200);
    expect(
      dom.window.document.head.querySelectorAll('script[src="/__zapp/client.js"]'),
    ).toHaveLength(1);
    expect(dom.window.document.body.textContent).toContain('ready');
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('content-md5')).toBeNull();
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('last-modified')).toBeNull();
  });

  test('injects the client exactly once into a chunked HTML response', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => {
        response.status(200).type('html');
        response.write('<html><HEAD><style>.fixture::after { content: "</he');
        setTimeout(() => response.end('ad>"; }</style></HEAD><body>chunked</body></html>'), 5);
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const dom = new JSDOM(await (await fetch(`${proxy.url}/`)).text());
    cleanups.push(() => {
      dom.window.close();
      return Promise.resolve();
    });

    expect(
      dom.window.document.head.querySelectorAll('script[src="/__zapp/client.js"]'),
    ).toHaveLength(1);
    expect(dom.window.document.querySelector('style')?.textContent).toContain('</head>');
    expect(dom.window.document.body.textContent).toContain('chunked');
  });

  test('injects the client into the implicit head of a body-only document', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => {
        response.status(200).type('html').send('<body><main id="app">ready</main></body>');
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const dom = new JSDOM(await (await fetch(`${proxy.url}/`)).text());
    cleanups.push(() => {
      dom.window.close();
      return Promise.resolve();
    });

    expect(
      dom.window.document.head.querySelectorAll('script[src="/__zapp/client.js"]'),
    ).toHaveLength(1);
    expect(dom.window.document.body.firstElementChild?.id).toBe('app');
  });

  test('injects the client into the implicit head before omitted-head body content', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => {
        response
          .status(200)
          .type('html')
          .send('<!doctype html><html><main id="app">ready</main></html>');
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const dom = new JSDOM(await (await fetch(`${proxy.url}/`)).text());
    cleanups.push(() => {
      dom.window.close();
      return Promise.resolve();
    });

    expect(
      dom.window.document.head.querySelectorAll('script[src="/__zapp/client.js"]'),
    ).toHaveLength(1);
    expect(dom.window.document.body.firstElementChild?.id).toBe('app');
  });

  test.each([
    ['empty HTML', ''],
    ['prolog-only HTML', '<!doctype html><!-- fixture -->'],
  ])('injects the client into the implicit head at EOF for %s', async (_caseName, original) => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => {
        response.status(200).type('html').send(original);
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const dom = new JSDOM(await (await fetch(`${proxy.url}/`)).text());
    cleanups.push(() => {
      dom.window.close();
      return Promise.resolve();
    });

    expect(
      dom.window.document.head.querySelectorAll('script[src="/__zapp/client.js"]'),
    ).toHaveLength(1);
  });

  test.each([
    [
      'explicit head',
      '<html><head><template><p>inert</p></template></head><body>ready</body></html>',
    ],
    ['implicit head', '<template><p>inert</p></template><main>ready</main>'],
  ])('fix round 1 template injects before an %s template', async (_caseName, original) => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.status(200).type('html').send(original));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const dom = new JSDOM(await (await fetch(`${proxy.url}/`)).text());
    cleanups.push(() => {
      dom.window.close();
      return Promise.resolve();
    });
    const template = dom.window.document.querySelector('template');
    const clients = dom.window.document.head.querySelectorAll('script[src="/__zapp/client.js"]');

    expect(template).not.toBeNull();
    expect(clients).toHaveLength(1);
    expect(clients[0]?.compareDocumentPosition(template as Node)).toBe(
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(template?.content.querySelector('script[src="/__zapp/client.js"]')).toBeNull();
  });

  test('fix round 1 template does not let a template-contained client suppress real injection', async () => {
    const original =
      '<html><head><template><script src="/__zapp/client.js"></script></template></head><body>ready</body></html>';
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.status(200).type('html').send(original));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const dom = new JSDOM(await (await fetch(`${proxy.url}/`)).text());
    cleanups.push(() => {
      dom.window.close();
      return Promise.resolve();
    });
    const template = dom.window.document.querySelector('template');

    expect(
      dom.window.document.head.querySelectorAll('script[src="/__zapp/client.js"]'),
    ).toHaveLength(1);
    expect(template?.content.querySelector('script[src="/__zapp/client.js"]')).toBeNull();
    expect(
      template?.content.querySelector('script[type="application/x-zapp-neutralized"]'),
    ).not.toBeNull();
  });

  test('uses parsed unquoted src attributes and keeps only one origin client', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => {
        response
          .status(200)
          .type('html')
          .send(
            '<html><head><script src=/__zapp/client.js?v=1></script><script src="/__zapp/client.js"></script></head><body>ready</body></html>',
          );
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const dom = new JSDOM(await (await fetch(`${proxy.url}/`)).text());
    cleanups.push(() => {
      dom.window.close();
      return Promise.resolve();
    });

    expect(dom.window.document.querySelectorAll('script[src^="/__zapp/client.js"]')).toHaveLength(
      1,
    );
    expect(
      dom.window.document.querySelectorAll('script[type="application/x-zapp-neutralized"]'),
    ).toHaveLength(1);
  });

  test('streams an injected head before neutralizing a later body client', async () => {
    const releaseBody = deferred<undefined>();
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => {
        response.status(200).type('html');
        response.write('<html><head><title>stream first</title></head>');
        void releaseBody.promise.then(() => {
          response.end('<body><script src="/__zapp/client.js"></script>ready</body></html>');
        });
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      releaseBody.resolve(undefined);
      return;
    }
    const response = await fetch(`${proxy.url}/`);
    const reader = response.body?.getReader();
    if (!reader) {
      releaseBody.resolve(undefined);
      throw new Error('HTML response did not expose a readable body');
    }
    const first = await Promise.race([reader.read(), wait(150).then(() => undefined)]);
    expect(first, 'the transformed head must stream before the late body chunk').toBeDefined();

    releaseBody.resolve(undefined);
    const chunks = first?.value ? [Buffer.from(first.value)] : [];
    let done = first?.done ?? false;
    while (!done) {
      const next = await reader.read();
      done = next.done;
      if (next.value) chunks.push(Buffer.from(next.value));
    }
    const dom = new JSDOM(Buffer.concat(chunks).toString('utf8'));
    cleanups.push(() => {
      dom.window.close();
      return Promise.resolve();
    });

    expect(dom.window.document.querySelectorAll('script[src="/__zapp/client.js"]')).toHaveLength(1);
    expect(
      dom.window.document.querySelectorAll('script[type="application/x-zapp-neutralized"]'),
    ).toHaveLength(1);
  });

  test('injects before a cross-origin base so the client stays on the protected origin', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => {
        response
          .status(200)
          .type('html')
          .send(
            '<html><head><base href="https://attacker.invalid/assets/"><title>base</title></head><body>ready</body></html>',
          );
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const response = await fetch(`${proxy.url}/`);
    const dom = new JSDOM(await response.text(), { url: `${proxy.url}/` });
    cleanups.push(() => {
      dom.window.close();
      return Promise.resolve();
    });
    const clients = dom.window.document.querySelectorAll('script[src="/__zapp/client.js"]');
    const base = dom.window.document.querySelector('base');

    expect(clients).toHaveLength(1);
    expect(base).not.toBeNull();
    expect(clients[0]?.compareDocumentPosition(base as Node)).toBe(
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test('forwards WebSocket upgrades and echo frames', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('unused'));
    }, true);
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`${proxy.url.replace('http', 'ws')}/socket`);
      socket.once('error', reject);
      socket.once('open', () => {
        socket.send('through-the-proxy');
      });
      socket.once('message', (data) => {
        socket.close();
        const message = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : data instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(data)).toString('utf8')
            : Buffer.from(data).toString('utf8');
        resolve(message);
      });
    });

    expect(echoed).toBe('through-the-proxy');
  });

  test('rejects reserved-path WebSocket upgrades without forwarding them to the origin', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('unused'));
    }, true);
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const proxyWebSocketUrl = proxy.url.replace('http', 'ws');
    await expectWebSocketRejected(`${proxyWebSocketUrl}/__zapp`);
    await expectWebSocketRejected(`${proxyWebSocketUrl}/__zapp/private`);

    expect(origin.upgradePaths).toEqual([]);
  });

  test('serves the real browser client and streams console.error to SSE', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const events = await openSse(proxy.url);
    cleanups.push(() => events.close());
    const dom = await loadServedClient(proxy);

    const browserConsole = dom.window.console as unknown as Console;
    browserConsole.error('client-side boom');

    const event = await waitForSseEvent(events, (candidate) => candidate.type === 'console');

    expect(event).toMatchObject({
      type: 'console',
      payload: {
        level: 'error',
        message: 'client-side boom',
        stack: anyString(),
      },
    });
  });

  test('serializes hostile console values without invoking page code and redacts bounded payloads before upload', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const uploads: Record<string, unknown>[] = [];
    const dom = await loadServedClient(proxy, {
      beforeClientEval(clientWindow) {
        clientWindow.console.error = vi.fn();
        clientWindow.fetch = (_input: string | URL | Request, init?: RequestInit) => {
          if (init?.method === 'POST' && typeof init.body === 'string') {
            uploads.push(JSON.parse(init.body) as Record<string, unknown>);
          }
          return Promise.resolve(new Response(null, { status: 204 }));
        };
      },
    });
    const getter = vi.fn(() => 'GETTER_SENTINEL');
    const toJson = vi.fn(() => {
      throw new Error('toJSON must not run');
    });
    const toString = vi.fn(() => {
      throw new Error('toString must not run');
    });
    const hostile: Record<string, unknown> = { safe: 'visible' };
    Object.defineProperties(hostile, {
      credential: { enumerable: true, get: getter },
      toJSON: { value: toJson },
      toString: { value: toString },
    });
    const browserConsole = dom.window.console as unknown as Console;

    expect(() => {
      browserConsole.error(
        hostile,
        fixtureCredentialUrl('example.test', '/logs?access_token=URL_SENTINEL&tab=preview'),
        'x'.repeat(10_000),
      );
    }).not.toThrow();

    await eventually(() => {
      expect(uploads).toHaveLength(1);
    });
    const event = uploads[0] as { payload: { message: string; stack: string }; type: string };
    const serialized = JSON.stringify(event);

    expect(getter).not.toHaveBeenCalled();
    expect(toJson).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
    expect(event.type).toBe('console');
    expect(event.payload.message.length).toBeLessThanOrEqual(4_096);
    expect(serialized).not.toContain('GETTER_SENTINEL');
    expect(serialized).not.toContain('URL_SENTINEL');
    expect(serialized).not.toContain('fixture-password');
    expect(serialized).toContain('%5BREDACTED%5D');
  });

  test('captures Chrome console primitives without invoking any arbitrary Proxy reflection trap', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) =>
        response.type('html').send('<html><head></head><body>fixture</body></html>'),
      );
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const events = await openSse(proxy.url);
    const eventCleanupIndex = cleanups.push(() => events.close()) - 1;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    cleanups[eventCleanupIndex] = async () => {
      try {
        // Cancel the proxy's streaming request before asking Chrome to close.
        // Closing them concurrently can keep both transports waiting forever.
        await events.close();
      } finally {
        await browser.close();
      }
    };
    const page = await browser.newPage();
    await page.goto(`${proxy.url}/`);

    const result = await page.evaluate(() => {
      const traps = { get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 };
      const hostile = new Proxy(
        { secret: 'must-not-be-read' },
        {
          get(target, property) {
            traps.get += 1;
            return property === 'secret' ? target.secret : undefined;
          },
          getOwnPropertyDescriptor(target, property) {
            traps.getOwnPropertyDescriptor += 1;
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
          ownKeys(target) {
            traps.ownKeys += 1;
            return Reflect.ownKeys(target);
          },
        },
      );
      console.error('primitive', 42, true, undefined, hostile);
      return { traps };
    });
    const event = (await events.next()) as {
      payload: { message: string; stack: string };
      type: string;
    };

    expect(result.traps).toEqual({ get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 });
    expect(event.type).toBe('console');
    expect(event.payload.message).toContain('primitive 42 true undefined [OpaqueObject]');
    expect(event.payload.message.length).toBeLessThanOrEqual(4_096);
    expect(event.payload.stack).toContain('Error');
  }, 30_000);

  test('redacts complete Authorization Bearer tokens in client console uploads', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const uploads: Record<string, unknown>[] = [];
    const dom = await loadServedClient(proxy, {
      beforeClientEval(clientWindow) {
        clientWindow.console.error = vi.fn();
        clientWindow.fetch = (_input: string | URL | Request, init?: RequestInit) => {
          if (init?.method === 'POST' && typeof init.body === 'string') {
            uploads.push(JSON.parse(init.body) as Record<string, unknown>);
          }
          return Promise.resolve(new Response(null, { status: 204 }));
        };
      },
    });
    const browserConsole = dom.window.console as unknown as Console;

    browserConsole.error(
      'Authorization: Bearer CLIENT_COLON_BEARER_SENTINEL',
      'authorization=Bearer CLIENT_EQUALS_BEARER_SENTINEL',
    );

    await eventually(() => {
      expect(uploads).toHaveLength(1);
    });
    const serialized = JSON.stringify(uploads);
    expect(serialized).not.toContain('CLIENT_COLON_BEARER_SENTINEL');
    expect(serialized).not.toContain('CLIENT_EQUALS_BEARER_SENTINEL');
    expect(serialized).toContain('[REDACTED]');
  });

  test('suppresses reentrant console capture from hostile serialization traps', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const uploads: Record<string, unknown>[] = [];
    const dom = await loadServedClient(proxy, {
      beforeClientEval(clientWindow) {
        clientWindow.console.error = vi.fn();
        clientWindow.fetch = (_input: string | URL | Request, init?: RequestInit) => {
          if (init?.method === 'POST' && typeof init.body === 'string') {
            uploads.push(JSON.parse(init.body) as Record<string, unknown>);
          }
          return Promise.resolve(new Response(null, { status: 204 }));
        };
      },
    });
    const browserConsole = dom.window.console as unknown as Console;
    let trapped = false;
    const hostile = new Proxy(
      { visible: true },
      {
        ownKeys(target) {
          if (!trapped) {
            trapped = true;
            browserConsole.error('nested capture must be suppressed');
          }
          return Reflect.ownKeys(target);
        },
      },
    );

    browserConsole.error(hostile);

    await eventually(() => {
      expect(uploads).toHaveLength(1);
    });
    expect(JSON.stringify(uploads)).not.toContain('nested capture must be suppressed');
  });

  test('sanitizes client network, route, error message, and stack URLs before upload', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const uploads: Array<{ payload: Record<string, unknown>; type: string }> = [];
    const dom = await loadServedClient(proxy, {
      beforeClientEval(clientWindow) {
        clientWindow.fetch = (_input: string | URL | Request, init?: RequestInit) => {
          if (init?.method === 'POST' && typeof init.body === 'string') {
            uploads.push(
              JSON.parse(init.body) as { payload: Record<string, unknown>; type: string },
            );
          }
          return Promise.resolve(new Response(null, { status: 200 }));
        };
      },
    });

    await dom.window.fetch(
      'https://api.example.test/items?access_token=CLIENT_URL_SENTINEL&tab=preview',
    );
    dom.window.history.pushState({}, '', '/route?session_token=CLIENT_ROUTE_SENTINEL&tab=preview');
    const error = new dom.window.Error('authorization=CLIENT_ERROR_SENTINEL');
    Object.defineProperty(error, 'stack', {
      value: `Error: authorization=CLIENT_STACK_SENTINEL at ${fixtureCredentialUrl(
        'errors.example.test',
        '/frame?token=CLIENT_QUERY_SENTINEL',
      )}`,
    });
    dom.window.dispatchEvent(
      new dom.window.ErrorEvent('error', {
        error,
        message: 'authorization=CLIENT_ERROR_SENTINEL',
      }),
    );

    await eventually(() => {
      expect(uploads.some((event) => event.type === 'network')).toBe(true);
      expect(uploads.some((event) => event.type === 'route_change')).toBe(true);
      expect(uploads.some((event) => event.type === 'runtime_error')).toBe(true);
    });

    const serialized = JSON.stringify(uploads);
    expect(serialized).not.toMatch(/CLIENT_(?:URL|ROUTE|ERROR|STACK|QUERY)_SENTINEL/);
    expect(serialized).not.toContain('fixture-password');
    expect(serialized).toContain('tab=preview');
    expect(serialized).toContain('%5BREDACTED%5D');
  });

  test('sanitizes and bounds browser events at the server ingest boundary', async () => {
    const proxy = await startProxy({ maxRetainedEvents: 4, probePorts: [] });

    if (!proxy) {
      return;
    }

    await postBrowserEvent(proxy.url, {
      payload: {
        level: 'error',
        message: `token=SERVER_MESSAGE_SENTINEL ${'x'.repeat(8_000)}`,
        stack: `Error at ${fixtureCredentialUrl(
          'errors.example.test',
          '/frame?access_token=SERVER_STACK_SENTINEL&tab=preview',
        )}`,
      },
      type: 'console',
    });
    await postBrowserEvent(proxy.url, {
      payload: {
        durationMs: 1,
        method: 'GET',
        status: 200,
        transport: 'fetch',
        url: fixtureCredentialUrl(
          'api.example.test',
          '/items?access_token=SERVER_URL_SENTINEL&tab=preview',
        ),
      },
      type: 'network',
    });
    await postBrowserEvent(proxy.url, {
      payload: {
        url: 'https://app.example.test/route?session_token=SERVER_ROUTE_SENTINEL&tab=preview',
      },
      type: 'route_change',
    });
    await postBrowserEvent(proxy.url, {
      payload: {
        message: 'password=SERVER_ERROR_SENTINEL',
        stack: 'Error: password=SERVER_ERROR_SENTINEL',
      },
      type: 'runtime_error',
    });

    const events = await openSse(proxy.url);
    cleanups.push(() => events.close());
    const replayed = [
      await events.next(),
      await events.next(),
      await events.next(),
      await events.next(),
    ];
    const serialized = JSON.stringify(replayed);
    const consoleEvent = replayed[0] as { payload: { message: string } };

    expect(consoleEvent.payload.message.length).toBeLessThanOrEqual(4_096);
    expect(serialized).not.toMatch(/SERVER_(?:MESSAGE|STACK|URL|ROUTE|ERROR)_SENTINEL/);
    expect(serialized).not.toContain('fixture-password');
    expect(serialized).toContain('tab=preview');
    expect(serialized).toContain('%5BREDACTED%5D');
  });

  test('redacts complete Authorization Bearer tokens at the server ingest boundary', async () => {
    const proxy = await startProxy({ maxRetainedEvents: 1, probePorts: [] });

    if (!proxy) {
      return;
    }

    await postBrowserEvent(proxy.url, {
      payload: {
        level: 'error',
        message: 'Authorization: Bearer SERVER_COLON_BEARER_SENTINEL',
        stack: 'authorization=Bearer SERVER_EQUALS_BEARER_SENTINEL',
      },
      type: 'console',
    });

    const events = await openSse(proxy.url);
    cleanups.push(() => events.close());
    const serialized = JSON.stringify(await events.next());

    expect(serialized).not.toContain('SERVER_COLON_BEARER_SENTINEL');
    expect(serialized).not.toContain('SERVER_EQUALS_BEARER_SENTINEL');
    expect(serialized).toContain('[REDACTED]');
  });

  test('fix round 1 direct ingest rejects non-http capture URLs before retention and SSE', async () => {
    const proxy = await startProxy({ maxRetainedEvents: 4, probePorts: [] });

    if (!proxy) return;
    const events = await openSse(proxy.url);
    cleanups.push(() => events.close());
    const dataResponse = await requestBrowserEvent(proxy.url, {
      payload: {
        durationMs: 1,
        method: 'GET',
        status: 200,
        transport: 'fetch',
        url: 'data:text/plain,URL_SECRET',
      },
      type: 'network',
    });
    const javascriptResponse = await requestBrowserEvent(proxy.url, {
      payload: { url: 'javascript:authorization=URL_SECRET' },
      type: 'route_change',
    });

    expect(dataResponse.status).toBe(400);
    expect(javascriptResponse.status).toBe(400);
    await postBrowserEvent(proxy.url, {
      payload: { url: 'https://app.example.test/safe' },
      type: 'route_change',
    });
    const serialized = JSON.stringify(await events.next());
    expect(serialized).toContain('https://app.example.test/safe');
    expect(serialized).not.toContain('URL_SECRET');
  });

  test('fix round 1 direct ingest rejects an invalid HTTP method before retention and SSE', async () => {
    const proxy = await startProxy({ maxRetainedEvents: 2, probePorts: [] });

    if (!proxy) return;
    const events = await openSse(proxy.url);
    cleanups.push(() => events.close());
    const hostile = await requestBrowserEvent(proxy.url, {
      payload: {
        durationMs: 1,
        method: 'authorization=METHOD_SECRET',
        status: 200,
        transport: 'fetch',
        url: 'https://api.example.test/items',
      },
      type: 'network',
    });

    expect(hostile.status).toBe(400);
    await postBrowserEvent(proxy.url, {
      payload: {
        durationMs: 1,
        method: 'PATCH',
        status: 204,
        transport: 'fetch',
        url: 'https://api.example.test/items',
      },
      type: 'network',
    });
    const serialized = JSON.stringify(await events.next());
    expect(serialized).toContain('PATCH');
    expect(serialized).not.toContain('METHOD_SECRET');
  });

  test('captures fetch and XHR metadata without either request or response body', async () => {
    const origin = await startOrigin((app) => {
      app.post('/api/metadata', (_request, response) => {
        response.status(201).json({ accepted: true });
      });
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const events = await openSse(proxy.url);
    cleanups.push(() => events.close());
    const dom = await loadServedClient(proxy);

    await dom.window.fetch('/api/metadata', {
      body: 'fetch request body must never be captured',
      method: 'POST',
    });
    await new Promise<void>((resolve, reject) => {
      const request = new dom.window.XMLHttpRequest();
      request.addEventListener('error', () => {
        reject(new Error('fixture XHR failed'));
      });
      request.addEventListener('loadend', () => {
        resolve();
      });
      request.open('POST', '/api/metadata');
      request.send('xhr request body must never be captured');
    });

    const fetchEvent = await waitForSseEvent(
      events,
      (candidate) =>
        candidate.type === 'network' &&
        (candidate.payload as { transport?: string }).transport === 'fetch',
    );
    const xhrEvent = await waitForSseEvent(
      events,
      (candidate) =>
        candidate.type === 'network' &&
        (candidate.payload as { transport?: string }).transport === 'xhr',
    );

    for (const event of [fetchEvent, xhrEvent]) {
      expect(event).toMatchObject({
        type: 'network',
        payload: {
          durationMs: anyNumber(),
          method: 'POST',
          status: 201,
          url: `${proxy.url}/api/metadata`,
        },
      });
      expect(JSON.stringify(event)).not.toContain('request body must never be captured');
      expect(event.payload).not.toHaveProperty('body');
      expect(event.payload).not.toHaveProperty('requestBody');
      expect(event.payload).not.toHaveProperty('responseBody');
    }
  });

  test('suppresses only the exact same-origin browser-event ingest request', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const requests: Array<{ init: RequestInit | undefined; url: string }> = [];
    const dom = await loadServedClient(proxy, {
      beforeClientEval(clientWindow) {
        clientWindow.fetch = (input: string | URL | Request, init?: RequestInit) => {
          requests.push({ init, url: input instanceof Request ? input.url : String(input) });
          return Promise.resolve(new Response(null, { status: 204 }));
        };
      },
    });

    await dom.window.fetch('https://api.example.test/__zapp/events');
    await dom.window.fetch('/__zapp/events-more');
    await dom.window.fetch('/__zapp/events');

    await eventually(() => {
      const capturedRequests = requests.filter(
        ({ init, url }) => init?.method === 'POST' && url === '/__zapp/events',
      );
      const capturedEvents = capturedRequests.map(({ init }) => {
        if (typeof init?.body !== 'string') {
          throw new Error('captured browser event did not contain a JSON string body');
        }
        return JSON.parse(init.body) as { payload: { url: string }; type: string };
      });

      expect(capturedEvents).toHaveLength(2);
      expect(capturedEvents.map((event) => event.payload.url)).toEqual([
        'https://api.example.test/__zapp/events',
        `${proxy.url}/__zapp/events-more`,
      ]);
      const idempotencyKeys = capturedRequests.map(({ init }) =>
        new Headers(init?.headers).get('idempotency-key'),
      );
      expect(idempotencyKeys).toHaveLength(2);
      expect(idempotencyKeys).toEqual([
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
      ]);
      expect(new Set(idempotencyKeys).size).toBe(2);
    });
  });

  test('bounds 5,000 capture uploads to one active request and a 100-event drop-newest queue', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    let activeUploads = 0;
    let maxActiveUploads = 0;
    let startedUploads = 0;
    const releases: Array<() => void> = [];
    const dom = await loadServedClient(proxy, {
      beforeClientEval(clientWindow) {
        clientWindow.console.log = vi.fn();
        clientWindow.fetch = (_input: string | URL | Request, init?: RequestInit) => {
          if (init?.method !== 'POST') {
            return Promise.resolve(new Response(null, { status: 204 }));
          }
          startedUploads += 1;
          activeUploads += 1;
          maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
          return new Promise<Response>((resolve) => {
            releases.push(() => {
              activeUploads -= 1;
              resolve(new Response(null, { status: 204 }));
            });
          });
        };
      },
    });

    const browserConsole = dom.window.console as unknown as Console;
    for (let index = 0; index < 5_000; index += 1) {
      browserConsole.log(`event-${String(index)}`);
    }

    expect(startedUploads).toBe(1);
    expect(activeUploads).toBe(1);
    expect(maxActiveUploads).toBe(1);

    let released = 0;
    while (released < releases.length) {
      const batch = releases.slice(released);
      released = releases.length;
      for (const release of batch) {
        release();
      }
      await wait(0);
    }

    expect(startedUploads).toBe(101);
    expect(activeUploads).toBe(0);
    expect(maxActiveUploads).toBe(1);
  });

  test('serializes capture uploads through reverse timing, failure, saturation, and recovery', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const events = await openSse(proxy.url);
    cleanups.push(() => events.close());
    let uploadIndex = 0;
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const dom = await loadServedClient(proxy, {
        beforeClientEval(clientWindow) {
          clientWindow.console.log = vi.fn();
          clientWindow.fetch = (input: string | URL | Request, init?: RequestInit) => {
            if (init?.method !== 'POST')
              return Promise.resolve(new Response(null, { status: 204 }));
            const index = uploadIndex;
            uploadIndex += 1;
            if (index === 0) {
              return wait(30).then(() => Promise.reject(new Error('first upload failed')));
            }
            const delay = index === 1 ? 20 : 1;
            const inputUrl =
              input instanceof Request ? input.url : input instanceof URL ? input.href : input;
            return wait(delay).then(() => fetch(new URL(inputUrl, proxy.url), init));
          };
        },
      });
      const browserConsole = dom.window.console as unknown as Console;
      browserConsole.log('ordered-0');
      browserConsole.log('ordered-1');
      browserConsole.log('ordered-2');

      const received = [await events.next(), await events.next()];
      expect(received.map((event) => (event.payload as { message: string }).message)).toEqual([
        'ordered-1',
        'ordered-2',
      ]);
      expect(uploadIndex).toBe(3);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('leaves JSON and binary origin responses byte-for-byte unchanged', async () => {
    const image = Buffer.from([0, 255, 1, 254, 2, 253]);
    const origin = await startOrigin((app) => {
      app.get('/data.json', (_request, response) => {
        response.status(200).set({ 'content-type': 'application/json', 'x-origin': 'json' });
        response.send('{"answer":42}');
      });
      app.get('/image.png', (_request, response) => {
        response.status(200).set({ 'content-type': 'image/png', 'x-origin': 'binary' });
        response.send(image);
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const json = await fetch(`${proxy.url}/data.json`);
    const binary = await fetch(`${proxy.url}/image.png`);

    expect(Buffer.from(await json.arrayBuffer())).toEqual(Buffer.from('{"answer":42}'));
    expect(json.headers.get('x-origin')).toBe('json');
    expect(Buffer.from(await binary.arrayBuffer())).toEqual(image);
    expect(binary.headers.get('x-origin')).toBe('binary');
  });

  test('fix round 1 strips spoofed degraded-capture headers from successful upstream responses', async () => {
    const origin = await startOrigin((app) => {
      app.get('/page', (_request, response) => {
        response
          .status(200)
          .set('x-zapp-capture-degraded', 'origin-spoof')
          .type('html')
          .send('<html><head></head><body>ready</body></html>');
      });
      app.get('/data', (_request, response) => {
        response
          .status(200)
          .set({ 'content-type': 'application/json', 'x-zapp-capture-degraded': 'origin-spoof' })
          .send('{"ready":true}');
      });
      app.get('/latin-1', (_request, response) => {
        response.status(200).set({
          'content-type': 'text/html; charset=iso-8859-1',
          'x-zapp-capture-degraded': 'origin-spoof',
        });
        response.end('<html><head></head><body>ready</body></html>');
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const html = await fetch(`${proxy.url}/page`);
    const json = await fetch(`${proxy.url}/data`);
    const degraded = await fetch(`${proxy.url}/latin-1`);

    expect(html.headers.get('x-zapp-capture-degraded')).toBeNull();
    expect(json.headers.get('x-zapp-capture-degraded')).toBeNull();
    expect(degraded.headers.get('x-zapp-capture-degraded')).toBe('html-charset');
    expect(await json.text()).toBe('{"ready":true}');
  });

  test('does not transform a non-HTML media type whose name starts with text/html', async () => {
    const body = Buffer.from('<html><head></head><body>patch payload</body></html>');
    const origin = await startOrigin((app) => {
      app.get('/patch', (_request, response) => {
        response.status(200).set('content-type', 'text/html-patch').send(body);
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const response = await fetch(`${proxy.url}/patch`);

    expect(response.headers.get('content-type')).toContain('text/html-patch');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
  });

  test('passes unsupported HTML charsets through without changing their bytes', async () => {
    const body = Buffer.concat([
      Buffer.from('<html><head></head><body>caf'),
      Buffer.from([0xe9]),
      Buffer.from('</body></html>'),
    ]);
    const origin = await startOrigin((app) => {
      app.get('/latin-1', (_request, response) => {
        response.status(200).set({
          'content-length': String(body.length),
          'content-type': 'text/html; charset=iso-8859-1',
        });
        response.end(body);
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const response = await fetch(`${proxy.url}/latin-1`);

    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    expect(response.headers.get('x-zapp-capture-degraded')).toBe('html-charset');
  });

  test('passes through a partial HTML response without changing its bytes, status, or range headers', async () => {
    const body = Buffer.from('<head></head>');
    const origin = await startOrigin((app) => {
      app.get('/partial.html', (_request, response) => {
        response.status(206).set({
          'accept-ranges': 'bytes',
          'content-length': String(body.length),
          'content-range': 'bytes 40-52/120',
          'content-type': 'text/html; charset=utf-8',
          etag: '"partial-fixture"',
          'x-origin': 'partial-html',
        });
        response.send(body);
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const response = await fetch(`${proxy.url}/partial.html`);

    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe(String(body.length));
    expect(response.headers.get('content-range')).toBe('bytes 40-52/120');
    expect(response.headers.get('etag')).toBe('"partial-fixture"');
    expect(response.headers.get('x-origin')).toBe('partial-html');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
  });

  test('reports health without a target and returns 502 when no configured or probed target exists', async () => {
    const proxy = await startProxy({ probePorts: [] });

    if (!proxy) {
      return;
    }

    const health = await fetch(`${proxy.url}/__zapp/healthz`);
    const missingTarget = await fetch(`${proxy.url}/`);

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect(missingTarget.status).toBe(502);
  });

  test('auto-probes candidates in order until it reaches a listening origin', async () => {
    const origin = await startOrigin((app) => {
      app.get('/from-probe', (_request, response) =>
        response.type('text/plain').send('second candidate reached'),
      );
    });
    const unavailablePort = await findUnavailablePort();
    const proxy = await startProxy({ probePorts: [unavailablePort, origin.port] });

    if (!proxy) {
      return;
    }

    const response = await fetch(`${proxy.url}/from-probe`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('second candidate reached');
  });

  test('keeps auto-probing until a late origin can serve both HTTP and WebSocket requests', async () => {
    const candidatePort = await findUnavailablePort();
    const proxy = await startProxy({ probePorts: [candidatePort] });

    if (!proxy) {
      return;
    }

    expect((await fetch(`${proxy.url}/late`)).status).toBe(502);

    const origin = await startOrigin(
      (app) => {
        app.get('/late', (_request, response) =>
          response.type('text/plain').send('late origin reached'),
        );
      },
      true,
      candidatePort,
    );

    const httpResponse = await fetch(`${proxy.url}/late`);
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`${proxy.url.replace('http', 'ws')}/socket`);
      socket.once('error', reject);
      socket.once('open', () => {
        socket.send('late-upgrade');
      });
      socket.once('message', (message) => {
        socket.close();
        const body = Array.isArray(message)
          ? Buffer.concat(message)
          : message instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(message))
            : message;
        resolve(body.toString('utf8'));
      });
    });

    expect(origin.port).toBe(candidatePort);
    expect(httpResponse.status).toBe(200);
    expect(await httpResponse.text()).toBe('late origin reached');
    expect(echoed).toBe('late-upgrade');
  });

  test('invalidates a failed auto-probed target and selects a newly live candidate', async () => {
    const firstPort = await findUnavailablePort();
    const firstOrigin = await startOrigin(
      (app) => {
        app.get('/candidate', (_request, response) =>
          response.type('text/plain').send('first candidate'),
        );
      },
      false,
      firstPort,
    );
    const secondPort = await findUnavailablePort();
    const proxy = await startProxy({ probePorts: [firstPort, secondPort] });

    if (!proxy) {
      return;
    }

    expect(await (await fetch(`${proxy.url}/candidate`)).text()).toBe('first candidate');
    await closeServer(firstOrigin.server);
    const secondOrigin = await startOrigin(
      (app) => {
        app.get('/candidate', (_request, response) =>
          response.type('text/plain').send('second candidate'),
        );
      },
      false,
      secondPort,
    );

    const failedCachedRequest = await fetch(`${proxy.url}/candidate`);
    const recovered = await fetch(`${proxy.url}/candidate`);

    expect(failedCachedRequest.status).toBe(502);
    expect(secondOrigin.port).toBe(secondPort);
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe('second candidate');
  });

  test('continues HTTP auto-probe after a persistent resetting first listener', async () => {
    const resettingOrigin = createServer((_request, response) => {
      response.socket?.destroy();
    });
    resettingOrigin.listen(0, '127.0.0.1');
    await once(resettingOrigin, 'listening');
    cleanups.push(() => closeServer(resettingOrigin));
    const resettingPort = (resettingOrigin.address() as AddressInfo).port;
    const healthyOrigin = await startOrigin((app) => {
      app.get('/candidate', (_request, response) =>
        response.type('text/plain').send('healthy candidate'),
      );
    });
    const proxy = await startProxy({ probePorts: [resettingPort, healthyOrigin.port] });

    if (!proxy) {
      return;
    }

    expect((await fetch(`${proxy.url}/candidate`)).status).toBe(502);
    const recovered = await fetch(`${proxy.url}/candidate`);

    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe('healthy candidate');
  });

  test('continues WebSocket auto-probe after a persistent resetting first listener', async () => {
    const resettingOrigin = createServer();
    resettingOrigin.on('upgrade', (_request, socket) => {
      socket.destroy();
    });
    resettingOrigin.listen(0, '127.0.0.1');
    await once(resettingOrigin, 'listening');
    cleanups.push(() => closeServer(resettingOrigin));
    const resettingPort = (resettingOrigin.address() as AddressInfo).port;
    const healthyOrigin = await startOrigin(() => undefined, true);
    const proxy = await startProxy({ probePorts: [resettingPort, healthyOrigin.port] });

    if (!proxy) {
      return;
    }

    const proxyWebSocketUrl = `${proxy.url.replace('http', 'ws')}/socket`;
    await expectWebSocketRejected(proxyWebSocketUrl);
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(proxyWebSocketUrl);
      socket.once('error', reject);
      socket.once('open', () => {
        socket.send('healthy-upgrade');
      });
      socket.once('message', (message) => {
        socket.close();
        const body = Array.isArray(message)
          ? Buffer.concat(message)
          : message instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(message))
            : message;
        resolve(body.toString('utf8'));
      });
    });

    expect(echoed).toBe('healthy-upgrade');
  });

  test('times out a silent HTTP candidate and rotates to a healthy origin', async () => {
    const silent = await startSilentTcpOrigin();
    const healthy = await startOrigin((app) => {
      app.get('/candidate', (_request, response) =>
        response.type('text/plain').send('healthy after header timeout'),
      );
    });
    const proxy = await startProxy({
      probePorts: [silent.port, healthy.port],
      upstreamResponseHeaderTimeoutMs: 500,
    });

    if (!proxy) {
      return;
    }

    const timedOut = await fetch(`${proxy.url}/candidate`, { signal: AbortSignal.timeout(2_000) });
    const recovered = await fetch(`${proxy.url}/candidate`);

    expect(timedOut.status).toBe(502);
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe('healthy after header timeout');
    await eventually(() => {
      expect(silent.sockets).toHaveLength(0);
    });
  });

  test('times out a silent WebSocket handshake and rotates to a healthy origin', async () => {
    const silent = await startSilentTcpOrigin();
    const healthy = await startOrigin(() => undefined, true);
    const proxy = await startProxy({
      probePorts: [silent.port, healthy.port],
      webSocketUpgradeTimeoutMs: 25,
    });

    if (!proxy) {
      return;
    }

    const proxyWebSocketUrl = `${proxy.url.replace('http', 'ws')}/socket`;
    await expectWebSocketRejected(proxyWebSocketUrl);
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(proxyWebSocketUrl);
      socket.once('error', reject);
      socket.once('open', () => {
        socket.send('healthy after upgrade timeout');
      });
      socket.once('message', (message) => {
        socket.close();
        resolve(Buffer.from(message as Buffer).toString('utf8'));
      });
    });

    expect(echoed).toBe('healthy after upgrade timeout');
    await eventually(() => {
      expect(silent.sockets).toHaveLength(0);
    });
  });

  test('streams with bounded memory and injects once when </head> occurs after the inspection cap', async () => {
    const preHead = `<html><head>${'x'.repeat(65_537)}`;
    const html = `${preHead}</head><body>too late to inject</body></html>`;
    const releaseTail = deferred<undefined>();
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => {
        response.status(200).set({
          'content-length': String(Buffer.byteLength(html)),
          'content-type': 'text/html; charset=utf-8',
        });
        response.write(preHead);
        void releaseTail.promise.then(() => {
          response.end('</head><body>too late to inject</body></html>');
        });
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const responsePromise = fetch(`${proxy.url}/`);
    const responseBeforeTail = await Promise.race([
      responsePromise,
      wait(150).then(() => undefined),
    ]);
    if (!responseBeforeTail) {
      releaseTail.resolve(undefined);
      await responsePromise;
      expect(responseBeforeTail, 'the proxy must not buffer the whole HTML response').toBeDefined();
      return;
    }

    expect(responseBeforeTail.status).toBe(200);
    expect(responseBeforeTail.body).not.toBeNull();
    const reader = responseBeforeTail.body?.getReader();
    if (!reader) {
      releaseTail.resolve(undefined);
      throw new Error('HTML response did not expose a readable body');
    }
    const firstRead = await Promise.race([reader.read(), wait(150).then(() => undefined)]);
    releaseTail.resolve(undefined);
    if (!firstRead) {
      await reader.cancel();
      expect(
        firstRead,
        'the proxy must forward bytes before the upstream response ends',
      ).toBeDefined();
      return;
    }

    const transformedPromise = (async () => {
      const chunks = firstRead.value ? [Buffer.from(firstRead.value)] : [];
      let done = firstRead.done;
      while (!done) {
        const next = await reader.read();
        done = next.done;
        if (next.value) {
          chunks.push(Buffer.from(next.value));
        }
      }
      return Buffer.concat(chunks).toString('utf8');
    })();
    const transformed = await Promise.race([transformedPromise, wait(500).then(() => undefined)]);
    if (transformed === undefined) {
      await reader.cancel();
    }

    expect(
      transformed,
      'the rewriter must resume after backpressure and finish the response',
    ).toBeDefined();
    if (transformed === undefined) {
      return;
    }
    const dom = new JSDOM(transformed);
    cleanups.push(() => {
      dom.window.close();
      return Promise.resolve();
    });
    expect(
      dom.window.document.head.querySelectorAll('script[src="/__zapp/client.js"]'),
    ).toHaveLength(1);
    expect(dom.window.document.body.textContent).toContain('too late to inject');
    expect(responseBeforeTail.headers.get('x-zapp-capture-degraded')).toBeNull();
  });

  test('marks capture degraded before streaming past the cap when CSP blocks a later client', async () => {
    const preHead = `<html><head>${'x'.repeat(65_537)}`;
    const tail = '<script src="/__zapp/client.js"></script></head><body>blocked</body></html>';
    const original = `${preHead}${tail}`;
    const releaseTail = deferred<undefined>();
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => {
        response.status(200).set({
          'content-security-policy': "default-src 'self'; script-src 'none'",
          'content-type': 'text/html; charset=utf-8',
        });
        response.write(preHead);
        void releaseTail.promise.then(() => response.end(tail));
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      releaseTail.resolve(undefined);
      return;
    }

    const responsePromise = fetch(`${proxy.url}/`);
    const response = await Promise.race([responsePromise, wait(150).then(() => undefined)]);
    expect(response, 'the degraded response must start before the upstream tail').toBeDefined();
    if (!response) {
      releaseTail.resolve(undefined);
      await responsePromise;
      return;
    }

    expect(response.headers.get('x-zapp-capture-degraded')).toBe('csp');
    releaseTail.resolve(undefined);
    expect(await response.text()).toBe(original);
  });

  test('turns an HTML upstream stream error before headers into a visible 502 without an unhandled rejection', async () => {
    const origin = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.flushHeaders();
      response.destroy();
    });
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    const { port } = origin.address() as AddressInfo;
    cleanups.push(() => closeServer(origin));
    const proxy = await startProxy({ target: `http://127.0.0.1:${String(port)}` });

    if (!proxy) {
      return;
    }

    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    const status = await Promise.race([
      fetch(`${proxy.url}/`)
        .then((response) => response.status)
        .catch(() => undefined),
      wait(100).then(() => 'timed out waiting for the proxy response'),
    ]);
    await wait(20);
    process.off('unhandledRejection', unhandled);

    expect(status).toBe(502);
    expect(unhandled).not.toHaveBeenCalled();
  });

  test('cancels a header-only origin immediately when the downstream closes', async () => {
    const originReached = deferred<undefined>();
    const originClosed = deferred<undefined>();
    let hangingResponse: ServerResponse | undefined;
    const origin = createServer((_request, response) => {
      hangingResponse = response;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.flushHeaders();
      response.once('close', () => {
        originClosed.resolve(undefined);
      });
      originReached.resolve(undefined);
    });
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    const { port } = origin.address() as AddressInfo;
    cleanups.push(async () => {
      hangingResponse?.destroy();
      await closeServer(origin);
    });
    const proxy = await startProxy({ target: `http://127.0.0.1:${String(port)}` });

    if (!proxy) {
      return;
    }

    const proxyUrl = new URL(proxy.url);
    const downstream = createConnection({ host: '127.0.0.1', port: Number(proxyUrl.port) });
    await once(downstream, 'connect');
    downstream.write(`GET / HTTP/1.1\r\nHost: ${proxyUrl.host}\r\nConnection: close\r\n\r\n`);
    await originReached.promise;
    downstream.destroy();

    const canceled = await Promise.race([
      originClosed.promise.then(() => true),
      wait(150).then(() => false),
    ]);

    expect(canceled, 'the origin stream must be canceled without waiting for proxy.close()').toBe(
      true,
    );
  });

  test('cancels a no-header upstream request when the downstream aborts', async () => {
    const origin = await startNoHeaderOrigin();
    const proxy = await startProxy({ target: `http://127.0.0.1:${String(origin.port)}` });

    if (!proxy) {
      return;
    }

    const proxyUrl = new URL(proxy.url);
    const downstream = createConnection({ host: '127.0.0.1', port: Number(proxyUrl.port) });
    await once(downstream, 'connect');
    downstream.write(`GET / HTTP/1.1\r\nHost: ${proxyUrl.host}\r\nConnection: close\r\n\r\n`);
    await origin.reached;
    downstream.destroy();

    await eventually(() => {
      expect(downstream.destroyed).toBe(true);
      expect(origin.sockets).toHaveLength(0);
    });
  });

  test('destroys no-header upstream requests during proxy shutdown', async () => {
    const origin = await startNoHeaderOrigin();
    const proxy = await startProxy({ target: `http://127.0.0.1:${String(origin.port)}` });

    if (!proxy) {
      return;
    }

    const request = fetch(`${proxy.url}/`).catch(() => undefined);
    await origin.reached;
    await proxy.close();
    await request;

    await eventually(() => {
      expect(origin.sockets).toHaveLength(0);
    });
  });

  test('preserves restrictive CSP without widening it and marks capture degraded', async () => {
    const policy = "default-src 'self'; script-src 'none'";
    const original = '<html><head><title>restricted</title></head><body>ready</body></html>';
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => {
        response.status(200).set('content-security-policy', policy).type('html').send(original);
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const response = await fetch(`${proxy.url}/`);

    expect(response.headers.get('content-security-policy')).toBe(policy);
    expect(response.headers.get('x-zapp-capture-degraded')).toBe('csp');
    expect(await response.text()).toBe(original);
  });

  test.each([
    "script-src 'nonce-preview' 'strict-dynamic' 'self'",
    "script-src 'sha256-YWJj' 'strict-dynamic' 'self'",
  ])('fix round 1 strict-dynamic passes through an unauthorized %s policy', async (policy) => {
    const original = '<html><head><title>restricted</title></head><body>ready</body></html>';
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => {
        response.status(200).set('content-security-policy', policy).type('html').send(original);
      });
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) return;
    const response = await fetch(`${proxy.url}/`);

    expect(response.headers.get('content-security-policy')).toBe(policy);
    expect(response.headers.get('x-zapp-capture-degraded')).toBe('csp');
    expect(await response.text()).toBe(original);
  });

  test('returns 501 rather than faking a screenshot without a capture capability', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const response = await fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });

    expect(response.status).toBe(501);
  });

  test('rejects concurrent screenshot requests without starting a second capture', async () => {
    const firstCapture = deferred<{ contentType: 'image/png'; image: Buffer }>();
    const image = PNG_IMAGE;
    const captureScreenshot = vi.fn(() => {
      if (captureScreenshot.mock.calls.length === 1) {
        return firstCapture.promise;
      }

      return Promise.resolve({ contentType: 'image/png' as const, image });
    });
    const proxy = await startProxy({ captureScreenshot, probePorts: [] });

    if (!proxy) {
      return;
    }

    const firstResponse = fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });
    await eventually(() => {
      expect(captureScreenshot).toHaveBeenCalledOnce();
    });
    const rejected = await fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });
    firstCapture.resolve({ contentType: 'image/png', image });

    expect(rejected.status).toBe(503);
    expect(captureScreenshot).toHaveBeenCalledOnce();
    expect((await firstResponse).status).toBe(200);
  });

  test('aborts a hung screenshot capture at its timeout and responds with 503', async () => {
    let signal: AbortSignal | undefined;
    const captureScreenshot = vi.fn((captureSignal: AbortSignal) => {
      signal = captureSignal;
      return new Promise<{ contentType: 'image/png'; image: Buffer }>((_resolve, reject) => {
        captureSignal.addEventListener(
          'abort',
          () => {
            reject(new Error('fixture screenshot timed out'));
          },
          { once: true },
        );
      });
    }) as unknown as ScreenshotCapture;
    const proxy = await startProxy({
      captureScreenshot,
      probePorts: [],
      screenshotTimeoutMs: 25,
    });

    if (!proxy) {
      return;
    }

    const result = await Promise.race([
      fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' }).then(
        (response) => response.status,
      ),
      wait(100).then(() => 'timed out waiting for screenshot response'),
    ]);

    expect(result).toBe(503);
    expect(signal?.aborted).toBe(true);
    expect(captureScreenshot).toHaveBeenCalledOnce();
  });

  test('aborts screenshot capture when the downstream disconnects and releases the capture slot', async () => {
    const captureStarted = deferred<AbortSignal>();
    let captureCalls = 0;
    const captureScreenshot: ScreenshotCapture = (signal) => {
      captureCalls += 1;
      if (captureCalls > 1) {
        return Promise.resolve({ contentType: 'image/png', image: PNG_IMAGE });
      }

      captureStarted.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('downstream disconnected'));
          },
          { once: true },
        );
      });
    };
    const proxy = await startProxy({
      captureScreenshot,
      probePorts: [],
      screenshotTimeoutMs: 5_000,
    });

    if (!proxy) {
      return;
    }

    const proxyUrl = new URL(proxy.url);
    const socket = createConnection({ host: '127.0.0.1', port: Number(proxyUrl.port) });
    await once(socket, 'connect');
    socket.write(
      [
        'POST /__zapp/screenshot HTTP/1.1',
        `Host: ${proxyUrl.host}`,
        'Content-Length: 0',
        '',
        '',
      ].join('\r\n'),
    );
    const signal = await captureStarted.promise;
    const closed = once(socket, 'close');
    socket.destroy();
    await closed;

    await eventually(() => {
      expect(signal.aborted).toBe(true);
    });
    const recovered = await fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });
    expect(recovered.status).toBe(200);
    expect(captureCalls).toBe(2);
  });

  test('never writes or ends a downstream response after abort, close, or late capture settlement', async () => {
    const captureStarted = deferred<AbortSignal>();
    const captureScreenshot: ScreenshotCapture = (signal) => {
      captureStarted.resolve(signal);
      return new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            setImmediate(() => {
              resolve({ contentType: 'image/png', image: PNG_IMAGE });
            });
          },
          { once: true },
        );
      });
    };
    const writeHeadAfterClose = vi.fn();
    const endAfterClose = vi.fn();
    const writeHeadSpy = vi
      .spyOn(ServerResponse.prototype, 'writeHead')
      .mockImplementation(function writeHead(
        this: ServerResponse,
        statusCode: number,
        ...args: unknown[]
      ) {
        if (this.destroyed || this.writableEnded || this.headersSent) writeHeadAfterClose();
        void statusCode;
        void args;
        return this;
      } as ServerResponse['writeHead']);
    const endSpy = vi.spyOn(ServerResponse.prototype, 'end').mockImplementation(function end(
      this: ServerResponse,
      ...args: unknown[]
    ) {
      if (this.destroyed || this.writableEnded) endAfterClose();
      void args;
      return this;
    } as ServerResponse['end']);
    cleanups.push(() => {
      endSpy.mockRestore();
      writeHeadSpy.mockRestore();
      return Promise.resolve();
    });
    const proxy = await startProxy({
      captureScreenshot,
      probePorts: [],
      screenshotTimeoutMs: 5_000,
    });

    if (!proxy) {
      return;
    }

    const proxyUrl = new URL(proxy.url);
    const socket = createConnection({ host: '127.0.0.1', port: Number(proxyUrl.port) });
    await once(socket, 'connect');
    socket.write(
      `POST /__zapp/screenshot HTTP/1.1\r\nHost: ${proxyUrl.host}\r\nContent-Length: 0\r\n\r\n`,
    );
    const signal = await captureStarted.promise;
    const closed = once(socket, 'close');
    socket.destroy();
    await closed;
    await eventually(() => {
      expect(signal.aborted).toBe(true);
    });
    await wait(20);

    expect(writeHeadAfterClose).not.toHaveBeenCalled();
    expect(endAfterClose).not.toHaveBeenCalled();
  });

  test('returns 503 for an abort-ignoring screenshot capture and stays busy until its late rejection', async () => {
    const firstCapture = deferred<{ contentType: 'image/png'; image: Buffer }>();
    const image = PNG_IMAGE;
    let captureCalls = 0;
    const captureScreenshot: ScreenshotCapture = () => {
      captureCalls += 1;
      if (captureCalls === 1) {
        return firstCapture.promise;
      }

      return Promise.resolve({ contentType: 'image/png' as const, image });
    };
    const proxy = await startProxy({ captureScreenshot, probePorts: [], screenshotTimeoutMs: 25 });

    if (!proxy) {
      return;
    }

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const firstResponse = fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });
      const status = await Promise.race([
        firstResponse.then((response) => response.status),
        wait(150).then(() => 'timed out waiting for screenshot response'),
      ]);

      expect(status).toBe(503);
      const busy = await fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });
      expect(busy.status).toBe(503);
      expect(captureCalls).toBe(1);

      firstCapture.reject(new Error('capture rejected after timeout'));
      await expect(firstResponse).resolves.toHaveProperty('status', 503);
      await wait(20);
      expect(unhandled).not.toHaveBeenCalled();

      const recovered = await fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });
      expect(recovered.status).toBe(200);
      expect(captureCalls).toBe(2);
    } finally {
      process.off('unhandledRejection', unhandled);
      firstCapture.resolve({ contentType: 'image/png', image });
    }
  });

  test('keeps screenshots serialized until an aborted CDP connection settles and closes the late browser', async () => {
    let cdpPort = 0;
    const cdpWebSockets = new WebSocketServer({ noServer: true });
    const cdpServer = createServer((request, response) => {
      if (request.url !== '/json/version/') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${String(cdpPort)}/devtools/browser/fixture`,
        }),
      );
    });
    cdpServer.on('upgrade', (request, socket, head) => {
      cdpWebSockets.handleUpgrade(request, socket, head, (client) => {
        cdpWebSockets.emit('connection', client, request);
      });
    });
    cdpServer.listen(0, '127.0.0.1');
    await once(cdpServer, 'listening');
    cdpPort = (cdpServer.address() as AddressInfo).port;
    cleanups.push(async () => {
      for (const client of cdpWebSockets.clients) {
        client.terminate();
      }
      await closeWebSocketServer(cdpWebSockets);
      await closeServer(cdpServer);
    });
    const connection = deferred<Awaited<ReturnType<typeof chromium.connectOverCDP>>>();
    const connectionStarted = deferred<undefined>();
    const lateClose = vi.fn(() => Promise.resolve());
    const recoveredClose = vi.fn(() => Promise.resolve());
    const lateBrowser = {
      close: lateClose,
      contexts: () => [],
    } as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>;
    const recoveredBrowser = {
      close: recoveredClose,
      contexts: () => [
        {
          pages: () => [{ screenshot: () => Promise.resolve(PNG_IMAGE) }],
        },
      ],
    } as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>;
    const connect = vi
      .spyOn(chromium, 'connectOverCDP')
      .mockImplementationOnce(() => {
        connectionStarted.resolve(undefined);
        return connection.promise;
      })
      .mockResolvedValue(recoveredBrowser);
    const proxy = await startProxy({
      cdpEndpoint: `http://127.0.0.1:${String(cdpPort)}`,
      probePorts: [],
      screenshotTimeoutMs: 5_000,
    });

    if (!proxy) {
      return;
    }

    const controller = new AbortController();
    const aborted = fetch(`${proxy.url}/__zapp/screenshot`, {
      method: 'POST',
      signal: controller.signal,
    });
    await connectionStarted.promise;
    controller.abort();
    await expect(aborted).rejects.toThrow(/abort/iu);
    const busy = await fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });

    expect(busy.status).toBe(503);
    expect(connect).toHaveBeenCalledTimes(1);

    connection.resolve(lateBrowser);
    await eventually(() => {
      expect(lateClose).toHaveBeenCalledTimes(1);
    });
    let recoveredStatus: number | undefined;
    await eventually(async () => {
      const recovered = await fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });
      recoveredStatus = recovered.status;
      expect(recovered.status).toBe(200);
    });

    expect(recoveredStatus).toBe(200);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(recoveredClose).toHaveBeenCalledTimes(1);
  });

  test('cancels a silent CDP handshake socket after screenshot abort and proxy close', async () => {
    const silentCdp = await startSilentTcpOrigin();
    const proxy = await startProxy({
      cdpEndpoint: `http://127.0.0.1:${String(silentCdp.port)}`,
      probePorts: [],
      screenshotTimeoutMs: 25,
    });

    if (!proxy) {
      return;
    }

    const status = await Promise.race([
      fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' }).then(
        (response) => response.status,
      ),
      wait(250).then(() => 'timed out waiting for screenshot response'),
    ]);
    expect(status).toBe(503);
    await proxy.close();

    await eventually(() => {
      expect(silentCdp.sockets).toHaveLength(0);
    });
  });

  test.each(['ws', 'wss'])(
    'forcibly terminates a silent direct %s CDP handshake on abort and close',
    async (protocol) => {
      const silentCdp = await startSilentTcpOrigin();
      const proxy = await startProxy({
        cdpEndpoint: `${protocol}://127.0.0.1:${String(silentCdp.port)}/devtools/browser/silent`,
        probePorts: [],
        screenshotTimeoutMs: 25,
      });

      if (!proxy) {
        return;
      }

      const status = await Promise.race([
        fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' }).then(
          (response) => response.status,
        ),
        wait(250).then(() => 'timed out waiting for screenshot response'),
      ]);
      expect(status).toBe(503);
      await proxy.close();

      await eventually(() => {
        expect(silentCdp.sockets).toHaveLength(0);
      });
    },
  );

  test('settles direct CDP DNS, connect, and close races without leaked sockets or rejections', async () => {
    const unavailablePort = await findUnavailablePort();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      for (const cdpEndpoint of [
        'ws://cdp-does-not-exist.invalid/devtools/browser/missing',
        `ws://127.0.0.1:${String(unavailablePort)}/devtools/browser/refused`,
      ]) {
        const proxy = await startProxy({ cdpEndpoint, probePorts: [], screenshotTimeoutMs: 100 });
        if (!proxy) return;
        const response = await fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });
        expect(response.status).toBe(503);
        await proxy.close();
      }

      const silentCdp = await startSilentTcpOrigin();
      const racingProxy = await startProxy({
        cdpEndpoint: `wss://127.0.0.1:${String(silentCdp.port)}/devtools/browser/race`,
        probePorts: [],
        screenshotTimeoutMs: 5_000,
      });
      if (!racingProxy) return;
      const request = fetch(`${racingProxy.url}/__zapp/screenshot`, { method: 'POST' }).catch(
        () => undefined,
      );
      await eventually(() => {
        expect(silentCdp.sockets.size).toBe(1);
      });
      await racingProxy.close();
      await request;
      await eventually(() => {
        expect(silentCdp.sockets).toHaveLength(0);
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('uses the injected screenshot capture seam when one is available', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const image = PNG_IMAGE;
    const captureScreenshot = vi.fn(() =>
      Promise.resolve({ contentType: 'image/png' as const, image }),
    );
    const proxy = await startProxy({ captureScreenshot, target: origin.url });

    if (!proxy) {
      return;
    }

    const response = await fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
    expect(captureScreenshot).toHaveBeenCalledOnce();
  });

  test.each([
    ['an unsupported image MIME', { contentType: 'image/jpeg', image: PNG_IMAGE }],
    ['an empty PNG', { contentType: 'image/png', image: Buffer.alloc(0) }],
    ['a truncated PNG signature', { contentType: 'image/png', image: PNG_IMAGE.subarray(0, 4) }],
    [
      'bytes that do not match the PNG signature',
      { contentType: 'image/png', image: Buffer.from('not-a-png') },
    ],
  ])('rejects screenshot capture output with %s', async (_caseName, captureResult) => {
    const captureScreenshot = vi.fn(() =>
      Promise.resolve(captureResult),
    ) as unknown as ScreenshotCapture;
    const proxy = await startProxy({ captureScreenshot, probePorts: [] });

    if (!proxy) {
      return;
    }

    const response = await fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });

    expect(response.status).toBe(503);
    expect(captureScreenshot).toHaveBeenCalledOnce();
  });

  test('rejects malformed screenshot capture results instead of sending an invalid successful response', async () => {
    const captureScreenshot = vi.fn(() =>
      Promise.resolve({
        contentType: 'image/png',
        image: 'not a Buffer',
      }),
    ) as unknown as ScreenshotCapture;
    const proxy = await startProxy({ captureScreenshot, probePorts: [] });

    if (!proxy) {
      return;
    }

    const response = await fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });

    expect(response.status).toBe(503);
    expect(captureScreenshot).toHaveBeenCalledOnce();
  });

  test.each([
    ['the exact 10 MiB screenshot boundary', 10 * 1024 * 1024, 200],
    ['one byte over the 10 MiB screenshot boundary', 10 * 1024 * 1024 + 1, 503],
  ])('enforces screenshot output bytes at %s', async (_caseName, imageBytes, expectedStatus) => {
    const image = Buffer.alloc(imageBytes);
    PNG_IMAGE.copy(image, 0, 0, 8);
    const captureScreenshot = vi.fn(() =>
      Promise.resolve({ contentType: 'image/png' as const, image }),
    );
    const proxy = await startProxy({ captureScreenshot, probePorts: [] });

    if (!proxy) {
      return;
    }

    const response = await fetch(`${proxy.url}/__zapp/screenshot`, { method: 'POST' });
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(expectedStatus);
    if (expectedStatus === 200) {
      expect(response.headers.get('content-length')).toBe(String(imageBytes));
      expect(body).toHaveLength(imageBytes);
    } else {
      expect(response.headers.get('content-type')).toBeNull();
      expect(body).toHaveLength(0);
    }
  });

  test('sends heartbeats every configured interval and stops them during shutdown', async () => {
    vi.useFakeTimers();
    const sendHeartbeat = vi.fn(() => Promise.resolve());
    const proxy = await startProxy({
      heartbeat: { intervalMs: 30_000, send: sendHeartbeat },
      probePorts: [],
    });

    if (!proxy) {
      return;
    }

    await vi.advanceTimersByTimeAsync(29_999);
    expect(sendHeartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendHeartbeat).toHaveBeenCalledTimes(2);

    await proxy.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendHeartbeat).toHaveBeenCalledTimes(2);
  });

  test('aborts a hung heartbeat on timeout before starting its bounded retry', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const sendHeartbeat = vi.fn((heartbeatSignal: AbortSignal) => {
      signals.push(heartbeatSignal);
      return new Promise<void>(() => undefined);
    });
    const proxy = await startProxy({
      heartbeat: { intervalMs: 10, send: sendHeartbeat, timeoutMs: 25 },
      probePorts: [],
    });

    if (!proxy) {
      return;
    }

    await vi.advanceTimersByTimeAsync(50);

    expect(sendHeartbeat).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  test('retries an abort-ignoring heartbeat once while bounding unresolved sends and consuming late rejections', async () => {
    vi.useFakeTimers();
    const firstSend = deferred<never>();
    const retrySend = deferred<never>();
    const signals: AbortSignal[] = [];
    const sendHeartbeat = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return sendHeartbeat.mock.calls.length === 1 ? firstSend.promise : retrySend.promise;
    });
    const proxy = await startProxy({
      heartbeat: { intervalMs: 10, send: sendHeartbeat, timeoutMs: 25 },
      probePorts: [],
    });

    if (!proxy) {
      return;
    }

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await vi.advanceTimersByTimeAsync(35);
      expect(sendHeartbeat).toHaveBeenCalledOnce();
      expect(signals[0]?.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(5);
      expect(sendHeartbeat).toHaveBeenCalledTimes(2);
      expect(signals[1]?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      expect(sendHeartbeat).toHaveBeenCalledTimes(2);

      retrySend.reject(new Error('retry rejected after timeout'));
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('aborts an in-flight heartbeat when the proxy closes', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const sendHeartbeat = vi.fn((heartbeatSignal: AbortSignal) => {
      signal = heartbeatSignal;
      return new Promise<void>(() => undefined);
    });
    const proxy = await startProxy({
      heartbeat: { intervalMs: 10, send: sendHeartbeat },
      probePorts: [],
    });

    if (!proxy) {
      return;
    }

    await vi.advanceTimersByTimeAsync(10);
    await proxy.close();

    expect(sendHeartbeat).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
  });

  test('uses an abort signal for production heartbeats and rejects non-success responses without exposing the token', async () => {
    const productionModule = (await import('../src/main.js')) as Record<string, unknown>;
    const createHeartbeatSender = productionModule.createHeartbeatSender as
      | ((url: string, token: string | undefined) => (signal: AbortSignal) => Promise<void>)
      | undefined;
    const fetchMock = vi.fn(() => Promise.resolve(new Response('unavailable', { status: 503 })));
    vi.stubGlobal('fetch', fetchMock);

    expect(createHeartbeatSender).toBeTypeOf('function');

    if (!createHeartbeatSender) {
      return;
    }

    const controller = new AbortController();
    await expect(
      createHeartbeatSender(
        'https://sandbox.example.test/heartbeat',
        'not-for-logs',
      )(controller.signal),
    ).rejects.toThrow('503');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sandbox.example.test/heartbeat',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  test('bounds retained events and removes disconnected SSE writers before accepting a replacement', async () => {
    const proxy = await startProxy({ maxRetainedEvents: 2, maxSseClients: 1, probePorts: [] });

    if (!proxy) {
      return;
    }

    await postBrowserEvent(proxy.url, {
      payload: { level: 'error', message: 'discarded', stack: 'Error: discarded' },
      type: 'console',
    });
    await postBrowserEvent(proxy.url, {
      payload: { level: 'warn', message: 'kept-one', stack: 'Error: kept-one' },
      type: 'console',
    });
    await postBrowserEvent(proxy.url, {
      payload: { level: 'log', message: 'kept-two', stack: 'Error: kept-two' },
      type: 'console',
    });

    const first = await openSse(proxy.url);
    cleanups.push(() => first.close());
    const replayed = [await first.next(), await first.next()];

    expect(replayed.map((event) => (event.payload as { message: string }).message)).toEqual([
      'kept-one',
      'kept-two',
    ]);
    const rejected = await fetch(`${proxy.url}/__zapp/events`);
    expect(rejected.status).toBe(429);

    await first.close();
    await eventually(async () => {
      const replacement = await openSse(proxy.url);
      await replacement.close();
    });
  });

  test('resumes a bounded SSE queue on drain instead of treating backpressure as disconnect', () => {
    const capture = new CaptureStore(2, 1);
    const response = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
    };
    const frames: string[] = [];
    let firstWrite = true;
    let ended = false;
    response.write = vi.fn((frame: string) => {
      if (ended) {
        throw new Error('write after end');
      }
      frames.push(frame);
      if (firstWrite) {
        firstWrite = false;
        return false;
      }
      return true;
    });
    response.end = vi.fn(() => {
      ended = true;
      return response;
    });

    expect(() => capture.open(response as unknown as ServerResponse)).not.toThrow();
    for (const message of ['one', 'two', 'three', 'four']) {
      capture.add({
        payload: { level: 'log', message, stack: '' },
        type: 'console',
      });
    }

    expect(frames).toHaveLength(1);
    expect(ended).toBe(false);
    expect(response.listenerCount('error')).toBe(1);
    expect(response.listenerCount('close')).toBe(1);
    expect(response.listenerCount('drain')).toBe(1);

    response.emit('drain');

    const delivered = frames.map((frame) => {
      const data = frame.match(/^data: (.+)\n\n$/)?.[1];
      if (!data) {
        throw new Error('SSE frame did not contain one data record');
      }
      return (JSON.parse(data) as { payload: { message: string } }).payload.message;
    });
    expect(delivered).toEqual(['one', 'three', 'four']);
    expect(ended).toBe(false);

    capture.add({
      payload: { level: 'log', message: 'five', stack: '' },
      type: 'console',
    });
    expect(frames.at(-1)).toContain('"message":"five"');
  });

  test('requires one strict UUID idempotency key for browser-event POSTs', async () => {
    const proxy = await startProxy({ probePorts: [] });

    if (!proxy) {
      return;
    }

    const event = {
      payload: { level: 'log', message: 'boundary fixture', stack: '' },
      type: 'console',
    };
    const missing = await fetch(`${proxy.url}/__zapp/events`, {
      body: JSON.stringify(event),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const malformed = await fetch(`${proxy.url}/__zapp/events`, {
      body: JSON.stringify(event),
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'not-a-uuid',
      },
      method: 'POST',
    });

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
  });

  test('deduplicates retries by idempotency key while accepting distinct keys', async () => {
    const proxy = await startProxy({ maxRetainedEvents: 4, probePorts: [] });

    if (!proxy) {
      return;
    }

    const firstKey = randomUUID();
    const secondKey = randomUUID();
    const firstEvent = {
      payload: { level: 'log', message: 'first event', stack: '' },
      type: 'console',
    };
    const secondEvent = {
      payload: { level: 'log', message: 'second event', stack: '' },
      type: 'console',
    };
    const post = (key: string, event: Record<string, unknown>) =>
      fetch(`${proxy.url}/__zapp/events`, {
        body: JSON.stringify(event),
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        method: 'POST',
      });

    expect((await post(firstKey, firstEvent)).status).toBe(204);
    expect((await post(firstKey, firstEvent)).status).toBe(204);
    expect((await post(secondKey, secondEvent)).status).toBe(204);

    const events = await openSse(proxy.url);
    cleanups.push(() => events.close());
    const replayed = [await events.next(), await events.next()];

    expect(replayed.map((event) => (event.payload as { message: string }).message)).toEqual([
      'first event',
      'second event',
    ]);
  });

  test('evicts idempotency keys with retained events to keep dedupe memory bounded', async () => {
    const proxy = await startProxy({ maxRetainedEvents: 2, probePorts: [] });

    if (!proxy) {
      return;
    }

    const evictedKey = randomUUID();
    const middleKey = randomUUID();
    const latestKey = randomUUID();
    const post = (key: string, message: string) =>
      fetch(`${proxy.url}/__zapp/events`, {
        body: JSON.stringify({
          payload: { level: 'log', message, stack: '' },
          type: 'console',
        }),
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        method: 'POST',
      });

    expect((await post(evictedKey, 'evicted')).status).toBe(204);
    expect((await post(middleKey, 'middle')).status).toBe(204);
    expect((await post(latestKey, 'latest')).status).toBe(204);
    expect((await post(evictedKey, 'accepted after eviction')).status).toBe(204);

    const events = await openSse(proxy.url);
    cleanups.push(() => events.close());
    const replayed = [await events.next(), await events.next()];

    expect(replayed.map((event) => (event.payload as { message: string }).message)).toEqual([
      'latest',
      'accepted after eviction',
    ]);
  });

  test('reserves every /__zapp path instead of forwarding unknown routes or wrong methods to the origin', async () => {
    const origin = await startOrigin((app) => {
      app.all('/__zapp/*path', (_request, response) =>
        response.status(200).send('origin must never receive this'),
      );
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const unknown = await fetch(`${proxy.url}/__zapp/unrecognised`);
    const healthWrongMethod = await fetch(`${proxy.url}/__zapp/healthz`, { method: 'POST' });
    const eventsWrongMethod = await fetch(`${proxy.url}/__zapp/events`, { method: 'PUT' });

    expect(unknown.status).toBe(404);
    expect(healthWrongMethod.status).toBe(405);
    expect(healthWrongMethod.headers.get('allow')).toBe('GET');
    expect(eventsWrongMethod.status).toBe(405);
    expect(eventsWrongMethod.headers.get('allow')).toBe('GET, POST');
  });

  test('strictly validates query strings, bodies, and content types for owned endpoints', async () => {
    const image = PNG_IMAGE;
    const captureScreenshot = vi.fn(() =>
      Promise.resolve({ contentType: 'image/png' as const, image }),
    );
    const proxy = await startProxy({ captureScreenshot, probePorts: [] });

    if (!proxy) {
      return;
    }

    const healthWithQuery = await fetch(`${proxy.url}/__zapp/healthz?unexpected=1`);
    const clientWithContentType = await fetch(`${proxy.url}/__zapp/client.js`, {
      headers: { 'content-type': 'application/json' },
    });
    const eventsWithQuery = await fetch(`${proxy.url}/__zapp/events?unexpected=1`);
    const eventWithWrongContentType = await fetch(`${proxy.url}/__zapp/events`, {
      body: JSON.stringify({ type: 'console' }),
      headers: {
        'content-type': 'text/plain',
        'idempotency-key': randomUUID(),
      },
      method: 'POST',
    });
    const eventWithEmptyJsonBody = await fetch(`${proxy.url}/__zapp/events`, {
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      method: 'POST',
    });
    const screenshotWithBody = await fetch(`${proxy.url}/__zapp/screenshot`, {
      body: 'not allowed',
      method: 'POST',
    });
    const screenshotWithContentType = await fetch(`${proxy.url}/__zapp/screenshot`, {
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(healthWithQuery.status).toBe(400);
    expect(clientWithContentType.status).toBe(415);
    expect(eventsWithQuery.status).toBe(400);
    expect(eventWithWrongContentType.status).toBe(415);
    expect(eventWithEmptyJsonBody.status).toBe(400);
    expect(screenshotWithBody.status).toBe(400);
    expect(screenshotWithContentType.status).toBe(415);
    expect(captureScreenshot).not.toHaveBeenCalled();
  });

  test('contains an aborted malformed browser-event upload without an unhandled rejection and remains healthy', async () => {
    const proxy = await startProxy({ probePorts: [] });

    if (!proxy) {
      return;
    }

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await abortBrowserEventUpload(proxy);
      await wait(20);

      const health = await fetch(`${proxy.url}/__zapp/healthz`);
      expect(health.status).toBe(200);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('rejects malformed and unknown browser-event fields without retaining them', async () => {
    const proxy = await startProxy({ maxRetainedEvents: 3, probePorts: [] });

    if (!proxy) {
      return;
    }

    const missingStack = await fetch(`${proxy.url}/__zapp/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        payload: { level: 'error', message: 'missing required stack' },
        type: 'console',
      }),
    });
    const unknownField = await fetch(`${proxy.url}/__zapp/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        payload: {
          level: 'error',
          message: 'unknown field must be rejected',
          stack: 'Error: unknown field',
          unexpected: true,
        },
        type: 'console',
      }),
    });

    expect(missingStack.status).toBe(400);
    expect(unknownField.status).toBe(400);

    await postBrowserEvent(proxy.url, {
      payload: { level: 'error', message: 'accepted sentinel', stack: 'Error: accepted sentinel' },
      type: 'console',
    });
    const events = await openSse(proxy.url);
    cleanups.push(() => events.close());

    expect(await events.next()).toMatchObject({
      payload: { message: 'accepted sentinel' },
      type: 'console',
    });
  });

  test('relays history route changes from the served client to SSE', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const events = await openSse(proxy.url);
    cleanups.push(() => events.close());
    const dom = await loadServedClient(proxy);

    dom.window.history.pushState({ view: 'details' }, '', '/projects/zapp?tab=preview');

    const event = await waitForSseEvent(events, (candidate) => candidate.type === 'route_change');

    expect(event).toMatchObject({
      type: 'route_change',
      payload: { url: `${proxy.url}/projects/zapp?tab=preview` },
    });
  });

  test('relays selected element context and screenshot requests only to the configured trusted parent origin', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const trustedOrigin = 'https://builder.zapp.test';
    const proxy = await startProxy({ parentOrigin: trustedOrigin, target: origin.url });

    if (!proxy) {
      return;
    }

    const { messages, parent } = createParentWindow();
    const dom = await loadServedClient(proxy, { parent });
    const button = dom.window.document.createElement('button');
    button.textContent = 'Save changes';
    dom.window.document.body.append(button);

    dispatchParentMessage(dom, parent, trustedOrigin, {
      enabled: true,
      type: 'zapp:selection-mode',
    });
    button.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true }));
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    dispatchParentMessage(dom, parent, trustedOrigin, { type: 'zapp:screenshot-request' });

    expect(messages).toEqual([
      {
        data: {
          payload: expect.objectContaining({
            boundingBox: anyObject(),
            componentHint: anyValue(),
            computedRole: 'button',
            selector: anyString(),
            text: 'Save changes',
          }) as unknown as Record<string, unknown>,
          type: 'zapp:element-selected',
        },
        targetOrigin: trustedOrigin,
      },
      { data: { type: 'zapp:screenshot-requested' }, targetOrigin: trustedOrigin },
    ]);
    expect(messages.map((message) => message.targetOrigin)).not.toContain('*');
  });

  test('fails closed for an embedded attacker parent even when the document has a valid referrer', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const validReferrerOrigin = 'https://builder.zapp.test';
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const { messages, parent: attacker } = createParentWindow();
    const dom = await loadServedClient(proxy, {
      parent: attacker,
      referrer: `${validReferrerOrigin}/projects/preview`,
    });
    const button = dom.window.document.createElement('button');
    button.textContent = 'Do not disclose';
    dom.window.document.body.append(button);

    dispatchParentMessage(dom, attacker, validReferrerOrigin, {
      enabled: true,
      type: 'zapp:selection-mode',
    });
    dispatchParentMessage(dom, attacker, validReferrerOrigin, { type: 'zapp:screenshot-request' });
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(messages).toEqual([]);
  });

  test('fails closed when an embedded client has neither a configured parent origin nor a valid referrer', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const { messages, parent } = createParentWindow();
    const dom = await loadServedClient(proxy, { parent });
    const button = dom.window.document.createElement('button');
    dom.window.document.body.append(button);

    dispatchParentMessage(dom, parent, 'https://builder.zapp.test', {
      enabled: true,
      type: 'zapp:selection-mode',
    });
    dispatchParentMessage(dom, parent, 'https://builder.zapp.test', {
      type: 'zapp:screenshot-request',
    });
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(messages).toEqual([]);
  });

  test('permits same-window standalone controls from its own origin', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const proxy = await startProxy({ target: origin.url });

    if (!proxy) {
      return;
    }

    const dom = await loadServedClient(proxy);
    const received: Record<string, unknown>[] = [];
    dom.window.addEventListener('message', (event) => {
      const data: unknown = event.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        data.type === 'zapp:screenshot-requested'
      ) {
        received.push({ type: data.type });
      }
    });

    dispatchParentMessage(dom, dom.window, dom.window.location.origin, {
      type: 'zapp:screenshot-request',
    });

    await eventually(() => {
      expect(received).toEqual([{ type: 'zapp:screenshot-requested' }]);
    });
  });

  test('uses its served lexical parent origin when a page pre-poisons the legacy global', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const trustedOrigin = 'https://builder.zapp.test';
    const attackerOrigin = 'https://attacker.zapp.test';
    const proxy = await startProxy({ parentOrigin: trustedOrigin, target: origin.url });

    if (!proxy) {
      return;
    }

    const { messages, parent } = createParentWindow();
    const dom = await loadServedClient(proxy, {
      beforeClientEval(clientWindow) {
        Object.defineProperty(clientWindow, '__ZAPP_PARENT_ORIGIN__', {
          configurable: false,
          get: () => attackerOrigin,
        });
      },
      parent,
    });

    dispatchParentMessage(dom, parent, trustedOrigin, { type: 'zapp:screenshot-request' });
    dispatchParentMessage(dom, parent, attackerOrigin, { type: 'zapp:screenshot-request' });

    expect(messages).toEqual([
      { data: { type: 'zapp:screenshot-requested' }, targetOrigin: trustedOrigin },
    ]);
  });

  test('serves the parent origin as a lexical literal without a mutable global assignment', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const trustedOrigin = 'https://builder.zapp.test';
    const proxy = await startProxy({ parentOrigin: trustedOrigin, target: origin.url });

    if (!proxy) {
      return;
    }

    const clientSource = await (await fetch(`${proxy.url}/__zapp/client.js`)).text();

    expect(clientSource).toContain(
      `const configuredParentOrigin = ${JSON.stringify(trustedOrigin)};`,
    );
    expect(clientSource).not.toMatch(/window\.__ZAPP_PARENT_ORIGIN__\s*=/);
  });

  test('ignores selection and screenshot controls from an untrusted parent origin or source', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const trustedOrigin = 'https://builder.zapp.test';
    const proxy = await startProxy({ parentOrigin: trustedOrigin, target: origin.url });

    if (!proxy) {
      return;
    }

    const { messages, parent } = createParentWindow();
    const { parent: attacker } = createParentWindow();
    const dom = await loadServedClient(proxy, { parent });
    const button = dom.window.document.createElement('button');
    button.textContent = 'Do not select';
    dom.window.document.body.append(button);

    dispatchParentMessage(dom, attacker, trustedOrigin, {
      enabled: true,
      type: 'zapp:selection-mode',
    });
    dispatchParentMessage(dom, parent, 'https://attacker.zapp.test', {
      enabled: true,
      type: 'zapp:selection-mode',
    });
    dispatchParentMessage(dom, attacker, trustedOrigin, { type: 'zapp:screenshot-request' });
    dispatchParentMessage(dom, parent, 'https://attacker.zapp.test', {
      type: 'zapp:screenshot-request',
    });
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(messages).toEqual([]);
  });

  test('canonicalizes the production parent origin and rejects malformed configured origins', async () => {
    const productionModule = (await import('../src/main.js')) as Record<string, unknown>;
    const optionsFromEnvironment = productionModule.previewProxyOptionsFromEnvironment as
      (() => PreviewProxyOptions) | undefined;
    vi.stubEnv('ZAPP_PARENT_ORIGIN', 'https://builder.zapp.test:443/');

    expect(optionsFromEnvironment).toBeTypeOf('function');
    if (typeof optionsFromEnvironment !== 'function') {
      throw new Error('preview proxy must expose its production environment configuration');
    }

    expect(optionsFromEnvironment()).toMatchObject({
      parentOrigin: 'https://builder.zapp.test',
    });
    await expect(
      createPreviewProxy({ parentOrigin: 'https://builder.zapp.test/preview', probePorts: [] }),
    ).rejects.toThrow('ZAPP_PARENT_ORIGIN');
  });

  test.each([
    ['unknown key', { unsupportedOption: true }],
    ['non-HTTP CDP endpoint', { cdpEndpoint: 'file:///tmp/cdp.sock' }],
    ['zero retained-event bound', { maxRetainedEvents: 0 }],
    ['fractional probe port', { probePorts: [5_173.5] }],
    ['zero heartbeat interval', { heartbeat: { intervalMs: 0, send: () => Promise.resolve() } }],
  ])('rejects invalid public preview-proxy options: %s', async (_caseName, invalidOptions) => {
    await expectInvalidPreviewProxyOptions(invalidOptions);
  });

  test.each([
    ['PORT', 'not-a-port'],
    ['ZAPP_CDP_ENDPOINT', 'file:///tmp/cdp.sock'],
    ['ZAPP_SANDBOX_HEARTBEAT_URL', 'ws://sandbox.example.test/heartbeat'],
    ['ZAPP_PREVIEW_TARGET', 'ftp://127.0.0.1:3000'],
    ['ZAPP_PREVIEW_PROBE_PORTS', '3000,not-a-port'],
  ])('rejects invalid environment configuration at %s', (name, value) => {
    vi.stubEnv(name, value);

    expect(() => previewProxyOptionsFromEnvironment()).toThrow();
  });

  test('parses configured environment probe ports as bounded numeric ports', () => {
    vi.stubEnv('ZAPP_PREVIEW_PROBE_PORTS', '3000, 5173,4321');

    expect(previewProxyOptionsFromEnvironment()).toMatchObject({
      probePorts: [3000, 5173, 4321],
    });
  });

  test('creates a unique selector for a clicked repeated sibling button', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const trustedOrigin = 'https://builder.zapp.test';
    const proxy = await startProxy({ parentOrigin: trustedOrigin, target: origin.url });

    if (!proxy) {
      return;
    }

    const { messages, parent } = createParentWindow();
    const dom = await loadServedClient(proxy, { parent });
    const container = dom.window.document.createElement('section');
    const first = dom.window.document.createElement('button');
    const clicked = dom.window.document.createElement('button');
    first.textContent = 'Cancel';
    clicked.textContent = 'Save';
    container.append(first, clicked);
    dom.window.document.body.append(container);

    dispatchParentMessage(dom, parent, trustedOrigin, {
      enabled: true,
      type: 'zapp:selection-mode',
    });
    clicked.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    const selector = selectedPayload(messages).selector;
    expect(typeof selector).toBe('string');
    const matches = dom.window.document.querySelectorAll(selector as string);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(clicked);
  });

  test('prefers unique id, data-testid, and aria-label selectors', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const trustedOrigin = 'https://builder.zapp.test';
    const proxy = await startProxy({ parentOrigin: trustedOrigin, target: origin.url });

    if (!proxy) {
      return;
    }

    const { messages, parent } = createParentWindow();
    const dom = await loadServedClient(proxy, { parent });
    const idButton = dom.window.document.createElement('button');
    const testIdButton = dom.window.document.createElement('button');
    const ariaLabelButton = dom.window.document.createElement('button');
    idButton.id = 'save:button';
    testIdButton.setAttribute('data-testid', 'save-test');
    ariaLabelButton.setAttribute('aria-label', 'Save and continue');
    dom.window.document.body.append(idButton, testIdButton, ariaLabelButton);
    const fixtures: Array<[Element, string]> = [
      [idButton, '#save\\:button'],
      [testIdButton, '[data-testid="save-test"]'],
      [ariaLabelButton, '[aria-label="Save and continue"]'],
    ];

    for (const [element, expectedSelector] of fixtures) {
      dispatchParentMessage(dom, parent, trustedOrigin, {
        enabled: true,
        type: 'zapp:selection-mode',
      });
      element.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      );

      const selector = selectedPayload(messages).selector;
      expect(selector).toBe(expectedSelector);
      expect([...dom.window.document.querySelectorAll(selector as string)]).toEqual([element]);
      messages.length = 0;
    }
  });

  test('bounds cyclic sibling and ancestor getters before returning selector fallbacks', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const trustedOrigin = 'https://builder.zapp.test';
    const proxy = await startProxy({ parentOrigin: trustedOrigin, target: origin.url });

    if (!proxy) {
      return;
    }

    const { messages, parent } = createParentWindow();
    const dom = await loadServedClient(proxy, { parent });
    const cyclicSibling = dom.window.document.createElement('button');
    const cyclicAncestor = dom.window.document.createElement('button');
    const matchingContainer = dom.window.document.createElement('section');
    matchingContainer.append(
      dom.window.document.createElement('button'),
      dom.window.document.createElement('button'),
    );
    dom.window.document.body.append(cyclicSibling, cyclicAncestor, matchingContainer);
    let siblingReads = 0;
    Object.defineProperty(cyclicSibling, 'previousElementSibling', {
      configurable: true,
      get() {
        siblingReads += 1;
        if (siblingReads > 32) {
          throw new Error('unbounded sibling traversal');
        }
        return cyclicSibling;
      },
    });
    let ancestorReads = 0;
    Object.defineProperty(cyclicAncestor, 'parentElement', {
      configurable: true,
      get() {
        ancestorReads += 1;
        if (ancestorReads > 32) {
          throw new Error('unbounded ancestor traversal');
        }
        return cyclicAncestor;
      },
    });

    for (const element of [cyclicSibling, cyclicAncestor]) {
      dispatchParentMessage(dom, parent, trustedOrigin, {
        enabled: true,
        type: 'zapp:selection-mode',
      });
      element.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      expect(selectedPayload(messages).selector).toBe('button');
      messages.length = 0;
    }

    expect(siblingReads).toBeLessThanOrEqual(4);
    expect(ancestorReads).toBeLessThanOrEqual(4);
  });

  test('bounds hostile selection strings and sanitizes non-finite geometry before postMessage', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const trustedOrigin = 'https://builder.zapp.test';
    const proxy = await startProxy({ parentOrigin: trustedOrigin, target: origin.url });

    if (!proxy) {
      return;
    }

    const { messages, parent } = createParentWindow();
    const dom = await loadServedClient(proxy, { parent });
    const hostile = dom.window.document.createElement('button');
    hostile.id = `hostile-${'s'.repeat(10_000)}`;
    hostile.setAttribute('data-component', 'c'.repeat(10_000));
    hostile.textContent = 't'.repeat(10_000);
    hostile.getBoundingClientRect = () => ({
      bottom: Number.NaN,
      height: Number.NaN,
      left: Number.NEGATIVE_INFINITY,
      right: Number.POSITIVE_INFINITY,
      toJSON: () => ({}),
      top: Number.NaN,
      width: Number.POSITIVE_INFINITY,
      x: Number.NaN,
      y: Number.NEGATIVE_INFINITY,
    });
    dom.window.document.body.append(hostile);

    dispatchParentMessage(dom, parent, trustedOrigin, {
      enabled: true,
      type: 'zapp:selection-mode',
    });
    hostile.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    const payload = selectedPayload(messages);
    expect((payload.selector as string).length).toBeLessThanOrEqual(2_048);
    expect((payload.componentHint as string).length).toBeLessThanOrEqual(256);
    expect((payload.text as string).length).toBeLessThanOrEqual(4_096);
    expect(payload.computedRole).toBe('button');
    expect(
      Object.values(payload.boundingBox as Record<string, number>).every(Number.isFinite),
    ).toBe(true);
    expect(payload.boundingBox).toEqual({ height: 0, width: 0, x: 0, y: 0 });
  });

  test('restores a pre-existing outline when selection hover and selection mode end', async () => {
    const origin = await startOrigin((app) => {
      app.get('/', (_request, response) => response.send('fixture'));
    });
    const trustedOrigin = 'https://builder.zapp.test';
    const proxy = await startProxy({ parentOrigin: trustedOrigin, target: origin.url });

    if (!proxy) {
      return;
    }

    const { parent } = createParentWindow();
    const dom = await loadServedClient(proxy, { parent });
    const button = dom.window.document.createElement('button');
    button.style.outline = '3px dotted orange';
    dom.window.document.body.append(button);

    dispatchParentMessage(dom, parent, trustedOrigin, {
      enabled: true,
      type: 'zapp:selection-mode',
    });
    button.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true }));
    expect(button.style.outline).toBe('2px solid #7c3aed');
    dispatchParentMessage(dom, parent, trustedOrigin, {
      enabled: false,
      type: 'zapp:selection-mode',
    });
    expect(button.style.outline).toBe('3px dotted orange');

    dispatchParentMessage(dom, parent, trustedOrigin, {
      enabled: true,
      type: 'zapp:selection-mode',
    });
    button.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true }));
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(button.style.outline).toBe('3px dotted orange');
  });
});
