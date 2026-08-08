import { createHash, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { CleanupFailureResponseSchema } from '@zapp/contracts';
import { PathViolationError } from '@zapp/workspace-runtime';
import {
  ContainmentCleanupError,
  ContainmentUnavailableError,
  type Containment,
} from './containment/types.js';
import {
  ExecManager,
  ExecPreflightError,
  ExecRequestSchema,
  ExecResultSchema,
  type ExecStreamRecord,
  ExecStreamRecordSchema,
} from './exec.js';
import {
  BinaryBodySchema,
  FileListSchema,
  FileQuerySchema,
  ListQuerySchema,
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
} from './fs.js';
import { GitRequestSchema, GitResultSchema, runGit } from './git.js';
import {
  HealthResponseSchema,
  MetricsResponseSchema,
  getHealth,
  getMetrics,
  type MetricsSource,
} from './health.js';

const MetricsSourceSchema = z.custom<MetricsSource>((value) => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as { sample?: unknown }).sample === 'function';
});
const ContainmentSchema = z.custom<Containment>((value) => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as { create?: unknown }).create === 'function';
});

const BuildOptionsSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    token: z.string().min(1),
    devServerPort: z.number().int().min(1).max(65_535).optional(),
    metricsSource: MetricsSourceSchema.optional(),
    containment: ContainmentSchema.optional(),
  })
  .strict();
export type BuildOptions = z.infer<typeof BuildOptionsSchema>;

const CleanupIdSchema = z.string().uuid();
const ExecQuerySchema = z
  .object({ stream: z.literal('1').optional(), cleanupId: CleanupIdSchema.optional() })
  .strict();
const EmptyQuerySchema = z.object({}).strict();
const EmptyBodySchema = z.undefined();
const KillParamsSchema = z.object({ pid: z.coerce.number().int().positive() }).strict();
const KillBodySchema = z.object({ executionId: z.string().uuid() }).strict();
const KillResponseSchema = z.object({ killed: z.boolean() }).strict();
const CleanupParamsSchema = z.object({ cleanupId: CleanupIdSchema }).strict();
const CleanupResponseSchema = z.object({ cleaned: z.literal(true) }).strict();
const ErrorResponseSchema = z.object({ error: z.string() }).strict();
const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const IDEMPOTENCY_REQUIRED_ROUTES = new Set([
  'POST /exec',
  'POST /exec/:pid/kill',
  'PUT /files',
  'POST /git',
]);
const MAX_IDEMPOTENCY_ENTRIES = 256;
const MAX_IDEMPOTENCY_ENTRY_BYTES = 64 * 1_024;
const MAX_IDEMPOTENCY_TOTAL_BYTES = 256 * 1_024;

interface CachedResponse {
  readonly statusCode: number;
  readonly contentType?: string;
  readonly body?: string | Buffer;
}

interface IdempotencyEntry {
  readonly fingerprint: string;
  completion?: Promise<CachedResponse>;
  resolve?: (response: CachedResponse) => void;
  reject?: (error: Error) => void;
  cachedResponse?: CachedResponse;
  complete: boolean;
  retained: boolean;
  responseBytes: number;
}

const RESPONSE_NOT_RETAINED: CachedResponse = {
  statusCode: 409,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify({ error: 'idempotency_response_not_retained' }),
};

function cachedResponseBytes(response: CachedResponse): number {
  const bodyBytes =
    typeof response.body === 'string'
      ? Buffer.byteLength(response.body)
      : (response.body?.byteLength ?? 0);
  return 8 + Buffer.byteLength(response.contentType ?? '') + bodyBytes;
}

function copyCachedResponse(response: CachedResponse): CachedResponse {
  return {
    ...response,
    ...(Buffer.isBuffer(response.body) ? { body: Buffer.from(response.body) } : {}),
  };
}

type IdempotencyStart =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'full' }
  | { readonly kind: 'owner'; readonly entry: IdempotencyEntry }
  | { readonly kind: 'replay'; readonly completion: Promise<CachedResponse> };

/**
 * Replay state is deliberately process-lifetime only. The fixed-size map prevents
 * an agent from accumulating keys without bound; sandbox-service callers retain
 * responsibility for retrying with the same standard Idempotency-Key after reconnect.
 */
