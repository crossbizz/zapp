import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  CreatePreviewShareBodySchema,
  CreatePreviewShareResultSchema,
  ListPreviewSharesResultSchema,
  PreviewSessionExchangeBodySchema,
  PreviewSessionExchangeResultSchema,
  PreviewSessionRedeemBodySchema,
  PreviewSessionRedeemResultSchema,
  PreviewShareLocatorSchema,
  PreviewShareSchema,
  RevokePreviewShareResultSchema,
  idSchema,
} from '@zapp/contracts';
import {
  createPreviewSecret,
  derivePreviewGrant,
  derivePreviewSessionCredential,
  previewShareLocator,
  recoverPreviewBearer,
  verifyPreviewSecret,
} from '@zapp/sandbox-service/preview-tokens';
import { sanitizePreviewRequestHeaders } from '@zapp/sandbox-service/preview-transport';
import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { parseCookies } from '../auth/cookies.js';
import { ApiError } from '../errors.js';
import type { EventWakeupSource } from '../events/sse.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf, type MembershipLookup } from '../plugins/tenant.js';
import type { StoredPreviewShare } from '../preview/store.js';
import type { RedisCommands, RedisPublisher } from '../redis/client.js';

const WorkspaceParams = z.object({ workspaceId: idSchema('ws') }).strict();
const ProjectParams = z.object({ projectId: idSchema('proj') }).strict();
const RevokeParams = z
  .object({ workspaceId: idSchema('ws'), shareId: PreviewShareLocatorSchema })
  .strict();
const ExchangeParams = z
  .object({ organizationId: idSchema('org'), shareId: PreviewShareLocatorSchema })
  .strict();
const IDEMPOTENCY_HEADER = 'idempotency-key';
const SESSION_COOKIE = '__Host-zapp_preview';
const MAX_GRANT_TTL_MS = 60_000;
const PREVIEW_DATA_PREFIX = '/__zapp_preview_data';
const PREVIEW_REVOCATION_CHANNEL = 'preview:revoked';

export interface PreviewShareStore {
  readonly rows?: readonly StoredPreviewShare[];
  byOperation(organizationId: string, operationKey: string): Promise<StoredPreviewShare | undefined>;
  get(organizationId: string, shareId: string): Promise<StoredPreviewShare | undefined>;
  list(organizationId: string, projectId: string): Promise<StoredPreviewShare[]>;
  create(row: StoredPreviewShare): Promise<StoredPreviewShare>;
  revoke(
    organizationId: string,
    workspaceId: string,
    shareId: string,
    now: Date,
  ): Promise<StoredPreviewShare | undefined>;
}

export interface PreviewSessionRecord {
  readonly organizationId: string;
  readonly shareId: string;
  readonly expiresAt: Date;
}

export interface PreviewSessionStore {
  issueGrant(record: PreviewSessionRecord, grant: string): Promise<PreviewSessionRecord>;
  consumeGrant(
    record: PreviewSessionRecord,
    grant: string,
    operationKey: string,
  ): Promise<boolean>;
  issueSession(
    record: PreviewSessionRecord,
    credential: { id: string; secret: string },
  ): Promise<PreviewSessionRecord>;
  authorize(cookie: string): Promise<PreviewSessionRecord | undefined>;
  revoke(organizationId: string, shareId: string): Promise<void>;
}

export interface PreviewRevocationSource {
  subscribe(
    listener: (record: { readonly organizationId: string; readonly shareId: string }) => void,
  ): () => void;
}

export interface PreviewProxyResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface PreviewProxyPort {
  request(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly method: string;
    readonly path: string;
    readonly publicOrigin: URL;
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    readonly body: AsyncIterable<Uint8Array> | undefined;
    readonly signal: AbortSignal;
  }): Promise<PreviewProxyResponse>;
  openWebSocket(
    input: {
      readonly organizationId: string;
      readonly projectId: string;
      readonly workspaceId: string;
      readonly path: string;
      readonly publicOrigin: URL;
      readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
      readonly signal: AbortSignal;
    },
    downstream: PreviewProxySocket,
  ): Promise<void>;
}

export interface PreviewProxySocket {
  send(data: string | Uint8Array): void;
  close(): void;
  onMessage(handler: (data: string | Uint8Array) => void): void;
  onClose(handler: () => void): void;
  onError(handler: () => void): void;
}

