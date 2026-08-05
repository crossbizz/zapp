import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { idSchema, internalRepoRef, InternalRepoRefSchema } from '@zapp/contracts';
import {
  branches as branchesTable,
  repositories as repositoriesTable,
  type Database,
} from '@zapp/db';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';

import { DEFAULT_TOKEN_TTL_SECONDS } from './tokens.js';

export const BackupDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    if (value.startsWith('0000-')) {
      return false;
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });

const BackupKeyInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    date: BackupDateSchema,
  })
  .strict();

const SafeCloneUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'credentials are not allowed in URLs',
      });
    }
  });

const RefNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !/[\u0000-\u0020\u007f~^:?*[\\]/.test(value) &&
      !value.includes('..') &&
      !value.includes('@{') &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value
        .split('/')
        .some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock')),
  );

const FullRefNameSchema = z
  .string()
  .startsWith('refs/')
  .refine((value) => RefNameSchema.safeParse(value.slice('refs/'.length)).success);

export const BackupRepositorySchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    internalRepoRef: InternalRepoRefSchema,
    cloneUrl: SafeCloneUrlSchema,
    defaultBranch: RefNameSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.internalRepoRef ===
      internalRepoRef({
        organizationId: value.organizationId,
        projectId: value.projectId,
      }),
  );

export type BackupRepository = z.infer<typeof BackupRepositorySchema>;

const ExpectedBranchSchema = z
  .object({
    name: RefNameSchema,
    headCommitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .nullable(),
  })
  .strict();

export type ExpectedBranch = z.infer<typeof ExpectedBranchSchema>;

const BranchRestoreEvidenceSchema = z
  .object({
    name: RefNameSchema,
    expectedSha: z.string().regex(/^[0-9a-f]{40}$/i),
    actualSha: z.string().regex(/^[0-9a-f]{40}$/i),
  })
  .strict();

const RestoredRefEvidenceSchema = z
  .object({
    name: FullRefNameSchema,
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
  })
  .strict();

export const RestoreRepositoryResultSchema = z
  .object({
    checkedBranches: z.number().int().nonnegative(),
    branches: z.array(BranchRestoreEvidenceSchema),
    refs: z.array(RestoredRefEvidenceSchema),
  })
  .strict();

export type RestoreRepositoryResult = z.infer<typeof RestoreRepositoryResultSchema>;

const BackupObjectSchema = z
  .object({
    key: z.string().min(1),
    lastModified: z.date(),
  })
  .strict();

export type BackupObject = z.infer<typeof BackupObjectSchema>;

export interface BackupUploadSource {
  readonly contentLength: number;
  readonly contentType?: string;
  open(range?: { readonly start: number; readonly endExclusive: number }): Readable;
}

export type BackupPutResult = 'created' | 'existing';

export interface BackupObjectStore {
  exists(key: string): Promise<boolean>;
  put(key: string, source: BackupUploadSource): Promise<BackupPutResult>;
  get(key: string): Promise<Readable>;
  list(
    prefix: string,
    continuationToken?: string,
  ): Promise<{ readonly objects: readonly BackupObject[]; readonly continuationToken?: string }>;
  delete(key: string): Promise<void>;
}

export type S3ClientPortCommand =
  | AbortMultipartUploadCommand
  | CompleteMultipartUploadCommand
  | CreateMultipartUploadCommand
  | DeleteObjectCommand
  | GetObjectCommand
  | HeadObjectCommand
  | ListObjectsV2Command
  | PutObjectCommand
  | UploadPartCommand;

export interface S3ClientPort {
  send(
    command: S3ClientPortCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown>;
  /** Closes pooled sockets without invalidating future requests on the client. */
  destroy(): void;
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) {
    return undefined;
  }
  const metadata = (error as { readonly $metadata?: unknown }).$metadata;
  if (typeof metadata !== 'object' || metadata === null || !('httpStatusCode' in metadata)) {
    return undefined;
  }
  const status = (metadata as { readonly httpStatusCode?: unknown }).httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;
const R2_MIN_MULTIPART_PART_BYTES = 5 * MIB;
const R2_MAX_MULTIPART_PART_BYTES = 5 * GIB;
const R2_MAX_MULTIPART_PARTS = 10_000;
const R2_MAX_OBJECT_BYTES = 5 * TIB;
const RETRYABLE_HTTP_STATUSES = new Set([409, 429, 500, 502, 503, 504]);
const RETRYABLE_TRANSPORT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);
const RETRYABLE_TRANSPORT_NAMES = new Set(['NetworkingError', 'RequestTimeout', 'TimeoutError']);

export function multipartUploadLayout(
  contentLength: number,
  configuredPartSizeBytes: number,
): { readonly partSizeBytes: number; readonly partCount: number } {
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > R2_MAX_OBJECT_BYTES
  ) {
    throw new Error('Backup exceeds the R2 object size limit');
  }
  if (
    !Number.isSafeInteger(configuredPartSizeBytes) ||
    configuredPartSizeBytes < R2_MIN_MULTIPART_PART_BYTES ||
    configuredPartSizeBytes > R2_MAX_MULTIPART_PART_BYTES
  ) {
    throw new Error('Invalid multipart part size');
  }
  const partSizeBytes = Math.max(
    configuredPartSizeBytes,
    Math.ceil(contentLength / R2_MAX_MULTIPART_PARTS),
  );
  if (partSizeBytes > R2_MAX_MULTIPART_PART_BYTES) {
    throw new Error('Multipart upload exceeds the R2 part size limit');
  }
  return {
    partSizeBytes,
    partCount: Math.ceil(contentLength / partSizeBytes),
  };
}