class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private totalResponseBytes = 0;

  private deleteEntry(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return;
    }
    this.totalResponseBytes -= entry.responseBytes;
    this.entries.delete(key);
  }

  private evictCompleted(excluded?: IdempotencyEntry): boolean {
    const completed = [...this.entries].find(
      ([, entry]) => entry !== excluded && entry.complete && !entry.retained,
    );
    if (completed === undefined) {
      return false;
    }
    this.deleteEntry(completed[0]);
    return true;
  }

  private tombstoneCompleted(excluded: IdempotencyEntry): boolean {
    const completed = [...this.entries.values()].find(
      (entry) => entry !== excluded && entry.complete && !entry.retained,
    );
    if (completed === undefined) {
      return false;
    }
    const tombstone = copyCachedResponse(RESPONSE_NOT_RETAINED);
    const responseBytes = cachedResponseBytes(tombstone);
    this.totalResponseBytes += responseBytes - completed.responseBytes;
    completed.cachedResponse = tombstone;
    completed.responseBytes = responseBytes;
    completed.retained = true;
    return true;
  }

  start(key: string, fingerprint: string): IdempotencyStart {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return { kind: 'conflict' };
      }
      if (existing.complete) {
        this.entries.delete(key);
        this.entries.set(key, existing);
        if (existing.cachedResponse === undefined) {
          throw new Error('Completed idempotency entry has no response');
        }
        return {
          kind: 'replay',
          completion: Promise.resolve(copyCachedResponse(existing.cachedResponse)),
        };
      }
      if (existing.completion === undefined) {
        throw new Error('Pending idempotency entry has no completion');
      }
      return { kind: 'replay', completion: existing.completion };
    }

    if (this.entries.size >= MAX_IDEMPOTENCY_ENTRIES) {
      if (!this.evictCompleted()) {
        return { kind: 'full' };
      }
    }

    let resolveCompletion: (response: CachedResponse) => void = () => undefined;
    let rejectCompletion: (error: Error) => void = () => undefined;
    const completion = new Promise<CachedResponse>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);
    const entry: IdempotencyEntry = {
      fingerprint,
      completion,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      complete: false,
      retained: false,
      responseBytes: 0,
    };
    this.entries.set(key, entry);
    return { kind: 'owner', entry };
  }

  complete(entry: IdempotencyEntry, response: CachedResponse, retained = false): void {
    if (entry.complete) {
      return;
    }
    const responseFits = cachedResponseBytes(response) <= MAX_IDEMPOTENCY_ENTRY_BYTES;
    let cached = responseFits ? response : RESPONSE_NOT_RETAINED;
    let mustRetain = retained || !responseFits;
    let responseBytes = cachedResponseBytes(cached);
    while (this.totalResponseBytes + responseBytes > MAX_IDEMPOTENCY_TOTAL_BYTES) {
      if (this.tombstoneCompleted(entry)) {
        continue;
      }
      cached = RESPONSE_NOT_RETAINED;
      mustRetain = true;
      responseBytes = cachedResponseBytes(cached);
      break;
    }
    entry.complete = true;
    entry.retained = mustRetain;
    entry.responseBytes = responseBytes;
    entry.cachedResponse = copyCachedResponse(cached);
    this.totalResponseBytes += responseBytes;
    entry.resolve?.(copyCachedResponse(cached));
    delete entry.completion;
    delete entry.resolve;
    delete entry.reject;
  }

  fail(key: string, entry: IdempotencyEntry, error: unknown): void {
    if (this.entries.get(key) !== entry) {
      return;
    }
    this.deleteEntry(key);
    entry.reject?.(error instanceof Error ? error : new Error('Idempotent operation failed'));
  }
}

function canonicalize(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { binary: value.toString('base64') };
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function idempotencyFingerprint(request: FastifyRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        method: request.method,
        url: request.url,
        body: canonicalize(request.body),
      }),
    )
    .digest('hex');
}

function cachedPayload(payload: unknown): string | Buffer | undefined {
  if (payload === undefined || payload === null) {
    return undefined;
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return Buffer.from(payload);
  }
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload);
  }
  throw new Error('Unsupported idempotent response payload');
}

