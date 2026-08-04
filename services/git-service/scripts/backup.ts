import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { idSchema, newId, parseInternalRepoRef } from '@zapp/contracts';
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
  type NightlyBackupReport,
  type RestoreRepositoryResult,
} from '../src/backup.js';
import { loadArtifactEnv, loadDatabaseUrl, loadForgejoEnv } from '../src/env.js';
import { createForgejoClient } from '../src/forgejo/client.js';
import { createForgejoGitProvider } from '../src/provider/forgejo.js';

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

function createProductionOperations(): BackupCliOperations {
  const forgejo = loadForgejoEnv();
  const artifact = loadArtifactEnv();
  const database = createDb(loadDatabaseUrl());
  const client = createForgejoClient(forgejo);
  const provider = createForgejoGitProvider({ client });
  const inventory = createDbBackupInventory(database.db, forgejo.baseUrl);
  const store = createR2BackupObjectStore(artifact);
  const git = createGitBundleCommands({
    username: 'zapp-admin-token',
    password: forgejo.adminToken,
    timeoutMs: 30_000,
  });

  async function createEmptyTarget(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly defaultBranch: string;
  }) {
    const created = await provider.createRepository(input);
    const compensate = async (): Promise<void> => {
      await provider.deleteRepository(created.internalRepoRef);
    };
    try {
      const { owner, name } = parseInternalRepoRef(created.internalRepoRef);
      const details = await client.send<{ readonly empty?: boolean }>({
        method: 'GET',
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      });
      if (details.body?.empty !== true) {
        throw new Error('Restore target is not a fresh empty repository');
      }
    } catch {
      try {
        await compensate();
      } catch {
        throw new Error('Fresh target validation and compensation failed');
      }
      throw new Error('Restore target is not a fresh empty repository');
    }
    return { cloneUrl: created.cloneUrl, compensate };
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
      const drillOrganizationId = newId('org');
      const drillProjectId = newId('proj');
      let disposeCreatedTarget: (() => Promise<void>) | undefined;
      try {
        const result = await restoreRepositoryBackup(
          {
            store,
            git,
            createTarget: async () => {
              const target = await createEmptyTarget({
                organizationId: drillOrganizationId,
                projectId: drillProjectId,
                defaultBranch: repository.defaultBranch,
              });
              disposeCreatedTarget = target.compensate;
              return {
                ...target,
                compensate: async () => {
                  const compensate = disposeCreatedTarget;
                  disposeCreatedTarget = undefined;
                  await compensate?.();
                },
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
        await disposeCreatedTarget?.();
        await client.send({
          method: 'DELETE',
          path: `/orgs/${drillOrganizationId.toLowerCase()}`,
          allow: [404],
        });
      }
    },

    close: async () => {
      await database.close();
    },
  };
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
