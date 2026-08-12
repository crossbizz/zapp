import { internalRepoRef, newId } from '@zapp/contracts';
import { writeFile } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRecordingGitAuditSink, type RecordingGitAuditSink } from '../../src/audit.js';
import { createGitBundleCommands } from '../../src/backup.js';
import {
  createGitBundleExporter,
  createTokenServiceGitBundleCredentials,
} from '../../src/export.js';
import type { ForgejoClient } from '../../src/forgejo/client.js';
import { createForgejoGitProvider } from '../../src/provider/forgejo.js';
import type { GitProvider } from '../../src/provider/types.js';
import { createTokenService, expiryOf, type TokenService } from '../../src/tokens.js';
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

/**
 * Repository-scoped tokens, against a real Forgejo (plan 06 GIT-3).
 *
 * **This file is the security argument.** Everything else about GIT-3 is
 * arrangement — a username format, a ceiling, an audit row — and the only claim
 * that matters is the one no unit test can make: *a token minted for one
 * repository cannot reach another one.* Forgejo has no repository-scoped token,
 * so that property is manufactured out of a restricted user with exactly one
 * collaboration, and whether that actually holds is a question about Forgejo.
 * The answer here is a `git clone` that fails.
 *
 * Four properties, in the order they matter:
 *
 *   1. the token clones and pushes **its own** repository;
 *   2. it cannot clone another repository, in the same tenant or another one —
 *      over `git` *and* over the API, because either would be a cross-tenant read;
 *   3. a **read** token cannot push;
 *   4. once expired and swept, it cannot do anything at all.
 *
 * Skips loudly without the dev stack — see `helpers.ts`.
 */