function retryable(error: unknown): boolean {
  const status = httpStatus(error);
  if (status !== undefined && RETRYABLE_HTTP_STATUSES.has(status)) {
    return true;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { readonly code?: unknown; readonly name?: unknown };
  return (
    (typeof candidate.code === 'string' && RETRYABLE_TRANSPORT_CODES.has(candidate.code)) ||
    (typeof candidate.name === 'string' && RETRYABLE_TRANSPORT_NAMES.has(candidate.name))
  );
}

export function createS3BackupObjectStore(options: {
  readonly client: S3ClientPort;
  /** One disposable transport per conditional streamed PUT. */
  readonly createConditionalClient: () => S3ClientPort;
  readonly bucket: string;
  readonly timeoutMs: number;
  readonly multipartThresholdBytes?: number;
  readonly multipartPartSizeBytes?: number;
  readonly multipartConcurrency?: number;
  readonly uploadDeadlineMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
}): BackupObjectStore {
  const parsed = z
    .object({
      bucket: z
        .string()
        .min(3)
        .max(63)
        .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
      timeoutMs: z.number().int().min(100).max(300_000),
      multipartThresholdBytes: z
        .number()
        .int()
        .min(1)
        .max(5 * 1024 * MIB)
        .default(100 * MIB),
      multipartPartSizeBytes: z
        .number()
        .int()
        .min(5 * MIB)
        .max(5 * 1024 * MIB)
        .default(10 * MIB),
      multipartConcurrency: z.number().int().min(1).max(16).default(4),
      uploadDeadlineMs: z.number().int().min(100).max(7_200_000).default(1_800_000),
      maxAttempts: z.number().int().min(1).max(5).default(3),
      retryBaseDelayMs: z.number().int().min(0).max(10_000).default(100),
    })
    .strict()
    .safeParse({
      bucket: options.bucket,
      timeoutMs: options.timeoutMs,
      multipartThresholdBytes: options.multipartThresholdBytes,
      multipartPartSizeBytes: options.multipartPartSizeBytes,
      multipartConcurrency: options.multipartConcurrency,
      uploadDeadlineMs: options.uploadDeadlineMs,
      maxAttempts: options.maxAttempts,
      retryBaseDelayMs: options.retryBaseDelayMs,
    });
  if (!parsed.success) {
    throw new Error('Invalid object store configuration');
  }
  const config = parsed.data;

  const send = async (command: S3ClientPortCommand): Promise<unknown> =>
    await options.client.send(command, {
      abortSignal: AbortSignal.timeout(config.timeoutMs),
    });

  async function sendWithRetry(
    client: S3ClientPort,
    command: () => S3ClientPortCommand,
    signal: AbortSignal,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      try {
        return await client.send(command(), { abortSignal: signal });
      } catch (error) {
        lastError = error;
        if (attempt === config.maxAttempts || !retryable(error) || signal.aborted) {
          throw error;
        }
        await delay(config.retryBaseDelayMs * 2 ** (attempt - 1), undefined, { signal });
      }
    }
    throw lastError;
  }

  async function abortMultipart(key: string, uploadId: string): Promise<void> {
    try {
      await options.client.send(
        new AbortMultipartUploadCommand({
          Bucket: config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
        { abortSignal: AbortSignal.timeout(config.timeoutMs) },
      );
    } catch {
      // The original upload failure remains authoritative. R2 also expires
      // incomplete multipart uploads, but this best-effort abort is the normal cleanup path.
    }
  }

  async function finalObjectExists(key: string): Promise<boolean> {
    const reconciliationSignal = AbortSignal.timeout(config.timeoutMs);
    try {
      await sendWithRetry(
        options.client,
        () => new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
        reconciliationSignal,
      );
      return true;
    } catch (error) {
      if (httpStatus(error) === 404) {
        return false;
      }
      throw error;
    }
  }

  async function completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly { readonly PartNumber: number; readonly ETag: string }[],
    signal: AbortSignal,
  ): Promise<BackupPutResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      try {
        await options.client.send(
          new CompleteMultipartUploadCommand({
            Bucket: config.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: [...parts] },
            IfNoneMatch: '*',
          }),
          { abortSignal: signal },
        );
        return 'created';
      } catch (error) {
        lastError = error;
        if (httpStatus(error) === 412) {
          return 'existing';
        }
        if (signal.aborted || retryable(error)) {
          if (await finalObjectExists(key)) {
            return 'existing';
          }
        }
        if (
          httpStatus(error) === 409 ||
          !retryable(error) ||
          signal.aborted ||
          attempt === config.maxAttempts
        ) {
          throw error;
        }
        await delay(config.retryBaseDelayMs * 2 ** (attempt - 1), undefined, { signal });
      }
    }
    throw lastError;
  }

  async function multipartAttempt(
    key: string,
    source: BackupUploadSource,
    deadline: AbortSignal,
  ): Promise<BackupPutResult> {
    const layout = multipartUploadLayout(source.contentLength, config.multipartPartSizeBytes);
    const created = await sendWithRetry(
      options.client,
      () =>
        new CreateMultipartUploadCommand({
          Bucket: config.bucket,
          Key: key,
          ContentType: source.contentType ?? 'application/x-git-bundle',
        }),
      deadline,
    );
    const uploadId =
      typeof created === 'object' && created !== null && 'UploadId' in created
        ? (created as { readonly UploadId?: unknown }).UploadId
        : undefined;
    if (typeof uploadId !== 'string' || uploadId === '') {
      throw new Error('Multipart upload response carried no upload id');
    }

    const controller = new AbortController();
    const signal = AbortSignal.any([deadline, controller.signal]);
    const { partCount, partSizeBytes } = layout;
    const parts: { PartNumber: number; ETag: string }[] = [];
    let nextPart = 0;

    const workers = Array.from(
      { length: Math.min(config.multipartConcurrency, partCount) },
      async () => {
        for (;;) {
          const index = nextPart;
          nextPart += 1;
          if (index >= partCount) {
            return;
          }
          const start = index * partSizeBytes;
          const endExclusive = Math.min(start + partSizeBytes, source.contentLength);
          const response = await sendWithRetry(
            options.client,
            () =>
              new UploadPartCommand({
                Bucket: config.bucket,
                Key: key,
                UploadId: uploadId,
                PartNumber: index + 1,
                Body: source.open({ start, endExclusive }),
                ContentLength: endExclusive - start,
              }),
            signal,
          );
          const etag =
            typeof response === 'object' && response !== null && 'ETag' in response
              ? (response as { readonly ETag?: unknown }).ETag
              : undefined;
          if (typeof etag !== 'string' || etag === '') {
            throw new Error('Multipart part response carried no ETag');
          }
          parts.push({ PartNumber: index + 1, ETag: etag });
        }
      },
    );

    try {
      await Promise.all(workers);
      parts.sort((left, right) => left.PartNumber - right.PartNumber);
      const result = await completeMultipart(key, uploadId, parts, signal);
      if (result === 'existing') {
        await abortMultipart(key, uploadId);
      }
      return result;
    } catch (error) {
      controller.abort();
      await Promise.allSettled(workers);
      await abortMultipart(key, uploadId);
      throw error;
    }
  }

  return {
    async exists(key: string): Promise<boolean> {
      try {
        await send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return true;
      } catch (error) {
        if (httpStatus(error) === 404) {
          return false;
        }
        throw error;
      }
    },

    async put(key: string, source: BackupUploadSource): Promise<BackupPutResult> {
      if (
        !Number.isSafeInteger(source.contentLength) ||
        source.contentLength <= 0 ||
        typeof source.open !== 'function'
      ) {
        throw new Error('Invalid backup upload source');
      }
      if (source.contentLength > R2_MAX_OBJECT_BYTES) {
        throw new Error('Backup exceeds the R2 object size limit');
      }
      const deadline = AbortSignal.timeout(config.uploadDeadlineMs);
      if (source.contentLength < config.multipartThresholdBytes) {
        const conditionalClient = options.createConditionalClient();
        try {
          await sendWithRetry(
            conditionalClient,
            () =>
              new PutObjectCommand({
                Bucket: config.bucket,
                Key: key,
                Body: source.open(),
                ContentLength: source.contentLength,
                ContentType: source.contentType ?? 'application/x-git-bundle',
                IfNoneMatch: '*',
              }),
            deadline,
          );
          return 'created';
        } catch (error) {
          if (httpStatus(error) === 412) {
            return 'existing';
          }
          if (deadline.aborted || retryable(error)) {
            if (await finalObjectExists(key)) {
              return 'existing';
            }
          }
          throw error;
        } finally {
          // Conditional stream failures can poison their keep-alive socket.
          // This client owns only this PUT, so destroying it cannot abort a
          // concurrent multipart part or an independent reconciliation HEAD.
          conditionalClient.destroy();
        }
      }

      for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
        try {
          return await multipartAttempt(key, source, deadline);
        } catch (error) {
          if (httpStatus(error) !== 409 || attempt === config.maxAttempts || deadline.aborted) {
            throw error;
          }
          await delay(config.retryBaseDelayMs * 2 ** (attempt - 1), undefined, {
            signal: deadline,
          });
        }
      }
      throw new Error('Multipart upload attempts exhausted');
    },

    async get(key: string): Promise<Readable> {
      const response = await send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      const body =
        typeof response === 'object' && response !== null && 'Body' in response
          ? (response as { readonly Body?: unknown }).Body
          : undefined;
      if (!(body instanceof Readable)) {
        throw new Error('Object download response carried no Node stream');
      }
      return body;
    },

    async list(prefix: string, continuationToken?: string) {
      const response = await send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        }),
      );
      if (typeof response !== 'object' || response === null) {
        throw new Error('Invalid object listing response');
      }
      const value = response as {
        readonly Contents?: readonly {
          readonly Key?: unknown;
          readonly LastModified?: unknown;
        }[];
        readonly NextContinuationToken?: unknown;
      };
      const objects = (value.Contents ?? []).map((object) => {
        if (typeof object.Key !== 'string' || !(object.LastModified instanceof Date)) {
          throw new Error('Invalid object listing response');
        }
        return { key: object.Key, lastModified: object.LastModified };
      });
      const next = value.NextContinuationToken;
      if (next !== undefined && typeof next !== 'string') {
        throw new Error('Invalid object listing response');
      }
      return {
        objects,
        ...(next === undefined ? {} : { continuationToken: next }),
      };
    },

    async delete(key: string): Promise<void> {
      await send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}

