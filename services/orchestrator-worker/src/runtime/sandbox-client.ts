import { createHash, randomUUID } from 'node:crypto';

import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import { idSchema, type ExecInput } from '@zapp/contracts';
import {
  AtomicWriteConflictError,
  type AtomicFileWrite,
  type ExecChunk,
  type ExecResult,
  type FileEntry,
  type FileStat,
  type GitOp,
  type GitResult,
  type WorkspaceFileSnapshot,
  type WorkspaceRenameInput,
  type WorkspaceRuntime,
  type WorkspaceSearchInput,
} from '@zapp/workspace-runtime';
import { z } from 'zod';

const REQUEST_GRACE_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 15 * 60_000;

const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
const ExecResultSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().finite().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
const ExecStreamRecordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), pid: z.number().int().positive(), executionId: z.string().uuid(), at: z.string().datetime() }).strict(),
  z.object({ type: z.enum(['stdout', 'stderr']), data: z.string(), at: z.string().datetime() }).strict(),
  z.object({ type: z.literal('exit'), exitCode: z.number().int(), durationMs: z.number().nonnegative(), truncated: z.boolean(), at: z.string().datetime() }).strict(),
]);
const FileEntrySchema = z
  .object({ path: z.string(), type: z.enum(['file', 'directory', 'symlink']) })
  .strict();
const FileStatSchema = FileEntrySchema.extend({
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().finite().nonnegative(),
}).strict();
const FileSnapshotSchema = z
  .object({ dataBase64: z.string(), revision: z.string().min(1) })
  .strict();
const GitResultSchema = z
  .object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() })
  .strict();
const DevServerResponseSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    pid: z.number().int().positive(),
    supervisorId: z.string().min(1),
    ownership: z.enum(['process', 'process_group']),
  })
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
const DevServerLogsResponseSchema = z
  .object({
    entries: z.array(z.object({
      cursor: z.number().int().positive(),
      at: z.string().datetime(),
      stream: z.enum(['stdout', 'stderr']),
      message: z.string(),
    }).strict()),
    nextCursor: z.number().int().nonnegative(),
    truncated: z.boolean(),
    state: z.enum(['idle', 'starting', 'ready', 'restarting', 'failed']),
    failureId: z.string().min(1).nullable(),
  })
  .strict();
const PublicWorkspaceSchema = z
  .object({
    id: idSchema('ws'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    branchId: idSchema('br').nullable(),
    provider: z.enum(['modal', 'docker']),
    status: z.enum(['requested', 'provisioning', 'started', 'ready', 'active', 'checkpointing', 'idle', 'terminated']),
    resourceProfile: z.enum(['small', 'standard', 'large']),
    snapshotRef: z.string().nullable(),
    createdAt: z.string().datetime(),
    lastActiveAt: z.string().datetime().nullable(),
    terminatedAt: z.string().datetime().nullable(),
  })
  .strict();
const WorkspaceWireSchema = PublicWorkspaceSchema.extend({
  providerWorkspaceId: z.string().min(1).nullable().optional(),
})
  .strict()
  .transform((wire) => {
    const workspace: Record<string, unknown> = { ...wire };
    delete workspace['providerWorkspaceId'];
    return PublicWorkspaceSchema.parse(workspace);
  });
const WorkspaceResponseSchema = z.object({ workspace: WorkspaceWireSchema }).strict();

export interface SandboxWorkspaceClientOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly organizationId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly fetch?: typeof fetch;
  readonly operationKey?: () => string;
}

export interface SandboxWorkspaceControls {
  attach(): Promise<z.infer<typeof PublicWorkspaceSchema>>;
  terminate(): Promise<z.infer<typeof PublicWorkspaceSchema>>;
  readDevServerLogs(input?: { readonly after?: number; readonly limit?: number }): Promise<z.infer<typeof DevServerLogsResponseSchema>>;
}

export class SandboxWorkspaceRequestError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxWorkspaceRequestError';
  }
}

function defaultOperationKey(): string {
  return `op_${createHash('sha256').update(randomUUID()).digest('hex')}`;
}

function requestTimeout(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): number {
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1, timeoutMs + REQUEST_GRACE_MS));
}

function encodeQuery(input: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

function copyArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return copy;
}