async function sendCachedResponse(reply: FastifyReply, response: CachedResponse): Promise<void> {
  reply.code(response.statusCode);
  if (response.contentType !== undefined) {
    reply.header('content-type', response.contentType);
  }
  await reply.send(Buffer.isBuffer(response.body) ? Buffer.from(response.body) : response.body);
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function hasValidToken(header: string | string[] | undefined, expectedDigest: Buffer): boolean {
  const value = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  return timingSafeEqual(tokenDigest(value), expectedDigest);
}

function hasHttpBody(headers: Record<string, string | string[] | undefined>): boolean {
  const contentLength = headers['content-length'];
  return (
    headers['transfer-encoding'] !== undefined ||
    (contentLength !== undefined && contentLength !== '0')
  );
}

function requiresIdempotencyKey(request: FastifyRequest): boolean {
  const routeUrl = request.routeOptions.url;
  return routeUrl !== undefined && IDEMPOTENCY_REQUIRED_ROUTES.has(`${request.method} ${routeUrl}`);
}

export interface NdjsonWriter {
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  write(value: string): boolean;
  once(event: 'close' | 'drain' | 'error', listener: (...args: unknown[]) => void): unknown;
  off(event: 'close' | 'drain' | 'error', listener: (...args: unknown[]) => void): unknown;
}

type ActiveStreamWriter = NdjsonWriter & { destroy: () => unknown };

function serializeNdjsonRecord(record: unknown): string {
  return `${JSON.stringify(ExecStreamRecordSchema.parse(record))}\n`;
}

export async function writeNdjsonRecord(writer: NdjsonWriter, record: unknown): Promise<void> {
  if (writer.destroyed === true || writer.writableEnded === true) {
    throw new Error('Streaming client closed');
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      writer.off('drain', onDrain);
      writer.off('close', onClose);
      writer.off('error', onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('Streaming client closed'));
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('Streaming client failed'));
    };
    writer.once('drain', onDrain);
    writer.once('close', onClose);
    writer.once('error', onError);
    if (writer.write(serializeNdjsonRecord(record))) {
      cleanup();
      resolve();
    }
  });
}