export function createR2BackupObjectStore(config: {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly region: string;
  readonly timeoutMs?: number;
  readonly multipartThresholdBytes?: number;
  readonly multipartPartSizeBytes?: number;
  readonly multipartConcurrency?: number;
  readonly uploadDeadlineMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
}): BackupObjectStore {
  const endpoint = new URL(config.endpoint);
  const clientOptions = {
    endpoint: endpoint.toString().replace(/\/$/, ''),
    region: config.region,
    maxAttempts: 1,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Cloudflare's documented endpoint uses virtual-host addressing. The local
    // MinIO dev stack is on loopback and needs path-style bucket addressing.
    forcePathStyle:
      endpoint.hostname === 'localhost' ||
      endpoint.hostname === '127.0.0.1' ||
      endpoint.hostname === 'minio',
  };
  const createClient = (): S3Client => new S3Client(clientOptions);
  const client = createClient();
  return createS3BackupObjectStore({
    client,
    createConditionalClient: createClient,
    bucket: config.bucket,
    timeoutMs: config.timeoutMs ?? 30_000,
    ...(config.multipartThresholdBytes === undefined
      ? {}
      : { multipartThresholdBytes: config.multipartThresholdBytes }),
    ...(config.multipartPartSizeBytes === undefined
      ? {}
      : { multipartPartSizeBytes: config.multipartPartSizeBytes }),
    ...(config.multipartConcurrency === undefined
      ? {}
      : { multipartConcurrency: config.multipartConcurrency }),
    ...(config.uploadDeadlineMs === undefined ? {} : { uploadDeadlineMs: config.uploadDeadlineMs }),
    ...(config.maxAttempts === undefined ? {} : { maxAttempts: config.maxAttempts }),
    ...(config.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: config.retryBaseDelayMs }),
  });
}

