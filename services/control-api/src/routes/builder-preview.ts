import {
  BuilderPreviewDevServerResponseSchema,
  BuilderPreviewEventSchema,
  BuilderPreviewLogsQuerySchema,
  BuilderPreviewLogsResponseSchema,
  ExecutionContractSchema,
  idSchema,
} from '@zapp/contracts';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { scanProjectCapabilities } from '@zapp/project-adapters';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { IDEMPOTENT_REPLAY_HEADER, IdempotencyHeadersSchema } from '../plugins/idempotency.js';
import {
  ReadBuilderPreviewLogsInputSchema,
  RestartBuilderPreviewInputSchema,
  type BuilderPreviewSandboxPort,
} from '../sandbox/port.js';
import { operationOf } from './runs.js';
import { toSandboxWorkspace } from './workspaces.js';
import type { PreviewProxyPort } from './preview.js';
import type { BuilderArtifactPort } from './builder-artifacts.js';

const WorkspaceParams = z.object({ workspaceId: idSchema('ws') });

export interface BuilderPreviewRoutesDeps {
  readonly sandbox: BuilderPreviewSandboxPort;
  readonly artifacts?: BuilderArtifactPort;
  readonly proxy: PreviewProxyPort;
  readonly screenshots: BuilderPreviewScreenshotStore;
  readonly publicOrigin: URL;
  readonly now: () => Date;
  readonly revalidateAuthorization: (
    context: BuilderPreviewAuthorizationContext,
  ) => Promise<boolean>;
  readonly recheckIntervalMs?: number;
}

export interface BuilderPreviewAuthorizationContext {
  readonly organizationId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly jti: string;
  readonly expiresAt: Date;
}

export interface BuilderPreviewScreenshotStore {
  reserve(key: string): Promise<BuilderPreviewScreenshotReservation>;
  complete(key: string, body: Buffer, capturedAt: Date): Promise<void>;
  release(key: string): Promise<void>;
}

export type BuilderPreviewScreenshotReservation =
  | { readonly state: 'acquired' }
  | { readonly state: 'pending' }
  | { readonly state: 'completed'; readonly body: Buffer; readonly capturedAt: Date };

export type BuilderPreviewS3Command = GetObjectCommand | PutObjectCommand | DeleteObjectCommand;

export interface BuilderPreviewS3CommandSender {
  send(command: BuilderPreviewS3Command): Promise<unknown>;
}

export function createUnavailableBuilderPreviewProxy(): PreviewProxyPort {
  const unavailable = (): Promise<never> => Promise.reject(previewProxyFailed());
  return { request: unavailable, openWebSocket: unavailable };
}