export async function buildWorkspaceAgent(options: BuildOptions): Promise<FastifyInstance> {
  const parsed = BuildOptionsSchema.parse(options);
  const workspaceRoot = await realpath(parsed.workspaceRoot);
  const workspaceStat = await stat(workspaceRoot);
  if (!workspaceStat.isDirectory()) {
    throw new Error('Workspace root must be a directory');
  }

  const app = fastify({
    logger: false,
    bodyLimit: 16 * 1_024 * 1_024,
    forceCloseConnections: true,
  });
  const expectedDigest = tokenDigest(parsed.token);
  const execManager = new ExecManager(workspaceRoot, parsed.containment);
  const idempotency = new IdempotencyStore();
  const activeStreamWriters = new Set<ActiveStreamWriter>();
  const idempotencyKeys = new WeakMap<FastifyRequest, string>();
  const idempotencyOwners = new WeakMap<FastifyRequest, { key: string; entry: IdempotencyEntry }>();

  const completeIdempotency = (
    request: FastifyRequest,
    response: CachedResponse,
    retained = false,
  ): void => {
    const owner = idempotencyOwners.get(request);
    if (owner !== undefined) {
      idempotency.complete(owner.entry, response, retained);
    }
  };

  const failIdempotency = (request: FastifyRequest, error: unknown): void => {
    const owner = idempotencyOwners.get(request);
    if (owner !== undefined) {
      idempotency.fail(owner.key, owner.entry, error);
    }
  };

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.addHook('onRequest', async (request, reply) => {
    if (!hasValidToken(request.headers.authorization, expectedDigest)) {
      await reply.code(401).send(ErrorResponseSchema.parse({ error: 'unauthorized' }));
      return;
    }
    if (request.method === 'GET' && hasHttpBody(request.headers)) {
      await reply.code(400).send(ErrorResponseSchema.parse({ error: 'bad_request' }));
      return;
    }
    if (requiresIdempotencyKey(request)) {
      const header = request.headers['idempotency-key'];
      const key = IdempotencyKeySchema.parse(typeof header === 'string' ? header : undefined);
      idempotencyKeys.set(request, key);
    }
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!requiresIdempotencyKey(request)) {
      return;
    }
    const key = idempotencyKeys.get(request);
    if (key === undefined) {
      throw new Error('Idempotency key was not validated');
    }
    const started = idempotency.start(key, idempotencyFingerprint(request));
    if (started.kind === 'conflict') {
      await reply.code(409).send(ErrorResponseSchema.parse({ error: 'idempotency_conflict' }));
      return;
    }
    if (started.kind === 'full') {
      await reply.code(503).send(ErrorResponseSchema.parse({ error: 'idempotency_capacity' }));
      return;
    }
    if (started.kind === 'replay') {
      await sendCachedResponse(reply, await started.completion);
      return;
    }
    idempotencyOwners.set(request, { key, entry: started.entry });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const contentType = reply.getHeader('content-type');
    const body = cachedPayload(payload);
    completeIdempotency(request, {
      statusCode: reply.statusCode,
      ...(contentType === undefined ? {} : { contentType: String(contentType) }),
      ...(body === undefined ? {} : { body }),
    });
    return payload;
  });
  app.addHook('preClose', async () => {
    for (const writer of activeStreamWriters) {
      if (writer.destroyed !== true) {
        writer.destroy();
      }
    }
    await execManager.killAll();
  });
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ContainmentCleanupError) {
      await reply
        .code(503)
        .send(
          CleanupFailureResponseSchema.parse({
            error: 'containment_cleanup_failed',
            stage: error.stage,
          }),
        );
      return;
    }
    if (error instanceof ContainmentUnavailableError) {
      await reply.code(503).send(ErrorResponseSchema.parse({ error: 'containment_unavailable' }));
      return;
    }
    if (
      error instanceof ZodError ||
      error instanceof PathViolationError ||
      error instanceof ExecPreflightError ||
      (error instanceof Error && error.message.startsWith('Unsafe git'))
    ) {
      await reply.code(400).send(ErrorResponseSchema.parse({ error: 'bad_request' }));
      return;
    }
    await reply.code(500).send(ErrorResponseSchema.parse({ error: 'internal_error' }));
  });

  app.post('/exec', async (request, reply) => {
    const query = ExecQuerySchema.parse(request.query);
    const input = ExecRequestSchema.parse(request.body);
    if (query.stream !== '1') {
      return ExecResultSchema.parse(await execManager.run(input, undefined, query.cleanupId));
    }

    const pendingRecords: Array<{
      record: ExecStreamRecord;
      resolve: () => void;
      reject: (error: unknown) => void;
    }> = [];
    const streamBody: string[] = [];
    let streamReady = false;
    let activePid: number | undefined;
    let activeExecutionId: string | undefined;
    let resolveStarted: () => void = () => undefined;
    let rejectStarted: (error: unknown) => void = () => undefined;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const completion = execManager.run(
      input,
      async (record) => {
        streamBody.push(serializeNdjsonRecord(record));
        if (record.type === 'started') {
          activePid = record.pid;
          activeExecutionId = record.executionId;
          resolveStarted();
        }
        if (streamReady) {
          await writeNdjsonRecord(reply.raw, record);
          return;
        }
        await new Promise<void>((resolve, reject) => {
          pendingRecords.push({ record, resolve, reject });
        });
      },
      query.cleanupId,
    );
    void completion.catch(rejectStarted);
    await started;

    reply.hijack();
    activeStreamWriters.add(reply.raw);
    reply.raw.statusCode = 200;
    reply.raw.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    const onClose = (): void => {
      if (
        !reply.raw.writableEnded &&
        activePid !== undefined &&
        activeExecutionId !== undefined
      ) {
        execManager.kill(activePid, activeExecutionId);
      }
    };
    reply.raw.once('close', onClose);
    try {
      while (pendingRecords.length > 0) {
        const pending = pendingRecords.shift();
        if (pending !== undefined) {
          try {
            await writeNdjsonRecord(reply.raw, pending.record);
            pending.resolve();
          } catch (error) {
            pending.reject(error);
            throw error;
          }
        }
      }
      streamReady = true;
      await completion;
      completeIdempotency(request, {
        statusCode: 200,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: streamBody.join(''),
      });
      reply.raw.end();
    } catch (error) {
      if (activePid === undefined) {
        failIdempotency(request, error);
      } else {
        completeIdempotency(
          request,
          {
            statusCode: 409,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify(ErrorResponseSchema.parse({ error: 'idempotency_ambiguous' })),
          },
          true,
        );
      }
      for (const pending of pendingRecords.splice(0)) {
        pending.reject(error);
      }
      if (activePid !== undefined && activeExecutionId !== undefined) {
        execManager.kill(activePid, activeExecutionId);
      }
      await completion.catch(() => undefined);
      if (!reply.raw.destroyed) {
        reply.raw.destroy();
      }
    } finally {
      reply.raw.off('close', onClose);
      activeStreamWriters.delete(reply.raw);
    }
  });

  app.post('/exec/:pid/kill', (request) => {
    EmptyQuerySchema.parse(request.query);
    const { pid } = KillParamsSchema.parse(request.params);
    const { executionId } = KillBodySchema.parse(request.body);
    return KillResponseSchema.parse({ killed: execManager.kill(pid, executionId) });
  });

  app.get('/exec/cleanup/:cleanupId', async (request, reply) => {
    EmptyQuerySchema.parse(request.query);
    EmptyBodySchema.parse(request.body);
    const { cleanupId } = CleanupParamsSchema.parse(request.params);
    if (!(await execManager.acknowledgeCleanup(cleanupId))) {
      await reply.code(404).send(ErrorResponseSchema.parse({ error: 'cleanup_not_found' }));
      return;
    }
    return CleanupResponseSchema.parse({ cleaned: true });
  });

  app.get('/files/list', async (request) => {
    EmptyBodySchema.parse(request.body);
    const query = ListQuerySchema.parse(request.query);
    return FileListSchema.parse(await listWorkspaceFiles(workspaceRoot, query));
  });

  app.get('/files', async (request, reply) => {
    EmptyBodySchema.parse(request.body);
    const { path } = FileQuerySchema.parse(request.query);
    const body = BinaryBodySchema.parse(await readWorkspaceFile(workspaceRoot, path));
    return reply.type('application/octet-stream').send(body);
  });

  app.put('/files', async (request, reply) => {
    const { path } = FileQuerySchema.parse(request.query);
    const body = BinaryBodySchema.parse(request.body);
    await writeWorkspaceFile(workspaceRoot, path, body);
    return reply.code(204).send();
  });

  app.post('/git', async (request) => {
    EmptyQuerySchema.parse(request.query);
    const gitRequest = GitRequestSchema.parse(request.body);
    return GitResultSchema.parse(await runGit(workspaceRoot, gitRequest, execManager));
  });

  app.get('/healthz', async (request) => {
    EmptyQuerySchema.parse(request.query);
    EmptyBodySchema.parse(request.body);
    return HealthResponseSchema.parse(await getHealth(parsed.devServerPort));
  });

  app.get('/metrics', async (request) => {
    EmptyQuerySchema.parse(request.query);
    EmptyBodySchema.parse(request.body);
    return MetricsResponseSchema.parse(
      await getMetrics(execManager.activeProcessGroups(), parsed.metricsSource),
    );
  });

  await app.ready();
  return app;
}

