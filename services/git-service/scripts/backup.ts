import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

import { idSchema, internalRepoRef, parseInternalRepoRef } from '@zapp/contracts';
import { createDb, type Db } from '@zapp/db';
import { z } from 'zod';

import {
  BackupDateSchema,
  createDbBackupInventory,
  createGitBundleCommands,
  createR2BackupObjectStore,
  latestBackupKey,
  restoreRepositoryBackup,
  runNightlyBackups,
  type CreatedRestoreTarget,
  type BackupGit,
  type BackupInventory,
  type BackupObjectStore,
  type BackupRepository,
  type NightlyBackupReport,
  type RestoreRepositoryResult,
} from '../src/backup.js';
import { loadArtifactEnv, loadDatabaseUrl, loadForgejoEnv } from '../src/env.js';
import { createForgejoClient, type ForgejoClient } from '../src/forgejo/client.js';

const RestoreSelectorSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    key: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const prefix = `org/${value.organizationId}/project/${value.projectId}/git-backups/`;
    const suffix = value.key.startsWith(prefix) ? value.key.slice(prefix.length) : '';
    const date = suffix.endsWith('.bundle') ? suffix.slice(0, -'.bundle'.length) : '';
    if (!BackupDateSchema.safeParse(date).success || value.key !== `${prefix}${date}.bundle`) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid backup key' });
    }
  });

export type RestoreSelector = z.infer<typeof RestoreSelectorSchema>;

const BackupActionSchema = z.enum(['nightly', 'restore', 'restore-drill']);

export interface BackupCliProcess {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: { write(message: string): unknown };
  readonly stderr: { write(message: string): unknown };
  exitCode?: string | number | null | undefined;
}

type RestoreResult = {
  readonly status: 'restored';
  readonly projectId: string;
} & RestoreRepositoryResult;

type RestoreDrillResult = {
  readonly status: 'restore-drill-verified';
  readonly projectId: string;
} & RestoreRepositoryResult;

export interface BackupCliOperations {
  nightly(): Promise<NightlyBackupReport>;
  restore(selector: RestoreSelector): Promise<RestoreResult>;
  restoreDrill(): Promise<RestoreDrillResult>;
  close(): Promise<void>;
}

export interface RestoreDrillLease {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

const RESTORE_DRILL_ADVISORY_LOCK_NAMESPACE = 0x5a415050;
const RESTORE_DRILL_ADVISORY_LOCK_KEY = 0x47495434;

export function createPostgresRestoreDrillLease(
  sql: Pick<Db['sql'], 'reserve'>,
): RestoreDrillLease {
  return {
    runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => {
      const session = await sql.reserve();
      let acquired = false;
      try {
        const rows = await session`
          SELECT pg_try_advisory_lock(
            ${RESTORE_DRILL_ADVISORY_LOCK_NAMESPACE},
            ${RESTORE_DRILL_ADVISORY_LOCK_KEY}
          ) AS acquired
        `;
        const result = z
          .array(z.object({ acquired: z.boolean() }).passthrough())
          .length(1)
          .safeParse(rows);
        if (!result.success || !result.data[0]?.acquired) {
          throw new Error('Restore drill is already in progress');
        }
        acquired = true;
        return await operation();
      } finally {
        try {
          if (acquired) {
            await session`
              SELECT pg_advisory_unlock(
                ${RESTORE_DRILL_ADVISORY_LOCK_NAMESPACE},
                ${RESTORE_DRILL_ADVISORY_LOCK_KEY}
              ) AS released
            `;
          }
        } finally {
          session.release();
        }
      }
    },
  };
}

const ForgejoRestoreTargetInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    defaultBranch: z.string().min(1).max(255),
    description: z.string().max(255).optional(),
  })
  .strict();

const ForgejoRestoreRepositorySchema = z
  .object({
    id: z.number().int().positive(),
    clone_url: z.string().min(1),
    description: z.string(),
    empty: z.boolean(),
  })
  .passthrough();

type ForgejoRestoreRepository = z.infer<typeof ForgejoRestoreRepositorySchema>;

export interface CreatedForgejoRestoreTarget extends CreatedRestoreTarget {
  readonly repositoryId: number;
}