export function registerBuilderPreviewRoutes(
  app: AppInstance,
  deps: BuilderPreviewRoutesDeps,
): void {
  app.get(
    '/v1/workspaces/:workspaceId/dev-server/logs',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: WorkspaceParams,
        querystring: BuilderPreviewLogsQuerySchema,
        response: { 200: BuilderPreviewLogsResponseSchema },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const workspace = await ctx.db.workspaces.getById(request.params.workspaceId);
      if (workspace === undefined) throw workspaceNotFound();
      authorize(ctx, 'view_project');
      try {
        return BuilderPreviewLogsResponseSchema.parse(
          await deps.sandbox.readDevServerLogs(
            ReadBuilderPreviewLogsInputSchema.parse({
              workspace: toSandboxWorkspace(workspace),
              after: request.query.after,
              limit: request.query.limit,
            }),
          ),
        );
      } catch {
        throw sandboxFailed();
      }
    },
  );

  app.post(
    '/v1/workspaces/:workspaceId/dev-server/restart',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: WorkspaceParams,
        headers: IdempotencyHeadersSchema,
        response: { 200: BuilderPreviewDevServerResponseSchema },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const workspace = await ctx.db.workspaces.getById(request.params.workspaceId);
      if (workspace === undefined) throw workspaceNotFound();
      authorize(ctx, 'edit_code');
      const stored = await ctx.db.contracts.latestForProject(workspace.projectId);
      let contract =
        stored === undefined
          ? undefined
          : ExecutionContractSchema.safeParse(stored.contractJson).data;
      if (deps.artifacts !== undefined) {
        try {
          const scan = await scanProjectCapabilities({
            workspaceRoot: '.',
            listFiles: async (glob) =>
              (
                await deps.artifacts?.listFiles({
                  organizationId: ctx.organizationId,
                  projectId: workspace.projectId,
                  workspaceId: workspace.id,
                  path: '.',
                  glob,
                  maxDepth: 100,
                })
              )?.entries
                .filter(({ type }) => type === 'file')
                .map(({ path }) => path) ?? [],
            readFile: async (path) => {
              const file = await deps.artifacts?.readFile({
                organizationId: ctx.organizationId,
                projectId: workspace.projectId,
                workspaceId: workspace.id,
                path,
              });
              if (file === undefined) throw new Error('workspace source unavailable');
              return new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.from(file.dataBase64, 'base64'),
              );
            },
          });
          contract = ExecutionContractSchema.parse(scan.contract);
        } catch {
          if (contract === undefined) throw projectContractUnavailable();
        }
      }
      if (contract === undefined) throw projectContractUnavailable();
      const attachedRun =
        workspace.runId === null ? undefined : await ctx.db.runs.getById(workspace.runId);
      const latestRun =
        attachedRun === undefined
          ? (await ctx.db.runs.byProject(workspace.projectId, 1))[0]
          : undefined;
      const previewWorkspace = toSandboxWorkspace({
        ...workspace,
        runId: attachedRun?.id ?? latestRun?.id ?? workspace.runId,
      });
      const operationKey = operationOf(request);
      request.log.info(
        {
          packageManager: contract.package_manager,
          workspaceRoot: contract.workspace_root,
        },
        'Resolved current preview execution contract',
      );
      await request.auditDetached({
        organizationId: ctx.organizationId,
        action: 'workspace.preview_requested',
        target: { type: 'workspace', id: workspace.id },
        metadata: { operation: 'restart', operationKey },
      });
      let response: z.infer<typeof BuilderPreviewDevServerResponseSchema>;
      try {
        response = BuilderPreviewDevServerResponseSchema.parse(
          await deps.sandbox.restartDevServer(
            RestartBuilderPreviewInputSchema.parse({
              workspace: previewWorkspace,
              contract,
              operationKey,
            }),
          ),
        );
      } catch {
        await request.auditDetached({
          organizationId: ctx.organizationId,
          action: 'workspace.preview_rejected',
          target: { type: 'workspace', id: workspace.id },
          metadata: { operation: 'restart', operationKey },
        });
        throw sandboxFailed();
      }
      await request.auditDetached({
        organizationId: ctx.organizationId,
        action: 'workspace.previewed',
        target: { type: 'workspace', id: workspace.id },
        metadata: { operation: 'restart', operationKey },
      });
      return response;
    },
  );

  app.get(
    '/v1/workspaces/:workspaceId/preview/events',
    {
      config: { idempotency: 'exempt' },
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: WorkspaceParams },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const workspace = await ctx.db.workspaces.getById(request.params.workspaceId);
      if (workspace === undefined) throw workspaceNotFound();
      authorize(ctx, 'view_project');
      if (!acceptsEventStream(request.headers.accept)) {
        throw new ApiError('event_stream_required', 406, 'Accept must permit text/event-stream.');
      }
      const controller = new AbortController();
      const abort = (): void => {
        controller.abort();
      };
      const session = request.auth;
      if (session === undefined) throw new Error('builder preview requires app.requireSession');
      const stopRechecking = watchAuthorization(
        deps,
        {
          organizationId: ctx.organizationId,
          userId: session.userId,
          sessionId: session.sessionId,
          jti: session.jti,
          expiresAt: session.expiresAt,
        },
        abort,
      );
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      try {
        const upstream = await deps.proxy.request({
          organizationId: workspace.organizationId,
          projectId: workspace.projectId,
          workspaceId: workspace.id,
          method: 'GET',
          path: '/__zapp/events',
          publicOrigin: deps.publicOrigin,
          headers: { accept: 'text/event-stream' },
          body: undefined,
          signal: controller.signal,
        });
        if (upstream.statusCode !== 200 || !isEventStream(upstream.headers['content-type'])) {
          throw previewProxyFailed();
        }
        reply
          .header('content-type', 'text/event-stream; charset=utf-8')
          .header('cache-control', 'no-cache, no-transform')
          .header('connection', 'keep-alive')
          .header('x-accel-buffering', 'no');
        return await reply.send(
          Readable.from(validatedCaptureStream(upstream.body, controller.signal)),
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw previewProxyFailed();
      } finally {
        stopRechecking();
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
      }
    },
  );

  app.post(
    '/v1/workspaces/:workspaceId/preview/screenshot',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { params: WorkspaceParams, headers: IdempotencyHeadersSchema },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const workspace = await ctx.db.workspaces.getById(request.params.workspaceId);
      if (workspace === undefined) throw workspaceNotFound();
      authorize(ctx, 'view_project');
      const operationKey = operationOf(request);
      const screenshotKey = screenshotStorageKey(workspace, operationKey);
      let reservation: BuilderPreviewScreenshotReservation;
      try {
        reservation = await deps.screenshots.reserve(screenshotKey);
      } catch {
        throw previewProxyFailed();
      }
      if (reservation.state === 'completed') {
        await request.auditDetachedOnce(
          `${operationKey}:previewed`,
          screenshotAuditEntry(ctx.organizationId, workspace.id, operationKey, 'completed'),
          reservation.capturedAt,
        );
        reply.header('content-type', 'image/png').header(IDEMPOTENT_REPLAY_HEADER, 'true');
        return await reply.send(reservation.body);
      }
      if (reservation.state === 'pending') {
        reply.header('retry-after', '1');
        throw screenshotOperationPending();
      }
      try {
        await request.auditDetached({
          organizationId: ctx.organizationId,
          action: 'workspace.preview_requested',
          target: { type: 'workspace', id: workspace.id },
          metadata: { operation: 'screenshot', operationKey },
        });
      } catch (error) {
        await deps.screenshots.release(screenshotKey);
        throw error;
      }
      const controller = new AbortController();
      const abort = (): void => {
        controller.abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      let rejectionRecorded = false;
      let captureCompleted = false;
      try {
        const upstream = await deps.proxy.request({
          organizationId: workspace.organizationId,
          projectId: workspace.projectId,
          workspaceId: workspace.id,
          method: 'POST',
          path: '/__zapp/screenshot',
          publicOrigin: deps.publicOrigin,
          headers: {},
          body: undefined,
          signal: controller.signal,
        });
        const body = await readBoundedScreenshot(upstream.body);
        if (upstream.statusCode === 200) {
          if (mediaType(upstream.headers['content-type']) !== 'image/png') {
            throw previewProxyFailed();
          }
          captureCompleted = true;
          const capturedAt = deps.now();
          await deps.screenshots.complete(screenshotKey, body, capturedAt);
          await request.auditDetachedOnce(
            `${operationKey}:previewed`,
            screenshotAuditEntry(ctx.organizationId, workspace.id, operationKey, 'completed'),
            capturedAt,
          );
          reply.header('content-type', 'image/png');
        } else {
          await deps.screenshots.release(screenshotKey);
          await request.auditDetached({
            organizationId: ctx.organizationId,
            action: 'workspace.preview_rejected',
            target: { type: 'workspace', id: workspace.id },
            metadata: { operation: 'screenshot', operationKey, statusCode: upstream.statusCode },
          });
          rejectionRecorded = true;
        }
        return await reply.status(upstream.statusCode).send(body);
      } catch (error) {
        if (!rejectionRecorded && !captureCompleted) {
          await request.auditDetached({
            organizationId: ctx.organizationId,
            action: 'workspace.preview_rejected',
            target: { type: 'workspace', id: workspace.id },
            metadata: { operation: 'screenshot', operationKey },
          });
        }
        if (captureCompleted || error instanceof ApiError) throw error;
        throw previewProxyFailed();
      } finally {
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
      }
    },
  );
}

