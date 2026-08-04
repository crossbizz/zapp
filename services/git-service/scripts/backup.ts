import process from 'node:process';

import { idSchema, internalRepoRef, newId, parseInternalRepoRef } from '@zapp/contracts';
import { createDb } from '@zapp/db';
import { z } from 'zod';

import {
  createDbBackupInventory,
  createGitBundleCommands,
  createR2BackupObjectStore,
  latestBackupKey,
  restoreRepositoryBackup,
  runNightlyBackups,
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
  .refine((value) =>
    new RegExp(
      `^org/${value.organizationId}/project/${value.projectId}/git-backups/\\d{4}-\\d{2}-\\d{2}\\.bundle$`,
    ).test(value.key),
  );

function restoreSelector(
  source: NodeJS.ProcessEnv = process.env,
): z.infer<typeof RestoreSelectorSchema> {
  const parsed = RestoreSelectorSchema.safeParse({
    organizationId: source['GIT_RESTORE_ORGANIZATION_ID'],
    projectId: source['GIT_RESTORE_PROJECT_ID'],
    key: source['GIT_RESTORE_KEY'],
  });
  if (!parsed.success) {
    throw new Error(
      'Invalid restore selector: GIT_RESTORE_ORGANIZATION_ID, GIT_RESTORE_PROJECT_ID, GIT_RESTORE_KEY',
    );
  }
  return parsed.data;
}

const action = z
  .enum(['nightly', 'restore', 'restore-drill', 'restore-cleanup'])
  .safeParse(process.argv[2] ?? 'nightly');
if (!action.success) {
  throw new Error('Invalid backup action');
}

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
}): Promise<string> {
  const created = await provider.createRepository(input);
  const { owner, name } = parseInternalRepoRef(created.internalRepoRef);
  const details = await client.send<{ readonly empty?: boolean }>({
    method: 'GET',
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  });
  if (details.body?.empty !== true) {
    throw new Error('Restore target is not a fresh empty repository');
  }
  return created.cloneUrl;
}

async function nightly(): Promise<void> {
  const report = await runNightlyBackups({ inventory, store, git });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

async function restore(): Promise<void> {
  const selector = restoreSelector();
  const repositories = await inventory.listProvisionedRepositories();
  const repository = repositories.find(
    (entry) =>
      entry.organizationId === selector.organizationId && entry.projectId === selector.projectId,
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
  process.stdout.write(
    `${JSON.stringify({ status: 'restored', projectId: selector.projectId, ...result })}\n`,
  );
}

async function restoreDrill(): Promise<void> {
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
  const drillRef = internalRepoRef({
    organizationId: drillOrganizationId,
    projectId: drillProjectId,
  });
  try {
    const result = await restoreRepositoryBackup(
      {
        store,
        git,
        createTarget: async () =>
          await createEmptyTarget({
            organizationId: drillOrganizationId,
            projectId: drillProjectId,
            defaultBranch: repository.defaultBranch,
          }),
      },
      { key, expectedBranches: [...expectedBranches] },
    );
    process.stdout.write(
      `${JSON.stringify({ status: 'restore-drill-verified', projectId: repository.projectId, ...result })}\n`,
    );
  } finally {
    await provider.deleteRepository(drillRef);
    await client.send({
      method: 'DELETE',
      path: `/orgs/${drillOrganizationId.toLowerCase()}`,
      allow: [404],
    });
  }
}

async function restoreCleanup(): Promise<void> {
  const selector = restoreSelector();
  await provider.deleteRepository(
    internalRepoRef({
      organizationId: selector.organizationId,
      projectId: selector.projectId,
    }),
  );
  process.stdout.write(`${JSON.stringify({ status: 'restore-target-removed' })}\n`);
}

try {
  switch (action.data) {
    case 'nightly':
      await nightly();
      break;
    case 'restore':
      await restore();
      break;
    case 'restore-drill':
      await restoreDrill();
      break;
    case 'restore-cleanup':
      await restoreCleanup();
      break;
  }
} catch {
  process.stderr.write('Git backup operation failed\n');
  process.exitCode = 1;
} finally {
  await database.close();
}