export interface PreviewRoutesDeps {
  readonly shares: PreviewShareStore;
  readonly sessions: PreviewSessionStore;
  readonly proxy: PreviewProxyPort;
  readonly memberships: MembershipLookup;
  readonly signingKey: Buffer;
  readonly keyVersion: number;
  readonly appBaseUrl: URL;
  readonly previewBaseDomain: string;
  readonly now: () => Date;
  readonly revocations?: PreviewRevocationSource;
  /** Defaults to the ADR-0023 five-second revocation backstop; tests inject a short clock. */
  readonly recheckIntervalMs?: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function keyed(request: FastifyRequest, payload: unknown): {
  readonly operationKey: string;
  readonly fingerprint: string;
} {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  const key = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  if (!/^[A-Za-z0-9._:-]{8,255}$/u.test(key)) {
    throw new ApiError(
      'idempotency_key_required',
      400,
      'A valid Idempotency-Key header is required.',
    );
  }
  const routeUrl = request.routeOptions.url;
  if (routeUrl === undefined) throw new Error('Preview route URL is unavailable');
  return {
    operationKey: `op_${digest(key)}`,
    fingerprint: digest(
      `${request.method}\n${routeUrl}\n${JSON.stringify(request.params)}\n${JSON.stringify(payload)}`,
    ),
  };
}

function shareNotFound(): ApiError {
  return new ApiError('preview_share_not_found', 404, 'That preview share does not exist.');
}

function previewUnauthorized(): ApiError {
  return new ApiError('preview_unauthorized', 401, 'Preview authorization is required.');
}

function active(share: StoredPreviewShare, now: Date): boolean {
  return share.revokedAt === null && share.expiresAt.getTime() > now.getTime();
}

function orgLocator(organizationId: string): string {
  return idSchema('org').parse(organizationId).slice(4).toLowerCase();
}

function previewOrigin(
  organizationId: string,
  shareId: string,
  previewBaseDomain: string,
): URL {
  const domain = z.string().trim().min(1).parse(previewBaseDomain).toLowerCase();
  return new URL(
    `https://${orgLocator(organizationId)}-${PreviewShareLocatorSchema.parse(shareId)}.${domain}`,
  );
}

function shareUrl(
  appBaseUrl: URL,
  organizationId: string,
  shareId: string,
  bearer?: string,
): string {
  const url = new URL(
    `/preview/${encodeURIComponent(organizationId)}/${encodeURIComponent(shareId)}`,
    appBaseUrl,
  );
  if (bearer !== undefined) url.hash = `token=${bearer}`;
  return url.toString();
}

function publicShare(row: StoredPreviewShare, appBaseUrl: URL) {
  return PreviewShareSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    url: shareUrl(appBaseUrl, row.organizationId, row.id),
    expiresAt: row.expiresAt.toISOString(),
    policy: row.policy,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  });
}

function originIdentity(host: string, previewBaseDomain: string) {
  const suffix = `.${previewBaseDomain.toLowerCase()}`;
  const hostname = host.split(':', 1)[0]?.toLowerCase() ?? '';
  if (!hostname.endsWith(suffix)) return undefined;
  const locator = hostname.slice(0, -suffix.length);
  const match = /^([0-9a-hjkmnp-tv-z]{26})-([0-9a-hjkmnp-tv-z]{26})$/u.exec(locator);
  if (match === null) return undefined;
  return {
    organizationId: idSchema('org').parse(`org_${(match[1] ?? '').toUpperCase()}`),
    shareId: PreviewShareLocatorSchema.parse(match[2]),
  };
}

export function rewritePreviewOriginUrl(
  rawUrl: string,
  host: string | undefined,
  previewBaseDomain: string,
): string {
  if (originIdentity(host ?? '', previewBaseDomain) === undefined) return rawUrl;
  const pathname = rawUrl.split('?', 1)[0] ?? '';
  if (pathname === '/v1/preview/session') return rawUrl;
  return `${PREVIEW_DATA_PREFIX}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`;
}

function requestBody(request: FastifyRequest): AsyncIterable<Uint8Array> | undefined {
  if (request.body === undefined || request.body === null) return undefined;
  if (typeof request.body === 'object' && Symbol.asyncIterator in request.body) {
    return request.body as AsyncIterable<Uint8Array>;
  }
  const bytes = Buffer.isBuffer(request.body)
    ? request.body
    : Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
  return (async function* () {
    await Promise.resolve();
    yield bytes;
  })();
}

function cookieValue(request: FastifyRequest): string | undefined {
  return parseCookies(request.headers.cookie).get(SESSION_COOKIE);
}

function socketData(data: RawData): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