export async function createForgejoRestoreTarget(
  client: ForgejoClient,
  input: z.input<typeof ForgejoRestoreTargetInputSchema>,
): Promise<CreatedForgejoRestoreTarget> {
  const parsed = ForgejoRestoreTargetInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('Invalid restore target');
  }
  const ref = internalRepoRef(parsed.data);
  const { owner, name } = parseInternalRepoRef(ref);
  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const operationMarker = parsed.data.description ?? `zapp.build restore operation ${randomUUID()}`;

  const organization = await client.send({
    method: 'GET',
    path: `/orgs/${encodeURIComponent(owner)}`,
    allow: [404],
  });
  if (organization.status === 404) {
    await client.send({
      method: 'POST',
      path: '/orgs',
      body: {
        username: owner,
        visibility: 'private',
        description: 'zapp.build tenant',
      },
      allow: [409, 422],
    });
  }

  const existing = await client.send({ method: 'GET', path: repositoryPath, allow: [404] });
  if (existing.status !== 404) {
    throw new Error('Forgejo restore target already exists');
  }

  const created = await client.send<ForgejoRestoreRepository>({
    method: 'POST',
    path: `/orgs/${encodeURIComponent(owner)}/repos`,
    body: {
      name,
      private: true,
      auto_init: false,
      default_branch: parsed.data.defaultBranch,
      description: operationMarker,
    },
    allow: [409],
  });
  if (created.status === 409) {
    throw new Error('Forgejo restore target creation conflicted');
  }

  const createdRepository = ForgejoRestoreRepositorySchema.safeParse(created.body);
  if (
    !createdRepository.success ||
    createdRepository.data.description !== operationMarker ||
    !createdRepository.data.empty
  ) {
    throw new Error('Fresh restore target creation failed');
  }

  const repositoryId = createdRepository.data.id;
  const compensate = async (): Promise<void> => {
    const current = await client.send<ForgejoRestoreRepository>({
      method: 'GET',
      path: repositoryPath,
      allow: [404],
    });
    if (current.status === 404) {
      throw new Error(
        'Forgejo restore target ownership was lost; target absent, no delete attempted',
      );
    }
    const owned = ForgejoRestoreRepositorySchema.safeParse(current.body);
    if (
      !owned.success ||
      owned.data.id !== repositoryId ||
      owned.data.description !== operationMarker
    ) {
      throw new Error('Forgejo restore target ownership was lost; replacement preserved');
    }
    await client.send({ method: 'DELETE', path: repositoryPath, allow: [404] });
  };
  return { repositoryId, cloneUrl: createdRepository.data.clone_url, compensate };
}

const RestoreDrillMarkerSchema = z
  .object({
    version: z.literal(1),
    sourceOrganizationId: idSchema('org'),
    sourceProjectId: idSchema('proj'),
    targetOrganizationId: idSchema('org'),
    targetProjectId: idSchema('proj'),
    description: z.string().min(1).max(255),
  })
  .strict();

type RestoreDrillMarker = z.infer<typeof RestoreDrillMarkerSchema>;

const RestoreDrillOwnershipSchema = z
  .object({
    version: z.literal(1),
    markerKey: z.string().min(1),
    repositoryId: z.number().int().positive(),
    description: z.string().min(1).max(255),
  })
  .strict();

type RestoreDrillOwnership = z.infer<typeof RestoreDrillOwnershipSchema>;

export interface PreparedRestoreDrillTarget {
  readonly markerKey: string;
  readonly ownershipKey: string;
  readonly targetRef: string;
  readonly target: CreatedForgejoRestoreTarget;
  clearMarker(): Promise<void>;
}

function deterministicId(prefix: 'org' | 'proj', seed: string): string {
  const value = createHash('sha256').update(seed).digest('hex').slice(0, 26).toUpperCase();
  return `${prefix}_${value}`;
}

function restoreDrillMarker(source: BackupRepository): {
  readonly key: string;
  readonly value: RestoreDrillMarker;
  readonly json: string;
} {
  const key = `org/${source.organizationId}/project/${source.projectId}/git-restore-drills/quarterly-v1.json`;
  const digest = createHash('sha256').update(key).digest('hex');
  const value = RestoreDrillMarkerSchema.parse({
    version: 1,
    sourceOrganizationId: source.organizationId,
    sourceProjectId: source.projectId,
    targetOrganizationId: deterministicId('org', `organization:${key}`),
    targetProjectId: deterministicId('proj', `project:${key}`),
    description: `zapp.build restore drill ${digest.slice(0, 32)}`,
  });
  return { key, value, json: JSON.stringify(value) };
}

async function readRestoreDrillMarker(
  store: BackupObjectStore,
  key: string,
): Promise<RestoreDrillMarker> {
  const stream = await store.get(key);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > 4_096) {
      throw new Error('Restore drill marker is invalid');
    }
    chunks.push(bytes);
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('Restore drill marker is invalid');
  }
  const parsed = RestoreDrillMarkerSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('Restore drill marker is invalid');
  }
  return parsed.data;
}

async function readRestoreDrillOwnership(
  store: BackupObjectStore,
  key: string,
): Promise<RestoreDrillOwnership> {
  const stream = await store.get(key);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > 4_096) {
      throw new Error('Restore drill ownership receipt is invalid');
    }
    chunks.push(bytes);
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('Restore drill ownership receipt is invalid');
  }
  const parsed = RestoreDrillOwnershipSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('Restore drill ownership receipt is invalid');
  }
  return parsed.data;
}