export function createSandboxWorkspaceRuntime(
  optionsValue: SandboxWorkspaceClientOptions,
): WorkspaceRuntime & SandboxWorkspaceControls {
  const options = {
    ...optionsValue,
    baseUrl: z.string().url().parse(optionsValue.baseUrl).replace(/\/$/u, ''),
    organizationId: idSchema('org').parse(optionsValue.organizationId),
    projectId: idSchema('proj').parse(optionsValue.projectId),
    workspaceId: idSchema('ws').parse(optionsValue.workspaceId),
    runId: idSchema('run').parse(optionsValue.runId),
  };
  const fetchImpl = options.fetch ?? fetch;
  const serviceTokens = createServiceTokenSigner(options.serviceTokens);
  const nextOperationKey = options.operationKey ?? defaultOperationKey;
  const workspacePath = `/internal/workspaces/${encodeURIComponent(options.workspaceId)}`;

  const makeHeaders = async (input: {
    readonly mutation: boolean;
    readonly contentType?: string;
    readonly idempotencyKey?: string;
  }) => {
    const issued = await serviceTokens.signServiceToken({
      service: 'orchestrator-worker',
      aud: 'sandbox-service',
    });
    const headers = new Headers({
      'x-zapp-service-token': issued.token,
      'x-zapp-organization-id': options.organizationId,
      'x-zapp-project-id': options.projectId,
      'x-zapp-run-id': options.runId,
    });
    if (input.contentType !== undefined) headers.set('content-type', input.contentType);
    if (input.mutation) {
      headers.set(
        'idempotency-key',
        OperationKeySchema.parse(input.idempotencyKey ?? nextOperationKey()),
      );
    }
    return headers;
  };

  const request = async (input: {
    readonly method: string;
    readonly path: string;
    readonly body?: string | ArrayBuffer;
    readonly contentType?: string;
    readonly mutation?: boolean;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly idempotencyKey?: string;
  }): Promise<Response> => {
    const timeoutSignal = AbortSignal.timeout(requestTimeout(input.timeoutMs));
    const signal = input.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([input.signal, timeoutSignal]);
    const response = await fetchImpl(`${options.baseUrl}${input.path}`, {
      method: input.method,
      headers: await makeHeaders({
        mutation: input.mutation === true,
        ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      }),
      ...(input.body === undefined ? {} : { body: input.body }),
      signal,
    });
    if (!response.ok) {
      if (response.status === 409) {
        const conflict = z.object({ code: z.literal('atomic_write_conflict') }).passthrough()
          .safeParse(await response.clone().json().catch(() => undefined));
        if (conflict.success) throw new AtomicWriteConflictError();
      }
      await response.body?.cancel().catch(() => undefined);
      throw new SandboxWorkspaceRequestError(response.status, 'Sandbox workspace request failed.');
    }
    return response;
  };

  const requestJson = async <T>(
    schema: z.ZodType<T>,
    input: Parameters<typeof request>[0],
  ): Promise<T> => schema.parse(await (await request(input)).json());

  const commandBody = (input: {
    readonly cmd: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly pty?: boolean;
  }) => ({
    command: input.cmd,
    args: [...input.args],
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
    timeoutMs: input.timeoutMs,
    ...(input.pty === undefined ? {} : { pty: input.pty }),
  });

  const mutateJson = <T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    timeoutMs?: number,
    idempotencyKey?: string,
  ) =>
    requestJson(schema, {
      method: 'POST', path, body: JSON.stringify(body), contentType: 'application/json',
      mutation: true, ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });

  return {
    kind: 'cloud',
    exec(input): Promise<ExecResult> {
      return mutateJson(
        `${workspacePath}/exec`,
        commandBody(input),
        ExecResultSchema,
        input.timeoutMs,
      );
    },
    async *execStream(input: ExecInput): AsyncIterable<ExecChunk> {
      const controller = new AbortController();
      const response = await request({
        method: 'POST',
        path: `${workspacePath}/exec?stream=1`,
        body: JSON.stringify(commandBody({
          cmd: input.command,
          args: input.args,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.env === undefined ? {} : { env: input.env }),
          timeoutMs: input.timeoutMs,
          ...(input.pty === undefined ? {} : { pty: input.pty }),
        })),
        contentType: 'application/json',
        mutation: true,
        timeoutMs: input.timeoutMs,
        signal: controller.signal,
      });
      if (!response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
        await response.body?.cancel();
        throw new Error('Sandbox workspace stream response was invalid.');
      }
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error('Sandbox workspace stream body was missing.');
      const decoder = new TextDecoder();
      let pending = '';
      let started = false;
      let exited = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          for (;;) {
            const newline = pending.indexOf('\n');
            if (newline < 0) break;
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (line === '') continue;
            const record = ExecStreamRecordSchema.parse(JSON.parse(line) as unknown);
            if (record.type === 'started') {
              if (started || exited) throw new Error('Sandbox workspace stream order was invalid.');
              started = true;
              continue;
            }
            if (record.type === 'stdout' || record.type === 'stderr') {
              if (!started || exited) throw new Error('Sandbox workspace stream order was invalid.');
              yield { stream: record.type, data: record.data, at: record.at };
              continue;
            }
            if (!started || exited) throw new Error('Sandbox workspace stream order was invalid.');
            exited = true;
          }
          if (done) break;
        }
        if (pending !== '') throw new Error('Sandbox workspace stream ended with a partial record.');
        if (!exited) throw new Error('Sandbox workspace stream ended without an exit record.');
      } finally {
        controller.abort();
        await reader.cancel().catch(() => undefined);
      }
    },
    async readFile(path): Promise<Uint8Array> {
      const response = await request({
        method: 'GET',
        path: `${workspacePath}/files${encodeQuery({ path })}`,
      });
      if (!response.headers.get('content-type')?.startsWith('application/octet-stream')) {
        await response.body?.cancel();
        throw new Error('Sandbox workspace file response was invalid.');
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async readFileForUpdate(path): Promise<WorkspaceFileSnapshot> {
      const result = await requestJson(FileSnapshotSchema, {
        method: 'GET',
        path: `${workspacePath}/files/update-snapshot${encodeQuery({ path })}`,
      });
      return { data: new Uint8Array(Buffer.from(result.dataBase64, 'base64')), revision: result.revision };
    },
    async writeFile(path, data): Promise<void> {
      await request({
        method: 'PUT', path: `${workspacePath}/files${encodeQuery({ path })}`,
        body: copyArrayBuffer(data), contentType: 'application/octet-stream', mutation: true,
      });
    },
    async writeFilesAtomically(files: readonly AtomicFileWrite[]): Promise<void> {
      await mutateJson(`${workspacePath}/files/atomic-write`, {
        files: files.map((file) => ({
          path: file.path,
          dataBase64: Buffer.from(file.data).toString('base64'),
          ...(file.expectedRevision === undefined ? {} : { expectedRevision: file.expectedRevision }),
        })),
      }, z.object({ ok: z.literal(true) }).strict());
    },
    search(input: WorkspaceSearchInput): Promise<ExecResult> {
      return requestJson(ExecResultSchema, {
        method: 'POST', path: `${workspacePath}/search`, body: JSON.stringify(input),
        contentType: 'application/json', mutation: true,
      });
    },
    listFiles(path, listOptions = {}): Promise<FileEntry[]> {
      return requestJson(z.array(FileEntrySchema), {
        method: 'GET',
        path: `${workspacePath}/files/list${encodeQuery({ path, glob: listOptions.glob, maxDepth: listOptions.maxDepth })}`,
      });
    },
    stat(path): Promise<FileStat> {
      return requestJson(FileStatSchema, {
        method: 'GET', path: `${workspacePath}/files/stat${encodeQuery({ path })}`,
      });
    },
    async delete(path): Promise<void> {
      await requestJson(z.object({ ok: z.literal(true), alreadyAbsent: z.boolean() }).strict(), {
        method: 'DELETE', path: `${workspacePath}/files${encodeQuery({ path })}`, mutation: true,
      });
    },
    async deleteFile(path): Promise<void> {
      await requestJson(z.object({ ok: z.literal(true), alreadyAbsent: z.boolean() }).strict(), {
        method: 'DELETE', path: `${workspacePath}/files${encodeQuery({ path })}`, mutation: true,
      });
    },
    async renameFile(input: WorkspaceRenameInput): Promise<void> {
      await mutateJson(`${workspacePath}/files/rename`, input, z.object({ ok: z.literal(true) }).strict());
    },
    git(op: GitOp): Promise<GitResult> {
      return mutateJson(`${workspacePath}/git`, op, GitResultSchema);
    },
    async startDevServer(contract) {
      const result = await mutateJson(`${workspacePath}/dev-server/start`, { contract }, DevServerResponseSchema);
      return { port: result.port, pid: result.pid };
    },
    async restartDevServer(contract) {
      const result = await mutateJson(`${workspacePath}/dev-server/restart`, { contract }, DevServerResponseSchema);
      return { port: result.port, pid: result.pid };
    },
    async health() {
      const result = await requestJson(HealthResponseSchema, {
        method: 'GET', path: `${workspacePath}/healthz`,
      });
      return { ok: result.ok, details: result.details };
    },
    async readDevServerLogs(input = {}) {
      return requestJson(DevServerLogsResponseSchema, {
        method: 'GET',
        path: `${workspacePath}/dev-server/logs${encodeQuery({ after: input.after, limit: input.limit })}`,
      });
    },
    async attach() {
      const operationKey = OperationKeySchema.parse(nextOperationKey());
      const result = await mutateJson(`${workspacePath}/attach`, {
        operationKey,
      }, WorkspaceResponseSchema, undefined, operationKey);
      return result.workspace;
    },
    async terminate() {
      const operationKey = OperationKeySchema.parse(nextOperationKey());
      const result = await mutateJson(`${workspacePath}/terminate`, {
        operationKey,
      }, WorkspaceResponseSchema, undefined, operationKey);
      return result.workspace;
    },
  };
}