export interface BackupGit {
  createBundle(cloneUrl: string, bundlePath: string): Promise<void>;
  verifyBundle(bundlePath: string): Promise<void>;
}

export type PreparedRestore =
  | { readonly kind: 'bundle'; readonly mirrorPath: string }
  | { readonly kind: 'empty'; readonly mirrorPath: string };
export type BackupRepresentation = 'bundle' | 'empty';

export interface RestorePreparationGit {
  verifyBundle(bundlePath: string): Promise<void>;
  prepareRestore(bundlePath: string, mirrorPath: string): Promise<PreparedRestore>;
}

export interface RestoreBackupInspectionGit extends RestorePreparationGit {
  backupRepresentation(bundlePath: string): Promise<BackupRepresentation>;
}

export interface RestoreRemoteGit {
  pushMirror(mirrorPath: string, targetCloneUrl: string, deadlineAt: Date): Promise<void>;
  remoteRefs(targetCloneUrl: string, deadlineAt: Date): Promise<ReadonlyMap<string, string>>;
}

export type GitBundleCommands = BackupGit & RestoreBackupInspectionGit & RestoreRemoteGit;

export interface GitCommandCall {
  readonly args: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly signal: AbortSignal;
}

export type GitCommandExecutor = (call: GitCommandCall) => Promise<{ readonly stdout: string }>;

export interface GitAskpassFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: string, options: { readonly mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(path: string, options: { readonly recursive: boolean; readonly force: boolean }): Promise<void>;
}

function defaultGitExecutor(call: GitCommandCall): Promise<{ readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...call.args],
      {
        env: { ...call.env },
        signal: call.signal,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error instanceof Error ? error : new Error('Git process failed'));
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

const AskpassScript = `#!/bin/sh
case "$1" in
  *sername*) printf '%s\\n' "$ZAPP_GIT_USERNAME" ;;
  *) printf '%s\\n' "$ZAPP_GIT_PASSWORD" ;;
esac
`;

const EMPTY_REPOSITORY_BACKUP = Buffer.from(
  'zapp.build git backup\nversion=1\nrepository=empty\n',
  'utf8',
);
const EMPTY_RESTORE_SENTINEL_REF = 'refs/zapp-build/empty-restore-sentinel';
const EMPTY_RESTORE_SENTINEL_FILE = 'zapp-empty-restore';

async function isEmptyRepositoryBackup(bundlePath: string): Promise<boolean> {
  try {
    const details = await stat(bundlePath);
    if (!details.isFile() || details.size !== EMPTY_REPOSITORY_BACKUP.byteLength) {
      return false;
    }
    return (await readFile(bundlePath)).equals(EMPTY_REPOSITORY_BACKUP);
  } catch {
    return false;
  }
}

async function isEmptyRestoreMirror(mirrorPath: string): Promise<boolean> {
  try {
    return (await readFile(join(mirrorPath, EMPTY_RESTORE_SENTINEL_FILE), 'utf8')) === 'version=1\n';
  } catch {
    return false;
  }
}

function safeGitUrl(value: string): string {
  const parsed = SafeCloneUrlSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Invalid Git URL');
  }
  return parsed.data;
}

