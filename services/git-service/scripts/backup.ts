import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

import { idSchema, internalRepoRef, parseInternalRepoRef } from '@zapp/contracts';
import { createDb, type Db } from '@zapp/db';
import { z } from 'zod';

import {
  BackupDateSchema,
  BackupRepositorySchema,
  createDbBackupInventory,
  createGitBundleCommands,
  createR2BackupObjectStore,
  latestBackupKey,
  restoreRepositoryBackup,
  runNightlyBackups,
  type BackupGit,
  type BackupInventory,
  type BackupObjectStore,
  type NightlyBackupReport,
  type RestorePhase,
  type RestoreRepositoryResult,
} from '../src/backup.js';
import { loadArtifactEnv, loadDatabaseUrl, loadForgejoEnv } from '../src/env.js';
import { createForgejoClient, type ForgejoClient } from '../src/forgejo/client.js';

const RestoreIdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

function isExactBackupKey(organizationId: string, projectId: string, key: string): boolean {
  const prefix = `org/${organizationId}/project/${projectId}/git-backups/`;
  const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : '';
  const date = suffix.endsWith('.bundle') ? suffix.slice(0, -'.bundle'.length) : '';
  return BackupDateSchema.safeParse(date).success && key === `${prefix}${date}.bundle`;
}

const RestoreSelectorSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    key: z.string().min(1),
    idempotencyKey: RestoreIdempotencyKeySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!isExactBackupKey(value.organizationId, value.projectId, value.key)) {
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

const ForgejoRestoreRepositorySchema = z
  .object({
    id: z.number().int().positive(),
    clone_url: z.string().min(1),
    description: z.string(),
    empty: z.boolean(),
  })
  .passthrough();

type ForgejoRestoreRepository = z.infer<typeof ForgejoRestoreRepositorySchema>;

const RestoreOperationInputSchema = z
  .object({
    kind: z.enum(['manual', 'drill']),
    idempotencyKey: RestoreIdempotencyKeySchema,
    source: BackupRepositorySchema,
    backupKey: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (!isExactBackupKey(value.source.organizationId, value.source.projectId, value.backupKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid backup key' });
    }
  });

const RestoreIntentSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['manual', 'drill']),
    operationId: z.string().regex(/^[0-9a-f]{64}$/),
    sourceOrganizationId: idSchema('org'),
    sourceProjectId: idSchema('proj'),
    backupKey: z.string().min(1),
    targetOrganizationId: idSchema('org'),
    targetProjectId: idSchema('proj'),
    targetReceiptKey: z.string().min(1),
    targetMarker: z.string().min(1).max(255),
    defaultBranch: z.string().min(1).max(255),
  })
  .strict();

type RestoreIntent = z.infer<typeof RestoreIntentSchema>;

const RestoreTargetReceiptSchema = z
  .object({
    version: z.literal(1),
    targetRef: z.string().min(1),
    repositoryId: z.number().int().positive(),
    targetMarker: z.string().min(1).max(255),
  })
  .strict();

type RestoreTargetReceipt = z.infer<typeof RestoreTargetReceiptSchema>;

export interface ResolvedForgejoRestoreTarget {
  readonly repositoryId: number;
  readonly cloneUrl: string;
}

export interface RestoreOperation {
  readonly intentKey: string;
  readonly targetRef: string;
  resolveTarget(): Promise<ResolvedForgejoRestoreTarget>;
  recordPhase(phase: RestorePhase, result?: RestoreRepositoryResult): Promise<void>;
}