function proxySocket(socket: WebSocket): PreviewProxySocket {
  return {
    send(data) {
      socket.send(data);
    },
    close() {
      socket.close();
    },
    onMessage(handler) {
      socket.on('message', (data) => {
        handler(socketData(data));
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

export function registerPreviewRoutes(app: AppInstance, deps: PreviewRoutesDeps): void {
  app.post(
    '/v1/workspaces/:workspaceId/preview/shares',
    {
      config: { idempotency: 'exempt' },
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: WorkspaceParams,
        body: CreatePreviewShareBodySchema,
        response: { 201: CreatePreviewShareResultSchema },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'edit_code');
      const workspace = await ctx.db.workspaces.getById(request.params.workspaceId);
      if (
        workspace === undefined ||
        workspace.providerWorkspaceId === null ||
        workspace.status === 'terminated'
      ) {
        throw shareNotFound();
      }
      const input = CreatePreviewShareBodySchema.parse(request.body);
      const { operationKey, fingerprint } = keyed(request, input);
      const existing = await deps.shares.byOperation(ctx.organizationId, operationKey);
      if (existing !== undefined && existing.requestFingerprint !== fingerprint) {
        throw new ApiError(
          'idempotency_conflict',
          422,
          'That Idempotency-Key was already used for a different request.',
        );
      }
      const shareId =
        existing?.id ??
        previewShareLocator({
          organizationId: ctx.organizationId,
          workspaceId: workspace.id,
          operationKey,
          signingKey: deps.signingKey,
        });
      const recovered = recoverPreviewBearer({
        organizationId: ctx.organizationId,
        shareLocator: shareId,
        keyVersion: existing?.keyVersion ?? deps.keyVersion,
        signingKey: deps.signingKey,
      });
      let row = existing;
      if (row === undefined) {
        const secret = await createPreviewSecret({
          organizationId: ctx.organizationId,
          shareLocator: shareId,
          keyVersion: deps.keyVersion,
          signingKey: deps.signingKey,
        });
        const now = deps.now();
        row = await deps.shares.create({
          id: shareId,
          organizationId: ctx.organizationId,
          projectId: workspace.projectId,
          workspaceId: workspace.id,
          operationKey,
          requestFingerprint: fingerprint,
          tokenHash: secret.hash,
          keyVersion: deps.keyVersion,
          policy: input.policy,
          expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1_000),
          revokedAt: null,
          createdBy: actorOf(request),
          createdAt: now,
          updatedAt: now,
        });
        if (row.requestFingerprint !== fingerprint) {
          throw new ApiError('idempotency_conflict', 422, 'Idempotency request conflict.');
        }
      }
      return await reply.status(201).send({
        share: {
          id: row.id,
          url: shareUrl(deps.appBaseUrl, row.organizationId, row.id, recovered),
          expiresAt: row.expiresAt.toISOString(),
          policy: row.policy,
        },
      });
    },
  );

  app.get(
    '/v1/projects/:projectId/preview/shares',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: ProjectParams, response: { 200: ListPreviewSharesResultSchema } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'view_project');
      if ((await ctx.db.projects.getById(request.params.projectId)) === undefined) {
        throw shareNotFound();
      }
      return {
        shares: (await deps.shares.list(ctx.organizationId, request.params.projectId)).map((row) =>
          publicShare(row, deps.appBaseUrl),
        ),
      };
    },
  );

  app.delete(
    '/v1/workspaces/:workspaceId/preview/shares/:shareId',
    {
      config: { idempotency: 'exempt' },
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { params: RevokeParams, response: { 200: RevokePreviewShareResultSchema } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'edit_code');
      keyed(request, request.params);
      const workspace = await ctx.db.workspaces.getById(request.params.workspaceId);
      if (workspace === undefined) throw shareNotFound();
      const revoked = await deps.shares.revoke(
        ctx.organizationId,
        workspace.id,
        request.params.shareId,
        deps.now(),
      );
      if (revoked === undefined) throw shareNotFound();
      await deps.sessions.revoke(ctx.organizationId, revoked.id);
      return { revoked: true } as const;
    },
  );

  app.post(
    '/v1/organizations/:organizationId/preview-shares/:shareId/sessions',
    {
      config: { idempotency: 'exempt' },
      preHandler: [app.resolveSession, app.requireCsrf],
      schema: {
        params: ExchangeParams,
        body: PreviewSessionExchangeBodySchema,
        response: { 200: PreviewSessionExchangeResultSchema },
      },
    },
    async (request, reply) => {
      const input = PreviewSessionExchangeBodySchema.parse(request.body);
      const { operationKey } = keyed(request, input);
      const share = await deps.shares.get(request.params.organizationId, request.params.shareId);
      if (
        share === undefined ||
        !active(share, deps.now()) ||
        !(await verifyPreviewSecret(input.bearer, share.tokenHash))
      ) {
        throw previewUnauthorized();
      }
      if (share.policy === 'org') {
        const userId = actorOf(request);
        const membership = await deps.memberships.membership(share.organizationId, userId);
        if (membership?.status !== 'active') throw previewUnauthorized();
      }
      const grant = derivePreviewGrant({
        organizationId: share.organizationId,
        shareLocator: share.id,
        operationKey,
        signingKey: deps.signingKey,
      });
      const expiresAt = new Date(
        Math.min(share.expiresAt.getTime(), deps.now().getTime() + MAX_GRANT_TTL_MS),
      );
      const issued = await deps.sessions.issueGrant(
        { organizationId: share.organizationId, shareId: share.id, expiresAt },
        grant,
      );
      reply.header('cache-control', 'no-store');
      return {
        previewOrigin: previewOrigin(
          share.organizationId,
          share.id,
          deps.previewBaseDomain,
        ).toString().replace(/\/$/u, ''),
        grant,
        expiresAt: issued.expiresAt.toISOString(),
      };
    },
  );

  app.post(
    '/v1/preview/session',
    {
      config: { idempotency: 'exempt' },
      schema: {
        body: PreviewSessionRedeemBodySchema,
        response: { 200: PreviewSessionRedeemResultSchema },
      },
    },
    async (request, reply) => {
      reply
        .header('access-control-allow-origin', deps.appBaseUrl.origin)
        .header('access-control-allow-credentials', 'true')
        .header('vary', 'Origin');
      const input = PreviewSessionRedeemBodySchema.parse(request.body);
      const { operationKey } = keyed(request, input);
      const identity = originIdentity(request.headers.host ?? '', deps.previewBaseDomain);
      if (
        identity === undefined ||
        identity.organizationId !== input.organizationId ||
        identity.shareId !== input.shareId ||
        request.headers.origin !== deps.appBaseUrl.origin
      ) {
        throw previewUnauthorized();
      }
      const share = await deps.shares.get(input.organizationId, input.shareId);
      const grantRecord =
        share === undefined
          ? undefined
          : { organizationId: share.organizationId, shareId: share.id, expiresAt: share.expiresAt };
      if (
        share === undefined ||
        !active(share, deps.now()) ||
        grantRecord === undefined ||
        !(await deps.sessions.consumeGrant(grantRecord, input.grant, operationKey))
      ) {
        throw previewUnauthorized();
      }
      const credential = derivePreviewSessionCredential({
        organizationId: share.organizationId,
        shareLocator: share.id,
        grant: input.grant,
        signingKey: deps.signingKey,
      });
      const expiresAt = new Date(Math.min(share.expiresAt.getTime(), deps.now().getTime() + 3_600_000));
      const issued = await deps.sessions.issueSession(
        { organizationId: share.organizationId, shareId: share.id, expiresAt },
        credential,
      );
      reply
        .header('cache-control', 'no-store')
        .header(
          'set-cookie',
          `${SESSION_COOKIE}=${credential.id}.${credential.secret}; Path=/; Secure; HttpOnly; SameSite=Lax`,
        );
      return { expiresAt: issued.expiresAt.toISOString() };
    },
  );

  app.options(
    '/v1/preview/session',
    { config: { idempotency: 'exempt' }, schema: { hide: true } },
    async (request, reply) => {
      const requestedHeaders = request.headers['access-control-request-headers'] ?? '';
      if (
        originIdentity(request.headers.host ?? '', deps.previewBaseDomain) === undefined ||
        request.headers.origin !== deps.appBaseUrl.origin ||
        request.headers['access-control-request-method'] !== 'POST' ||
        typeof requestedHeaders !== 'string' ||
        !requestedHeaders
          .toLowerCase()
          .split(',')
          .map((value) => value.trim())
          .every((value) => value === 'content-type' || value === 'idempotency-key')
      ) {
        throw previewUnauthorized();
      }
      return await reply
        .header('access-control-allow-origin', deps.appBaseUrl.origin)
        .header('access-control-allow-credentials', 'true')
        .header('access-control-allow-methods', 'POST')
        .header('access-control-allow-headers', 'content-type, idempotency-key')
        .header('access-control-max-age', '600')
        .header('vary', 'Origin, Access-Control-Request-Headers')
        .status(204)
        .send();
    },
  );

  interface AuthorizedPreview {
    readonly identity: { readonly organizationId: string; readonly shareId: string };
    readonly cookie: string;
    readonly share: StoredPreviewShare;
  }
  const authorized = new WeakMap<FastifyRequest, AuthorizedPreview>();
  const resolveAuthorized = async (request: FastifyRequest): Promise<AuthorizedPreview> => {
    const identity = originIdentity(request.headers.host ?? '', deps.previewBaseDomain);
    if (identity === undefined) throw shareNotFound();
    const cookie = cookieValue(request);
    const session = cookie === undefined ? undefined : await deps.sessions.authorize(cookie);
    const share = await deps.shares.get(identity.organizationId, identity.shareId);
    if (
      cookie === undefined ||
      session === undefined ||
      share === undefined ||
      session.organizationId !== share.organizationId ||
      session.shareId !== share.id ||
      !active(share, deps.now())
    ) {
      throw previewUnauthorized();
    }
    return { identity, cookie, share };
  };
  const activeClosers = new Map<string, Set<() => void>>();
  const connectionKey = (organizationId: string, shareId: string): string =>
    `${organizationId}:${shareId}`;
  const unsubscribeRevocations = deps.revocations?.subscribe((record) => {
    for (const close of activeClosers.get(
      connectionKey(record.organizationId, record.shareId),
    ) ?? []) {
      close();
    }
  });
  if (unsubscribeRevocations !== undefined) {
    app.addHook('onClose', async () => {
      unsubscribeRevocations();
      await Promise.resolve();
    });
  }
  const watchAuthorization = (
    context: AuthorizedPreview,
    close: () => void,
  ): (() => void) => {
    const key = connectionKey(context.identity.organizationId, context.identity.shareId);
    const closers = activeClosers.get(key) ?? new Set<() => void>();
    closers.add(close);
    activeClosers.set(key, closers);
    const recheck = setInterval(() => {
      void Promise.all([
        deps.sessions.authorize(context.cookie),
        deps.shares.get(context.identity.organizationId, context.identity.shareId),
      ])
        .then(([liveSession, liveShare]) => {
          if (
            liveSession === undefined ||
            liveShare === undefined ||
            !active(liveShare, deps.now())
          ) {
            close();
          }
        })
        .catch(() => {
          close();
        });
    }, deps.recheckIntervalMs ?? 5_000);
    recheck.unref();
    return () => {
      clearInterval(recheck);
      closers.delete(close);
      if (closers.size === 0) activeClosers.delete(key);
    };
  };
  const serveHttp = async (
    request: FastifyRequest,
    reply: FastifyReply,
    supplied?: AuthorizedPreview,
  ) => {
    const context = supplied ?? (await resolveAuthorized(request));
    const controller = new AbortController();
    const abortRequest = (): void => {
      controller.abort();
    };
    const abortReply = (): void => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once('aborted', abortRequest);
    reply.raw.once('close', abortReply);
    const publicPath = request.url.startsWith(PREVIEW_DATA_PREFIX)
      ? request.url.slice(PREVIEW_DATA_PREFIX.length) || '/'
      : request.url;
    let response: PreviewProxyResponse;
    try {
      response = await deps.proxy.request({
        organizationId: context.share.organizationId,
        projectId: context.share.projectId,
        workspaceId: context.share.workspaceId,
        method: request.method,
        path: publicPath,
        publicOrigin: previewOrigin(
          context.share.organizationId,
          context.share.id,
          deps.previewBaseDomain,
        ),
        headers: request.headers,
        body: requestBody(request),
        signal: controller.signal,
      });
    } catch (error) {
      request.raw.off('aborted', abortRequest);
      reply.raw.off('close', abortReply);
      throw error;
    }
    const stopWatching = watchAuthorization(context, () => {
      controller.abort();
    });
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) reply.header(name, value);
    }
    const checkedBody = (async function* () {
      try {
        yield* response.body;
      } finally {
        stopWatching();
        request.raw.off('aborted', abortRequest);
        reply.raw.off('close', abortReply);
      }
    })();
    return await reply.status(response.statusCode).send(Readable.from(checkedBody));
  };

  void app.register((previewDataApp, _options, done) => {
    previewDataApp.removeAllContentTypeParsers();
    previewDataApp.addContentTypeParser('*', (_request, payload, parsed) => {
      parsed(null, payload);
    });
    previewDataApp.route({
      method: 'GET',
      url: `${PREVIEW_DATA_PREFIX}/*`,
      config: { idempotency: 'exempt' },
      preValidation: async (request) => {
        authorized.set(request, await resolveAuthorized(request));
      },
      handler: async (request, reply) =>
        await serveHttp(request, reply, authorized.get(request)),
      wsHandler: async (socket, request) => {
        const context = authorized.get(request);
        if (context === undefined) {
          socket.close();
          return;
        }
        const controller = new AbortController();
        const downstream = proxySocket(socket);
        const stopWatching = watchAuthorization(context, () => {
          controller.abort();
          downstream.close();
        });
        try {
          await deps.proxy.openWebSocket(
            {
              organizationId: context.share.organizationId,
              projectId: context.share.projectId,
              workspaceId: context.share.workspaceId,
              path:
                request.url.slice(PREVIEW_DATA_PREFIX.length) || '/',
              publicOrigin: previewOrigin(
                context.share.organizationId,
                context.share.id,
                deps.previewBaseDomain,
              ),
              headers: request.headers,
              signal: controller.signal,
            },
            downstream,
          );
        } finally {
          stopWatching();
        }
      },
    });
    previewDataApp.route({
      method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url: `${PREVIEW_DATA_PREFIX}/*`,
      config: { idempotency: 'exempt' },
      handler: async (request, reply) => await serveHttp(request, reply),
    });
    done();
  });
}

