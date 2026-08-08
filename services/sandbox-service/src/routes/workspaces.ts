import {
  CreateWorkspaceInputSchema,
  ExecutionContractSchema,
  ExecInputSchema,
  EnvVarsSchema,
  NetworkProfileSchema,
  ResourceProfileSchema,
  WorkspacePurposeSchema,
  WorkspaceHandleSchema,
  WorkspaceStatusSchema,
  idSchema,
  type CreateWorkspaceInput,
  type ExecutionContract,
  type ExecInput,
  type WorkspaceHandle,
  type WorkspacePurpose,
  type WorkspaceStatus,
} from '@zapp/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { SandboxServiceApp } from '../app.js';

const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);

export const WorkspaceLifecycleRowSchema = z
  .object({
    id: idSchema('ws'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    branchId: idSchema('br').nullable(),
    provider: z.literal('modal'),
    providerWorkspaceId: z.string().min(1).nullable(),
    status: WorkspaceStatusSchema,
    resourceProfile: ResourceProfileSchema,
    snapshotRef: z.string().nullable(),
    createdAt: z.coerce.date(),
    lastActiveAt: z.coerce.date().nullable(),
    terminatedAt: z.coerce.date().nullable(),
  })
  .strict();
export type WorkspaceLifecycleRow = z.infer<typeof WorkspaceLifecycleRowSchema>;

const RequestedWorkspaceRowSchema = WorkspaceLifecycleRowSchema.extend({
  branchId: idSchema('br'),
  providerWorkspaceId: z.null(),
  status: z.literal('requested'),
  snapshotRef: z.null(),
  lastActiveAt: z.null(),
  terminatedAt: z.null(),
}).strict();

export const WorkspaceRowIdempotencyKeySchema = z
  .object({
    runId: idSchema('run'),
    taskId: idSchema('task'),
    purpose: WorkspacePurposeSchema,
  })
  .strict();
export type WorkspaceRowIdempotencyKey = z.infer<typeof WorkspaceRowIdempotencyKeySchema>;

export interface WorkspaceRowClaim {
  readonly created: boolean;
  /** On a replay, the boundary waits until the original row has a provider identity. */
  readonly row: WorkspaceLifecycleRow;
}

/** Durable row operations are injected so CP-9's tenant repository remains the row owner. */
export interface WorkspaceRowBoundary {
  claimCreate(
    row: WorkspaceLifecycleRow,
    key: WorkspaceRowIdempotencyKey,
  ): Promise<WorkspaceRowClaim>;
  get(workspaceId: string, organizationId?: string): Promise<WorkspaceLifecycleRow | undefined>;
  transition(
    workspaceId: string,
    status: WorkspaceStatus,
    patch?: { readonly providerWorkspaceId?: string; readonly terminatedAt?: Date },
  ): Promise<WorkspaceLifecycleRow>;
}

export interface WorkspaceLifecycleProvider {
  readonly lockedImageTag: string;
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceHandle>;
  terminateWorkspace(providerWorkspaceId: string): Promise<void>;
  getStatus(providerWorkspaceId: string): Promise<WorkspaceStatus>;
}

export interface WorkspaceAgentProvider extends WorkspaceLifecycleProvider {
  exec(input: ExecInput, idempotencyKey?: string): Promise<z.infer<typeof ExecResultSchema>>;
  execStream(
    input: ExecInput,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): AsyncIterable<z.infer<typeof ExecStreamRecordSchema>>;
  killExec(providerWorkspaceId: string, pid: number, executionId: string, idempotencyKey?: string): Promise<z.infer<typeof KillResponseSchema>>;
  readFile(providerWorkspaceId: string, path: string): Promise<Uint8Array>;
  writeFile(providerWorkspaceId: string, path: string, data: Uint8Array, idempotencyKey?: string): Promise<void>;
  listFiles(providerWorkspaceId: string, path: string, options?: { glob?: string; maxDepth?: number }): Promise<z.infer<typeof FileListResponseSchema>>;
  git(providerWorkspaceId: string, input: unknown, idempotencyKey?: string): Promise<z.infer<typeof GitResponseSchema>>;
  health(providerWorkspaceId: string): Promise<z.infer<typeof HealthResponseSchema>>;
  metrics(providerWorkspaceId: string): Promise<z.infer<typeof MetricsResponseSchema>>;
  readFileForUpdate(providerWorkspaceId: string, path: string): Promise<unknown>;
  writeFilesAtomically(
    providerWorkspaceId: string,
    files: readonly { path: string; data: Uint8Array; expectedRevision?: string }[],
    idempotencyKey?: string,
  ): Promise<void>;
  search(providerWorkspaceId: string, input: unknown): Promise<z.infer<typeof ExecResultSchema>>;
  deleteFile(providerWorkspaceId: string, path: string, idempotencyKey?: string): Promise<{ alreadyAbsent: boolean }>;
  renameFile(providerWorkspaceId: string, input: unknown, idempotencyKey?: string): Promise<void>;
  startDevServer(providerWorkspaceId: string, contract: ExecutionContract, idempotencyKey?: string): Promise<z.infer<typeof DevServerResponseSchema>>;
  restartDevServer(providerWorkspaceId: string, contract: ExecutionContract, idempotencyKey?: string): Promise<z.infer<typeof DevServerResponseSchema>>;
}

const CreateWorkspaceBodySchema = z
  .object({
    workspace: RequestedWorkspaceRowSchema,
    runId: idSchema('run'),
    taskId: idSchema('task'),
    purpose: WorkspacePurposeSchema,
    env: EnvVarsSchema,
    networkProfile: NetworkProfileSchema,
    operationKey: OperationKeySchema,
  })
  .strict();
const WorkspaceParamsSchema = z.object({ workspaceId: idSchema('ws') }).strict();
const TerminateBodySchema = z.object({ operationKey: OperationKeySchema }).strict();
const WorkspaceResponseSchema = z.object({ workspace: WorkspaceLifecycleRowSchema }).strict();
const StatusResponseSchema = z
  .object({ workspace: WorkspaceLifecycleRowSchema, providerStatus: WorkspaceStatusSchema })
  .strict();
const ExecBodySchema = ExecInputSchema.omit({ providerWorkspaceId: true }).strict();
const ExecQuerySchema = z.object({ stream: z.literal('1').optional() }).strict();
const ExecParamsSchema = WorkspaceParamsSchema.extend({ pid: z.coerce.number().int().positive() }).strict();
const KillBodySchema = z.object({ executionId: z.string().uuid() }).strict();
const FileQuerySchema = z.object({ path: z.string().min(1) }).strict();
const ListQuerySchema = z
  .object({
    path: z.string().min(1).default('.'),
    glob: z.string().min(1).optional(),
    maxDepth: z.coerce.number().int().min(0).max(100).optional(),
  })
  .strict();
const GitBodySchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.enum(['status', 'diff', 'log', 'show', 'push', 'checkout', 'branch', 'restore']),
      args: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({ operation: z.literal('add_commit'), paths: z.array(z.string()).min(1), message: z.string().min(1) })
    .strict(),
]);
const AtomicWriteBodySchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            dataBase64: z.string().refine(
              (value) => Buffer.from(value, 'base64').toString('base64') === value,
              'Expected canonical base64',
            ),
            expectedRevision: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const SearchBodySchema = z
  .object({
    pattern: z.string(),
    path: z.string().min(1),
    glob: z.string().min(1).optional(),
    fixedStrings: z.boolean().optional(),
    ignoreCase: z.boolean().optional(),
  })
  .strict();