export async function prepareRestoreDrillTarget(
  deps: { readonly store: BackupObjectStore; readonly client: ForgejoClient },
  source: BackupRepository,
): Promise<PreparedRestoreDrillTarget> {
  const marker = restoreDrillMarker(source);
  const ownershipKey = marker.key.replace(/\.json$/, '.ownership.json');
  const markerBytes = Buffer.from(marker.json, 'utf8');
  await deps.store.put(marker.key, {
    contentLength: markerBytes.length,
    contentType: 'application/json',
    open: () => Readable.from(markerBytes),
  });
  const persisted = await readRestoreDrillMarker(deps.store, marker.key);
  if (JSON.stringify(persisted) !== marker.json) {
    throw new Error('Restore drill marker does not match this drill');
  }

  const targetRef = internalRepoRef({
    organizationId: persisted.targetOrganizationId,
    projectId: persisted.targetProjectId,
  });
  const { owner, name } = parseInternalRepoRef(targetRef);
  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const hasOwnershipReceipt = await deps.store.exists(ownershipKey);
  const existing = await deps.client.send<ForgejoRestoreRepository>({
    method: 'GET',
    path: repositoryPath,
    allow: [404],
  });
  if (existing.status !== 404) {
    if (!hasOwnershipReceipt) {
      throw new Error('Forgejo restore drill target has no immutable ownership receipt');
    }
    const receipt = await readRestoreDrillOwnership(deps.store, ownershipKey);
    const currentResponse = await deps.client.send<ForgejoRestoreRepository>({
      method: 'GET',
      path: repositoryPath,
      allow: [404],
    });
    const current = ForgejoRestoreRepositorySchema.safeParse(currentResponse.body);
    if (
      receipt.markerKey !== marker.key ||
      receipt.description !== persisted.description ||
      currentResponse.status === 404 ||
      !current.success ||
      current.data.id !== receipt.repositoryId ||
      current.data.description !== receipt.description
    ) {
      throw new Error('Forgejo restore target ownership was lost; replacement preserved');
    }
    await deps.client.send({ method: 'DELETE', path: repositoryPath, allow: [404] });
    await deps.store.delete(ownershipKey);
  } else if (hasOwnershipReceipt) {
    throw new Error(
      'Forgejo restore target ownership was lost; target absent, no delete attempted',
    );
  }

  const target = await createForgejoRestoreTarget(deps.client, {
    organizationId: persisted.targetOrganizationId,
    projectId: persisted.targetProjectId,
    defaultBranch: source.defaultBranch,
    description: persisted.description,
  });
  const ownership = RestoreDrillOwnershipSchema.parse({
    version: 1,
    markerKey: marker.key,
    repositoryId: target.repositoryId,
    description: persisted.description,
  });
  const ownershipBytes = Buffer.from(JSON.stringify(ownership), 'utf8');
  const ownershipPut = await deps.store.put(ownershipKey, {
    contentLength: ownershipBytes.length,
    contentType: 'application/json',
    open: () => Readable.from(ownershipBytes),
  });
  if (ownershipPut !== 'created') {
    await target.compensate();
    throw new Error('Restore drill ownership receipt already exists');
  }
  const persistedOwnership = await readRestoreDrillOwnership(deps.store, ownershipKey);
  if (JSON.stringify(persistedOwnership) !== JSON.stringify(ownership)) {
    await target.compensate();
    throw new Error('Restore drill ownership receipt does not match this target');
  }
  return {
    markerKey: marker.key,
    ownershipKey,
    targetRef,
    target,
    clearMarker: async () => {
      await deps.store.delete(ownershipKey);
      await deps.store.delete(marker.key);
    },
  };
}

function restoreSelector(source: NodeJS.ProcessEnv): RestoreSelector {
  const parsed = RestoreSelectorSchema.safeParse({
    organizationId: source['GIT_RESTORE_ORGANIZATION_ID'],
    projectId: source['GIT_RESTORE_PROJECT_ID'],
    key: source['GIT_RESTORE_KEY'],
  });
  if (!parsed.success) {
    throw new Error('Invalid restore selector');
  }
  return parsed.data;
}

