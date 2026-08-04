import { createHash, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { PathViolationError } from '@zapp/workspace-runtime';
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

const MetricsSourceSchema = z.custom<MetricsSource>(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    return typeof (value as { sample?: unknown }).sample === 'function';
  },
);

const BuildOptionsSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    token: z.string().min(1),
    devServerPort: z.number().int().min(1).max(65_535).optional(),
    metricsSource: MetricsSourceSchema.optional(),
  })
  .strict();
export type BuildOptions = z.infer<typeof BuildOptionsSchema>;

const ExecQuerySchema = z.object({ stream: z.literal('1').optional() }).strict();
const EmptyQuerySchema = z.object({}).strict();
const EmptyBodySchema = z.undefined();
const KillParamsSchema = z.object({ pid: z.coerce.number().int().positive() }).strict();
const KillResponseSchema = z.object({ killed: z.boolean() }).strict();
const ErrorResponseSchema = z.object({ error: z.string() }).strict();

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

export interface NdjsonWriter {
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  write(value: string): boolean;
  once(event: 'close' | 'drain' | 'error', listener: (...args: unknown[]) => void): unknown;
  off(event: 'close' | 'drain' | 'error', listener: (...args: unknown[]) => void): unknown;
}

export async function writeNdjsonRecord(writer: NdjsonWriter, record: unknown): Promise<void> {
  const validated = ExecStreamRecordSchema.parse(record);
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
    if (writer.write(`${JSON.stringify(validated)}\n`)) {
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

  const app = fastify({ logger: false, bodyLimit: 16 * 1_024 * 1_024 });
  const expectedDigest = tokenDigest(parsed.token);
  const execManager = new ExecManager(workspaceRoot);

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
    }
  });
  app.addHook('preClose', async () => {
    await execManager.killAll();
  });
  app.setErrorHandler(async (error, _request, reply) => {
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
      return ExecResultSchema.parse(await execManager.run(input));
    }

    const pendingRecords: Array<{
      record: ExecStreamRecord;
      resolve: () => void;
      reject: (error: unknown) => void;
    }> = [];
    let streamReady = false;
    let activePid: number | undefined;
    let resolveStarted: () => void = () => undefined;
    let rejectStarted: (error: unknown) => void = () => undefined;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const completion = execManager.run(input, async (record) => {
      if (record.type === 'started') {
        activePid = record.pid;
        resolveStarted();
      }
      if (streamReady) {
        await writeNdjsonRecord(reply.raw, record);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        pendingRecords.push({ record, resolve, reject });
      });
    });
    void completion.catch(rejectStarted);
    await started;

    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    const onClose = (): void => {
      if (!reply.raw.writableEnded && activePid !== undefined) {
        execManager.kill(activePid);
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
      reply.raw.end();
    } catch (error) {
      for (const pending of pendingRecords.splice(0)) {
        pending.reject(error);
      }
      if (activePid !== undefined) {
        execManager.kill(activePid);
      }
      await completion.catch(() => undefined);
      if (!reply.raw.destroyed) {
        reply.raw.destroy();
      }
    } finally {
      reply.raw.off('close', onClose);
    }
  });

  app.post('/exec/:pid/kill', (request) => {
    EmptyQuerySchema.parse(request.query);
    EmptyBodySchema.parse(request.body);
    const { pid } = KillParamsSchema.parse(request.params);
    return KillResponseSchema.parse({ killed: execManager.kill(pid) });
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
      await getMetrics(execManager.activePids(), parsed.metricsSource),
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
    void app.close().finally(() => {
      process.exit(0);
    });
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
