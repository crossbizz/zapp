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
      cloneUrl === undefined
    ) {
      throw new Error('live backup test was not initialized');
    }
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

    await provider.deleteRepository(ref);
    const [owner, name] = ref.split('/');
    const missing = await client.send({
      method: 'GET',
      path: `/repos/${owner ?? ''}/${name ?? ''}`,
      allow: [404],
    });
    expect(missing.status).toBe(404);

    const restoredTarget = await provider.createRepository({
      organizationId,
      projectId,
      defaultBranch: 'main',
    });
    const expectedBranches = await inventory.expectedBranches(organizationId, projectId);
    await expect(
      restoreRepositoryBackup(
        { store, git },
        {
          key: backedUp.key,
          targetCloneUrl: restoredTarget.cloneUrl,
          expectedBranches: [...expectedBranches],
        },
      ),
    ).resolves.toEqual({ checkedBranches: 2 });

    const after = refs(
      await authenticatedGit(tmpdir(), token, ['ls-remote', restoredTarget.cloneUrl]),
    );
    expect(after).toEqual(before);
    expect(after.get('refs/tags/restore-proof-v1')).toBe(before.get('refs/tags/restore-proof-v1'));

    const cloneRoot = await mkdtemp(join(tmpdir(), 'zapp-backup-live-clone-'));
    scratch.push(cloneRoot);
    await authenticatedGit(cloneRoot, token, ['clone', restoredTarget.cloneUrl, 'repository']);
    const clone = join(cloneRoot, 'repository');
    expect((await authenticatedGit(clone, token, ['rev-parse', 'origin/main'])).trim()).toBe(
      before.get('refs/heads/main'),
    );
    expect(
      (await authenticatedGit(clone, token, ['rev-parse', 'origin/feature/restore-proof'])).trim(),
    ).toBe(before.get('refs/heads/feature/restore-proof'));
  }, 180_000);
});