describe.skipIf(!hasForgejo)('repository-scoped tokens, against a real instance', () => {
  let client: ForgejoClient;
  let provider: GitProvider;
  let tokens: TokenService;
  let audit: RecordingGitAuditSink;
  const created: { organizationId: string; projectId: string }[] = [];
  /** Ephemeral users this suite minted, cleaned up even when an assertion fails. */
  const minted: string[] = [];

  /**
   * A project, optionally in an organization that already exists.
   *
   * The `organizationId` argument is what makes the same-tenant half of the
   * cross-repo assertion real. Without it every project gets a fresh
   * organization, so "another repository" only ever means "another Forgejo
   * organization" — and a token scoped by *namespace* alone would pass. The
   * interesting case is two repositories the same tenant owns, side by side in
   * one organization, where only the collaboration distinguishes them.
   */
  function project(organizationId = newId('org')): {
    organizationId: string;
    projectId: string;
    ref: string;
  } {
    const projectId = newId('proj');
    created.push({ organizationId, projectId });
    return { organizationId, projectId, ref: internalRepoRef({ organizationId, projectId }) };
  }

  async function mint(
    target: { organizationId: string; projectId: string },
    access: 'read' | 'write',
    ttlSec = 600,
  ) {
    const token = await tokens.mint({
      ...target,
      access,
      ttlSec,
      requestingService: 'sandbox-service',
      runId: newId('run'),
    });
    minted.push(token.username);
    return token;
  }

  beforeAll(() => {
    client = integrationClient();
    provider = createForgejoGitProvider({ client });
    audit = createRecordingGitAuditSink();
    tokens = createTokenService({ client, audit });
  });

  afterAll(async () => {
    for (const username of minted) {
      await client.send({
        method: 'DELETE',
        path: `/admin/users/${username}?purge=true`,
        allow: [404],
      });
    }
    // Two passes, and the order is not optional: this suite deliberately puts
    // two projects in one organization (see `project`), and Forgejo answers a
    // delete of an organization that still owns a repository with a 500. Every
    // repository first, then each organization once.
    for (const { organizationId, projectId } of created) {
      const [owner, name] = internalRepoRef({ organizationId, projectId }).split('/') as [
        string,
        string,
      ];
      await client.send({ method: 'DELETE', path: `/repos/${owner}/${name}`, allow: [404] });
    }
    for (const owner of new Set(created.map((entry) => entry.organizationId.toLowerCase()))) {
      await client.send({ method: 'DELETE', path: `/orgs/${owner}`, allow: [404] });
    }
  });

  it('clones and pushes its own repository, and cannot touch any other', async () => {
    const mine = project();
    // Same organization, different project: the case a namespace alone does not
    // cover, and the one a real tenant hits every time it has two projects.
    const neighbour = project(mine.organizationId);
    const stranger = project();

    await provider.createRepository({ ...mine, defaultBranch: 'main' });
    // A second project in the *same* tenant, and a third in another: a token
    // scoped to one repository must be refused by both, and the same-tenant case
    // is the one a namespace alone would not cover.
    const neighbourRepo = await provider.createRepository({ ...neighbour, defaultBranch: 'main' });
    const strangerRepo = await provider.createRepository({ ...stranger, defaultBranch: 'main' });

    const grant = await mint(mine, 'write');
    expect(grant.token).not.toBe('');
    expect(expiryOf(grant.username)).toBeInstanceOf(Date);

    const dir = await workspace();
    try {
      const own = credentialUrl(grant.cloneUrl, grant.username, grant.token);
      expect((await git(dir, 'clone', own, 'mine')).ok).toBe(true);

      const repo = `${dir}/mine`;
      await git(repo, 'config', 'user.email', 'suite@zapp.test');
      await git(repo, 'config', 'user.name', 'zapp suite');
      await git(repo, 'commit', '--allow-empty', '-m', 'from a scoped token');
      // Write access, on the one repository it was granted.
      expect((await git(repo, 'push', 'origin', 'HEAD:main')).ok).toBe(true);

      for (const [label, other] of [
        ['the same tenant', neighbourRepo],
        ['another tenant', strangerRepo],
      ] as const) {
        const denied = await git(
          dir,
          'clone',
          credentialUrl(other.cloneUrl, grant.username, grant.token),
          `other-${label.replace(/\s/g, '-')}`,
        );
        // The property. Not "the clone was empty" — the clone was *refused*.
        expect(denied.ok, label).toBe(false);
        expect(denied.output, label).toMatch(/not found|Authentication failed|denied/i);
      }

      // And over the API, which is the same reach by another door: a restricted
      // user sees nothing it was not explicitly given, so another repository is
      // indistinguishable from one that does not exist.
      for (const [label, other] of [
        ['the same tenant', neighbour],
        ['another tenant', stranger],
      ] as const) {
        const [owner, name] = internalRepoRef(other).split('/') as [string, string];
        const response = await client.send({
          method: 'GET',
          path: `/repos/${owner}/${name}`,
          auth: { kind: 'token', token: grant.token },
          allow: [401, 403, 404],
        });
        expect(response.status, label).toBe(404);
      }

      // What it *can* see is one repository, and only one. A scoped token that
      // could enumerate is a scoped token that has already leaked which projects
      // exist.
      const listed = await client.send<{ data?: { full_name?: string }[] }>({
        method: 'GET',
        path: '/repos/search?limit=50',
        auth: { kind: 'token', token: grant.token },
      });
      expect((listed.body?.data ?? []).map((entry) => entry.full_name)).toEqual([mine.ref]);
    } finally {
      await removeWorkspace(dir);
    }
  }, 180_000);

  it('mints a read token that cannot push', async () => {
    const mine = project();
    const repository = await provider.createRepository({ ...mine, defaultBranch: 'main' });
    const grant = await mint(mine, 'read');

    const dir = await workspace();
    try {
      const url = credentialUrl(repository.cloneUrl, grant.username, grant.token);
      expect((await git(dir, 'clone', url, 'mine')).ok).toBe(true);

      const repo = `${dir}/mine`;
      await git(repo, 'config', 'user.email', 'suite@zapp.test');
      await git(repo, 'config', 'user.name', 'zapp suite');
      await git(repo, 'commit', '--allow-empty', '-m', 'should not land');

      // `read` is a collaborator permission and a token scope, and both have to
      // hold for this to fail — which is why it is asserted rather than assumed.
      const refused = await git(repo, 'push', 'origin', 'HEAD:main');
      expect(refused.ok).toBe(false);
    } finally {
      await removeWorkspace(dir);
    }
  }, 120_000);

  it('exports a verified Git bundle through a read credential and revokes it immediately', async () => {
    const mine = project();
    const repository = await provider.createRepository({ ...mine, defaultBranch: 'main' });
    const dir = await workspace();
    try {
      const url = credentialUrl(repository.cloneUrl, 'zapp-admin-token', adminToken());
      expect((await git(dir, 'clone', url, 'mine')).ok).toBe(true);
      const repo = `${dir}/mine`;
      await git(repo, 'config', 'user.email', 'suite@zapp.test');
      await git(repo, 'config', 'user.name', 'zapp suite');
      expect((await git(repo, 'commit', '--allow-empty', '-m', 'portable')).ok).toBe(true);
      expect((await git(repo, 'push', 'origin', 'HEAD:main')).ok).toBe(true);
      const head = (await git(repo, 'rev-parse', 'HEAD')).output.trim();

      const exporter = createGitBundleExporter({
        credentials: createTokenServiceGitBundleCredentials(tokens),
        commands: ({ username, token }) =>
          createGitBundleCommands({ username, password: token, timeoutMs: 60_000 }),
      });
      const bytes = await exporter.bundle({
        organizationId: mine.organizationId,
        projectId: mine.projectId,
        operationKey: 'cp18-provider-export',
      });
      const bundlePath = `${dir}/repository.bundle`;
      await writeFile(bundlePath, bytes);
      expect((await git(repo, 'bundle', 'verify', bundlePath)).ok).toBe(true);
      expect((await git(repo, 'bundle', 'list-heads', bundlePath)).output).toContain(head);

      const minted = [...audit.events]
        .reverse()
        .find(
          (event) =>
            event.action === 'git_token.minted' && event.projectId === mine.projectId,
        );
      const revoked = [...audit.events]
        .reverse()
        .find(
          (event) =>
            event.action === 'git_token.revoked' && event.projectId === mine.projectId,
        );
      expect(minted?.action).toBe('git_token.minted');
      expect(revoked?.action).toBe('git_token.revoked');
      if (minted?.action !== 'git_token.minted') throw new Error('missing export token audit');
      const account = await client.send({
        method: 'GET',
        path: `/users/${minted.metadata.tokenUser}`,
        allow: [404],
      });
      expect(account.status).toBe(404);
    } finally {
      await removeWorkspace(dir);
    }
  }, 120_000);

  it('stops working once expired and swept', async () => {
    const mine = project();
    const repository = await provider.createRepository({ ...mine, defaultBranch: 'main' });
    // One second, so the deadline is already in the past by the time the sweep
    // runs — the sweep reads the deadline out of the username, so nothing here
    // has to wait for a real clock.
    const grant = await mint(mine, 'write', 1);

    const dir = await workspace();
    try {
      const url = credentialUrl(repository.cloneUrl, grant.username, grant.token);
      // Usable before the sweep: Forgejo has no expiring token, so the deadline
      // means nothing until something enforces it. That is the honest, bounded
      // exposure this design documents.
      expect((await git(dir, 'clone', url, 'before')).ok).toBe(true);

      const revoked = await tokens.sweepExpired(new Date(Date.now() + 60_000));
      expect(revoked).toBeGreaterThanOrEqual(1);

      const denied = await git(dir, 'clone', url, 'after');
      expect(denied.ok).toBe(false);
      expect(denied.output).toMatch(/incorrect|expired|Authentication failed|not found/i);

      // And the account is gone, not merely disabled: a disabled account is one
      // configuration change away from working again.
      const account = await client.send({
        method: 'GET',
        path: `/users/${grant.username}`,
        allow: [404],
      });
      expect(account.status).toBe(404);
    } finally {
      await removeWorkspace(dir);
    }
  }, 120_000);

  it('revokes every outstanding grant when a project goes away', async () => {
    const mine = project();
    const repository = await provider.createRepository({ ...mine, defaultBranch: 'main' });
    const first = await mint(mine, 'read');
    const second = await mint(mine, 'write');

    const revoked = await tokens.revokeForProject({
      ...mine,
      requestingService: 'control-api',
    });
    expect(revoked).toBe(2);

    const dir = await workspace();
    try {
      for (const grant of [first, second]) {
        // Deleting the project must not leave credentials that outlive it for
        // the rest of their TTL.
        const denied = await git(
          dir,
          'clone',
          credentialUrl(repository.cloneUrl, grant.username, grant.token),
          grant.username,
        );
        expect(denied.ok).toBe(false);
      }
    } finally {
      await removeWorkspace(dir);
    }

    expect(audit.events.filter((event) => event.action === 'git_token.revoked')).toHaveLength(1);
  }, 120_000);

  it('records a mint in the trail, and never the token in it', async () => {
    const mine = project();
    await provider.createRepository({ ...mine, defaultBranch: 'main' });

    const grant = await mint(mine, 'write');

    const row = audit.events.findLast(
      (event) => event.action === 'git_token.minted' && event.projectId === mine.projectId,
    );
    expect(row).toMatchObject({
      organizationId: mine.organizationId,
      requestingService: 'sandbox-service',
      metadata: { internalRepoRef: mine.ref, access: 'write', tokenUser: grant.username },
    });
    // The identity is recorded so a Forgejo access-log line can be tied back to
    // this row; the secret is not, and there is no field it would fit in.
    expect(JSON.stringify(row)).not.toContain(grant.token);
  }, 120_000);

  it('waits for the first push before a scoped clone has any history', async () => {
    // A grant on a repository nothing has pushed to: the clone succeeds and is
    // empty, which is what every project looks like before its first run.
    const mine = project();
    const repository = await provider.createRepository({ ...mine, defaultBranch: 'main' });
    const grant = await mint(mine, 'write');

    const dir = await workspace();
    try {
      const url = credentialUrl(repository.cloneUrl, grant.username, grant.token);
      const clone = await git(dir, 'clone', url, 'mine');
      expect(clone.ok).toBe(true);

      const repo = `${dir}/mine`;
      await git(repo, 'config', 'user.email', 'suite@zapp.test');
      await git(repo, 'config', 'user.name', 'zapp suite');
      await git(repo, 'commit', '--allow-empty', '-m', 'first');
      expect((await git(repo, 'push', 'origin', 'HEAD:main')).ok).toBe(true);

      const head = (await git(repo, 'rev-parse', 'HEAD')).output.trim();
      const branch = await eventually(() => provider.getBranch(mine.ref, 'main'), 'main to appear');
      expect(branch.headSha).toBe(head);
    } finally {
      await removeWorkspace(dir);
    }
  }, 120_000);
});
