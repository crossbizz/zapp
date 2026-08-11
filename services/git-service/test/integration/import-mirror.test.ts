import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { internalRepoRef, newId } from '@zapp/contracts';

import type { ForgejoClient } from '../../src/forgejo/client.js';
import { createGitMirror, GitMirrorConflictError } from '../../src/import/mirror.js';
import { createForgejoGitProvider } from '../../src/provider/forgejo.js';
import type { GitProvider } from '../../src/provider/types.js';
import {
  adminToken,
  credentialUrl,
  eventually,
  git,
  hasForgejo,
  integrationClient,
  removeWorkspace,
  workspace,
} from './helpers.js';

describe.skipIf(!hasForgejo)('GitHub-style import mirror, against a real Forgejo instance', () => {
  let client: ForgejoClient;
  let provider: GitProvider;
  const created: { organizationId: string; projectId: string }[] = [];

  function project(): { organizationId: string; projectId: string; ref: string } {
    const organizationId = newId('org');
    const projectId = newId('proj');
    created.push({ organizationId, projectId });
    return { organizationId, projectId, ref: internalRepoRef({ organizationId, projectId }) };
  }

  beforeAll(() => {
    client = integrationClient();
    provider = createForgejoGitProvider({ client });
  });

  afterAll(async () => {
    for (const { organizationId, projectId } of created) {
      const [owner, name] = internalRepoRef({ organizationId, projectId }).split('/') as [string, string];
      await client.send({ method: 'DELETE', path: `/repos/${owner}/${name}`, allow: [404] });
    }
    for (const owner of new Set(created.map((entry) => entry.organizationId.toLowerCase()))) {
      await client.send({ method: 'DELETE', path: `/orgs/${owner}`, allow: [404] });
    }
  });

  it('preserves selected-branch lineage, retries equal heads, and refuses divergent history', async () => {
    const source = project();
    const target = project();
    const sourceRepository = await provider.createRepository({
      organizationId: source.organizationId,
      projectId: source.projectId,
      defaultBranch: 'main',
    });
    const targetRepository = await provider.createRepository({
      organizationId: target.organizationId,
      projectId: target.projectId,
      defaultBranch: 'main',
    });
    const directory = await workspace();
    try {
      const sourceWork = `${directory}/source`;
      expect(
        (await git(directory, 'clone', credentialUrl(sourceRepository.cloneUrl, 'zapp-admin-token', adminToken()), sourceWork)).ok,
      ).toBe(true);
      await git(sourceWork, 'config', 'user.name', 'Import Integration');
      await git(sourceWork, 'config', 'user.email', 'import-integration@zapp.test');
      await git(sourceWork, 'checkout', '-b', 'feature/import');
      await git(sourceWork, 'commit', '--allow-empty', '-m', 'first source commit');
      const first = (await git(sourceWork, 'rev-parse', 'HEAD')).output.trim();
      await git(sourceWork, 'commit', '--allow-empty', '-m', 'second source commit');
      const sourceHead = (await git(sourceWork, 'rev-parse', 'HEAD')).output.trim();
      expect((await git(sourceWork, 'push', 'origin', 'HEAD:feature/import')).ok).toBe(true);
      await eventually(() => provider.getBranch(source.ref, 'feature/import'), 'source branch to appear');

      const mirrorInput = {
        sourceCloneUrl: sourceRepository.cloneUrl,
        sourceToken: adminToken(),
        sourceBranch: 'feature/import',
        targetCloneUrl: targetRepository.cloneUrl,
        targetUsername: 'zapp-admin-token',
        targetToken: adminToken(),
      } as const;
      const mirror = createGitMirror({ timeoutMs: 30_000 });
      await expect(mirror.mirror(mirrorInput)).resolves.toEqual({ headCommitSha: sourceHead });
      await expect(mirror.mirror(mirrorInput)).resolves.toEqual({ headCommitSha: sourceHead });
      const targetBranch = await eventually(
        () => provider.getBranch(target.ref, 'feature/import'),
        'mirrored branch to appear',
      );
      expect(targetBranch.headSha).toBe(sourceHead);

      const targetWork = `${directory}/target`;
      expect(
        (await git(directory, 'clone', credentialUrl(targetRepository.cloneUrl, 'zapp-admin-token', adminToken()), targetWork)).ok,
      ).toBe(true);
      await git(targetWork, 'config', 'user.name', 'Import Target');
      await git(targetWork, 'config', 'user.email', 'import-target@zapp.test');
      await git(targetWork, 'fetch', 'origin', 'feature/import');
      await git(targetWork, 'checkout', '-b', 'conflict', first);
      await git(targetWork, 'commit', '--allow-empty', '-m', 'divergent target commit');
      const divergentHead = (await git(targetWork, 'rev-parse', 'HEAD')).output.trim();
      expect((await git(targetWork, 'push', '--force', 'origin', 'HEAD:feature/import')).ok).toBe(true);
      await eventually(
        async () =>
          (await provider.getBranch(target.ref, 'feature/import'))?.headSha === divergentHead
            ? true
            : undefined,
        'target branch to diverge',
      );
      await expect(mirror.mirror(mirrorInput)).rejects.toBeInstanceOf(GitMirrorConflictError);
      expect((await provider.getBranch(target.ref, 'feature/import'))?.headSha).toBe(divergentHead);
    } finally {
      await removeWorkspace(directory);
    }
  }, 120_000);
});
