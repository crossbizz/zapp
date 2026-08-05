import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { internalRepoRef, newId } from '@zapp/contracts';
import { branches, organizations, projects, repositories, users } from '@zapp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  beginRestoreOperation,
  createForgejoRestoreCredentialIssuer,
} from '../../scripts/backup.js';
import { createRecordingGitAuditSink } from '../../src/audit.js';
import {
  createDbBackupInventory,
  createGitBundleCommands,
  createR2BackupObjectStore,
  restoreRepositoryBackup,
  runRepositoryBackup,
  type BackupInventory,
  type BackupObjectStore,
} from '../../src/backup.js';
import { loadArtifactEnv } from '../../src/env.js';
import type { ForgejoClient } from '../../src/forgejo/client.js';
import { createForgejoGitProvider } from '../../src/provider/forgejo.js';
import type { GitProvider } from '../../src/provider/types.js';
import { createTokenService } from '../../src/tokens.js';
import { credentialGate } from '../support/credentials.js';
import {
  adminToken,
  forgejoUrl,
  inContinuousIntegration,
  integrationClient,
  setUpTestDatabase,
} from './helpers.js';

const run = promisify(execFile);
const backupGate = credentialGate([
  'FORGEJO_URL',
  'FORGEJO_ADMIN_TOKEN',
  'DATABASE_URL',
  'ARTIFACT_ENDPOINT',
  'ARTIFACT_KEY',
  'ARTIFACT_SECRET',
  'ARTIFACT_BUCKET',
]);
const liveClaimed = (process.env['GIT_BACKUP_LIVE'] ?? '') === '1';

if (inContinuousIntegration() && liveClaimed && !backupGate.present) {
  throw new Error(
    `refusing to skip the declared GIT_BACKUP_LIVE job: ${backupGate.reason}. Forgejo, PostgreSQL, and S3-compatible storage must all be declared services.`,
  );
}
if (!backupGate.present) {
  console.warn(
    `[@zapp/git-service] backup/restore integration SKIPPED — not run, not passed: ${backupGate.reason}`,
  );
}

const AskpassScript = `#!/bin/sh
case "$1" in
  *sername*) printf '%s\\n' "$ZAPP_GIT_USERNAME" ;;
  *) printf '%s\\n' "$ZAPP_GIT_PASSWORD" ;;
esac
`;