export function createGitBundleCommands(options: {
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
  readonly executor?: GitCommandExecutor;
  readonly now?: () => Date;
  readonly askpassFileSystem?: GitAskpassFileSystem;
}): GitBundleCommands {
  const parsed = z
    .object({
      username: z.string().min(1),
      password: z.string().min(1),
      timeoutMs: z.number().int().min(100).max(7_200_000),
    })
    .strict()
    .safeParse({
      username: options.username,
      password: options.password,
      timeoutMs: options.timeoutMs,
    });
  if (!parsed.success) {
    throw new Error('Invalid Git backup command configuration');
  }
  const commandConfig = parsed.data;
  const executor = options.executor ?? defaultGitExecutor;
  const now = options.now ?? ((): Date => new Date());
  const askpassFileSystem = options.askpassFileSystem ?? { mkdtemp, writeFile, chmod, rm };

  async function withAskpass<T>(operation: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const directory = await askpassFileSystem.mkdtemp(join(tmpdir(), 'zapp-git-askpass-'));
    const askpass = join(directory, 'askpass.sh');
    try {
      await askpassFileSystem.writeFile(askpass, AskpassScript, { mode: 0o700 });
      await askpassFileSystem.chmod(askpass, 0o700);
      return await operation({
        PATH: process.env['PATH'] ?? '',
        LANG: process.env['LANG'] ?? 'C',
        GIT_ASKPASS: askpass,
        GIT_ASKPASS_REQUIRE: 'force',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        ZAPP_GIT_USERNAME: commandConfig.username,
        ZAPP_GIT_PASSWORD: commandConfig.password,
      });
    } finally {
      await askpassFileSystem.rm(directory, { recursive: true, force: true });
    }
  }

  async function execute(
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    deadlineAt?: Date,
  ): Promise<string> {
    const timeoutMs =
      deadlineAt === undefined
        ? commandConfig.timeoutMs
        : Math.floor(deadlineAt.getTime() - now().getTime());
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 7_200_000) {
      throw new Error('Invalid Git command deadline');
    }
    const result = await executor({
      args,
      env,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return result.stdout;
  }

  return {
    async backupRepresentation(bundlePath: string): Promise<BackupRepresentation> {
      return (await isEmptyRepositoryBackup(bundlePath)) ? 'empty' : 'bundle';
    },

    async createBundle(cloneUrl: string, bundlePath: string): Promise<void> {
      const url = safeGitUrl(cloneUrl);
      const directory = await mkdtemp(join(tmpdir(), 'zapp-git-mirror-'));
      const mirror = join(directory, 'repository.git');
      try {
        await withAskpass(async (env) => {
          try {
            await execute(['clone', '--mirror', url, mirror], env);
          } catch {
            throw new Error('Git clone for backup failed');
          }
          try {
            const refs = await execute(['-C', mirror, 'for-each-ref', '--format=%(refname)'], env);
            if (refs.trim() === '') {
              await writeFile(bundlePath, EMPTY_REPOSITORY_BACKUP, { flag: 'wx' });
            } else {
              await execute(['-C', mirror, 'bundle', 'create', bundlePath, '--all'], env);
            }
          } catch {
            throw new Error('Git bundle creation command failed');
          }
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },

    async verifyBundle(bundlePath: string): Promise<void> {
      if (await isEmptyRepositoryBackup(bundlePath)) {
        return;
      }
      try {
        await execute(['bundle', 'verify', bundlePath], {
          PATH: process.env['PATH'] ?? '',
          LANG: process.env['LANG'] ?? 'C',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        });
      } catch {
        throw new Error('Git bundle verification command failed');
      }
    },

    async prepareRestore(bundlePath: string, mirrorPath: string): Promise<PreparedRestore> {
      if (await isEmptyRepositoryBackup(bundlePath)) {
        try {
          await execute(['init', '--bare', mirrorPath], {
            PATH: process.env['PATH'] ?? '',
            LANG: process.env['LANG'] ?? 'C',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          });
          const localEnvironment = {
            PATH: process.env['PATH'] ?? '',
            LANG: process.env['LANG'] ?? 'C',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          };
          const emptyTree = (
            await execute(['-C', mirrorPath, 'hash-object', '-t', 'tree', '-w', '/dev/null'], {
              ...localEnvironment,
            })
          ).trim();
          const sentinelCommit = (
            await execute(
              [
                '-C',
                mirrorPath,
                '-c',
                'user.name=zapp.build restore',
                '-c',
                'user.email=restore@zapp.build',
                'commit-tree',
                emptyTree,
                '-m',
                'empty repository restore sentinel',
              ],
              { ...localEnvironment },
            )
          ).trim();
          await execute(
            ['-C', mirrorPath, 'update-ref', EMPTY_RESTORE_SENTINEL_REF, sentinelCommit],
            { ...localEnvironment },
          );
          await writeFile(join(mirrorPath, EMPTY_RESTORE_SENTINEL_FILE), 'version=1\n', {
            flag: 'wx',
          });
        } catch {
          throw new Error('Git empty mirror preparation failed');
        }
        return { kind: 'empty', mirrorPath };
      }
      try {
        await execute(['clone', '--mirror', bundlePath, mirrorPath], {
          PATH: process.env['PATH'] ?? '',
          LANG: process.env['LANG'] ?? 'C',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        });
      } catch {
        throw new Error('Git bundle mirror preparation failed');
      }
      return { kind: 'bundle', mirrorPath };
    },

    async pushMirror(mirrorPath: string, targetCloneUrl: string, deadlineAt: Date): Promise<void> {
      const url = safeGitUrl(targetCloneUrl);
      await withAskpass(async (env) => {
        try {
          await execute(['-C', mirrorPath, 'push', '--mirror', url], env, deadlineAt);
          if (await isEmptyRestoreMirror(mirrorPath)) {
            await execute(
              ['-C', mirrorPath, 'push', url, `:${EMPTY_RESTORE_SENTINEL_REF}`],
              env,
              deadlineAt,
            );
          }
        } catch {
          throw new Error('Git mirror push command failed');
        }
      });
    },

    async remoteRefs(
      targetCloneUrl: string,
      deadlineAt: Date,
    ): Promise<ReadonlyMap<string, string>> {
      const url = safeGitUrl(targetCloneUrl);
      let stdout: string;
      try {
        stdout = await withAskpass(
          async (env) => await execute(['ls-remote', '--refs', url], env, deadlineAt),
        );
      } catch {
        throw new Error('Git remote ref listing failed');
      }
      const refs = new Map<string, string>();
      for (const line of stdout.split('\n')) {
        if (line === '') {
          continue;
        }
        const match = /^([0-9a-f]{40})\t(.+)$/i.exec(line);
        if (
          match?.[1] === undefined ||
          match[2] === undefined ||
          !FullRefNameSchema.safeParse(match[2]).success
        ) {
          throw new Error('Git remote ref listing was invalid');
        }
        refs.set(match[2], match[1]);
      }
      return refs;
    },
  };
}

export interface BackupInventory {
  listProvisionedRepositories(): Promise<readonly BackupRepository[]>;
  expectedBranches(organizationId: string, projectId: string): Promise<readonly ExpectedBranch[]>;
}

export function createDbBackupInventory(
  database: Database,
  forgejoBaseUrl: string,
): BackupInventory {
  const baseUrl = SafeCloneUrlSchema.safeParse(forgejoBaseUrl);
  if (!baseUrl.success) {
    throw new Error('Invalid Forgejo base URL for backup inventory');
  }
  const normalizedBase = `${baseUrl.data.replace(/\/+$/, '')}/`;

  return {
    async listProvisionedRepositories(): Promise<readonly BackupRepository[]> {
      const rows = await database
        .select({
          organizationId: repositoriesTable.organizationId,
          projectId: repositoriesTable.projectId,
          internalRepoRef: repositoriesTable.internalRepoRef,
          defaultBranch: repositoriesTable.defaultBranch,
        })
        .from(repositoriesTable)
        .where(
          and(
            eq(repositoriesTable.provider, 'internal'),
            isNotNull(repositoriesTable.provisionedAt),
          ),
        )
        .orderBy(asc(repositoriesTable.organizationId), asc(repositoriesTable.projectId));

      const parsed = z.array(BackupRepositorySchema).safeParse(
        rows.map((row) => ({
          ...row,
          cloneUrl: new URL(`${row.internalRepoRef}.git`, normalizedBase).toString(),
        })),
      );
      if (!parsed.success) {
        throw new Error('Invalid provisioned repository inventory');
      }
      return parsed.data;
    },

    async expectedBranches(
      organizationId: string,
      projectId: string,
    ): Promise<readonly ExpectedBranch[]> {
      const ids = BackupKeyInputSchema.omit({ date: true }).safeParse({
        organizationId,
        projectId,
      });
      if (!ids.success) {
        throw new Error('Invalid branch inventory scope');
      }
      const rows = await database
        .select({
          name: branchesTable.name,
          headCommitSha: branchesTable.headCommitSha,
        })
        .from(branchesTable)
        .where(
          and(
            eq(branchesTable.organizationId, ids.data.organizationId),
            eq(branchesTable.projectId, ids.data.projectId),
          ),
        )
        .orderBy(asc(branchesTable.name));
      const parsed = z.array(ExpectedBranchSchema).safeParse(rows);
      if (!parsed.success) {
        throw new Error('Invalid expected branch inventory');
      }
      return parsed.data;
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function backupPrefix(input: {
  readonly organizationId: string;
  readonly projectId: string;
}): string {
  const parsed = BackupKeyInputSchema.omit({ date: true }).safeParse({
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!parsed.success) {
    throw new Error('Invalid backup prefix input');
  }
  return `org/${parsed.data.organizationId}/project/${parsed.data.projectId}/git-backups/`;
}

function utcDate(now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new Error('Invalid backup clock');
  }
  return now.toISOString().slice(0, 10);
}

export function backupKey(input: z.input<typeof BackupKeyInputSchema>): string {
  const parsed = BackupKeyInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('Invalid backup key input');
  }
  const { organizationId, projectId, date } = parsed.data;
  return `org/${organizationId}/project/${projectId}/git-backups/${date}.bundle`;
}

export async function enforceBackupRetention(
  store: BackupObjectStore,
  input: { readonly organizationId: string; readonly projectId: string; readonly now: Date },
): Promise<void> {
  const prefix = backupPrefix(input);
  const objects: BackupObject[] = [];
  const seenTokens = new Set<string>();
  let continuationToken: string | undefined;

  for (;;) {
    const page = await store.list(prefix, continuationToken);
    const parsed = z
      .object({
        objects: z.array(BackupObjectSchema),
        continuationToken: z.string().min(1).optional(),
      })
      .strict()
      .safeParse(page);
    if (!parsed.success || parsed.data.objects.some((object) => !object.key.startsWith(prefix))) {
      throw new Error('Invalid object listing response');
    }
    objects.push(...parsed.data.objects);
    const next = parsed.data.continuationToken;
    if (next === undefined) {
      break;
    }
    if (seenTokens.has(next)) {
      throw new Error('Object listing pagination did not advance');
    }
    seenTokens.add(next);
    continuationToken = next;
  }

  const dated = objects.map((object) => {
    const suffix = object.key.slice(prefix.length);
    const match = /^(\d{4}-\d{2}-\d{2})\.bundle$/.exec(suffix);
    if (match?.[1] === undefined || !BackupDateSchema.safeParse(match[1]).success) {
      throw new Error('Invalid backup object key');
    }
    return { ...object, date: match[1] };
  });
  const newest = dated.reduce<(typeof dated)[number] | undefined>(
    (latest, object) => (latest === undefined || object.date > latest.date ? object : latest),
    undefined,
  );
  const startOfToday = Date.parse(`${utcDate(input.now)}T00:00:00.000Z`);
  const cutoff = startOfToday - 29 * DAY_MS;

  for (const object of dated) {
    const objectTime = Date.parse(`${object.date}T00:00:00.000Z`);
    if (object.key !== newest?.key && objectTime < cutoff) {
      await store.delete(object.key);
    }
  }
}

export async function latestBackupKey(
  store: BackupObjectStore,
  input: { readonly organizationId: string; readonly projectId: string },
): Promise<string> {
  const prefix = backupPrefix(input);
  let newest: string | undefined;
  const seenTokens = new Set<string>();
  let continuationToken: string | undefined;

  for (;;) {
    const page = await store.list(prefix, continuationToken);
    const parsed = z
      .object({
        objects: z.array(BackupObjectSchema),
        continuationToken: z.string().min(1).optional(),
      })
      .strict()
      .safeParse(page);
    if (!parsed.success || parsed.data.objects.some((object) => !object.key.startsWith(prefix))) {
      throw new Error('Invalid object listing response');
    }
    for (const object of parsed.data.objects) {
      const suffix = object.key.slice(prefix.length);
      const match = /^(\d{4}-\d{2}-\d{2})\.bundle$/.exec(suffix);
      if (match?.[1] === undefined || !BackupDateSchema.safeParse(match[1]).success) {
        throw new Error('Invalid backup object key');
      }
      if (newest === undefined || object.key > newest) {
        newest = object.key;
      }
    }
    const next = parsed.data.continuationToken;
    if (next === undefined) {
      if (newest === undefined) {
        throw new NoGitBackupError();
      }
      return newest;
    }
    if (seenTokens.has(next)) {
      throw new Error('Object listing pagination did not advance');
    }
    seenTokens.add(next);
    continuationToken = next;
  }
}

class NoGitBackupError extends Error {
  constructor() {
    super('No Git backup exists for project');
  }
}

export interface RepositoryBackupResult {
  readonly organizationId: string;
  readonly projectId: string;
  readonly key: string;
  readonly status: 'uploaded' | 'existing';
}

async function verifyStoredBundle(
  store: BackupObjectStore,
  git: Pick<BackupGit, 'verifyBundle'> &
    Partial<Pick<RestoreBackupInspectionGit, 'backupRepresentation'>>,
  key: string,
): Promise<BackupRepresentation> {
  const directory = await mkdtemp(join(tmpdir(), 'zapp-git-backup-verify-'));
  const bundlePath = join(directory, 'repository.bundle');
  try {
    await pipeline(await store.get(key), createWriteStream(bundlePath));
    const details = await stat(bundlePath);
    if (!details.isFile() || details.size === 0) {
      throw new Error('Stored bundle is empty');
    }
    await git.verifyBundle(bundlePath);
    return (await git.backupRepresentation?.(bundlePath)) ?? 'bundle';
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function selectRestoreDrillBackup(
  deps: { readonly store: BackupObjectStore; readonly git: RestoreBackupInspectionGit },
  repositoryInputs: readonly BackupRepository[],
): Promise<{
  readonly repository: BackupRepository;
  readonly key: string;
  readonly representation: BackupRepresentation;
}> {
  const repositories = z.array(BackupRepositorySchema).parse(repositoryInputs);
  for (const repository of repositories) {
    let key: string;
    try {
      key = await latestBackupKey(deps.store, repository);
    } catch (error) {
      if (error instanceof NoGitBackupError) {
        continue;
      }
      throw error;
    }
    try {
      const representation = await verifyStoredBundle(deps.store, deps.git, key);
      return { repository, key, representation };
    } catch {
      // A drill may use another tenant-scoped candidate, but never an unverified object.
    }
  }
  throw new Error('No verified Git backup is available for the restore drill');
}

export async function runRepositoryBackup(
  deps: {
    readonly store: BackupObjectStore;
    readonly git: BackupGit;
    readonly now?: () => Date;
  },
  repositoryInput: BackupRepository,
): Promise<RepositoryBackupResult> {
  const parsed = BackupRepositorySchema.safeParse(repositoryInput);
  if (!parsed.success) {
    throw new Error('Invalid backup repository');
  }
  const repository = parsed.data;
  const now = (deps.now ?? ((): Date => new Date()))();
  const key = backupKey({
    organizationId: repository.organizationId,
    projectId: repository.projectId,
    date: utcDate(now),
  });

  let exists: boolean;
  try {
    exists = await deps.store.exists(key);
  } catch {
    throw new Error('Bundle existence check failed');
  }
  if (exists) {
    try {
      await verifyStoredBundle(deps.store, deps.git, key);
    } catch {
      throw new Error('Stored bundle verification failed');
    }
    try {
      await enforceBackupRetention(deps.store, { ...repository, now });
    } catch {
      throw new Error('Backup retention failed');
    }
    return {
      organizationId: repository.organizationId,
      projectId: repository.projectId,
      key,
      status: 'existing',
    };
  }

  const directory = await mkdtemp(join(tmpdir(), 'zapp-git-backup-'));
  const bundlePath = join(directory, 'repository.bundle');
  try {
    try {
      await deps.git.createBundle(repository.cloneUrl, bundlePath);
    } catch {
      throw new Error('Git bundle creation failed');
    }
    const details = await stat(bundlePath);
    if (!details.isFile() || details.size === 0) {
      throw new Error('Created bundle is empty');
    }
    try {
      await deps.git.verifyBundle(bundlePath);
    } catch {
      throw new Error('Git bundle verification failed');
    }
    let putResult: BackupPutResult;
    try {
      putResult = await deps.store.put(key, {
        contentLength: details.size,
        open: (range) =>
          range === undefined
            ? createReadStream(bundlePath)
            : createReadStream(bundlePath, {
                start: range.start,
                end: range.endExclusive - 1,
              }),
      });
    } catch {
      throw new Error('Bundle upload failed');
    }
    try {
      await verifyStoredBundle(deps.store, deps.git, key);
    } catch {
      throw new Error('Stored bundle verification failed');
    }
    try {
      await enforceBackupRetention(deps.store, { ...repository, now });
    } catch {
      throw new Error('Backup retention failed');
    }
    return {
      organizationId: repository.organizationId,
      projectId: repository.projectId,
      key,
      status: putResult === 'created' ? 'uploaded' : 'existing',
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface NightlyBackupReport {
  readonly succeeded: number;
  readonly failed: number;
  readonly repositories: readonly (
    | RepositoryBackupResult
    | {
        readonly organizationId: string;
        readonly projectId: string;
        readonly status: 'failed';
        readonly error: string;
      }
  )[];
}

export async function runNightlyBackups(deps: {
  readonly inventory: BackupInventory;
  readonly store: BackupObjectStore;
  readonly git: BackupGit;
  readonly now?: () => Date;
}): Promise<NightlyBackupReport> {
  const repositories = z
    .array(BackupRepositorySchema)
    .parse(await deps.inventory.listProvisionedRepositories());
  const results: NightlyBackupReport['repositories'][number][] = [];

  for (const repository of repositories) {
    try {
      results.push(await runRepositoryBackup(deps, repository));
    } catch (error) {
      results.push({
        organizationId: repository.organizationId,
        projectId: repository.projectId,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Repository backup failed',
      });
    }
  }

  const failed = results.filter((result) => result.status === 'failed').length;
  return { succeeded: results.length - failed, failed, repositories: results };
}

const RestoreInputSchema = z
  .object({
    key: z.string().min(1),
    expectedBranches: z.array(ExpectedBranchSchema),
  })
  .strict();

export interface ResolvedRestoreTarget {
  readonly cloneUrl: string;
  /** Push and ref reads use this repository-bound credential, never backup admin access. */
  readonly git: RestoreRemoteGit;
  /** Actual token expiry returned by the issuer; runtime enforcement never trusts config alone. */
  readonly expiresAt: Date;
  /** One absolute command window shared by every credential-bound Git operation. */
  readonly deadlineAt: Date;
  /** Revokes the one ephemeral grant issued for this restore attempt. */
  release(): Promise<void>;
}

export type RestorePhase = 'push-started' | 'push-complete' | 'verified';

export const RESTORE_CREDENTIAL_SAFETY_MARGIN_MS = 5_000;

function remainingRestoreCredentialBudgetMs(
  target: ResolvedRestoreTarget,
  now: () => Date,
): number {
  const currentMs = now().getTime();
  const expiresAtMs = target.expiresAt.getTime();
  const deadlineAtMs = target.deadlineAt.getTime();
  const credentialTtlMs = DEFAULT_TOKEN_TTL_SECONDS * 1_000;
  if (
    !Number.isFinite(currentMs) ||
    !Number.isFinite(expiresAtMs) ||
    !Number.isFinite(deadlineAtMs) ||
    deadlineAtMs > expiresAtMs - RESTORE_CREDENTIAL_SAFETY_MARGIN_MS ||
    deadlineAtMs - currentMs >= credentialTtlMs
  ) {
    throw new Error('Restore credential deadline is invalid');
  }
  const remainingMs = Math.floor(deadlineAtMs - currentMs);
  if (remainingMs <= 0) {
    throw new Error('Restore credential deadline expired');
  }
  return remainingMs;
}

export async function restoreRepositoryBackup(
  deps: {
    readonly store: BackupObjectStore;
    readonly git: RestorePreparationGit;
    readonly resolveTarget: () => Promise<ResolvedRestoreTarget>;
    readonly recordPhase?: (phase: RestorePhase, result?: RestoreRepositoryResult) => Promise<void>;
    readonly now?: () => Date;
  },
  input: z.input<typeof RestoreInputSchema>,
): Promise<RestoreRepositoryResult> {
  const parsed = RestoreInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('Invalid restore input');
  }
  const directory = await mkdtemp(join(tmpdir(), 'zapp-git-restore-'));
  const bundlePath = join(directory, 'repository.bundle');
  const mirrorPath = join(directory, 'repository.git');
  let resolvedTarget: ResolvedRestoreTarget | undefined;
  let credentialReleased = false;
  const releaseCredential = async (): Promise<void> => {
    if (resolvedTarget !== undefined && !credentialReleased) {
      await resolvedTarget.release();
      credentialReleased = true;
    }
  };
  try {
    try {
      await pipeline(await deps.store.get(parsed.data.key), createWriteStream(bundlePath));
    } catch {
      throw new Error('Bundle download failed');
    }
    const details = await stat(bundlePath);
    if (!details.isFile() || details.size === 0) {
      throw new Error('Downloaded bundle is empty');
    }
    try {
      await deps.git.verifyBundle(bundlePath);
    } catch {
      throw new Error('Git bundle verification failed');
    }
    let prepared: PreparedRestore;
    try {
      prepared = await deps.git.prepareRestore(bundlePath, mirrorPath);
    } catch {
      throw new Error('Git restore preparation failed');
    }
    try {
      resolvedTarget = await deps.resolveTarget();
      resolvedTarget = { ...resolvedTarget, cloneUrl: safeGitUrl(resolvedTarget.cloneUrl) };
    } catch {
      throw new Error('Restore target resolution failed');
    }
    const now = deps.now ?? ((): Date => new Date());
    remainingRestoreCredentialBudgetMs(resolvedTarget, now);
    await deps.recordPhase?.('push-started');
    remainingRestoreCredentialBudgetMs(resolvedTarget, now);
    try {
      await resolvedTarget.git.pushMirror(
        prepared.mirrorPath,
        resolvedTarget.cloneUrl,
        resolvedTarget.deadlineAt,
      );
    } catch {
      throw new Error('Bundle mirror push failed');
    }
    await deps.recordPhase?.('push-complete');
    let actual: ReadonlyMap<string, string>;
    remainingRestoreCredentialBudgetMs(resolvedTarget, now);
    try {
      actual = await resolvedTarget.git.remoteRefs(
        resolvedTarget.cloneUrl,
        resolvedTarget.deadlineAt,
      );
    } catch {
      throw new Error('Restored branch listing failed');
    }
    if (prepared.kind === 'empty' && actual.size > 0) {
      throw new Error('Restored empty repository contains refs');
    }
    const expected = parsed.data.expectedBranches.filter((branch) => branch.headCommitSha !== null);
    const branchEvidence = expected
      .map((branch) => ({
        name: branch.name,
        expectedSha: branch.headCommitSha ?? '',
        actualSha: actual.get(`refs/heads/${branch.name}`) ?? '',
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (branchEvidence.some((branch) => branch.actualSha !== branch.expectedSha)) {
      throw new Error('Restored branch heads do not match the database');
    }
    const result = RestoreRepositoryResultSchema.parse({
      checkedBranches: branchEvidence.length,
      branches: branchEvidence,
      refs: [...actual]
        .map(([name, sha]) => ({ name, sha }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    });
    await releaseCredential();
    await deps.recordPhase?.('verified', result);
    return result;
  } finally {
    try {
      await releaseCredential();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