const RestorePhaseReceiptSchema = z
  .object({
    version: z.literal(1),
    intentKey: z.string().min(1),
    operationId: z.string().regex(/^[0-9a-f]{64}$/),
    backupKey: z.string().min(1),
    repositoryId: z.number().int().positive(),
    phase: z.enum(['push-started', 'push-complete', 'verified']),
    resultDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

async function readSmallJson(store: BackupObjectStore, key: string): Promise<unknown> {
  const stream = await store.get(key);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > 16_384) {
      throw new Error('Restore receipt is invalid');
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('Restore receipt is invalid');
  }
}

async function putExactJson(
  store: BackupObjectStore,
  key: string,
  value: unknown,
  conflictMessage = 'Restore idempotency key conflicts with a different selector',
): Promise<void> {
  const json = JSON.stringify(value);
  const bytes = Buffer.from(json, 'utf8');
  await store.put(key, {
    contentLength: bytes.length,
    contentType: 'application/json',
    open: () => Readable.from(bytes),
  });
  if (JSON.stringify(await readSmallJson(store, key)) !== json) {
    throw new Error(conflictMessage);
  }
}

async function readTargetReceipt(
  store: BackupObjectStore,
  key: string,
): Promise<RestoreTargetReceipt> {
  const parsed = RestoreTargetReceiptSchema.safeParse(await readSmallJson(store, key));
  if (!parsed.success) {
    throw new Error('Restore target receipt is invalid');
  }
  return parsed.data;
}

async function ensureRestoreOrganization(client: ForgejoClient, owner: string): Promise<void> {
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
}

async function resolveIntentTarget(
  deps: { readonly store: BackupObjectStore; readonly client: ForgejoClient },
  intentKey: string,
  intent: RestoreIntent,
): Promise<ResolvedForgejoRestoreTarget> {
  const targetRef = internalRepoRef({
    organizationId: intent.targetOrganizationId,
    projectId: intent.targetProjectId,
  });
  const { owner, name } = parseInternalRepoRef(targetRef);
  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const targetReceiptKey = intent.targetReceiptKey;
  await ensureRestoreOrganization(deps.client, owner);

  const hasReceipt = await deps.store.exists(targetReceiptKey);
  const receipt = hasReceipt ? await readTargetReceipt(deps.store, targetReceiptKey) : undefined;
  let response = await deps.client.send<ForgejoRestoreRepository>({
    method: 'GET',
    path: repositoryPath,
    allow: [404],
  });
  if (response.status === 404) {
    if (receipt !== undefined) {
      throw new Error('Restore target ownership was lost; absent target preserved');
    }
    const created = await deps.client.send<ForgejoRestoreRepository>({
      method: 'POST',
      path: `/orgs/${encodeURIComponent(owner)}/repos`,
      body: {
        name,
        private: true,
        auto_init: false,
        default_branch: intent.defaultBranch,
        description: intent.targetMarker,
      },
      allow: [409],
    });
    response =
      created.status === 409
        ? await deps.client.send<ForgejoRestoreRepository>({
            method: 'GET',
            path: repositoryPath,
            allow: [404],
          })
        : created;
  }

  const repository = ForgejoRestoreRepositorySchema.safeParse(response.body);
  if (
    response.status === 404 ||
    !repository.success ||
    repository.data.description !== intent.targetMarker
  ) {
    throw new Error('Restore target does not match the durable intent; repository preserved');
  }
  if (
    receipt !== undefined &&
    (receipt.targetRef !== targetRef ||
      receipt.repositoryId !== repository.data.id ||
      receipt.targetMarker !== intent.targetMarker)
  ) {
    throw new Error('Restore target ownership was lost; replacement preserved');
  }

  const expectedReceipt = RestoreTargetReceiptSchema.parse({
    version: 1,
    targetRef,
    repositoryId: repository.data.id,
    targetMarker: intent.targetMarker,
  });
  await putExactJson(
    deps.store,
    targetReceiptKey,
    expectedReceipt,
    'Restore target receipt conflicts with the live repository',
  );

  const currentResponse = await deps.client.send<ForgejoRestoreRepository>({
    method: 'GET',
    path: repositoryPath,
    allow: [404],
  });
  const current = ForgejoRestoreRepositorySchema.safeParse(currentResponse.body);
  if (
    currentResponse.status === 404 ||
    !current.success ||
    current.data.id !== expectedReceipt.repositoryId ||
    current.data.description !== expectedReceipt.targetMarker
  ) {
    throw new Error('Restore target ownership was lost; replacement preserved');
  }
  return { repositoryId: current.data.id, cloneUrl: current.data.clone_url };
}

export async function beginRestoreOperation(
  deps: { readonly store: BackupObjectStore; readonly client: ForgejoClient },
  input: z.input<typeof RestoreOperationInputSchema>,
): Promise<RestoreOperation> {
  const parsed = RestoreOperationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('Invalid restore operation');
  }
  const operationId = createHash('sha256')
    .update(`${parsed.data.kind}\0${parsed.data.idempotencyKey}`)
    .digest('hex');
  const intentKey = `git-restore-intents/${parsed.data.kind}/${operationId}.json`;
  const drillTargetSeed = `org/${parsed.data.source.organizationId}/project/${parsed.data.source.projectId}/git-restore-drill-target/v1`;
  const drillTargetDigest = createHash('sha256').update(drillTargetSeed).digest('hex');
  const targetOrganizationId =
    parsed.data.kind === 'drill'
      ? deterministicId('org', `organization:${drillTargetSeed}`)
      : parsed.data.source.organizationId;
  const targetProjectId =
    parsed.data.kind === 'drill'
      ? deterministicId('proj', `project:${drillTargetSeed}`)
      : parsed.data.source.projectId;
  const targetReceiptKey =
    parsed.data.kind === 'drill'
      ? `git-restore-targets/drill/${drillTargetDigest}.json`
      : intentKey.replace(/\.json$/, '.target.json');
  const intent = RestoreIntentSchema.parse({
    version: 1,
    kind: parsed.data.kind,
    operationId,
    sourceOrganizationId: parsed.data.source.organizationId,
    sourceProjectId: parsed.data.source.projectId,
    backupKey: parsed.data.backupKey,
    targetOrganizationId,
    targetProjectId,
    targetReceiptKey,
    targetMarker:
      parsed.data.kind === 'drill'
        ? `zapp.build restore drill ${drillTargetDigest.slice(0, 32)}`
        : `zapp.build restore manual ${operationId.slice(0, 32)}`,
    defaultBranch: parsed.data.source.defaultBranch,
  });
  await putExactJson(deps.store, intentKey, intent);
  const targetRef = internalRepoRef({
    organizationId: targetOrganizationId,
    projectId: targetProjectId,
  });
  let resolvedTarget: ResolvedForgejoRestoreTarget | undefined;
  return {
    intentKey,
    targetRef,
    resolveTarget: async () => {
      resolvedTarget = await resolveIntentTarget(deps, intentKey, intent);
      return resolvedTarget;
    },
    recordPhase: async (phase, result) => {
      if (resolvedTarget === undefined) {
        throw new Error('Restore target must be resolved before recording progress');
      }
      const receipt = RestorePhaseReceiptSchema.parse({
        version: 1,
        intentKey,
        operationId: intent.operationId,
        backupKey: intent.backupKey,
        repositoryId: resolvedTarget.repositoryId,
        phase,
        ...(result === undefined
          ? {}
          : {
              resultDigest: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
            }),
      });
      await putExactJson(
        deps.store,
        intentKey.replace(/\.json$/, `.${phase}.json`),
        receipt,
        'Restore phase receipt conflicts with replayed state',
      );
    },
  };
}