const RenameBodySchema = z
  .object({ source: z.string().min(1), destination: z.string().min(1), overwrite: z.literal('replace') })
  .strict();
const DevServerBodySchema = z.object({ contract: ExecutionContractSchema }).strict();
const ExecResultSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
const ExecStreamRecordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), pid: z.number().int().positive(), executionId: z.string().uuid(), at: z.string().datetime() }).strict(),
  z.object({ type: z.enum(['stdout', 'stderr']), data: z.string(), at: z.string().datetime() }).strict(),
  z.object({ type: z.literal('exit'), exitCode: z.number().int(), durationMs: z.number().nonnegative(), truncated: z.boolean(), at: z.string().datetime() }).strict(),
]);
const KillResponseSchema = z.object({ killed: z.boolean() }).strict();
const FileListResponseSchema = z.array(
  z.object({ path: z.string(), type: z.enum(['file', 'directory', 'symlink']) }).strict(),
);
const GitResponseSchema = z
  .object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() })
  .strict();
const HealthResponseSchema = z
  .object({
    ok: z.boolean(),
    details: z.string(),
    devServer: z
      .object({
        port: z.number().int().min(1).max(65_535),
        pid: z.number().int().positive(),
        supervisorId: z.string().min(1),
        owned: z.boolean(),
        httpReady: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const MetricsResponseSchema = z
  .object({
    at: z.string().datetime(),
    activeChildren: z.number().int().nonnegative(),
    cpu: z.object({ userMicros: z.number().nonnegative(), systemMicros: z.number().nonnegative() }).strict(),
    memory: z
      .object({
        rssBytes: z.number().nonnegative(),
        heapTotalBytes: z.number().nonnegative(),
        heapUsedBytes: z.number().nonnegative(),
        externalBytes: z.number().nonnegative(),
        arrayBuffersBytes: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();
const OkResponseSchema = z.object({ ok: z.literal(true) }).strict();
const DeleteResponseSchema = z
  .object({ ok: z.literal(true), alreadyAbsent: z.boolean() })
  .strict();
const DevServerResponseSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    pid: z.number().int().positive(),
    supervisorId: z.string().min(1),
    ownership: z.enum(['process', 'process_group']),
  })
  .strict();

function requireIdempotencyKey(header: string | string[] | undefined, operationKey: string): void {
  if (typeof header !== 'string' || !OperationKeySchema.safeParse(header).success) {
    throw Object.assign(new Error('A valid idempotency key is required.'), { statusCode: 400 });
  }
  if (header !== operationKey) {
    throw Object.assign(new Error('Idempotency key does not match the request.'), {
      statusCode: 400,
    });
  }
}

function readIdempotencyKey(header: string | string[] | undefined): string {
  const parsed = OperationKeySchema.safeParse(typeof header === 'string' ? header : undefined);
  if (!parsed.success) {
    throw Object.assign(new Error('A valid idempotency key is required.'), { statusCode: 400 });
  }
  return parsed.data;
}

function createInputFor(
  row: WorkspaceLifecycleRow,
  body: z.infer<typeof CreateWorkspaceBodySchema>,
  lockedImageTag: string,
): CreateWorkspaceInput {
  return CreateWorkspaceInputSchema.parse({
    organizationId: row.organizationId,
    projectId: row.projectId,
    branchId: RequestedWorkspaceRowSchema.parse(row).branchId,
    runId: body.runId,
    taskId: body.taskId,
    purpose: body.purpose,
    resourceProfile: row.resourceProfile,
    imageTag: lockedImageTag,
    env: body.env,
    networkProfile: body.networkProfile,
  });
}

export function registerWorkspaceRoutes(
  app: SandboxServiceApp,
  deps: {
    readonly provider: WorkspaceAgentProvider;
    readonly rows: WorkspaceRowBoundary;
    readonly now: () => Date;
  },
): void {
  const resolveProviderWorkspaceId = async (
    workspaceId: string,
    request: FastifyRequest,
  ): Promise<string> => {
    const organizationId = idSchema('org').parse(request.headers['x-zapp-organization-id']);
    const row = await deps.rows.get(workspaceId, organizationId);
    if (
      row === undefined ||
      row.organizationId !== organizationId ||
      row.providerWorkspaceId === null ||
      row.status === 'terminated'
    ) {
      throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
    }
    return row.providerWorkspaceId;
  };
  app.post(
    '/internal/workspaces',
    {
      preHandler: app.requireService,
      schema: {
        body: CreateWorkspaceBodySchema,
        response: { 200: WorkspaceResponseSchema, 201: WorkspaceResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CreateWorkspaceBodySchema.parse(request.body);
      requireIdempotencyKey(request.headers['idempotency-key'], body.operationKey);
      const key = WorkspaceRowIdempotencyKeySchema.parse({
        runId: body.runId,
        taskId: body.taskId,
        purpose: body.purpose,
      });
      const input = createInputFor(body.workspace, body, deps.provider.lockedImageTag);
      const claim = await deps.rows.claimCreate(body.workspace, key);
      if (!claim.created) {
        if (claim.row.providerWorkspaceId === null) {
          throw Object.assign(new Error('Original workspace creation did not resolve.'), {
            statusCode: 502,
          });
        }
        return await reply.status(200).send({ workspace: claim.row });
      }

      await deps.rows.transition(claim.row.id, 'provisioning');
      const untrustedHandle = await deps.provider.createWorkspace(input);
      const providerWorkspaceId = z
        .object({ providerWorkspaceId: z.string().min(1) })
        .passthrough()
        .parse(untrustedHandle).providerWorkspaceId;
      try {
        const handle = WorkspaceHandleSchema.strict().parse(untrustedHandle);
        if (
          handle.status !== 'ready' ||
          handle.imageTag !== deps.provider.lockedImageTag ||
          handle.resourceProfile !== claim.row.resourceProfile
        ) {
          throw new Error('Workspace provider returned a mismatched handle.');
        }
        await deps.rows.transition(claim.row.id, 'started', {
          providerWorkspaceId: handle.providerWorkspaceId,
        });
        const providerStatus = await deps.provider.getStatus(handle.providerWorkspaceId);
        if (providerStatus !== 'ready') {
          throw new Error('Workspace provider did not become ready.');
        }
        const ready = await deps.rows.transition(claim.row.id, 'ready');
        return await reply.status(201).send({ workspace: ready });
      } catch (error) {
        await deps.provider.terminateWorkspace(providerWorkspaceId);
        if ((await deps.provider.getStatus(providerWorkspaceId)) !== 'terminated') {
          throw Object.assign(new Error('Workspace create compensation was not confirmed.'), {
            statusCode: 502,
            cause: error,
          });
        }
        await deps.rows.transition(claim.row.id, 'terminated', {
          providerWorkspaceId,
          terminatedAt: deps.now(),
        });
        throw Object.assign(new Error('Workspace creation did not persist safely.'), {
          statusCode: 502,
          cause: error,
        });
      }
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId',
    {
      preHandler: app.requireService,
      schema: {
        params: WorkspaceParamsSchema,
        response: { 200: StatusResponseSchema },
      },
    },
    async (request: FastifyRequest) => {
      const params = WorkspaceParamsSchema.parse(request.params);
      const row = await deps.rows.get(params.workspaceId);
      if (row === undefined) {
        throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
      }
      const providerStatus =
        row.providerWorkspaceId === null
          ? row.status
          : await deps.provider.getStatus(row.providerWorkspaceId);
      return { workspace: row, providerStatus };
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/terminate',
    {
      preHandler: app.requireService,
      schema: {
        params: WorkspaceParamsSchema,
        body: TerminateBodySchema,
        response: { 200: WorkspaceResponseSchema },
      },
    },
    async (request: FastifyRequest) => {
      const params = WorkspaceParamsSchema.parse(request.params);
      const body = TerminateBodySchema.parse(request.body);
      requireIdempotencyKey(request.headers['idempotency-key'], body.operationKey);
      const row = await deps.rows.get(params.workspaceId);
      if (row === undefined) {
        throw Object.assign(new Error('Workspace was not found.'), { statusCode: 404 });
      }
      if (row.status === 'terminated') return { workspace: row };
      if (row.providerWorkspaceId !== null) {
        await deps.provider.terminateWorkspace(row.providerWorkspaceId);
        if ((await deps.provider.getStatus(row.providerWorkspaceId)) !== 'terminated') {
          throw Object.assign(new Error('Workspace provider termination was not confirmed.'), {
            statusCode: 502,
          });
        }
      }
      const terminated = await deps.rows.transition(row.id, 'terminated', {
        terminatedAt: deps.now(),
      });
      return { workspace: terminated };
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/exec',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema, querystring: ExecQuerySchema, body: ExecBodySchema } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const query = ExecQuerySchema.parse(request.query);
      const body = ExecBodySchema.parse(request.body);
      const providerWorkspaceId = await resolveProviderWorkspaceId(workspaceId, request);
      const key = readIdempotencyKey(request.headers['idempotency-key']);
      const input = ExecInputSchema.parse({ ...body, providerWorkspaceId });
      if (query.stream !== '1') return ExecResultSchema.parse(await deps.provider.exec(input, key));
      const controller = new AbortController();
      const abort = (): void => {
        controller.abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      try {
        for await (const untrustedRecord of deps.provider.execStream(input, key, controller.signal)) {
          const record = ExecStreamRecordSchema.parse(untrustedRecord);
          if (reply.raw.destroyed) break;
          reply.raw.write(`${JSON.stringify(record)}\n`);
        }
        if (!reply.raw.destroyed) reply.raw.end();
      } finally {
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
      }
      return reply;
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/exec/:pid/kill',
    { preHandler: app.requireService, schema: { params: ExecParamsSchema, body: KillBodySchema } },
    async (request: FastifyRequest) => {
      const params = ExecParamsSchema.parse(request.params);
      const body = KillBodySchema.parse(request.body);
      return KillResponseSchema.parse(await deps.provider.killExec(
        await resolveProviderWorkspaceId(params.workspaceId, request),
        params.pid,
        body.executionId,
        readIdempotencyKey(request.headers['idempotency-key']),
      ));
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId/files',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema, querystring: FileQuerySchema } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const { path } = FileQuerySchema.parse(request.query);
      const body = await deps.provider.readFile(
        await resolveProviderWorkspaceId(workspaceId, request),
        path,
      );
      return reply.type('application/octet-stream').send(Buffer.from(body));
    },
  );

  app.put(
    '/internal/workspaces/:workspaceId/files',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema, querystring: FileQuerySchema } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const { path } = FileQuerySchema.parse(request.query);
      if (!Buffer.isBuffer(request.body)) throw new z.ZodError([]);
      await deps.provider.writeFile(
        await resolveProviderWorkspaceId(workspaceId, request),
        path,
        request.body,
        readIdempotencyKey(request.headers['idempotency-key']),
      );
      return reply.status(204).send();
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId/files/list',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema, querystring: ListQuerySchema } },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const query = ListQuerySchema.parse(request.query);
      return FileListResponseSchema.parse(await deps.provider.listFiles(await resolveProviderWorkspaceId(workspaceId, request), query.path, {
        ...(query.glob === undefined ? {} : { glob: query.glob }),
        ...(query.maxDepth === undefined ? {} : { maxDepth: query.maxDepth }),
      }));
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/git',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema, body: GitBodySchema } },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      return GitResponseSchema.parse(await deps.provider.git(
        await resolveProviderWorkspaceId(workspaceId, request),
        GitBodySchema.parse(request.body),
        readIdempotencyKey(request.headers['idempotency-key']),
      ));
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId/healthz',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema } },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      return HealthResponseSchema.parse(await deps.provider.health(await resolveProviderWorkspaceId(workspaceId, request)));
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId/metrics',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema } },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      return MetricsResponseSchema.parse(await deps.provider.metrics(await resolveProviderWorkspaceId(workspaceId, request)));
    },
  );

  app.get(
    '/internal/workspaces/:workspaceId/files/update-snapshot',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema, querystring: FileQuerySchema } },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const { path } = FileQuerySchema.parse(request.query);
      return deps.provider.readFileForUpdate(
        await resolveProviderWorkspaceId(workspaceId, request),
        path,
      );
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/files/atomic-write',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema, body: AtomicWriteBodySchema } },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const body = AtomicWriteBodySchema.parse(request.body);
      await deps.provider.writeFilesAtomically(
        await resolveProviderWorkspaceId(workspaceId, request),
        body.files.map((file) => ({
          path: file.path,
          data: Buffer.from(file.dataBase64, 'base64'),
          ...(file.expectedRevision === undefined ? {} : { expectedRevision: file.expectedRevision }),
        })),
        readIdempotencyKey(request.headers['idempotency-key']),
      );
      return OkResponseSchema.parse({ ok: true });
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/search',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema, body: SearchBodySchema } },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      return ExecResultSchema.parse(await deps.provider.search(
        await resolveProviderWorkspaceId(workspaceId, request),
        SearchBodySchema.parse(request.body),
      ));
    },
  );

  app.delete(
    '/internal/workspaces/:workspaceId/files',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema, querystring: FileQuerySchema } },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      const { path } = FileQuerySchema.parse(request.query);
      const result = await deps.provider.deleteFile(
        await resolveProviderWorkspaceId(workspaceId, request),
        path,
        readIdempotencyKey(request.headers['idempotency-key']),
      );
      return DeleteResponseSchema.parse({ ok: true, alreadyAbsent: result.alreadyAbsent });
    },
  );

  app.post(
    '/internal/workspaces/:workspaceId/files/rename',
    { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema, body: RenameBodySchema } },
    async (request: FastifyRequest) => {
      const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
      await deps.provider.renameFile(
        await resolveProviderWorkspaceId(workspaceId, request),
        RenameBodySchema.parse(request.body),
        readIdempotencyKey(request.headers['idempotency-key']),
      );
      return OkResponseSchema.parse({ ok: true });
    },
  );

  for (const action of ['start', 'restart'] as const) {
    app.post(
      `/internal/workspaces/:workspaceId/dev-server/${action}`,
      { preHandler: app.requireService, schema: { params: WorkspaceParamsSchema, body: DevServerBodySchema } },
      async (request: FastifyRequest) => {
        const { workspaceId } = WorkspaceParamsSchema.parse(request.params);
        const { contract } = DevServerBodySchema.parse(request.body);
        const providerWorkspaceId = await resolveProviderWorkspaceId(workspaceId, request);
        const key = readIdempotencyKey(request.headers['idempotency-key']);
        return DevServerResponseSchema.parse(
          await (action === 'start'
            ? deps.provider.startDevServer(providerWorkspaceId, contract, key)
            : deps.provider.restartDevServer(providerWorkspaceId, contract, key)),
        );
      },
    );
  }
}

export type { WorkspacePurpose };
