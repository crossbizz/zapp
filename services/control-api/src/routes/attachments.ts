import { createHash } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AttachmentRefSchema, idSchema } from '@zapp/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { operationOf, stableId } from './runs.js';

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 300;
const AttachmentParams = z.object({ attachmentId: idSchema('art') }).strict();
const ProjectParams = z.object({ projectId: idSchema('proj') }).strict();
const SignedAttachmentSchema = z
  .object({ url: z.string().url(), expiresAt: z.string().datetime() })
  .strict();

export interface AttachmentStoragePort {
  put(input: {
    readonly key: string;
    readonly body: Buffer;
    readonly contentType: string;
  }): Promise<void>;
  signGet(input: { readonly key: string; readonly expiresInSeconds: number }): Promise<string>;
}

export interface DeletableAttachmentStoragePort extends AttachmentStoragePort {
  delete(input: { readonly key: string }): Promise<void>;
}

export interface AttachmentRoutesDeps {
  readonly storage: AttachmentStoragePort;
  readonly now: () => Date;
}

const AttachmentMetadataSchema = AttachmentRefSchema.omit({ attachmentId: true }).strict();
interface PreparedAttachment {
  readonly body: Buffer;
  readonly contentHash: string;
  readonly metadata: z.infer<typeof AttachmentMetadataSchema>;
}

export function registerAttachmentRoutes(app: AppInstance, deps: AttachmentRoutesDeps): void {
  const prepared = new WeakMap<object, PreparedAttachment>();
  const prepareUpload = async (request: FastifyRequest): Promise<void> => {
    let upload;
    try {
      upload = await request.file({ limits: { files: 1, fileSize: MAX_ATTACHMENT_BYTES } });
    } catch (error) {
      if (isFileTooLarge(error)) throw attachmentTooLarge();
      throw error;
    }
    if (upload === undefined) throw attachmentRequired();
    if (!AttachmentRefSchema.shape.contentType.safeParse(upload.mimetype).success) {
      upload.file.resume();
      throw unsupportedAttachment();
    }
    let body: Buffer;
    try {
      body = await upload.toBuffer();
    } catch (error) {
      if (isFileTooLarge(error)) throw attachmentTooLarge();
      throw error;
    }
    if (body.length === 0) throw attachmentRequired();
    if (body.length > MAX_ATTACHMENT_BYTES || upload.file.truncated) throw attachmentTooLarge();
    const metadata = AttachmentMetadataSchema.parse({
      kind: 'image',
      name: upload.filename,
      byteSize: body.length,
      contentType: upload.mimetype,
    });
    const contentHash = createHash('sha256').update(body).digest('hex');
    prepared.set(request, { body, contentHash, metadata });
    // The idempotency hook runs after the route's preHandlers. Give it a
    // canonical, secret-free representation of multipart bytes so the same key
    // cannot replay a response for a different image.
    request.body = { ...metadata, contentHash };
  };

  app.post(
    '/v1/projects/:projectId/attachments',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant, prepareUpload],
      schema: {
        consumes: ['multipart/form-data'],
        params: ProjectParams,
        body: z.any().optional(),
        response: { 201: AttachmentRefSchema },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      authorize(ctx, 'edit_code');
      const operationKey = operationOf(request);
      const attachmentId = stableId('art', operationKey);
      const upload = prepared.get(request);
      if (upload === undefined) throw attachmentRequired();
      const { body, contentHash, metadata } = upload;
      const existing = await ctx.db.attachments.getById(attachmentId);
      if (existing !== undefined) {
        if (existing.contentHash !== contentHash) throw idempotencyConflict();
        return await reply.status(201).send(
          AttachmentRefSchema.parse({
            attachmentId: existing.id,
            ...AttachmentMetadataSchema.parse(existing.metadataJson),
          }),
        );
      }
      const storageRef = `${ctx.organizationId}/${project.id}/attachments/${attachmentId}`;
      await deps.storage.put({ key: storageRef, body, contentType: metadata.contentType });
      const created = await ctx.db.attachments.create({
        id: attachmentId,
        projectId: project.id,
        storageRef,
        contentHash,
        metadata,
        createdAt: deps.now(),
        audit: async (tx, artifact) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'attachment.created',
            target: { type: 'artifact', id: artifact.id },
            metadata: { projectId: project.id, operationKey, ...metadata },
          });
        },
      });
      if (created === undefined) throw projectNotFound();
      return await reply.status(201).send(
        AttachmentRefSchema.parse({
          attachmentId: created.id,
          ...AttachmentMetadataSchema.parse(created.metadataJson),
        }),
      );
    },
  );

  app.get(
    '/v1/attachments/:attachmentId',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: AttachmentParams,
        response: { 200: SignedAttachmentSchema },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const attachment = await ctx.db.attachments.getById(request.params.attachmentId);
      if (attachment === undefined) throw attachmentNotFound();
      authorize(ctx, 'view_project');
      const url = await deps.storage.signGet({
        key: attachment.storageRef,
        expiresInSeconds: SIGNED_URL_TTL_SECONDS,
      });
      return {
        url,
        expiresAt: new Date(deps.now().getTime() + SIGNED_URL_TTL_SECONDS * 1_000).toISOString(),
      };
    },
  );
}

export function createS3AttachmentStorage(config: {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}): DeletableAttachmentStoragePort {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    // Both Cloudflare R2 and the development MinIO service implement the
    // S3-compatible path-style form; it also avoids bucket-as-host DNS inside compose.
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return {
    async put(input) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );
    },
    async delete(input) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: input.key }));
    },
    signGet(input) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: config.bucket, Key: input.key }),
        { expiresIn: input.expiresInSeconds },
      );
    },
  };
}

export function createUnavailableAttachmentStorage(): AttachmentStoragePort {
  const unavailable = (): Promise<never> =>
    Promise.reject(new ApiError('attachment_storage_unavailable', 503, 'Attachment storage is unavailable.'));
  return { put: unavailable, signGet: unavailable };
}

function isFileTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE'
  );
}

function attachmentRequired(): ApiError {
  return new ApiError('attachment_required', 400, 'One non-empty image file is required.');
}
function attachmentTooLarge(): ApiError {
  return new ApiError('attachment_too_large', 413, 'Images must not exceed 8 MiB.');
}
function unsupportedAttachment(): ApiError {
  return new ApiError('attachment_type_unsupported', 415, 'That image type is not supported.');
}
function attachmentNotFound(): ApiError {
  return new ApiError('attachment_not_found', 404, 'That attachment does not exist.');
}
function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'That project does not exist.');
}
function idempotencyConflict(): ApiError {
  return new ApiError(
    'idempotency_conflict',
    422,
    'That Idempotency-Key was already used for a different attachment.',
  );
}
