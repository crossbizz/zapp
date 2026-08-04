import { createHash, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { PathViolationError } from '@zapp/workspace-runtime';
import {
  ExecManager,
  ExecRequestSchema,
  ExecResultSchema,
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
import { HealthResponseSchema, MetricsResponseSchema, getHealth, getMetrics } from './health.js';

const BuildOptionsSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    token: z.string().min(1),
    devServerPort: z.number().int().min(1).max(65_535).optional(),
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

function sendNdjson(reply: FastifyReply, record: unknown): void {
  const validated = ExecStreamRecordSchema.parse(record);
  reply.raw.write(`${JSON.stringify(validated)}\n`);
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
    }
  });
  app.addHook('preClose', async () => {
    await execManager.killAll();
  });
  app.setErrorHandler(async (error, _request, reply) => {
    if (
      error instanceof ZodError ||
      error instanceof PathViolationError ||
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

    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    let activePid: number | undefined;
    const onClose = (): void => {
      if (!reply.raw.writableEnded && activePid !== undefined) {
        execManager.kill(activePid);
      }
    };
    reply.raw.once('close', onClose);
    try {
      await execManager.run(input, (record) => {
        if (record.type === 'started') {
          activePid = record.pid;
        }
        sendNdjson(reply, record);
      });
      reply.raw.end();
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
    const query = ListQuerySchema.parse(request.query);
    return FileListSchema.parse(await listWorkspaceFiles(workspaceRoot, query));
  });

  app.get('/files', async (request, reply) => {
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
    return HealthResponseSchema.parse(await getHealth(parsed.devServerPort));
  });

  app.get('/metrics', (request) => {
    EmptyQuerySchema.parse(request.query);
    return MetricsResponseSchema.parse(getMetrics());
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