async function authenticatedGit(
  cwd: string,
  token: string,
  args: readonly string[],
): Promise<string> {
  expect(args.join(' ')).not.toContain(token);
  const directory = await mkdtemp(join(tmpdir(), 'zapp-backup-live-askpass-'));
  const askpass = join(directory, 'askpass.sh');
  try {
    await writeFile(askpass, AskpassScript, { mode: 0o700 });
    await chmod(askpass, 0o700);
    try {
      const { stdout } = await run('git', [...args], {
        cwd,
        env: {
          PATH: process.env['PATH'] ?? '',
          LANG: process.env['LANG'] ?? 'C',
          GIT_ASKPASS: askpass,
          GIT_ASKPASS_REQUIRE: 'force',
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          ZAPP_GIT_USERNAME: 'zapp-admin-token',
          ZAPP_GIT_PASSWORD: token,
        },
        signal: AbortSignal.timeout(30_000),
      });
      return stdout;
    } catch {
      throw new Error('live Git command failed');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function refs(output: string): Map<string, string> {
  return new Map(
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split('\t');
        if (sha === undefined || ref === undefined) {
          throw new Error('invalid ls-remote output');
        }
        return [ref, sha] as const;
      }),
  );
}

describe.skipIf(!backupGate.present)('live Forgejo + MinIO bundle backup and restore', () => {
  const organizationId = newId('org');
  const projectId = newId('proj');
  const userId = newId('user');
  const repositoryId = newId('repo');
  const mainBranchId = newId('br');
  const featureBranchId = newId('br');
  const ref = internalRepoRef({ organizationId, projectId });
  const scratch: string[] = [];
  let database: Awaited<ReturnType<typeof setUpTestDatabase>> | undefined;
  let client: ForgejoClient | undefined;
  let provider: GitProvider | undefined;
  let inventory: BackupInventory | undefined;
  let store: BackupObjectStore | undefined;
  let backupObjectKey: string | undefined;
  const restoreReceiptKeys = new Set<string>();
  let cloneUrl: string | undefined;

  beforeAll(async () => {
    database = await setUpTestDatabase();
    client = integrationClient();
    provider = createForgejoGitProvider({ client });
    inventory = createDbBackupInventory(database.db, forgejoUrl());
    store = createR2BackupObjectStore(loadArtifactEnv());

    await database.db.insert(users).values({
      id: userId,
      email: `${userId.toLowerCase()}@zapp.test`,
      displayName: 'GIT-4 restore drill',
    });
    await database.db.insert(organizations).values({
      id: organizationId,
      name: 'GIT-4 restore drill',
      slug: `git4-${organizationId.slice(-10).toLowerCase()}`,
    });
    await database.db.insert(projects).values({
      id: projectId,
      organizationId,
      name: 'GIT-4 restore drill',
      slug: `git4-${projectId.slice(-10).toLowerCase()}`,
      sourceType: 'prompt',
      supportLevel: 'compatible',
      createdBy: userId,
    });

    const created = await provider.createRepository({
      organizationId,
      projectId,
      defaultBranch: 'main',
    });
    cloneUrl = created.cloneUrl;
    await database.db.insert(repositories).values({
      id: repositoryId,
      organizationId,
      projectId,
      provider: 'internal',
      internalRepoRef: ref,
      defaultBranch: 'main',
      syncPolicy: 'internal',
      provisionedAt: created.provisionedAt,
    });

    const seedRoot = await mkdtemp(join(tmpdir(), 'zapp-backup-live-seed-'));
    scratch.push(seedRoot);
    await authenticatedGit(seedRoot, adminToken(), ['clone', created.cloneUrl, 'repository']);
    const seed = join(seedRoot, 'repository');
    await authenticatedGit(seed, adminToken(), ['config', 'user.email', 'backup@zapp.test']);
    await authenticatedGit(seed, adminToken(), ['config', 'user.name', 'GIT-4 restore drill']);
    await writeFile(join(seed, 'README.md'), 'main history\n');
    await authenticatedGit(seed, adminToken(), ['add', 'README.md']);
    await authenticatedGit(seed, adminToken(), ['commit', '-m', 'seed main']);
    await authenticatedGit(seed, adminToken(), ['branch', '-M', 'main']);
    const mainHead = (await authenticatedGit(seed, adminToken(), ['rev-parse', 'HEAD'])).trim();
    await authenticatedGit(seed, adminToken(), ['push', 'origin', 'main']);
    await authenticatedGit(seed, adminToken(), ['checkout', '-b', 'feature/restore-proof']);
    await writeFile(join(seed, 'feature.txt'), 'feature history\n');
    await authenticatedGit(seed, adminToken(), ['add', 'feature.txt']);
    await authenticatedGit(seed, adminToken(), ['commit', '-m', 'seed feature']);
    const featureHead = (await authenticatedGit(seed, adminToken(), ['rev-parse', 'HEAD'])).trim();
    await authenticatedGit(seed, adminToken(), ['push', 'origin', 'feature/restore-proof']);
    await authenticatedGit(seed, adminToken(), ['tag', 'restore-proof-v1', mainHead]);
    await authenticatedGit(seed, adminToken(), ['push', 'origin', 'restore-proof-v1']);

    await database.db.insert(branches).values([
      {
        id: mainBranchId,
        organizationId,
        projectId,
        name: 'main',
        headCommitSha: mainHead,
        status: 'active',
      },
      {
        id: featureBranchId,
        organizationId,
        projectId,
        name: 'feature/restore-proof',
        headCommitSha: featureHead,
        status: 'active',
      },
    ]);
  }, 180_000);

  afterAll(async () => {
    if (provider !== undefined) {
      await provider.deleteRepository(ref);
    }
    if (client !== undefined) {
      await client.send({
        method: 'DELETE',
        path: `/orgs/${organizationId.toLowerCase()}`,
        allow: [404],
      });
    }
    if (store !== undefined && backupObjectKey !== undefined) {
      await store.delete(backupObjectKey);
    }
    if (store !== undefined) {
      const activeStore = store;
      const intentKeys = [...restoreReceiptKeys].filter((key) =>
        /^git-restore-intents\/(?:manual|drill)\/[0-9a-f]{64}\.json$/.test(key),
      );
      for (const intentKey of intentKeys) {
        let continuationToken: string | undefined;
        const prefix = intentKey.replace(/\.json$/, '.credentials/');
        do {
          const page = await activeStore.list(prefix, continuationToken);
          for (const object of page.objects) {
            restoreReceiptKeys.add(object.key);
          }
          continuationToken = page.continuationToken;
        } while (continuationToken !== undefined);
      }
      await Promise.all(
        [...restoreReceiptKeys].map(async (key) => {
          await activeStore.delete(key);
        }),
      );
    }
    if (database !== undefined) {
      await database.db.delete(branches).where(eq(branches.projectId, projectId));
      await database.db.delete(repositories).where(eq(repositories.id, repositoryId));
      await database.db.delete(projects).where(eq(projects.id, projectId));
      await database.db.delete(organizations).where(eq(organizations.id, organizationId));
      await database.db.delete(users).where(eq(users.id, userId));
      await database.close();
    }
    await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
  }, 180_000);

  it('backs up, deletes, restores, compares every ref and database branch, then clones', async () => {
    if (
      client === undefined ||
      provider === undefined ||
      inventory === undefined ||
      store === undefined ||
      database === undefined ||
      cloneUrl === undefined
    ) {
      throw new Error('live backup test was not initialized');
    }
    const activeClient = client;
    const activeProvider = provider;
    const restoreCredentials = createForgejoRestoreCredentialIssuer(
      activeClient,
      createTokenService({ client: activeClient, audit: createRecordingGitAuditSink() }),
      240_000,
    );
    const token = adminToken();
    const before = refs(await authenticatedGit(tmpdir(), token, ['ls-remote', cloneUrl]));
    const repository = (await inventory.listProvisionedRepositories()).find(
      (entry) => entry.projectId === projectId,
    );
    if (repository === undefined) {
      throw new Error('seeded provisioned repository was not inventoried');
    }
    const git = createGitBundleCommands({
      username: 'zapp-admin-token',
      password: token,
      timeoutMs: 30_000,
    });
    const backedUp = await runRepositoryBackup({ store, git }, repository);
    backupObjectKey = backedUp.key;
    expect(await store.exists(backedUp.key)).toBe(true);

    await activeProvider.deleteRepository(ref);
    const [owner, name] = ref.split('/');
    const missing = await activeClient.send({
      method: 'GET',
      path: `/repos/${owner ?? ''}/${name ?? ''}`,
      allow: [404],
    });
    expect(missing.status).toBe(404);

    const expectedBranches = await inventory.expectedBranches(organizationId, projectId);
    const restoreInput = {
      kind: 'manual' as const,
      idempotencyKey: `live-${projectId}`,
      source: repository,
      backupKey: backedUp.key,
    };
    const failedOperation = await beginRestoreOperation(
      { store, client: activeClient },
      restoreInput,
    );
    restoreReceiptKeys.add(failedOperation.intentKey);
    restoreReceiptKeys.add(failedOperation.intentKey.replace(/\.json$/, '.target.json'));
    restoreReceiptKeys.add(failedOperation.intentKey.replace(/\.json$/, '.push-started.json'));
    restoreReceiptKeys.add(failedOperation.intentKey.replace(/\.json$/, '.push-complete.json'));
    restoreReceiptKeys.add(failedOperation.intentKey.replace(/\.json$/, '.verified.json'));
    await expect(
      restoreRepositoryBackup(
        {
          store,
          git,
          resolveTarget: async () => {
            const target = await failedOperation.resolveTarget();
            return await restoreCredentials.issue({
              sourceOrganizationId: organizationId,
              sourceProjectId: projectId,
              targetRef: failedOperation.targetRef,
              repositoryId: target.repositoryId,
              cloneUrl: target.cloneUrl,
              reserveCredentialCleanup: async (allocation) =>
                await failedOperation.reserveCredentialCleanup(allocation),
              recordCredentialCreated: async (allocation) => {
                await failedOperation.recordCredentialCreated(allocation);
              },
              completeCredentialCleanup: async (allocation) => {
                await failedOperation.completeCredentialCleanup(allocation);
              },
            });
          },
          recordPhase: async (phase, result) => {
            await failedOperation.recordPhase(phase, result);
          },
        },
        {
          key: backedUp.key,
          expectedBranches: expectedBranches.map((branch) =>
            branch.name === 'main' ? { ...branch, headCommitSha: 'f'.repeat(40) } : branch,
          ),
        },
      ),
    ).rejects.toThrow('Restored branch heads do not match the database');
    const [failedOwner, failedName] = failedOperation.targetRef.split('/');
    const retainedTarget = await activeClient.send({
      method: 'GET',
      path: `/repos/${failedOwner ?? ''}/${failedName ?? ''}`,
      allow: [404],
    });
    expect(retainedTarget.status).toBe(200);

    const retryOperation = await beginRestoreOperation(
      { store, client: activeClient },
      restoreInput,
    );
    let restoredCloneUrl: string | undefined;
    const restoreResult = await restoreRepositoryBackup(
      {
        store,
        git,
        resolveTarget: async () => {
          const target = await retryOperation.resolveTarget();
          const credential = await restoreCredentials.issue({
            sourceOrganizationId: organizationId,
            sourceProjectId: projectId,
            targetRef: retryOperation.targetRef,
            repositoryId: target.repositoryId,
            cloneUrl: target.cloneUrl,
            reserveCredentialCleanup: async (allocation) =>
              await retryOperation.reserveCredentialCleanup(allocation),
            recordCredentialCreated: async (allocation) => {
              await retryOperation.recordCredentialCreated(allocation);
            },
            completeCredentialCleanup: async (allocation) => {
              await retryOperation.completeCredentialCleanup(allocation);
            },
          });
          restoredCloneUrl = credential.cloneUrl;
          return credential;
        },
        recordPhase: async (phase, result) => {
          await retryOperation.recordPhase(phase, result);
        },
      },
      { key: backedUp.key, expectedBranches: [...expectedBranches] },
    );
    expect(restoreResult.checkedBranches).toBe(2);
    expect(restoreResult.branches).toEqual(
      expectedBranches
        .filter(
          (branch): branch is { readonly name: string; readonly headCommitSha: string } =>
            branch.headCommitSha !== null,
        )
        .map((branch) => ({
          name: branch.name,
          expectedSha: branch.headCommitSha,
          actualSha: branch.headCommitSha,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    );
    if (restoredCloneUrl === undefined) {
      throw new Error('live restore target was not created');
    }

    const after = refs(await authenticatedGit(tmpdir(), token, ['ls-remote', restoredCloneUrl]));
    expect(after).toEqual(before);
    expect(new Map(restoreResult.refs.map((entry) => [entry.name, entry.sha]))).toEqual(
      new Map([...before].filter(([name]) => name.startsWith('refs/'))),
    );
    expect(after.get('refs/tags/restore-proof-v1')).toBe(before.get('refs/tags/restore-proof-v1'));

    const cloneRoot = await mkdtemp(join(tmpdir(), 'zapp-backup-live-clone-'));
    scratch.push(cloneRoot);
    await authenticatedGit(cloneRoot, token, ['clone', restoredCloneUrl, 'repository']);
    const clone = join(cloneRoot, 'repository');
    expect((await authenticatedGit(clone, token, ['rev-parse', 'origin/main'])).trim()).toBe(
      before.get('refs/heads/main'),
    );
    expect(
      (await authenticatedGit(clone, token, ['rev-parse', 'origin/feature/restore-proof'])).trim(),
    ).toBe(before.get('refs/heads/feature/restore-proof'));
  }, 180_000);
});