const MAX_CAPTURE_FRAME_CHARS = 65_536;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const PENDING_SCREENSHOT_CONTENT_TYPE = 'application/vnd.zapp.screenshot-pending';

function screenshotAuditEntry(
  organizationId: string,
  workspaceId: string,
  operationKey: string,
  outcome: 'completed',
) {
  return {
    organizationId,
    action: 'workspace.previewed' as const,
    target: { type: 'workspace' as const, id: workspaceId },
    metadata: { operation: 'screenshot', operationKey, outcome },
  };
}

function watchAuthorization(
  deps: BuilderPreviewRoutesDeps,
  context: BuilderPreviewAuthorizationContext,
  close: () => void,
): () => void {
  let pending = false;
  let stopped = false;
  let timeout: NodeJS.Timeout | undefined;
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = true;
    timeout = setTimeout(close, 5_000);
    timeout.unref();
    void deps
      .revalidateAuthorization(context)
      .then((allowed) => {
        if (!stopped && !allowed) close();
      })
      .catch(() => {
        if (!stopped) close();
      })
      .finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
        timeout = undefined;
        pending = false;
      });
  }, deps.recheckIntervalMs ?? 60_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (timeout !== undefined) clearTimeout(timeout);
  };
}

async function readBoundedScreenshot(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  for await (const chunk of body) {
    byteSize += chunk.byteLength;
    if (byteSize > MAX_SCREENSHOT_BYTES) throw previewProxyFailed();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, byteSize);
}