const PreviewRevocationRecordSchema = z
  .object({ organizationId: idSchema('org'), shareId: PreviewShareLocatorSchema })
  .strict();

export function createRedisPreviewRevocationSource(
  wakeups: EventWakeupSource,
  onError: (error: Error) => void = () => undefined,
): PreviewRevocationSource {
  const listeners = new Set<
    (record: { readonly organizationId: string; readonly shareId: string }) => void
  >();
  let controller: AbortController | undefined;
  const start = (): void => {
    if (controller !== undefined) return;
    controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      const subscription = await wakeups.subscribe(PREVIEW_REVOCATION_CHANNEL, signal);
      try {
        while (!signal.aborted) {
          const message = await subscription.next();
          const decoded =
            typeof message === 'string' ? (JSON.parse(message) as unknown) : message;
          const record = PreviewRevocationRecordSchema.parse(decoded);
          for (const listener of listeners) listener(record);
        }
      } finally {
        await subscription.close().catch(() => {
          subscription.abort();
        });
      }
    })().catch((error: unknown) => {
      if (!signal.aborted) onError(error instanceof Error ? error : new Error(String(error)));
    });
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          controller?.abort();
          controller = undefined;
        }
      };
    },
  };
}

export function createInMemoryPreviewShareStore(): PreviewShareStore & {
  readonly rows: StoredPreviewShare[];
} {
  const rows: StoredPreviewShare[] = [];
  return {
    rows,
    byOperation(organizationId, operationKey) {
      return Promise.resolve(
        rows.find(
          (row) => row.organizationId === organizationId && row.operationKey === operationKey,
        ),
      );
    },
    get(organizationId, shareId) {
      return Promise.resolve(
        rows.find((row) => row.organizationId === organizationId && row.id === shareId),
      );
    },
    list(organizationId, projectId) {
      return Promise.resolve(
        rows.filter(
          (row) => row.organizationId === organizationId && row.projectId === projectId,
        ),
      );
    },
    create(row) {
      const existing = rows.find(
        (candidate) =>
          candidate.organizationId === row.organizationId &&
          candidate.operationKey === row.operationKey,
      );
      if (existing !== undefined) return Promise.resolve(existing);
      rows.push(row);
      return Promise.resolve(row);
    },
    revoke(organizationId, workspaceId, shareId, now) {
      const index = rows.findIndex(
        (row) =>
          row.organizationId === organizationId &&
          row.workspaceId === workspaceId &&
          row.id === shareId,
      );
      if (index < 0) return Promise.resolve(undefined);
      const existing = rows[index] as StoredPreviewShare;
      const next =
        existing.revokedAt === null ? { ...existing, revokedAt: now, updatedAt: now } : existing;
      rows.splice(index, 1, next);
      return Promise.resolve(next);
    },
  };
}