function deterministicId(prefix: 'org' | 'proj', seed: string): string {
  const value = createHash('sha256').update(seed).digest('hex').slice(0, 26).toUpperCase();
  return `${prefix}_${value}`;
}

function restoreSelector(source: NodeJS.ProcessEnv): RestoreSelector {
  const parsed = RestoreSelectorSchema.safeParse({
    organizationId: source['GIT_RESTORE_ORGANIZATION_ID'],
    projectId: source['GIT_RESTORE_PROJECT_ID'],
    key: source['GIT_RESTORE_KEY'],
    idempotencyKey: source['GIT_RESTORE_IDEMPOTENCY_KEY'],
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
      const operation = await beginRestoreOperation(
        { store, client },
        {
          kind: 'manual',
          idempotencyKey: selector.idempotencyKey,
          source: repository,
          backupKey: selector.key,
        },
      );
      const result = await restoreRepositoryBackup(
        {
          store,
          git,
          resolveTarget: async () => await operation.resolveTarget(),
          recordPhase: async (phase, result) => {
            await operation.recordPhase(phase, result);
          },
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
        const drillKey = `drill-${createHash('sha256')
          .update(`${repository.organizationId}\0${repository.projectId}\0${key}`)
          .digest('hex')}`;
        const operation = await beginRestoreOperation(
          { store, client },
          { kind: 'drill', idempotencyKey: drillKey, source: repository, backupKey: key },
        );
        const result = await restoreRepositoryBackup(
          {
            store,
            git,
            resolveTarget: async () => await operation.resolveTarget(),
            recordPhase: async (phase, result) => {
              await operation.recordPhase(phase, result);
            },
          },
          { key, expectedBranches: [...expectedBranches] },
        );
        return {
          status: 'restore-drill-verified',
          projectId: repository.projectId,
          ...result,
        };
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