function screenshotStorageKey(
  workspace: { readonly organizationId: string; readonly projectId: string; readonly id: string },
  operationKey: string,
): string {
  return `${workspace.organizationId}/${workspace.projectId}/builder-preview-screenshots/${workspace.id}/${operationKey}.png`;
}

export function createS3BuilderPreviewScreenshotStore(
  config: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  },
  injectedSender?: BuilderPreviewS3CommandSender,
): BuilderPreviewScreenshotStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const sender: BuilderPreviewS3CommandSender =
    injectedSender ?? createBuilderPreviewS3CommandSender(client);
  const read = async (key: string): Promise<BuilderPreviewScreenshotReservation | undefined> => {
    try {
      const result = getObjectResult(
        await sender.send(new GetObjectCommand({ Bucket: config.bucket, Key: key })),
      );
      if (result.Body === undefined) throw new Error('screenshot operation object has no body');
      if (!isAsyncByteIterable(result.Body)) {
        throw new Error('screenshot operation body is not an async byte stream');
      }
      const body = await readBoundedScreenshot(result.Body);
      if (result.ContentType === 'image/png') {
        const capturedAt = z.string().datetime().safeParse(result.Metadata?.['captured-at']);
        if (!capturedAt.success) throw new Error('screenshot object has no capture timestamp');
        return { state: 'completed', body, capturedAt: new Date(capturedAt.data) };
      }
      if (
        result.ContentType === PENDING_SCREENSHOT_CONTENT_TYPE &&
        body.equals(Buffer.from('pending'))
      ) {
        return { state: 'pending' };
      }
      throw new Error('screenshot operation object has an invalid content type');
    } catch (error) {
      if (isObjectNotFound(error)) return undefined;
      throw error;
    }
  };
  return {
    async reserve(key) {
      try {
        await sender.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: 'pending',
            ContentType: PENDING_SCREENSHOT_CONTENT_TYPE,
            IfNoneMatch: '*',
          }),
        );
        return { state: 'acquired' } as const;
      } catch (error) {
        if (isPreconditionFailed(error)) {
          const existing = await read(key);
          if (existing !== undefined) return existing;
        }
        throw error;
      }
    },
    async complete(key, body, capturedAt) {
      if (body.length > MAX_SCREENSHOT_BYTES) throw new Error('screenshot object exceeds limit');
      await sender.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: 'image/png',
          Metadata: { 'captured-at': capturedAt.toISOString() },
        }),
      );
    },
    async release(key) {
      await sender.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}

