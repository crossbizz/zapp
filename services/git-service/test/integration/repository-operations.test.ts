import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { internalRepoRef, newId } from '@zapp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRecordingGitAuditSink } from '../../src/audit.js';
import type { ForgejoClient } from '../../src/forgejo/client.js';
import { createForgejoGitProvider } from '../../src/provider/forgejo.js';
import { createRepositoryFeatures } from '../../src/provider/repository-features.js';
import {
  createRepositoryOperations,
  RepositorySeedConflictError,
} from '../../src/provider/repository-operations.js';
import type { GitProvider } from '../../src/provider/types.js';
import { createTemplateRegistry } from '../../src/template-registry.js';
import { createTokenService } from '../../src/tokens.js';
import {
  adminToken,
  credentialUrl,
  eventually,
  forgejoUrl,
  git,
  hasForgejo,
  integrationClient,
  removeWorkspace,
  workspace,
} from './helpers.js';

describe.skipIf(!hasForgejo)('repository comparison and template seeding, against Forgejo', () => {
  let client: ForgejoClient;
  let provider: GitProvider;
  const createdProjects: { organizationId: string; projectId: string }[] = [];
  const createdTemplateRepositories: string[] = [];

  beforeAll(async () => {
    client = integrationClient();
    provider = createForgejoGitProvider({ client });
    await client.send({
      method: 'POST',
      path: '/orgs',
      body: { username: 'zapp-projects', visibility: 'private' },
      allow: [422],
    });
  });

  afterAll(async () => {
    for (const name of createdTemplateRepositories) {
      await client.send({
        method: 'DELETE',
        path: `/repos/zapp-projects/${encodeURIComponent(name)}`,
        allow: [404],
      });
    }
    for (const project of createdProjects) {
      const [owner, name] = internalRepoRef(project).split('/') as [string, string];
      await client.send({ method: 'DELETE', path: `/repos/${owner}/${name}`, allow: [404] });
      await client.send({ method: 'DELETE', path: `/orgs/${owner}`, allow: [404] });
    }
  });

  it('atomically seeds an exact approved commit, replays its key, and compares its patch', async () => {
    const sourceName = `template-seed-${randomBytes(6).toString('hex')}`;
    createdTemplateRepositories.push(sourceName);
    await client.send({
      method: 'POST',
      path: '/orgs/zapp-projects/repos',
      body: { name: sourceName, private: true, auto_init: false, default_branch: 'main' },
    });

    const organizationId = newId('org');
    const projectId = newId('proj');
    createdProjects.push({ organizationId, projectId });
    await provider.createRepository({
      organizationId,
      projectId,
      defaultBranch: 'main',
    });

    const directory = await workspace();
    try {
      const sourceWork = `${directory}/source`;
      const sourceCloneUrl = `${forgejoUrl()}/zapp-projects/${sourceName}.git`;
      expect(
        (
          await git(
            directory,
            'clone',
            credentialUrl(sourceCloneUrl, 'zapp-admin-token', adminToken()),
            sourceWork,
          )
        ).ok,
      ).toBe(true);
      await git(sourceWork, 'config', 'user.name', 'Template Seed Integration');
      await git(sourceWork, 'config', 'user.email', 'template-seed@zapp.test');
      await writeFile(`${sourceWork}/value.txt`, 'one\n');
      await git(sourceWork, 'add', 'value.txt');
      await git(sourceWork, 'commit', '-m', 'first');
      const beforeSha = (await git(sourceWork, 'rev-parse', 'HEAD')).output.trim();
      await writeFile(`${sourceWork}/value.txt`, 'two\n');
      await git(sourceWork, 'commit', '-am', 'selected');
      const selectedSha = (await git(sourceWork, 'rev-parse', 'HEAD')).output.trim();
      await writeFile(`${sourceWork}/value.txt`, 'three\n');
      await git(sourceWork, 'commit', '-am', 'later');
      const laterSha = (await git(sourceWork, 'rev-parse', 'HEAD')).output.trim();
      expect((await git(sourceWork, 'push', 'origin', 'HEAD:main')).ok).toBe(true);

      const operations = createRepositoryOperations({ commandTimeoutMs: 30_000 });
      const audit = createRecordingGitAuditSink();
      const features = createRepositoryFeatures({
        registry: createTemplateRegistry({
          version: 1,
          templates: [
            {
              slug: sourceName,
              name: 'Integration Template',
              description: 'An integration-only approved source.',
              pagesIncluded: ['Home'],
              highlights: ['Scoped source credential'],
              demoUrl: `https://${sourceName}.demo.zapp.build`,
              stack: 'TypeScript',
              source: {
                approved: true,
                repoRef: `zapp-projects/${sourceName}`,
                commitSha: selectedSha,
              },
            },
          ],
        }),
        tokens: createTokenService({ client, audit }),
        operations,
        headReader: provider,
      });
      const seedInput = {
        organizationId,
        projectId,
        templateSlug: sourceName,
        operationKey: 'forgejo-template-seed-001',
      } as const;

      await expect(features.seedApprovedTemplate(seedInput)).resolves.toEqual({
        headCommitSha: selectedSha,
        replayed: false,
      });
      await expect(features.seedApprovedTemplate(seedInput)).resolves.toEqual({
        headCommitSha: selectedSha,
        replayed: true,
      });
      await expect(
        features.seedApprovedTemplate({
          ...seedInput,
          operationKey: 'forgejo-template-seed-002',
        }),
      ).rejects.toBeInstanceOf(RepositorySeedConflictError);

      const targetBranch = await eventually(
        () => provider.getBranch(internalRepoRef({ organizationId, projectId }), 'main'),
        'seeded main branch to appear',
      );
      expect(targetBranch.headSha).toBe(selectedSha);
      expect(targetBranch.headSha).not.toBe(laterSha);

      const comparison = await features.compare({
        organizationId,
        projectId,
        beforeSha,
        afterSha: selectedSha,
      });
      expect(comparison).toMatchObject({ beforeSha, afterSha: selectedSha });
      expect(comparison.patch).toContain('-one');
      expect(comparison.patch).toContain('+two');
      expect(
        audit.events.some(
          (event) =>
            event.action === 'git_token.minted' &&
            event.metadata.internalRepoRef === `zapp-projects/${sourceName}` &&
            event.metadata.access === 'read',
        ),
      ).toBe(true);
    } finally {
      await removeWorkspace(directory);
    }
  }, 120_000);
});