export function createInMemoryPreviewSessionStore(
  now: () => Date = () => new Date(),
): PreviewSessionStore {
  const grants = new Map<
    string,
    PreviewSessionRecord & { redeemOperationKey?: string }
  >();
  const sessions = new Map<string, PreviewSessionRecord & { readonly secretHash: string }>();
  const key = (secret: string): string => digest(secret);
  return {
    issueGrant(record, grant) {
      const grantKey = key(grant);
      const existing = grants.get(grantKey);
      if (existing !== undefined) return Promise.resolve(existing);
      grants.set(grantKey, record);
      return Promise.resolve(record);
    },
    consumeGrant(record, grant, operationKey) {
      const grantKey = key(grant);
      const found = grants.get(grantKey);
      if (
        found === undefined ||
        found.organizationId !== record.organizationId ||
        found.shareId !== record.shareId ||
        found.expiresAt.getTime() <= now().getTime() ||
        (found.redeemOperationKey !== undefined &&
          found.redeemOperationKey !== operationKey)
      ) {
        return Promise.resolve(false);
      }
      grants.set(grantKey, { ...found, redeemOperationKey: operationKey });
      return Promise.resolve(true);
    },
    issueSession(record, credential) {
      const existing = sessions.get(credential.id);
      if (existing !== undefined) return Promise.resolve(existing);
      sessions.set(credential.id, { ...record, secretHash: digest(credential.secret) });
      return Promise.resolve(record);
    },
    authorize(cookie) {
      const separator = cookie.indexOf('.');
      if (separator < 1) return Promise.resolve(undefined);
      const id = cookie.slice(0, separator);
      const secret = cookie.slice(separator + 1);
      const found = sessions.get(id);
      return Promise.resolve(
        found !== undefined &&
          found.expiresAt.getTime() > now().getTime() &&
          found.secretHash === digest(secret)
          ? found
          : undefined,
      );
    },
    revoke(organizationId, shareId) {
      for (const [grantKey, record] of grants) {
        if (record.organizationId === organizationId && record.shareId === shareId) {
          grants.delete(grantKey);
        }
      }
      for (const [sessionId, record] of sessions) {
        if (record.organizationId === organizationId && record.shareId === shareId) {
          sessions.delete(sessionId);
        }
      }
      return Promise.resolve();
    },
  };
}