const EnvironmentSchema = z.object({
  ZAPP_AGENT_TOKEN: z.string().min(1),
  ZAPP_WORKSPACE_ROOT: z.string().min(1),
  ZAPP_DEV_SERVER_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
});

export async function closeWorkspaceAgentForSignal(
  app: { close: () => Promise<unknown> },
  exit: (code: 0 | 1) => void = (code) => process.exit(code),
  diagnostic: (message: string) => void = (message) => {
    process.stderr.write(message);
  },
): Promise<void> {
  try {
    await app.close();
    exit(0);
  } catch {
    diagnostic('workspace-agent failed to shut down\n');
    exit(1);
  }
}

async function startFromEnvironment(): Promise<void> {
  const environment = EnvironmentSchema.parse(process.env);
  const app = await buildWorkspaceAgent({
    workspaceRoot: environment.ZAPP_WORKSPACE_ROOT,
    token: environment.ZAPP_AGENT_TOKEN,
    ...(environment.ZAPP_DEV_SERVER_PORT === undefined
      ? {}
      : { devServerPort: environment.ZAPP_DEV_SERVER_PORT }),
  });
  const shutdown = (): void => {
    void closeWorkspaceAgentForSignal(app);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ host: '0.0.0.0', port: 8877 });
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(entryPath).href === import.meta.url) {
  void startFromEnvironment().catch(() => {
    process.stderr.write('workspace-agent failed to start\n');
    process.exitCode = 1;
  });
}
