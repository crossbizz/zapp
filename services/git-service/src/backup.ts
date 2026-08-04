import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { idSchema, internalRepoRef, InternalRepoRefSchema } from '@zapp/contracts';
import {
  branches as branchesTable,
  repositories as repositoriesTable,
  type Database,
} from '@zapp/db';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';

const BackupDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value);

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

const BackupRepositorySchema = z
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

const BackupObjectSchema = z
  .object({
    key: z.string().min(1),
    lastModified: z.date(),
  })
  .strict();

export type BackupObject = z.infer<typeof BackupObjectSchema>;

export interface BackupObjectStore {
  exists(key: string): Promise<boolean>;
  put(key: string, body: Readable, contentLength: number): Promise<void>;
  get(key: string): Promise<Readable>;
  list(
    prefix: string,
    continuationToken?: string,
  ): Promise<{ readonly objects: readonly BackupObject[]; readonly continuationToken?: string }>;
  delete(key: string): Promise<void>;
}

export type S3ClientPortCommand =
  | DeleteObjectCommand
  | GetObjectCommand
  | HeadObjectCommand
  | ListObjectsV2Command
  | PutObjectCommand;

export interface S3ClientPort {
  send(
    command: S3ClientPortCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown>;
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

export function createS3BackupObjectStore(options: {
  readonly client: S3ClientPort;
  readonly bucket: string;
  readonly timeoutMs: number;
}): BackupObjectStore {
  const parsed = z
    .object({
      bucket: z
        .string()
        .min(3)
        .max(63)
        .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
      timeoutMs: z.number().int().min(100).max(300_000),
    })
    .strict()
    .safeParse({ bucket: options.bucket, timeoutMs: options.timeoutMs });
  if (!parsed.success) {
    throw new Error('Invalid object store configuration');
  }

  const send = async (command: S3ClientPortCommand): Promise<unknown> =>
    await options.client.send(command, {
      abortSignal: AbortSignal.timeout(parsed.data.timeoutMs),
    });

  return {
    async exists(key: string): Promise<boolean> {
      try {
        await send(new HeadObjectCommand({ Bucket: parsed.data.bucket, Key: key }));
        return true;
      } catch (error) {
        if (httpStatus(error) === 404) {
          return false;
        }
        throw error;
      }
    },

    async put(key: string, body: Readable, contentLength: number): Promise<void> {
      try {
        await send(
          new PutObjectCommand({
            Bucket: parsed.data.bucket,
            Key: key,
            Body: body,
            ContentLength: contentLength,
            ContentType: 'application/x-git-bundle',
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        if (httpStatus(error) === 412) {
          return;
        }
        throw error;
      }
    },

    async get(key: string): Promise<Readable> {
      const response = await send(new GetObjectCommand({ Bucket: parsed.data.bucket, Key: key }));
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
          Bucket: parsed.data.bucket,
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
      await send(new DeleteObjectCommand({ Bucket: parsed.data.bucket, Key: key }));
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
}): BackupObjectStore {
  const endpoint = new URL(config.endpoint);
  const client = new S3Client({
    endpoint: endpoint.toString().replace(/\/$/, ''),
    region: config.region,
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
  });
  return createS3BackupObjectStore({
    client,
    bucket: config.bucket,
    timeoutMs: config.timeoutMs ?? 30_000,
  });
}

export interface BackupGit {
  createBundle(cloneUrl: string, bundlePath: string): Promise<void>;
  verifyBundle(bundlePath: string): Promise<void>;
  mirrorPush(bundlePath: string, targetCloneUrl: string): Promise<void>;
  remoteHeads(targetCloneUrl: string): Promise<ReadonlyMap<string, string>>;
}

export interface GitCommandCall {
  readonly args: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly signal: AbortSignal;
}

export type GitCommandExecutor = (call: GitCommandCall) => Promise<{ readonly stdout: string }>;

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
}): BackupGit {
  const parsed = z
    .object({
      username: z.string().min(1),
      password: z.string().min(1),
      timeoutMs: z.number().int().min(100).max(300_000),
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

  async function withAskpass<T>(operation: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'zapp-git-askpass-'));
    const askpass = join(directory, 'askpass.sh');
    try {
      await writeFile(askpass, AskpassScript, { mode: 0o700 });
      await chmod(askpass, 0o700);
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
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function execute(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
    const result = await executor({
      args,
      env,
      signal: AbortSignal.timeout(commandConfig.timeoutMs),
    });
    return result.stdout;
  }

  return {
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
            await execute(['-C', mirror, 'bundle', 'create', bundlePath, '--all'], env);
          } catch {
            throw new Error('Git bundle creation command failed');
          }
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },

    async verifyBundle(bundlePath: string): Promise<void> {
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

    async mirrorPush(bundlePath: string, targetCloneUrl: string): Promise<void> {
      const url = safeGitUrl(targetCloneUrl);
      const directory = await mkdtemp(join(tmpdir(), 'zapp-git-restore-mirror-'));
      const mirror = join(directory, 'repository.git');
      try {
        await withAskpass(async (env) => {
          try {
            await execute(['clone', '--mirror', bundlePath, mirror], env);
          } catch {
            throw new Error('Git bundle mirror creation failed');
          }
          try {
            await execute(['-C', mirror, 'push', '--mirror', url], env);
          } catch {
            throw new Error('Git mirror push command failed');
          }
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },

    async remoteHeads(targetCloneUrl: string): Promise<ReadonlyMap<string, string>> {
      const url = safeGitUrl(targetCloneUrl);
      let stdout: string;
      try {
        stdout = await withAskpass(
          async (env) => await execute(['ls-remote', '--heads', url], env),
        );
      } catch {
        throw new Error('Git remote branch listing failed');
      }
      const heads = new Map<string, string>();
      for (const line of stdout.split('\n')) {
        if (line === '') {
          continue;
        }
        const match = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/i.exec(line);
        if (
          match?.[1] === undefined ||
          match[2] === undefined ||
          !RefNameSchema.safeParse(match[2]).success
        ) {
          throw new Error('Git remote branch listing was invalid');
        }
        heads.set(match[2], match[1]);
      }
      return heads;
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
  const cutoff = startOfToday - 30 * DAY_MS;

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
      return newest ?? Promise.reject(new Error('No Git backup exists for project'));
    }
    if (seenTokens.has(next)) {
      throw new Error('Object listing pagination did not advance');
    }
    seenTokens.add(next);
    continuationToken = next;
  }
}

export interface RepositoryBackupResult {
  readonly organizationId: string;
  readonly projectId: string;
  readonly key: string;
  readonly status: 'uploaded' | 'existing';
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
    try {
      await deps.store.put(key, createReadStream(bundlePath), details.size);
    } catch {
      throw new Error('Bundle upload failed');
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
      status: 'uploaded',
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
    targetCloneUrl: SafeCloneUrlSchema.optional(),
    expectedBranches: z.array(ExpectedBranchSchema),
  })
  .strict();

export async function restoreRepositoryBackup(
  deps: {
    readonly store: BackupObjectStore;
    readonly git: BackupGit;
    readonly createTarget?: () => Promise<string>;
  },
  input: z.input<typeof RestoreInputSchema>,
): Promise<{ readonly checkedBranches: number }> {
  const parsed = RestoreInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('Invalid restore input');
  }
  if ((deps.createTarget === undefined) === (parsed.data.targetCloneUrl === undefined)) {
    throw new Error('Invalid restore input');
  }
  const directory = await mkdtemp(join(tmpdir(), 'zapp-git-restore-'));
  const bundlePath = join(directory, 'repository.bundle');
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
    let targetCloneUrl = parsed.data.targetCloneUrl;
    if (deps.createTarget !== undefined) {
      try {
        targetCloneUrl = safeGitUrl(await deps.createTarget());
      } catch {
        throw new Error('Fresh restore target creation failed');
      }
    }
    if (targetCloneUrl === undefined) {
      throw new Error('Invalid restore input');
    }
    try {
      await deps.git.mirrorPush(bundlePath, targetCloneUrl);
    } catch {
      throw new Error('Bundle mirror push failed');
    }
    let actual: ReadonlyMap<string, string>;
    try {
      actual = await deps.git.remoteHeads(targetCloneUrl);
    } catch {
      throw new Error('Restored branch listing failed');
    }
    const expected = parsed.data.expectedBranches.filter((branch) => branch.headCommitSha !== null);
    if (expected.some((branch) => actual.get(branch.name) !== branch.headCommitSha)) {
      throw new Error('Restored branch heads do not match the database');
    }
    return { checkedBranches: expected.length };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
