import { Readable } from 'node:stream';

import { idSchema } from '@zapp/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { SandboxServiceApp } from '../app.js';
import {
  adaptWebSocket,
  isAllowedPreviewPublicOrigin,
  type PreviewTransport,
} from '../preview/transport.js';
import type { WorkspaceLifecycleRow } from './workspaces.js';

const PreviewParamsSchema = z
  .object({ workspaceId: idSchema('ws'), '*': z.string() })
  .strict();
const PreviewScopeSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
  })
  .strict();
const PreviewPublicOriginSchema = z
  .string()
  .url()
  .transform((value) => new URL(value))
  .refine(
    isAllowedPreviewPublicOrigin,
    'Preview public origin must use HTTPS outside loopback development hosts',
  );

export interface PreviewWorkspaceRows {
  get(
    workspaceId: string,
    organizationId: string,
    projectId: string,
  ): Promise<WorkspaceLifecycleRow | undefined>;
}

function bodyStream(body: unknown): AsyncIterable<Uint8Array> | undefined {
  if (body === undefined || body === null) return undefined;
  if (body instanceof Uint8Array) {
    return Readable.from([body]);
  }
  if (typeof body === 'string') {
    return Readable.from([Buffer.from(body)]);
  }
  if (typeof body === 'object' && Symbol.asyncIterator in body) {
    return body as AsyncIterable<Uint8Array>;
  }
  return Readable.from([Buffer.from(JSON.stringify(body))]);
}

function previewPath(request: FastifyRequest, wildcard: string): string {
  const queryAt = request.raw.url?.indexOf('?') ?? -1;
  const query = queryAt < 0 ? '' : (request.raw.url?.slice(queryAt) ?? '');
  return `/${wildcard}${query}`;
}

function notFound(reply: FastifyReply) {
  return reply.status(404).send({
    code: 'workspace_not_found',
    message: 'Workspace was not found.',
  });
}

export function registerPreviewRoutes(
  app: SandboxServiceApp,
  deps: { readonly rows: PreviewWorkspaceRows; readonly transport: PreviewTransport },
): void {
  const resolvedRows = new WeakMap<FastifyRequest, WorkspaceLifecycleRow>();
  const resolveWorkspace = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const params = PreviewParamsSchema.parse(request.params);
    const scope = PreviewScopeSchema.parse({
      organizationId: request.headers['x-zapp-organization-id'],
      projectId: request.headers['x-zapp-project-id'],
    });
    const row = await deps.rows.get(params.workspaceId, scope.organizationId, scope.projectId);
    if (row === undefined || row.providerWorkspaceId === null || row.status === 'terminated') {
      await notFound(reply);
      return;
    }
    resolvedRows.set(request, row);
  };
  const httpHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = PreviewParamsSchema.parse(request.params);
    const row = resolvedRows.get(request);
    if (row?.providerWorkspaceId === null || row?.providerWorkspaceId === undefined)
      return notFound(reply);

    const abort = new AbortController();
    const abortRequest = (): void => {
      abort.abort();
    };
    const abortReply = (): void => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    request.raw.once('aborted', abortRequest);
    reply.raw.once('close', abortReply);
    const cleanup = (): void => {
      request.raw.off('aborted', abortRequest);
      reply.raw.off('close', abortReply);
    };
    try {
      const requestBody = bodyStream(request.body);
      const applicationCookie =
        typeof request.headers['x-zapp-preview-app-cookie'] === 'string'
          ? request.headers['x-zapp-preview-app-cookie']
          : undefined;
      const response = await deps.transport.request({
        providerWorkspaceId: row.providerWorkspaceId,
        method: request.method,
        path: previewPath(request, params['*']),
        publicOrigin: PreviewPublicOriginSchema.parse(
          request.headers['x-zapp-preview-public-origin'],
        ),
        headers: request.headers,
        ...(applicationCookie === undefined ? {} : { applicationCookie }),
        ...(requestBody === undefined ? {} : { body: requestBody }),
        signal: abort.signal,
      });
      void reply.status(response.statusCode);
      for (const [name, value] of Object.entries(response.headers)) reply.header(name, value);
      const streamedBody = (async function* () {
        try {
          yield* response.body;
        } finally {
          cleanup();
        }
      })();
      return await reply.send(Readable.from(streamedBody));
    } catch (error) {
      cleanup();
      throw error;
    }
  };
  void app.register((previewApp, _options, done) => {
    previewApp.removeAllContentTypeParsers();
    previewApp.addContentTypeParser('*', (_request, payload, parsed) => {
      parsed(null, payload);
    });
    const preHandler = [app.requireService, resolveWorkspace];
    previewApp.route({
      method: 'GET',
      url: '/internal/workspaces/:workspaceId/preview/*',
      preHandler,
      wsHandler: async (socket, request) => {
      const params = PreviewParamsSchema.parse(request.params);
      const row = resolvedRows.get(request);
      if (row?.providerWorkspaceId === null || row?.providerWorkspaceId === undefined) {
        socket.close(1008, 'Workspace was not found.');
        return;
      }
      const applicationCookie =
        typeof request.headers['x-zapp-preview-app-cookie'] === 'string'
          ? request.headers['x-zapp-preview-app-cookie']
          : undefined;
      try {
        await deps.transport.openWebSocket(
          {
            providerWorkspaceId: row.providerWorkspaceId,
            method: 'GET',
            path: previewPath(request, params['*']),
            publicOrigin: PreviewPublicOriginSchema.parse(
              request.headers['x-zapp-preview-public-origin'],
            ),
            headers: request.headers,
            ...(applicationCookie === undefined ? {} : { applicationCookie }),
          },
          adaptWebSocket(socket),
        );
      } catch {
        socket.close(1011, 'Preview transport failed.');
      }
      },
      handler: httpHandler,
    });
    previewApp.route({
      method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url: '/internal/workspaces/:workspaceId/preview/*',
      preHandler,
      handler: httpHandler,
    });
    done();
  });
}