function createBuilderPreviewS3CommandSender(client: S3Client): BuilderPreviewS3CommandSender {
  return {
    async send(command) {
      if (command instanceof GetObjectCommand) return await client.send(command);
      if (command instanceof PutObjectCommand) return await client.send(command);
      return await client.send(command);
    },
  };
}

function getObjectResult(value: unknown): {
  readonly Body: unknown;
  readonly ContentType: string | undefined;
  readonly Metadata: Record<string, string> | undefined;
} {
  if (typeof value !== 'object' || value === null) {
    throw new Error('screenshot object response is invalid');
  }
  const result = value as {
    readonly Body?: unknown;
    readonly ContentType?: unknown;
    readonly Metadata?: unknown;
  };
  if (result.ContentType !== undefined && typeof result.ContentType !== 'string') {
    throw new Error('screenshot object content type is invalid');
  }
  let metadata: Record<string, string> | undefined;
  if (result.Metadata !== undefined) {
    if (typeof result.Metadata !== 'object' || result.Metadata === null) {
      throw new Error('screenshot object metadata is invalid');
    }
    const entries = Object.entries(result.Metadata);
    if (entries.some(([, nested]) => typeof nested !== 'string')) {
      throw new Error('screenshot object metadata value is invalid');
    }
    metadata = Object.fromEntries(entries);
  }
  return {
    Body: result.Body,
    ContentType: result.ContentType,
    Metadata: metadata,
  };
}

function isAsyncByteIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

export function createUnavailableBuilderPreviewScreenshotStore(): BuilderPreviewScreenshotStore {
  const unavailable = (): Promise<never> => Promise.reject(previewProxyFailed());
  return { reserve: unavailable, complete: unavailable, release: unavailable };
}

function isObjectNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
  );
}

function isPreconditionFailed(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412
  );
}

async function* validatedCaptureStream(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = '';
  for await (const chunk of body) {
    if (signal.aborted) return;
    buffered += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
    if (buffered.length > MAX_CAPTURE_FRAME_CHARS) throw previewProxyFailed();
    let boundary = buffered.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data !== '') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch {
          throw previewProxyFailed();
        }
        const event = BuilderPreviewEventSchema.parse(parsed);
        yield Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
      }
      boundary = buffered.indexOf('\n\n');
    }
  }
  buffered += decoder.decode();
  if (buffered.trim() !== '') throw previewProxyFailed();
}

function acceptsEventStream(header: string | undefined): boolean {
  return (
    header === undefined ||
    header.split(',').some((entry) => {
      const value = entry.split(';', 1)[0]?.trim().toLowerCase();
      return value === 'text/event-stream' || value === '*/*';
    })
  );
}

function mediaType(value: string | readonly string[] | undefined): string | undefined {
  const resolved = typeof value === 'string' ? value : value?.[0];
  return resolved?.split(';', 1)[0]?.trim().toLowerCase();
}

function isEventStream(value: string | readonly string[] | undefined): boolean {
  return mediaType(value) === 'text/event-stream';
}

function workspaceNotFound(): ApiError {
  return new ApiError('workspace_not_found', 404, 'That workspace does not exist.');
}

function projectContractUnavailable(): ApiError {
  return new ApiError(
    'project_contract_unavailable',
    409,
    'The project does not have a valid execution contract.',
  );
}

function sandboxFailed(): ApiError {
  return new ApiError(
    'sandbox_service_failed',
    502,
    'The sandbox service could not complete that operation.',
  );
}

function previewProxyFailed(): ApiError {
  return new ApiError('preview_proxy_failed', 502, 'The preview service is unavailable.');
}

function screenshotOperationPending(): ApiError {
  return new ApiError(
    'idempotency_in_progress',
    409,
    'A screenshot with that Idempotency-Key may already have completed.',
  );
}