export function createBackupOperations(deps: {
  readonly inventory: BackupInventory;
  readonly store: BackupObjectStore;
  readonly git: BackupGit;
  readonly client: ForgejoClient;
  readonly restoreDrillLease: RestoreDrillLease;
  readonly close: () => Promise<void>;
}): BackupCliOperations {
  const { inventory, store, git, client } = deps;

  async function createEmptyTarget(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly defaultBranch: string;
  }) {
    return await createForgejoRestoreTarget(client, input);
  }

  return {
    nightly: async () => await runNightlyBackups({ inventory, store, git }),

    restore: async (selector) => {
      const repositories = await inventory.listProvisionedRepositories();
      const repository = repositories.find(
        (entry) =>
          entry.organizationId === selector.organizationId &&
          entry.projectId === selector.projectId,
      );
      if (repository === undefined) {
        throw new Error('Restore source is not a provisioned internal repository');
      }
      const expectedBranches = await inventory.expectedBranches(
        selector.organizationId,
        selector.projectId,
      );
      const result = await restoreRepositoryBackup(
        {
          store,
          git,
          createTarget: async () =>
            await createEmptyTarget({
              organizationId: selector.organizationId,
              projectId: selector.projectId,
              defaultBranch: repository.defaultBranch,
            }),
        },
        { key: selector.key, expectedBranches: [...expectedBranches] },
      );
      return { status: 'restored', projectId: selector.projectId, ...result };
    },

    restoreDrill: async () =>
      await deps.restoreDrillLease.runExclusive(async () => {
        const [repository] = await inventory.listProvisionedRepositories();
        if (repository === undefined) {
          throw new Error('No provisioned internal repository is available for the restore drill');
        }
        const key = await latestBackupKey(store, repository);
        const expectedBranches = await inventory.expectedBranches(
          repository.organizationId,
          repository.projectId,
        );
        const ownership: {
          prepared?: PreparedRestoreDrillTarget;
          targetPresent: boolean;
          disposeCreatedTarget?: () => Promise<void>;
        } = { targetPresent: false };
        try {
          const result = await restoreRepositoryBackup(
            {
              store,
              git,
              createTarget: async () => {
                const prepared = await prepareRestoreDrillTarget({ store, client }, repository);
                ownership.prepared = prepared;
                ownership.targetPresent = true;
                ownership.disposeCreatedTarget = async () => {
                  if (!ownership.targetPresent) {
                    return;
                  }
                  await prepared.target.compensate();
                  ownership.targetPresent = false;
                };
                return {
                  cloneUrl: prepared.target.cloneUrl,
                  compensate: ownership.disposeCreatedTarget,
                };
              },
            },
            { key, expectedBranches: [...expectedBranches] },
          );
          return {
            status: 'restore-drill-verified',
            projectId: repository.projectId,
            ...result,
          };
        } finally {
          if (ownership.targetPresent) {
            await ownership.disposeCreatedTarget?.();
          }
          if (ownership.prepared !== undefined && !ownership.targetPresent) {
            await ownership.prepared.clearMarker();
          }
        }
      }),

    close: deps.close,
  };
}

function createProductionOperations(): BackupCliOperations {
  const forgejo = loadForgejoEnv();
  const artifact = loadArtifactEnv();
  const database = createDb(loadDatabaseUrl());
  const client = createForgejoClient(forgejo);
  const inventory = createDbBackupInventory(database.db, forgejo.baseUrl);
  const store = createR2BackupObjectStore(artifact);
  const git = createGitBundleCommands({
    username: 'zapp-admin-token',
    password: forgejo.adminToken,
    timeoutMs: 30_000,
  });
  return createBackupOperations({
    inventory,
    store,
    git,
    client,
    restoreDrillLease: createPostgresRestoreDrillLease(database.sql),
    close: async () => {
      await database.close();
    },
  });
}

export async function runBackupCli(
  cli: BackupCliProcess,
  createOperations: () =>
    BackupCliOperations | Promise<BackupCliOperations> = createProductionOperations,
): Promise<void> {
  let operations: BackupCliOperations | undefined;
  let failureReported = false;
  try {
    const action = BackupActionSchema.parse(cli.argv[2] ?? 'nightly');
    const selector = action === 'restore' ? restoreSelector(cli.env) : undefined;
    operations = await createOperations();

    switch (action) {
      case 'nightly': {
        const report = await operations.nightly();
        cli.stdout.write(`${JSON.stringify(report)}\n`);
        if (report.failed > 0) {
          cli.exitCode = 1;
        }
        break;
      }
      case 'restore': {
        if (selector === undefined) {
          throw new Error('Invalid restore selector');
        }
        cli.stdout.write(`${JSON.stringify(await operations.restore(selector))}\n`);
        break;
      }
      case 'restore-drill':
        cli.stdout.write(`${JSON.stringify(await operations.restoreDrill())}\n`);
        break;
    }
  } catch {
    failureReported = true;
    cli.stderr.write('Git backup operation failed\n');
    cli.exitCode = 1;
  } finally {
    if (operations !== undefined) {
      try {
        await operations.close();
      } catch {
        if (!failureReported) {
          cli.stderr.write('Git backup operation failed\n');
        }
        cli.exitCode = 1;
      }
    }
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  await runBackupCli(process);
}
