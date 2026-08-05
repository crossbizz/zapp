import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

import { idSchema, internalRepoRef, parseInternalRepoRef } from '@zapp/contracts';
import { createDb } from '@zapp/db';
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

const ForgejoRestoreTargetInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    defaultBranch: z.string().min(1).max(255),
    description: z.string().max(255).optional(),
  })
  .strict();

interface ForgejoRestoreRepositoryResponse {
  readonly clone_url?: string;
  readonly description?: string;
  readonly empty?: boolean;
}

export async function createForgejoRestoreTarget(
  client: ForgejoClient,
  input: z.input<typeof ForgejoRestoreTargetInputSchema>,
): Promise<CreatedRestoreTarget> {
  const parsed = ForgejoRestoreTargetInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('Invalid restore target');
  }
  const ref = internalRepoRef(parsed.data);
  const { owner, name } = parseInternalRepoRef(ref);
  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

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

  const created = await client.send<ForgejoRestoreRepositoryResponse>({
    method: 'POST',
    path: `/orgs/${encodeURIComponent(owner)}/repos`,
    body: {
      name,
      private: true,
      auto_init: false,
      default_branch: parsed.data.defaultBranch,
      ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }),
    },
    allow: [409],
  });
  if (created.status === 409) {
    throw new Error('Forgejo restore target creation conflicted');
  }

  const compensate = async (): Promise<void> => {
    await client.send({ method: 'DELETE', path: repositoryPath, allow: [404] });
  };
  const cloneUrl = created.body?.clone_url;
  if (cloneUrl === undefined || cloneUrl === '' || created.body?.empty === false) {
    try {
      await compensate();
    } catch {
      throw new Error('Fresh restore target validation and compensation failed');
    }
    throw new Error('Fresh restore target creation failed');
  }
  return { cloneUrl, compensate };
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

export interface PreparedRestoreDrillTarget {
  readonly markerKey: string;
  readonly targetRef: string;
  readonly target: CreatedRestoreTarget;
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

export async function prepareRestoreDrillTarget(
  deps: { readonly store: BackupObjectStore; readonly client: ForgejoClient },
  source: BackupRepository,
): Promise<PreparedRestoreDrillTarget> {
  const marker = restoreDrillMarker(source);
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
  const existing = await deps.client.send<ForgejoRestoreRepositoryResponse>({
    method: 'GET',
    path: repositoryPath,
    allow: [404],
  });
  if (existing.status !== 404) {
    if (existing.body?.description !== persisted.description) {
      throw new Error('Forgejo restore drill target is not marker-owned');
    }
    await deps.client.send({ method: 'DELETE', path: repositoryPath, allow: [404] });
  }

  const target = await createForgejoRestoreTarget(deps.client, {
    organizationId: persisted.targetOrganizationId,
    projectId: persisted.targetProjectId,
    defaultBranch: source.defaultBranch,
    description: persisted.description,
  });
  return {
    markerKey: marker.key,
    targetRef,
    target,
    clearMarker: async () => {
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

    restoreDrill: async () => {
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
    },

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