const GRANT_RECORD = z
  .object({
    organizationId: idSchema('org'),
    shareId: PreviewShareLocatorSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();
const SESSION_RECORD = GRANT_RECORD.extend({ secretHash: z.string().length(64) }).strict();
const REMEMBER_SECRET = `
  if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  redis.call('SADD', KEYS[2], KEYS[1])
  redis.call('PEXPIRE', KEYS[2], ARGV[2])
  return 1
`;
const REVOKE_SECRETS = `
  local keys = redis.call('SMEMBERS', KEYS[1])
  for _, key in ipairs(keys) do redis.call('DEL', key) end
  redis.call('DEL', KEYS[1])
  return #keys
`;
const CONSUME_GRANT = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then return false end
  local ok, record = pcall(cjson.decode, raw)
  if not ok then return false end
  if record.organizationId ~= ARGV[1] or record.shareId ~= ARGV[2] then return false end
  if record.redeemOperationKey and record.redeemOperationKey ~= ARGV[3] then return false end
  record.redeemOperationKey = ARGV[3]
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl <= 0 then return false end
  redis.call('SET', KEYS[1], cjson.encode(record), 'PX', ttl)
  return true
`;

export function createRedisPreviewSessionStore(
  redis: RedisCommands & RedisPublisher,
  now: () => Date = () => new Date(),
): PreviewSessionStore {
  const indexKey = (organizationId: string, shareId: string): string =>
    `preview:share:${organizationId}:${shareId}:secrets`;
  const grantKey = (grant: string): string => `preview:grant:${digest(grant)}`;
  const sessionKey = (id: string): string => `preview:session:${id}`;
  const remember = async (
    key: string,
    index: string,
    value: string,
    expiresAt: Date,
  ): Promise<string> => {
    const ttlMs = Math.max(1, expiresAt.getTime() - now().getTime());
    await redis.eval(REMEMBER_SECRET, [key, index], [value, ttlMs]);
    const stored = await redis.get(key);
    if (stored === null) throw new Error('Preview credential persistence failed');
    return stored;
  };
  const parseRecord = (raw: string): PreviewSessionRecord | undefined => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
    const parsed = GRANT_RECORD.safeParse(decoded);
    return parsed.success
      ? {
          organizationId: parsed.data.organizationId,
          shareId: parsed.data.shareId,
          expiresAt: new Date(parsed.data.expiresAt),
        }
      : undefined;
  };
  return {
    async issueGrant(record, grant) {
      const stored = await remember(
        grantKey(grant),
        indexKey(record.organizationId, record.shareId),
        JSON.stringify({ ...record, expiresAt: record.expiresAt.toISOString() }),
        record.expiresAt,
      );
      const issued = parseRecord(stored);
      if (issued === undefined) throw new Error('Stored preview grant is invalid');
      return issued;
    },
    async consumeGrant(record, grant, operationKey) {
      return (
        (await redis.eval(
          CONSUME_GRANT,
          [grantKey(grant)],
          [record.organizationId, record.shareId, operationKey],
        )) === 1
      );
    },
    async issueSession(record, credential) {
      const stored = await remember(
        sessionKey(credential.id),
        indexKey(record.organizationId, record.shareId),
        JSON.stringify({
          ...record,
          expiresAt: record.expiresAt.toISOString(),
          secretHash: digest(credential.secret),
        }),
        record.expiresAt,
      );
      const parsed = SESSION_RECORD.safeParse(JSON.parse(stored) as unknown);
      if (!parsed.success) throw new Error('Stored preview session is invalid');
      return {
        organizationId: parsed.data.organizationId,
        shareId: parsed.data.shareId,
        expiresAt: new Date(parsed.data.expiresAt),
      };
    },
    async authorize(cookie) {
      const separator = cookie.indexOf('.');
      if (separator < 1) return undefined;
      const raw = await redis.get(sessionKey(cookie.slice(0, separator)));
      if (raw === null) return undefined;
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw) as unknown;
      } catch {
        return undefined;
      }
      const parsed = SESSION_RECORD.safeParse(decoded);
      if (!parsed.success || new Date(parsed.data.expiresAt).getTime() <= now().getTime()) {
        return undefined;
      }
      const expected = Buffer.from(parsed.data.secretHash, 'hex');
      const received = Buffer.from(digest(cookie.slice(separator + 1)), 'hex');
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) return undefined;
      return {
        organizationId: parsed.data.organizationId,
        shareId: parsed.data.shareId,
        expiresAt: new Date(parsed.data.expiresAt),
      };
    },
    async revoke(organizationId, shareId) {
      await redis.eval(REVOKE_SECRETS, [indexKey(organizationId, shareId)], []);
      await redis.publish(
        'preview:revoked',
        JSON.stringify({ organizationId, shareId }),
      );
    },
  };
}

export interface SandboxPreviewProxyOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: typeof fetch;
}

function applicationCookie(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const kept = raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith(`${SESSION_COOKIE}=`));
  return kept.length === 0 ? undefined : kept.join('; ');
}

export function createSandboxPreviewProxy(options: SandboxPreviewProxyOptions): PreviewProxyPort {
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  return {
    async request(input) {
      const { token } = await signer.signServiceToken({
        service: 'control-api',
        aud: 'sandbox-service',
      });
      const rawCookie = input.headers.cookie;
      const cookie = applicationCookie(
        typeof rawCookie === 'string' ? rawCookie : rawCookie?.join('; '),
      );
      const sanitized = sanitizePreviewRequestHeaders(
        input.headers,
        cookie,
        input.publicOrigin,
      );
      const applicationHeaders = { ...sanitized };
      delete applicationHeaders.cookie;
      const headers: Record<string, string> = {
        ...applicationHeaders,
        'x-zapp-service-token': token,
        'x-zapp-organization-id': input.organizationId,
        'x-zapp-project-id': input.projectId,
        'x-zapp-preview-public-origin': input.publicOrigin.origin,
      };
      if (cookie !== undefined) headers['x-zapp-preview-app-cookie'] = cookie;
      const response = await doFetch(
        `${baseUrl}/internal/workspaces/${encodeURIComponent(input.workspaceId)}/preview${input.path}`,
        {
          method: input.method,
          headers,
          ...(input.body === undefined
            ? {}
            : { body: input.body as never, duplex: 'half' as const }),
          signal: input.signal,
          redirect: 'manual',
        },
      );
      const responseHeaders: Record<string, string | readonly string[]> = Object.fromEntries(
        response.headers.entries(),
      );
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length > 0) responseHeaders['set-cookie'] = setCookies;
      return {
        statusCode: response.status,
        headers: responseHeaders,
        body:
          response.body === null
            ? (async function* () {
                await Promise.resolve();
              })()
            : (response.body as unknown as AsyncIterable<Uint8Array>),
      };
    },
    async openWebSocket(input, downstream) {
      const { token } = await signer.signServiceToken({
        service: 'control-api',
        aud: 'sandbox-service',
      });
      const target = new URL(
        `/internal/workspaces/${encodeURIComponent(input.workspaceId)}/preview${input.path}`,
        `${baseUrl}/`,
      );
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      const rawCookie = input.headers.cookie;
      const cookie = applicationCookie(
        typeof rawCookie === 'string' ? rawCookie : rawCookie?.join('; '),
      );
      const sanitized = sanitizePreviewRequestHeaders(
        input.headers,
        cookie,
        input.publicOrigin,
      );
      const applicationHeaders = { ...sanitized };
      delete applicationHeaders.cookie;
      const headers: Record<string, string> = {
        ...applicationHeaders,
        'x-zapp-service-token': token,
        'x-zapp-organization-id': input.organizationId,
        'x-zapp-project-id': input.projectId,
        'x-zapp-preview-public-origin': input.publicOrigin.origin,
        ...(cookie === undefined ? {} : { 'x-zapp-preview-app-cookie': cookie }),
      };
      const upstream = new WebSocket(target, { headers });
      await new Promise<void>((resolve, reject) => {
        let opened = false;
        const abort = (): void => {
          upstream.close();
          downstream.close();
        };
        input.signal.addEventListener('abort', abort, { once: true });
        downstream.onMessage((data) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
        });
        downstream.onClose(() => {
          upstream.close();
        });
        downstream.onError(() => {
          upstream.close();
        });
        upstream.once('open', () => {
          opened = true;
        });
        upstream.on('message', (data) => {
          downstream.send(socketData(data));
        });
        upstream.once('error', (error) => {
          if (!opened) reject(error);
          else downstream.close();
        });
        upstream.once('close', () => {
          input.signal.removeEventListener('abort', abort);
          downstream.close();
          if (opened) resolve();
          else reject(new Error('Sandbox preview WebSocket closed before opening'));
        });
      });
    },
  };
}
